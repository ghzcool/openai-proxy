# openai-proxy

A small local **OpenAI-compatible proxy**. Your apps talk to
`http://127.0.0.1:1234/v1`; the proxy forwards every request to OpenRouter (or
any other OpenAI-compatible provider) using the key from `proxy.config.json`.
The app never sees the provider URL or the provider API key.

- Zero dependencies (Node.js 20+)
- Streaming SSE, tools, vision, embeddings, and anything else the provider supports
- GitHub Copilot compatibility for both Chat Completions and Responses API streams
- Config is read from the **current folder**, so every project can have its own
- Optional fixed model override in the config; otherwise the app's model is used
- If `proxy.config.json` is missing, the CLI asks whether to create a starter file
- Optional local client API key and CORS support
- Runs anywhere with `npx`; no global install needed

## Quick start

Run this in the folder where you want the config to live:

```bash
npx openai-proxy
```

> If you have not published this package yet, use the source install below, or
> run `npx --yes /absolute/path/to/openai-proxy`.

On the first run there is no config, so you will see:

```text
No proxy.config.json found in:
  /path/to/your/project

Create a starter proxy.config.json in this folder? [Y/n]
```

Answer `Y`, then open `proxy.config.json` and set `upstream.apiKey`:

```json
{
  "port": 1234,
  "host": "127.0.0.1",
  "model": null,
  "upstream": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKey": "sk-or-v1-your-real-key",
    "apiKeyEnv": null,
    "headers": {
      "HTTP-Referer": "http://localhost:1234",
      "X-Title": "openai-proxy"
    }
  },
  "clientApiKey": null,
  "requestTimeoutMs": 300000,
  "maxBodyBytes": 52428800,
  "log": true
}
```

Run the command again:

```bash
npx openai-proxy
```

```text
openai-proxy 0.1.1 is running.

  OpenAI base URL : http://127.0.0.1:1234/v1
  API key         : any value (no client key required)
  Config file     : /path/to/your/project/proxy.config.json
  Upstream        : openrouter.ai
  Model           : from request
  Logging         : on

Point your LLM app at the base URL above. Press Ctrl+C to stop.
```

Point your app at the local URL:

```bash
OPENAI_BASE_URL=http://127.0.0.1:1234/v1
OPENAI_API_KEY=local
```

Python:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:1234/v1",
    api_key="local",  # the proxy ignores it unless clientApiKey is set
)

print(client.chat.completions.create(
    model="openai/gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello!"}],
).choices[0].message.content)
```

JavaScript:

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:1234/v1",
  apiKey: "local",
});
```

curl:

```bash
curl http://127.0.0.1:1234/v1/chat/completions \
  -H "Authorization: Bearer local" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

## How paths are forwarded

The incoming path is translated to the configured `upstream.baseUrl`:

| App requests | Provider receives |
| --- | --- |
| `/v1/chat/completions` | `https://openrouter.ai/api/v1/chat/completions` |
| `/v1/models` | `https://openrouter.ai/api/v1/models` |
| `/chat/completions` | `https://openrouter.ai/api/v1/chat/completions` |

Any method and body are forwarded unchanged, and the response is streamed back
as it arrives. The client's `Authorization`, `x-api-key`, and `api-key` headers
are removed and replaced with the provider key from the config. Provider
compression headers are handled by the proxy, so clients always receive a
readable, uncompressed response.

Local-only endpoints:

- `GET /` — basic service info
- `GET /health` — health check
- `OPTIONS *` — CORS preflight

## Model selection

By default `"model": null`, so the proxy forwards whatever model the app puts in
the request body. For example, a request with `"model": "openai/gpt-4o-mini"`
uses that OpenRouter model.

To force one model for every app, set it in the config:

```json
{
  "model": "openai/gpt-4o-mini"
}
```

With this set, the proxy rewrites the `model` field in JSON API requests to
`openai/gpt-4o-mini`, ignoring the model sent by the app. Requests without a
model on endpoints such as `/v1/chat/completions`, `/v1/responses`, or
`/v1/embeddings` receive the configured model as well. Use `null` or omit the
field to use the model from each request.

The startup banner shows which mode is active:

```text
  Model           : openai/gpt-4o-mini (from config)
  Model           : from request
```

## Using with GitHub Copilot

Use the proxy as a Custom Endpoint / OpenAI-compatible provider:

```text
Base URL:   http://127.0.0.1:1234/v1
API key:    any value (or your clientApiKey)
API format: Chat Completions (recommended) or Responses
```

Keep the base URL at `/v1` for normal Copilot use. Recent Copilot versions
only switch to the Responses API when the custom model URL itself contains
`/responses`, and Chat Completions is the most reliable path through a
stateless provider like OpenRouter.

Responses API requests also work. The proxy adapts OpenRouter's Responses
stream to the canonical OpenAI event names that Copilot expects:

- `response.content_part.delta` becomes `response.output_text.delta`
- `response.done` becomes `response.completed`, with the usage detail objects
  Copilot reads
- the terminal `data: [DONE]` sentinel is removed

VS Code Copilot's Responses parser treats every SSE data line as JSON, so
without that last adaptation it reports:

