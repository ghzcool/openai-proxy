import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CONFIG_FILENAME = 'proxy.config.json';

const DEFAULTS = Object.freeze({
  port: 1234,
  host: '127.0.0.1',
  model: null,
  upstream: Object.freeze({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    apiKeyEnv: null,
    headers: Object.freeze({}),
  }),
  clientApiKey: null,
  requestTimeoutMs: 300_000,
  maxBodyBytes: 50 * 1024 * 1024,
  log: true,
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Starter config written when the user asks for one. It deliberately contains
 * an empty API key so nothing secret ends up in a file by accident.
 */
export function createConfigTemplate({ port = DEFAULTS.port } = {}) {
  const config = {
    port,
    host: DEFAULTS.host,
    model: null,
    upstream: {
      baseUrl: DEFAULTS.upstream.baseUrl,
      apiKey: '',
      apiKeyEnv: null,
      headers: {
        'HTTP-Referer': `http://localhost:${port}`,
        'X-Title': 'openai-proxy',
      },
    },
    clientApiKey: null,
    requestTimeoutMs: DEFAULTS.requestTimeoutMs,
    maxBodyBytes: DEFAULTS.maxBodyBytes,
    log: true,
  };

  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeConfigTemplate(configPath, options = {}) {
  try {
    await writeFile(configPath, createConfigTemplate(options), { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new ConfigError(`Config file already exists: ${configPath}`);
    }
    throw error;
  }
}

export async function loadConfig(configPath) {
  let text;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ConfigError(`Config file not found: ${configPath}`);
    }
    throw error;
  }

  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(
      `Could not parse ${path.basename(configPath)}: ${error.message}`,
    );
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${path.basename(configPath)} must contain a JSON object.`);
  }

  return normalizeConfig(raw, configPath);
}

export function normalizeConfig(raw, configPath = CONFIG_FILENAME) {
  const file = path.basename(configPath);
  const upstreamRaw = optionalObject(raw.upstream, 'upstream', file);
  const headersRaw = optionalObject(upstreamRaw.headers, 'upstream.headers', file);

  const config = {
    port: raw.port ?? DEFAULTS.port,
    host: raw.host ?? DEFAULTS.host,
    model: raw.model ?? DEFAULTS.model,
    clientApiKey: raw.clientApiKey ?? DEFAULTS.clientApiKey,
    requestTimeoutMs: raw.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    maxBodyBytes: raw.maxBodyBytes ?? DEFAULTS.maxBodyBytes,
    log: raw.log ?? DEFAULTS.log,
    upstream: {
      baseUrl: upstreamRaw.baseUrl ?? DEFAULTS.upstream.baseUrl,
      apiKey: upstreamRaw.apiKey ?? DEFAULTS.upstream.apiKey,
      apiKeyEnv: upstreamRaw.apiKeyEnv ?? DEFAULTS.upstream.apiKeyEnv,
      headers: {},
    },
  };

  validateInteger(config.port, 'port', 1, 65_535, file);
  validateInteger(config.requestTimeoutMs, 'requestTimeoutMs', 1, 86_400_000, file);
  validateInteger(config.maxBodyBytes, 'maxBodyBytes', 1_024, 1024 ** 3, file);

  if (typeof config.host !== 'string' || config.host.trim() === '') {
    throw new ConfigError(`"host" in ${file} must be a non-empty string.`);
  }

  if (typeof config.log !== 'boolean') {
    throw new ConfigError(`"log" in ${file} must be true or false.`);
  }

  if (config.model !== null) {
    if (typeof config.model !== 'string') {
      throw new ConfigError(`"model" in ${file} must be a string or null.`);
    }
    const model = config.model.trim();
    config.model = model === '' ? null : model;
  }

  config.upstream.baseUrl = normalizeBaseUrl(config.upstream.baseUrl, file);
  config.upstream.headers = normalizeHeaders(headersRaw, file);

  if (config.upstream.apiKeyEnv !== null) {
    if (
      typeof config.upstream.apiKeyEnv !== 'string' ||
      config.upstream.apiKeyEnv.trim() === ''
    ) {
      throw new ConfigError(`"upstream.apiKeyEnv" in ${file} must be a non-empty string or null.`);
    }

    const envName = config.upstream.apiKeyEnv.trim();
    const envValue = process.env[envName];
    if (envValue === undefined || envValue === '') {
      throw new ConfigError(
        `Environment variable "${envName}" (from "upstream.apiKeyEnv" in ${file}) is not set.`,
      );
    }
    config.upstream.apiKey = envValue;
  } else {
    if (typeof config.upstream.apiKey !== 'string') {
      throw new ConfigError(`"upstream.apiKey" in ${file} must be a string.`);
    }
    config.upstream.apiKey = expandEnv(config.upstream.apiKey, '"upstream.apiKey"', file);
  }

  config.upstream.apiKey = config.upstream.apiKey.trim();

  if (config.upstream.apiKey === '') {
    throw new ConfigError(
      `"upstream.apiKey" in ${file} is empty. Add your provider API key (or set "upstream.apiKeyEnv") and run again.`,
    );
  }

  if (config.clientApiKey !== null) {
    if (typeof config.clientApiKey !== 'string') {
      throw new ConfigError(`"clientApiKey" in ${file} must be a string or null.`);
    }
    const expanded = expandEnv(config.clientApiKey, '"clientApiKey"', file).trim();
    config.clientApiKey = expanded === '' ? null : expanded;
  }

  return Object.freeze(config);
}

function optionalObject(value, key, file) {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`"${key}" in ${file} must be an object.`);
  }
  return value;
}

function validateInteger(value, key, min, max, file) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(
      `"${key}" in ${file} must be an integer between ${min} and ${max}.`,
    );
  }
}

function normalizeBaseUrl(value, file) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`"upstream.baseUrl" in ${file} must be a URL string.`);
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConfigError(`"upstream.baseUrl" in ${file} is not a valid URL: ${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`"upstream.baseUrl" in ${file} must use http or https.`);
  }

  if (url.search || url.hash) {
    throw new ConfigError(
      `"upstream.baseUrl" in ${file} must not contain a query string or hash.`,
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function normalizeHeaders(headers, file) {
  const result = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === null) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new ConfigError(`"upstream.headers.${name}" in ${file} must be a string or null.`);
    }
    if (name.trim() === '') {
      continue;
    }
    result[name] = expandEnv(value, `"upstream.headers.${name}"`, file);
  }

  return Object.freeze(result);
}

function expandEnv(value, field, file) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    const envValue = process.env[name];
    if (envValue === undefined) {
      throw new ConfigError(
        `Environment variable "${name}" (referenced by ${field} in ${file}) is not set.`,
      );
    }
    return envValue;
  });
}
