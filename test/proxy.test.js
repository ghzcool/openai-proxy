import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildUpstreamUrl, createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function closeAll(server) {
  server.closeAllConnections?.();
  await close(server);
}

function createUpstream() {
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (req.url === '/api/v1/chat/completions') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'x-provider': 'mock-provider',
        });
        res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
        setTimeout(() => {
          res.write(
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
          );
          res.end();
        }, 10);
        return;
      }

      if (req.url === '/api/v1/models') {
        const payload = JSON.stringify({
          object: 'list',
          data: [{ id: 'mock-model', object: 'model' }],
        });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }

      if (req.url === '/api/v1/responses') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
        // Mimic OpenRouter's Responses stream: legacy event names and a usage
        // object without the detail objects OpenAI always includes.
        res.write(
          'data: {"type":"response.created","response":{"id":"resp_mock","model":"mock-model"}}\n\n',
        );
        res.write(
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_mock","role":"assistant","status":"in_progress","content":[]}}\n\n',
        );
        res.write(
          'data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n',
        );
        res.write(
          'data: {"type":"response.content_part.delta","delta":"hel","output_index":0,"content_index":0}\n\n',
        );
        setTimeout(() => {
          res.write(
            'data: {"type":"response.content_part.delta","delta":"lo","output_index":0,"content_index":0}\n\n',
          );
          res.write(
            'event: response.done\ndata: {"type":"response.done","response":{"id":"resp_mock","object":"response","status":"completed","model":"mock-model","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
          );
          // Split the sentinel across writes to exercise the filter's buffering.
          res.write('data: [DO');
          setTimeout(() => res.end('NE]\n\n'), 5);
        }, 10);
        return;
      }

      if (req.url === '/api/v1/slow') {
        // Intentionally never respond, so the proxy timeout fires.
        return;
      }

      const payload = JSON.stringify({ error: { message: 'not found upstream' } });
      res.writeHead(404, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    });
  });

  return { server, requests };
}

test('buildUpstreamUrl maps OpenAI paths to the configured base URL', () => {
  const base = 'https://openrouter.ai/api/v1';

  assert.equal(
    buildUpstreamUrl(base, '/v1/chat/completions?trace=1').href,
    'https://openrouter.ai/api/v1/chat/completions?trace=1',
  );
  assert.equal(
    buildUpstreamUrl(base, '/chat/completions').href,
    'https://openrouter.ai/api/v1/chat/completions',
  );
  assert.equal(
    buildUpstreamUrl(base, '/v1/models').href,
    'https://openrouter.ai/api/v1/models',
  );
  assert.equal(
    buildUpstreamUrl(base, '/v1').href,
    'https://openrouter.ai/api/v1',
  );
  assert.equal(
    buildUpstreamUrl('http://127.0.0.1:9000', '/v1/models').href,
    'http://127.0.0.1:9000/v1/models',
  );
  assert.equal(
    buildUpstreamUrl('http://127.0.0.1:9000/openai/v1', '/models').href,
    'http://127.0.0.1:9000/openai/v1/models',
  );
});

