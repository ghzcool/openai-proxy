import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REQUEST_HEADERS_TO_STRIP = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
  'api-key',
]);

const RESPONSE_HEADERS_TO_STRIP = new Set([
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'access-control-expose-headers',
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'server',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

const MODEL_ENDPOINT_PATTERN =
  /\/(?:chat\/completions|completions|embeddings|responses|moderations|images\/generations|audio\/speech)\/?$/;

/**
 * Turn an incoming OpenAI-style path into the provider's URL.
 *
 * The configured base URL is treated as the OpenAI "base URL" (normally ending
 * in /v1). Incoming paths may include /v1 or omit it, which keeps clients that
 * append or skip the prefix working.
 */
export function buildUpstreamUrl(baseUrl, requestUrl) {
  const base = baseUrl instanceof URL ? new URL(baseUrl.href) : new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const incoming = new URL(requestUrl || '/', 'http://openai-proxy.local');

  let pathname = incoming.pathname || '/';
  if (pathname !== '/v1' && !pathname.startsWith('/v1/')) {
    pathname = `/v1${pathname}`;
  }

  const mapped = /\/v1$/.test(basePath)
    ? `${basePath}${pathname.slice(3)}`
    : `${basePath}${pathname}`;

  const target = new URL(base.origin);
  target.pathname = mapped.replace(/\/{2,}/g, '/') || '/';
  target.search = incoming.search;
  return target;
}

export function createProxyServer(config, { logger = console } = {}) {
  const state = {
    upstreamBaseUrl: config.upstream.baseUrl,
    upstreamApiKey: config.upstream.apiKey,
    upstreamHeaders: config.upstream.headers ?? {},
    clientApiKey: config.clientApiKey ?? null,
    model: config.model ?? null,
    requestTimeoutMs: config.requestTimeoutMs ?? 300_000,
    maxBodyBytes: config.maxBodyBytes ?? 50 * 1024 * 1024,
    log: config.log !== false,
    logger,
    startedAt: Date.now(),
  };

  return http.createServer((req, res) => {
    handleRequest(req, res, state).catch((error) => {
      if (state.log) {
        (state.logger.error ?? console.error).call(
          state.logger,
          `[openai-proxy] Unhandled request error: ${error.message}`,
        );
      }
      if (res.destroyed) {
        return;
      }
      if (!res.headersSent) {
        sendError(res, 500, 'Internal proxy error.', 'api_error');
      } else {
        res.destroy(error);
      }
    });
  });
}

async function handleRequest(req, res, state) {
  const startedAt = performance.now();
  const url = new URL(req.url || '/', 'http://openai-proxy.local');
  const pathname = url.pathname;

  applyCors(req, res);

  if (state.log) {
    let logged = false;
    const writeLog = (outcome = '') => {
      if (logged) return;
      logged = true;
      const duration = Math.max(0, Math.round(performance.now() - startedAt));
      (state.logger.log ?? console.log).call(
        state.logger,
        `[openai-proxy] ${req.method} ${pathname} -> ${res.statusCode}${outcome} (${duration} ms)`,
      );
    };
    res.once('finish', () => writeLog());
    res.once('close', () => {
      if (!res.writableFinished) writeLog(' [aborted]');
    });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    (pathname === '/' || pathname === '/health')
  ) {
    const payload = JSON.stringify({
      status: 'ok',
      service: 'openai-proxy',
      openaiBaseUrl: '/v1',
      uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : payload);
    return;
  }

  if (state.clientApiKey && !isAuthorized(req, state.clientApiKey)) {
    sendError(
      res,
      401,
      'Invalid API key provided. Use the clientApiKey from proxy.config.json.',
      'invalid_request_error',
      'invalid_api_key',
    );
    return;
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > state.maxBodyBytes) {
      req.resume();
      sendError(
        res,
        413,
        `Request body is larger than maxBodyBytes (${state.maxBodyBytes} bytes).`,
        'invalid_request_error',
        'request_too_large',
      );
      return;
    }

    try {
      body = await readBody(req, state.maxBodyBytes);
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        req.resume();
        sendError(
          res,
          413,
          `Request body is larger than maxBodyBytes (${state.maxBodyBytes} bytes).`,
          'invalid_request_error',
          'request_too_large',
        );
        return;
      }
      if (req.destroyed || res.destroyed) {
        return;
      }
      throw error;
    }
  }

  if (res.destroyed) {
    return;
  }

  if (
    state.model &&
    body &&
    body.length > 0 &&
    isJsonRequest(req.headers['content-type'])
  ) {
    body = applyModelOverride(body, state.model, pathname);
  }

  let target;
  try {
    target = buildUpstreamUrl(state.upstreamBaseUrl, req.url || '/');
  } catch {
    sendError(res, 400, 'Invalid request path.', 'invalid_request_error');
    return;
  }

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lowerName = name.toLowerCase();
    if (REQUEST_HEADERS_TO_STRIP.has(lowerName)) continue;
    headers[lowerName] = Array.isArray(value) ? value.join(', ') : value;
  }

  for (const [name, value] of Object.entries(state.upstreamHeaders)) {
    headers[name.toLowerCase()] = value;
  }

  headers.authorization = `Bearer ${state.upstreamApiKey}`;
  if (body && body.length > 0 && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  const controller = new AbortController();
  const abortOnClientClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once('close', abortOnClientClose);

  const timeout = setTimeout(() => {
    controller.abort(new DOMException('Upstream request timed out', 'TimeoutError'));
  }, state.requestTimeoutMs);
  timeout.unref?.();

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(target, {
      method: req.method,
      headers,
      body: body && body.length > 0 ? body : undefined,
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (error) {
    clearTimeout(timeout);
    res.off('close', abortOnClientClose);

    if (res.destroyed) {
      return;
    }

    const aborted =
      error?.name === 'AbortError' ||
      error?.name === 'TimeoutError' ||
      error?.cause?.name === 'TimeoutError';

    if (aborted) {
      sendError(res, 504, 'The upstream provider timed out.', 'api_error', 'timeout');
      return;
    }

    if (state.log) {
      (state.logger.error ?? console.error).call(
        state.logger,
        `[openai-proxy] Could not reach upstream: ${error.message}`,
      );
    }
    sendError(
      res,
      502,
      'Could not reach the upstream provider. Check the proxy configuration and network connection.',
      'api_error',
      'upstream_unavailable',
    );
    return;
  }

  clearTimeout(timeout);

  res.statusCode = upstreamResponse.status;
  for (const [name, value] of upstreamResponse.headers.entries()) {
    const lowerName = name.toLowerCase();
    if (RESPONSE_HEADERS_TO_STRIP.has(lowerName)) continue;
    if (lowerName === 'set-cookie') {
      for (const cookie of upstreamResponse.headers.getSetCookie()) {
        res.appendHeader('set-cookie', cookie);
      }
      continue;
    }
    res.setHeader(name, value);
  }

  if (
    !upstreamResponse.body ||
    req.method === 'HEAD' ||
    upstreamResponse.status === 204 ||
    upstreamResponse.status === 304
  ) {
    res.end();
    return;
  }

  try {
    const upstreamBody = Readable.fromWeb(upstreamResponse.body);
    const isEventStream = /text\/event-stream/i.test(
      upstreamResponse.headers.get('content-type') ?? '',
    );

    if (isEventStream && isResponsesEndpoint(pathname)) {
      await pipeline(upstreamBody, createResponsesCompatFilter(), res);
    } else {
      await pipeline(upstreamBody, res);
    }
  } catch (error) {
    if (!res.destroyed && error?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      res.destroy(error);
    }
  }
}

function isResponsesEndpoint(pathname) {
  return /(?:^|\/)responses\/?$/.test(pathname);
}

// OpenRouter (and some other compatible providers) implement the Responses API
// with slightly different streaming event names than OpenAI. VS Code Copilot
// only understands the OpenAI names, so map the common differences.
const RESPONSES_EVENT_RENAMES = new Map([
  ['response.content_part.delta', 'response.output_text.delta'],
  ['response.content_part.done', 'response.output_text.done'],
  ['response.done', 'response.completed'],
]);

/**
 * Adapt a Responses API SSE stream for strict OpenAI clients:
 *
 * - Drop the terminal `data: [DONE]` sentinel. Copilot JSON.parses every data
 *   line and reports `Unexpected token 'D', "[DONE]" is not valid JSON`.
 * - Rename provider-specific event types to the canonical OpenAI names.
 * - Fill in usage detail objects that OpenAI always sends and Copilot reads
 *   without optional chaining.
 */
function createResponsesCompatFilter() {
  let pending = Buffer.alloc(0);

  const emitLine = (stream, line) => {
    const rewritten = rewriteResponsesLine(line);
    if (rewritten !== null) stream.push(rewritten);
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;

      let lineStart = 0;
      let newlineIndex;
      while ((newlineIndex = pending.indexOf(0x0a, lineStart)) !== -1) {
        emitLine(this, pending.subarray(lineStart, newlineIndex + 1));
        lineStart = newlineIndex + 1;
      }

      pending = pending.subarray(lineStart);
      callback();
    },
    flush(callback) {
      if (pending.length > 0) {
        emitLine(this, pending);
        pending = Buffer.alloc(0);
      }
      callback();
    },
  });
}

/** Returns the rewritten line, or null when the line should be dropped. */
function rewriteResponsesLine(line) {
  const text = line.toString('utf8');
  const ending = text.endsWith('\r\n')
    ? '\r\n'
    : text.endsWith('\n')
      ? '\n'
      : '';
  const body = ending ? text.slice(0, -ending.length) : text;

  const dataMatch = /^data:[ \t]*(.*)$/s.exec(body);
  if (dataMatch) {
    const raw = dataMatch[1];
    if (raw.trim() === '[DONE]') {
      return null;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return line;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return line;
    }

    let changed = false;

    const renamed = RESPONSES_EVENT_RENAMES.get(payload.type);
    if (renamed) {
      payload.type = renamed;
      changed = true;
    }

    if (payload.type === 'response.completed') {
      changed = normalizeCompletedResponse(payload.response) || changed;
    }

    return changed
      ? Buffer.from(`data: ${JSON.stringify(payload)}${ending}`, 'utf8')
      : line;
  }

  const eventMatch = /^event:[ \t]*(.*)$/s.exec(body);
  if (eventMatch) {
    const renamed = RESPONSES_EVENT_RENAMES.get(eventMatch[1].trim());
    if (renamed) {
      return Buffer.from(`event: ${renamed}${ending}`, 'utf8');
    }
  }

  return line;
}

function normalizeCompletedResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return false;
  }

  const usage = response.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return false;
  }

  let changed = false;
  if (!usage.input_tokens_details || typeof usage.input_tokens_details !== 'object') {
    usage.input_tokens_details = { cached_tokens: 0 };
    changed = true;
  }
  if (
    !usage.output_tokens_details ||
    typeof usage.output_tokens_details !== 'object'
  ) {
    usage.output_tokens_details = { reasoning_tokens: 0 };
    changed = true;
  }
  return changed;
}

