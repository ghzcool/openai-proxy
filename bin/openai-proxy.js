#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  if (process.env.OPENAI_PROXY_DEBUG) {
    console.error(error);
  }
  process.exitCode = 1;
});