test('proxy forwards, streams, and replaces provider credentials', async (t) => {
  const upstream = createUpstream();
  const upstreamPort = await listen(upstream.server);

  const proxy = createProxyServer({
    host: '127.0.0.1',
    model: 'openai/config-model',
    upstream: {
      baseUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
      apiKey: 'sk-provider-secret',
      headers: {
        'HTTP-Referer': 'http://local.test',
        'X-Title': 'openai-proxy-tests',
        Authorization: 'Bearer should-be-replaced',
      },
    },
    clientApiKey: 'sk-client',
    requestTimeoutMs: 250,
    maxBodyBytes: 1024 * 1024,
    log: false,
  });
  const proxyPort = await listen(proxy);

  t.after(async () => {
    await closeAll(proxy);
    await closeAll(upstream.server);
  });

  const baseUrl = `http://127.0.0.1:${proxyPort}`;

  await t.test('serves local health info without touching the provider', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.service, 'openai-proxy');
    assert.equal(upstream.requests.length, 0);
  });

  await t.test('answers CORS preflight requests', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-headers': 'authorization, content-type',
      },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(
      response.headers.get('access-control-allow-headers'),
      /authorization/,
    );
  });

  await t.test('rejects a wrong client key before contacting the provider', async () => {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: 'Bearer wrong-key' },
    });
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(payload.error.code, 'invalid_api_key');
    assert.equal(upstream.requests.length, 0);
  });

  await t.test('streams chat completions and hides the provider key', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-client',
        'content-type': 'application/json',
        'x-api-key': 'client-key-that-must-not-leak',
      },
      body: JSON.stringify({
        model: 'mock-model',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.equal(response.headers.get('x-provider'), 'mock-provider');

    const text = await response.text();
    assert.match(text, /"hel"/);
    assert.match(text, /"lo"/);
    assert.match(text, /\[DONE\]/);
    assert.doesNotMatch(text, /sk-provider-secret/);

    const forwarded = upstream.requests.at(-1);
    assert.equal(forwarded.method, 'POST');
    assert.equal(forwarded.url, '/api/v1/chat/completions');
    assert.equal(forwarded.headers.authorization, 'Bearer sk-provider-secret');
    assert.equal(forwarded.headers['x-api-key'], undefined);
    assert.equal(forwarded.headers['api-key'], undefined);
    assert.equal(forwarded.headers['http-referer'], 'http://local.test');
    assert.equal(forwarded.headers['x-title'], 'openai-proxy-tests');
    assert.equal(JSON.parse(forwarded.body).model, 'openai/config-model');
  });

  await t.test('normalizes Responses API streams for strict clients', async () => {
    const requestsBefore = upstream.requests.length;
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-client',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'request/model',
        stream: true,
        input: 'hello',
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const text = await response.text();
    // OpenRouter's response.content_part.delta becomes OpenAI's delta event.
    assert.match(text, /response\.output_text\.delta/);
    assert.doesNotMatch(text, /response\.content_part\.delta/);
    assert.match(text, /"delta":"hel"/);
    assert.match(text, /"delta":"lo"/);

    // response.done becomes response.completed and gains usage details.
    assert.match(text, /event: response\.completed/);
    assert.doesNotMatch(text, /event: response\.done/);
    const completed = text
      .split('\n')
      .find((line) => line.includes('"type":"response.completed"'));
    assert.ok(completed, 'expected a response.completed event');
    const payload = JSON.parse(completed.slice('data: '.length));
    assert.deepEqual(payload.response.usage.input_tokens_details, {
      cached_tokens: 0,
    });
    assert.deepEqual(payload.response.usage.output_tokens_details, {
      reasoning_tokens: 0,
    });

    // The terminal sentinel is removed for Responses streams.
    assert.doesNotMatch(text, /\[DONE\]/);

    const forwarded = upstream.requests[requestsBefore];
    assert.equal(forwarded.url, '/api/v1/responses');
    assert.equal(JSON.parse(forwarded.body).model, 'openai/config-model');
  });

  await t.test('applies the config model when the request omits one', async () => {
    const requestsBefore = upstream.requests.length;
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-client',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'no model sent' }],
      }),
    });

    assert.equal(response.status, 200);
    await response.text();

    const forwarded = upstream.requests[requestsBefore];
    assert.equal(JSON.parse(forwarded.body).model, 'openai/config-model');
  });

  await t.test('uses the request model when model is not configured', async () => {
    const passthroughProxy = createProxyServer({
      upstream: {
        baseUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
        apiKey: 'sk-provider-secret',
        headers: {},
      },
      requestTimeoutMs: 500,
      maxBodyBytes: 1024 * 1024,
      log: false,
    });
    const passthroughPort = await listen(passthroughProxy);

    try {
      const response = await fetch(
        `http://127.0.0.1:${passthroughPort}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'request/model',
            stream: true,
            messages: [{ role: 'user', content: 'request model' }],
          }),
        },
      );

      assert.equal(response.status, 200);
      await response.text();
      assert.equal(
        JSON.parse(upstream.requests.at(-1).body).model,
        'request/model',
      );
    } finally {
      await closeAll(passthroughProxy);
    }
  });

  await t.test('accepts paths without /v1 and x-api-key auth', async () => {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { 'x-api-key': 'sk-client' },
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.data[0].id, 'mock-model');
    assert.equal(upstream.requests.at(-1).url, '/api/v1/models');
  });

  await t.test('passes provider errors through', async () => {
    const response = await fetch(`${baseUrl}/v1/unknown-endpoint`, {
      headers: { authorization: 'Bearer sk-client' },
    });
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.equal(payload.error.message, 'not found upstream');
    assert.equal(upstream.requests.at(-1).url, '/api/v1/unknown-endpoint');
  });

  await t.test('returns a 504 when the provider times out', async () => {
    const response = await fetch(`${baseUrl}/v1/slow`, {
      headers: { authorization: 'Bearer sk-client' },
    });
    const payload = await response.json();

    assert.equal(response.status, 504);
    assert.equal(payload.error.code, 'timeout');
  });

  await t.test('rejects request bodies over maxBodyBytes', async () => {
    const limitedProxy = createProxyServer({
      upstream: {
        baseUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
        apiKey: 'sk-provider-secret',
        headers: {},
      },
      clientApiKey: null,
      requestTimeoutMs: 500,
      maxBodyBytes: 1024,
      log: false,
    });
    const limitedPort = await listen(limitedProxy);

    try {
      const requestsBefore = upstream.requests.length;
      const response = await fetch(
        `http://127.0.0.1:${limitedPort}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'x'.repeat(2048),
        },
      );
      const payload = await response.json();

      assert.equal(response.status, 413);
      assert.equal(payload.error.code, 'request_too_large');
      assert.equal(upstream.requests.length, requestsBefore);
    } finally {
      await closeAll(limitedProxy);
    }
  });
});
