import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigError,
  createConfigTemplate,
  loadConfig,
  writeConfigTemplate,
} from '../src/config.js';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openai-proxy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('config template is a valid starter config', () => {
  const config = JSON.parse(createConfigTemplate());

  assert.equal(config.port, 1234);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.model, null);
  assert.equal(config.upstream.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(config.upstream.apiKey, '');
  assert.equal(config.clientApiKey, null);
  assert.equal(config.log, true);
});

test('loadConfig reads the file and expands environment variables', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'proxy.config.json');

  process.env.OPENAI_PROXY_TEST_KEY = 'sk-from-env';
  process.env.OPENAI_PROXY_TEST_HEADER = 'header-value';
  t.after(() => {
    delete process.env.OPENAI_PROXY_TEST_KEY;
    delete process.env.OPENAI_PROXY_TEST_HEADER;
  });

  await writeFile(
    configPath,
    JSON.stringify({
      port: 4321,
      host: '0.0.0.0',
      model: ' openai/test-model ',
      upstream: {
        baseUrl: 'https://openrouter.ai/api/v1/',
        apiKey: '${OPENAI_PROXY_TEST_KEY}',
        headers: {
          'X-Test': '${OPENAI_PROXY_TEST_HEADER}',
          'X-Removed': null,
        },
      },
      clientApiKey: ' local-secret ',
      requestTimeoutMs: 120000,
      maxBodyBytes: 1048576,
      log: false,
    }),
  );

  const config = await loadConfig(configPath);

  assert.equal(config.port, 4321);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.model, 'openai/test-model');
  assert.equal(config.upstream.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(config.upstream.apiKey, 'sk-from-env');
  assert.deepEqual(config.upstream.headers, { 'X-Test': 'header-value' });
  assert.equal(config.clientApiKey, 'local-secret');
  assert.equal(config.log, false);
});

test('loadConfig supports upstream.apiKeyEnv', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'proxy.config.json');

  process.env.OPENAI_PROXY_ENV_ONLY = 'sk-env-only';
  t.after(() => {
    delete process.env.OPENAI_PROXY_ENV_ONLY;
  });

  await writeFile(
    configPath,
    JSON.stringify({
      upstream: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENAI_PROXY_ENV_ONLY',
      },
    }),
  );

  const config = await loadConfig(configPath);
  assert.equal(config.upstream.apiKey, 'sk-env-only');
});

test('loadConfig rejects an empty provider key with a helpful error', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'proxy.config.json');
  await writeFile(configPath, createConfigTemplate());

  await assert.rejects(
    loadConfig(configPath),
    (error) =>
      error instanceof ConfigError && /upstream\.apiKey/.test(error.message),
  );
});

test('loadConfig rejects invalid JSON and invalid ports', async (t) => {
  const dir = await tempDir(t);
  const invalidJsonPath = path.join(dir, 'broken.json');
  const invalidPortPath = path.join(dir, 'port.json');

  await writeFile(invalidJsonPath, '{ nope');
  await assert.rejects(
    loadConfig(invalidJsonPath),
    (error) =>
      error instanceof ConfigError && /Could not parse broken\.json/.test(error.message),
  );

  await writeFile(
    invalidPortPath,
    JSON.stringify({
      port: 70000,
      upstream: { apiKey: 'sk-test' },
    }),
  );
  await assert.rejects(
    loadConfig(invalidPortPath),
    (error) => error instanceof ConfigError && /"port"/.test(error.message),
  );

  const invalidModelPath = path.join(dir, 'model.json');
  await writeFile(
    invalidModelPath,
    JSON.stringify({
      model: 123,
      upstream: { apiKey: 'sk-test' },
    }),
  );
  await assert.rejects(
    loadConfig(invalidModelPath),
    (error) => error instanceof ConfigError && /"model"/.test(error.message),
  );
});

test('writeConfigTemplate refuses to overwrite an existing file', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'proxy.config.json');

  await writeConfigTemplate(configPath);
  assert.match(await readFile(configPath, 'utf8'), /"port": 1234/);

  await assert.rejects(
    writeConfigTemplate(configPath),
    (error) => error instanceof ConfigError && /already exists/.test(error.message),
  );
});