function isJsonRequest(contentType) {
  if (contentType === undefined) return true;
  return /^application\/(?:[^;]+\+)?json\b/i.test(contentType);
}

function applyModelOverride(body, model, pathname) {
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return body;
  }

  const hasModel = Object.prototype.hasOwnProperty.call(payload, 'model');
  if (!hasModel && !MODEL_ENDPOINT_PATTERN.test(pathname)) {
    return body;
  }

  if (payload.model === model) {
    return body;
  }

  payload.model = model;
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function applyCors(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader(
    'access-control-allow-methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
  );

  const requestedHeaders = req.headers['access-control-request-headers'];
  res.setHeader(
    'access-control-allow-headers',
    typeof requestedHeaders === 'string' && requestedHeaders.trim() !== ''
      ? requestedHeaders
      : 'authorization, content-type, x-api-key, api-key',
  );
  res.setHeader(
    'access-control-expose-headers',
    'x-request-id, openai-processing-ms, openai-version, x-ratelimit-limit-requests, x-ratelimit-remaining-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-tokens',
  );
  res.setHeader('access-control-max-age', '86400');
}

function isAuthorized(req, expectedKey) {
  let token;

  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) {
      token = match[1].trim();
    }
  }

  if (!token) {
    const apiKey = req.headers['x-api-key'] ?? req.headers['api-key'];
    if (typeof apiKey === 'string') {
      token = apiKey.trim();
    }
  }

  if (!token) {
    return false;
  }

  const provided = Buffer.from(token);
  const expected = Buffer.from(expectedKey);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function sendError(res, status, message, type = 'api_error', code = null) {
  if (res.destroyed) {
    return;
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }

  const payload = JSON.stringify({
    error: {
      message,
      type,
      param: null,
      code,
    },
  });

  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}