```text
Unexpected token 'D', "[DONE]" is not valid JSON
```

when it sees the sentinel after the response has already completed. Dropping it
is safe because the stream ends after `response.completed` and the upstream
connection closes. Chat Completions streams still receive their normal
`data: [DONE]` terminator.

If you still see that error, check that the custom model URL does not include
`/responses`, or set the model's API format in Copilot to **Chat Completions**.

## Configuration reference

| Field | Default | Description |
| --- | --- | --- |
| `port` | `1234` | Local HTTP port. Can be overridden with `--port`. |
| `host` | `127.0.0.1` | Listen address. Keep it on localhost unless you know what you are doing. |
| `model` | `null` | Optional model override. When set, requests use this OpenRouter model instead of the model sent by the app. When `null`, the app's model is forwarded unchanged. |
| `upstream.baseUrl` | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL, normally ending in `/v1`. |
| `upstream.apiKey` | — | Provider API key. Required unless `apiKeyEnv` is used. |
| `upstream.apiKeyEnv` | `null` | Name of an environment variable that contains the provider key. |
| `upstream.headers` | `{}` | Extra headers sent to the provider (for example OpenRouter's `HTTP-Referer` and `X-Title`). A header set to `null` is skipped. |
| `clientApiKey` | `null` | If set, apps must send this key as `Authorization: Bearer <key>` (or `x-api-key`). |
| `requestTimeoutMs` | `300000` | Time to wait for the provider to start responding. |
| `maxBodyBytes` | `52428800` (50 MiB) | Maximum accepted request body size. |
| `log` | `true` | Log method, path, status, and duration for each request. |

### Keeping the key out of the file

`upstream.apiKey` and header values support `${ENV_VAR}` expansion:

```json
{
  "upstream": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKey": "${OPENROUTER_API_KEY}"
  }
}
```

Or use the dedicated environment option:

```json
{
  "upstream": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKey": "",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  }
}
```

Then start the proxy from a shell where the variable is set:

```bash
set OPENROUTER_API_KEY=sk-or-v1-...        # Windows PowerShell: $env:OPENROUTER_API_KEY="..."
npx openai-proxy
```

### Protecting the local port

By default any local app can use the proxy without a key, which is convenient.
If other users or untrusted software can reach the port, set:

```json
{
  "clientApiKey": "my-local-secret"
}
```

Apps then use `api_key = "my-local-secret"`. Requests with a wrong key get an
OpenAI-style `401 invalid_api_key` response. The provider key is still never
sent to clients.

## CLI options

```text
-c, --config <path>  Config file to use (default: ./proxy.config.json)
-p, --port <port>    Override the port from the config
    --host <host>    Override the listen address
-y, --yes            Create the config without asking if it is missing
    --no-log         Disable request logging
    --log            Enable request logging
-h, --help           Show help
-v, --version        Show the version
```

Examples:

```bash
npx openai-proxy --port 4321
npx openai-proxy --config ./configs/work.json
npx openai-proxy --yes            # non-interactive config creation
```

## Using a different provider

Any provider with an OpenAI-compatible API works. Change `upstream.baseUrl`,
for example:

```json
{
  "upstream": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-..."
  }
}
```

or use a local model server:

```json
{
  "upstream": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "apiKey": "ollama"
  }
}
```

## Install from source

```bash
git clone <your-repo-url> openai-proxy
cd openai-proxy
npm link          # makes the `openai-proxy` command available
```

Then, from any project folder:

```bash
openai-proxy
```

Without linking, you can also run it directly from the package folder:

```bash
npx --yes /absolute/path/to/openai-proxy
```

To make the `npx openai-proxy` command work for everyone, publish it:

```bash
npm publish
```

## Security notes

- `proxy.config.json` contains a secret. It is listed in `.gitignore`; keep it
  that way and do not commit it.
- The default `host` is `127.0.0.1`, so the server is only reachable locally.
  Setting `host` to `0.0.0.0` exposes the proxy to your network; use
  `clientApiKey` if you do that.
- The proxy does not log API keys or request bodies by default. Provider errors
  are returned to the client, so a provider may mention its own name in an error
  message.
- This is a convenience proxy for your own machine, not a hardened multi-tenant
  gateway.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `No proxy.config.json found` | Run in the folder that has the config, or use `--config`. |
| `"upstream.apiKey" ... is empty` | Fill in the key or set `upstream.apiKeyEnv`. |
| `Port 1234 is already in use` | Stop the other process or run with `--port 4321`. |
| `401 invalid_api_key` from the proxy | The app's key does not match `clientApiKey`. |
| `401`/`402`/`429` from the provider | Passed through from the provider: check the provider key, credits, or rate limits. |
| `502 upstream_unavailable` | The provider could not be reached; check `upstream.baseUrl` and your network. |
| `504 timeout` | The provider did not respond in `requestTimeoutMs`. |
| Copilot shows `Unexpected token 'D', "[DONE]" is not valid JSON` | Update this proxy (it strips the Responses `[DONE]` sentinel), or set Copilot's API format to Chat Completions. |

## Development

```bash
npm test
npm start -- --port 4321
```

## License

MIT
