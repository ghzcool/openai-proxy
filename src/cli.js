import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import readline from 'node:readline/promises';
import {
  CONFIG_FILENAME,
  ConfigError,
  fileExists,
  loadConfig,
  writeConfigTemplate,
} from './config.js';
import { createProxyServer } from './server.js';

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const VERSION = packageJson.version;

const HELP = `openai-proxy ${VERSION} - local OpenAI-compatible proxy

Usage:
  openai-proxy [options]

Reads ./${CONFIG_FILENAME} from the current folder, starts a local
OpenAI-compatible HTTP server, and forwards every API request to the provider
configured in that file. If the config is missing, you are asked whether a
starter config should be created in the current folder.

Options:
  -c, --config <path>  Config file to use (default: ./${CONFIG_FILENAME})
  -p, --port <port>    Override the port from the config
      --host <host>    Override the host from the config
  -y, --yes            Create the config without asking if it is missing
      --no-log         Disable request logging
      --log            Enable request logging
  -h, --help           Show this help
  -v, --version        Show the version

Config tips:
  Set "upstream.apiKey" to your provider key, or set "upstream.apiKeyEnv" to
  the name of an environment variable. Values such as "\${MY_API_KEY}" are
  expanded inside "upstream.apiKey" and "upstream.headers".
  Set "model" to force one provider model for every request; null uses the
  model sent by the app.

Examples:
  npx openai-proxy-local
  npx openai-proxy-local --port 4321
  npx openai-proxy-local --config ./configs/dev.json --yes
`;

export async function main(argv = []) {
  const options = parseArgs(argv);

  if (options.help) {
    stdout.write(HELP);
    return;
  }

  if (options.version) {
    stdout.write(`${VERSION}\n`);
    return;
  }

  const cwd = process.cwd();
  const configPath = options.config
    ? path.resolve(cwd, options.config)
    : path.join(cwd, CONFIG_FILENAME);

  if (!(await fileExists(configPath))) {
    const shouldCreate = await askToCreateConfig(configPath, options);

    if (!shouldCreate) {
      process.exitCode = 1;
      return;
    }

    try {
      await writeConfigTemplate(configPath, { port: options.port ?? 1234 });
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(`\nCannot create the config: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    printCreatedMessage(configPath);
    return;
  }

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\nCannot start the proxy: ${error.message}\n`);
      console.error(`Edit ${configPath} and run this command again.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  config = {
    ...config,
    port: options.port ?? config.port,
    host: options.host ?? config.host,
    log: options.log ?? config.log,
  };

  const server = createProxyServer(config);

  try {
    await listen(server, config.port, config.host);
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      console.error(
        `\nPort ${config.port} is already in use. Change "port" in ${configPath} or run with --port <port>.`,
      );
      process.exitCode = 1;
      return;
    }
    if (error?.code === 'EACCES') {
      console.error(`\nNot allowed to listen on ${config.host}:${config.port}.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const address = server.address();
  const actualPort =
    address && typeof address === 'object' ? address.port : config.port;
  printRunningMessage(config, configPath, actualPort);

  installShutdownHandlers(server);

  // The HTTP server keeps the process alive. main() intentionally returns once
  // the server is listening so the CLI stays easy to test.
}

async function askToCreateConfig(configPath, options) {
  const folder = path.dirname(configPath);
  const fileName = path.basename(configPath);

  console.error(`\nNo ${fileName} found in:\n  ${folder}\n`);

  if (options.yes) {
    return true;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    console.error(
      `Run this command with --yes to create a starter ${fileName}, or create the file manually and run again.`,
    );
    return false;
  }

  const defaultYes = true;
  const answer = await ask(
    `Create a starter ${fileName} in this folder?`,
    defaultYes,
  );

  if (!answer) {
    console.error(
      `\nNo config created. Create ${fileName} in this folder and run the command again.`,
    );
  }

  return answer;
}

async function ask(question, defaultValue) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const hint = defaultValue ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${question} ${hint} `)).trim().toLowerCase();
    if (answer === '') return defaultValue;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function printCreatedMessage(configPath) {
  console.log(`\nCreated ${configPath}\n`);
  console.log('Next steps:');
  console.log('  1. Open the file and set "upstream.apiKey" to your provider API key.');
  console.log(
    '     Alternatively set "upstream.apiKeyEnv" to the name of an environment variable.',
  );
  console.log('  2. Run this command again in the same folder.');
  console.log('');
}

function printRunningMessage(config, configPath, port) {
  const urlHost =
    config.host === '0.0.0.0' || config.host === '::' || config.host === ''
      ? 'localhost'
      : config.host.includes(':')
        ? `[${config.host}]`
        : config.host;

  let upstreamName;
  try {
    upstreamName = new URL(config.upstream.baseUrl).host;
  } catch {
    upstreamName = 'configured provider';
  }

  const keyLine = config.clientApiKey
    ? 'the "clientApiKey" value from proxy.config.json'
    : 'any value (no client key required)';

  console.log(`\nopenai-proxy ${VERSION} is running.\n`);
  console.log(`  OpenAI base URL : http://${urlHost}:${port}/v1`);
  console.log(`  API key         : ${keyLine}`);
  console.log(`  Config file     : ${configPath}`);
  console.log(`  Upstream        : ${upstreamName}`);
  console.log(
    `  Model           : ${config.model ? `${config.model} (from config)` : 'from request'}`,
  );
  console.log(`  Logging         : ${config.log ? 'on' : 'off'}`);
  console.log('\nPoint your LLM app at the base URL above. Press Ctrl+C to stop.\n');
}

function installShutdownHandlers(server) {
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down...`);

    const forceExit = setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(1);
    }, 5_000);
    forceExit.unref();

    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function parseArgs(argv) {
  const options = {
    config: null,
    port: undefined,
    host: undefined,
    log: undefined,
    yes: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let flag = argument;
    let inlineValue;

    if (argument.startsWith('--') && argument.includes('=')) {
      const separator = argument.indexOf('=');
      flag = argument.slice(0, separator);
      inlineValue = argument.slice(separator + 1);
    }

    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`Option ${flag} requires a value.`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '-c':
      case '--config':
        options.config = takeValue();
        break;
      case '-p':
      case '--port':
        options.port = parsePort(takeValue());
        break;
      case '--host': {
        const host = takeValue().trim();
        if (host === '') {
          throw new Error('Option --host requires a non-empty value.');
        }
        options.host = host;
        break;
      }
      case '-y':
      case '--yes':
        options.yes = true;
        break;
      case '--no-log':
        options.log = false;
        break;
      case '--log':
        options.log = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}\nRun with --help for usage.`);
    }
  }

  return options;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port "${value}". Use an integer between 1 and 65535.`);
  }
  return port;
}
