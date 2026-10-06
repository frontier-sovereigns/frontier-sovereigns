# Model integration

Models are optional. The server can play with rule-based AI alone. Configuring a model adds strategic planning; tactical movement, gathering, combat and command validation remain in the game.

## Configure an endpoint

On the host computer, sign in through **Host access** and open **AI endpoint & diagnostics** in the lobby or while paused.

1. Add a catalog entry with a label, base URL including its API prefix, exact served model ID and provider profile.
2. Enter an API key only if your provider requires one.
3. Test the entry and inspect its structured-output status.
4. Assign the model to an AI faction, or select it from a human player's **AI Pilot** panel.

Supported provider profiles are `generic_openai_compatible`, `llama_cpp` and `vllm`. The catalog supports up to sixteen entries including the reserved **Host model**. Different commanders may share a model, but keep separate observations, memory and requests.

The base URL is resolved by the server. For example, `http://127.0.0.1:8080/v1` means a service on the game host, not on a joining player's computer. The game does not install, start or reconfigure a model service.

## Optional environment defaults

Copy the sanitized `.env.example` to a local `.env`, then configure your own endpoint:

```dotenv
AI_BASE_URL=http://127.0.0.1:8080/v1
AI_MODEL=replace-with-your-served-model-id
AI_API_KEY=
AI_PROVIDER_PROFILE=generic_openai_compatible
AI_MAX_CONCURRENT=5
AI_TIMEOUT_SECONDS=45
AI_INPUT_TOKEN_BUDGET=2500
AI_MAX_OUTPUT_TOKENS=512
AI_SEND_HUMAN_CHAT=false
```

Replace the example model ID. No key is required for a service that does not authenticate. Leave the base URL and model empty to keep models unconfigured.

Local host-model settings in `GAME_DATA_DIR/endpoint.local.json` take precedence over environment defaults. Additional entries live in `ai-models.local.json`. The host UI shows whether a key exists but never returns its value. Protect these files and `.env`; neither belongs in source control or portable saves.

Additional settings include `AI_INTERVAL_EASY_SECONDS`, `AI_INTERVAL_MEDIUM_SECONDS`, `AI_INTERVAL_HARD_SECONDS`, `AI_MAX_ADAPTIVE_INTERVAL_SECONDS`, `AI_TEMPERATURE` and `AI_PROVIDER_OPTIONS_JSON`. Provider-specific options pass a strict allowlist; arbitrary request fields cannot be forwarded.

## Structured output

The probe attempts schema-constrained output, then JSON-object mode when the provider explicitly rejects the preceding format. If both are explicitly unsupported, it can use `prompt_json`: ordinary prompted JSON with full host validation. This mode does not guarantee constrained decoding.

Responses must contain one complete plan in `choices[0].message.content`. The server rejects invalid JSON, extra fields, tool calls, truncated output and stale request bindings. See [AI commander API](AI_COMMANDER_API.md) for the full plan contract and extension points.

Only authorized summaries and selected allied requests are sent. `AI_SEND_HUMAN_CHAT=false` disables forwarding free-form human chat while retaining typed cooperation presets. Consider the model provider's data handling when enabling chat forwarding.

## Diagnostics and smoke test

```sh
corepack pnpm test:model
```

This explicitly contacts the configured **Host model**, probes output format and exercises five independent commander contexts. It can incur your provider's usage charges. It does not exercise every catalog entry. With no endpoint configured it exits with `REAL_ENDPOINT_NOT_CONFIGURED`; mock tests cannot establish real-provider compatibility.

| Status | Check |
| --- | --- |
| `CONNECTION_FAILED` | Host reachability, service listener and base URL |
| `MODEL_OR_ROUTE_UNAVAILABLE` | API prefix and exact model ID |
| `UNAUTHORIZED` | Provider key and permissions |
| `REQUEST_UNSUPPORTED` | Provider profile, supported options and output format |
| `TIMEOUT` / `RATE_LIMITED` | Endpoint load, concurrency and timeout settings |
| `OUTPUT_TRUNCATED` / `INVALID_JSON` | Output budget and provider response behavior |
| `AI_PLAN_SCHEMA_INVALID` | Required fields, supported goals and strict schema |
| `AI_PLAN_OBSERVATION_MISMATCH` | Exact observation ID copied from the current request |

Inspect fixed diagnostic codes and timing rather than publishing raw prompts, responses or secrets. Failure/backoff does not stop tactical AI. A successful smoke proves that exchange, not sustained combined game/model capacity.
