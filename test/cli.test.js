import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const binPath = fileURLToPath(new URL('../bin/openai-proxy.js', import.meta.url));

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openai-proxy-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [binPath, ...args],
      { cwd, env: { ...process.env, NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

test('CLI reports a missing config and creates it only when allowed', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'proxy.config.json');

  const declined = await runCli([], dir);
  assert.equal(declined.code, 1);
  assert.match(declined.stderr, /No proxy\.config\.json found/);
  assert.match(declined.stderr, /--yes/);
  await assert.rejects(readFile(configPath, 'utf8'), { code: 'ENOENT' });

  const created = await runCli(['--yes'], dir);
  assert.equal(created.code, 0);
  assert.match(created.stdout, /Created .*proxy\.config\.json/);
  assert.match(created.stdout, /upstream\.apiKey/);

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.port, 1234);
  assert.equal(config.upstream.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(config.upstream.apiKey, '');

  const notConfigured = await runCli([], dir);
  assert.equal(notConfigured.code, 1);
  assert.match(notConfigured.stderr, /upstream\.apiKey/);
});

test('CLI --help and --version work without a config', async (t) => {
  const dir = await tempDir(t);

  const help = await runCli(['--help'], dir);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--config/);

  const version = await runCli(['--version'], dir);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});
