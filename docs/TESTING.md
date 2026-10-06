# Testing

Run checks from the repository root with Node.js 22.23.2 and pinned pnpm 10.30.3. Commands here describe available checks, not a claim that every test or environment has passed.

## Install and core checks

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm protocol:build
corepack pnpm content:validate
corepack pnpm assets:build
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

`build` already runs protocol generation, content validation, asset generation and typechecking before server/client bundling. `lint` currently aliases typechecking; no separate formatter is configured.

Vitest discovers tests in `packages/`, `apps/` and `tests/`, excluding browser specs. These include rule/economy/navigation checks, strict protocol and recipient secrecy, worker execution, save/replay integrity, endpoint mocks, model catalog and AI Pilot. For a focused file:

```sh
corepack pnpm exec vitest run tests/save-store.test.ts
```

## Browser checks

Build first, install Google Chrome separately, then run:

```sh
corepack pnpm test:e2e
```

Playwright uses the installed Chrome channel, one worker, a production test host on port **3010**, and isolated `runtime-data/e2e` data. Keep that port free. Failure traces/screenshots go under `test-results`. The configured bootstrap token is test-only and must never be used for a real host.

Hard-coded credentials and private/documentation-range IP addresses in test fixtures are synthetic inputs for authentication, origin and networking checks. They are never deployment settings; do not reuse fixture tokens, keys, cookies or addresses when hosting a game.

To select installed Edge in PowerShell:

```powershell
$env:BROWSER_CHANNEL = 'msedge'
corepack pnpm test:e2e
Remove-Item Env:BROWSER_CHANNEL
```

Gameplay fixtures use software WebGL. Asset profiles can use the browser's native graphics backend; their measurements must be interpreted separately. Passing software rendering does not establish native GPU performance.

```sh
corepack pnpm test:firefox
```

The separate Firefox smoke uses an installed browser and isolated profile. It checks WebGL2 capability, camera input, context recovery and capability messages. It does not cover the full Firefox gameplay suite. To override its default executable, invoke `node scripts/firefox-smoke.mjs --run --firefox=<absolute-browser-path>`. Reports are generated under `runtime-data/e2e`; no browser download is performed by that script.

## Models, AI and progression

| Command | Scope |
| --- | --- |
| `corepack pnpm test:model` | Explicitly configured real Host-model endpoint and five commander contexts |
| `corepack pnpm test:fallback` | Ordinary-start rule AI economy, gathering/depletion/farming and conservation |
| `corepack pnpm test:progression` | Scripted four-age progression through a filtered human view |
| `corepack pnpm test:ai-regression -- --ticks=36000 --seeds=66,137 --suite=all` | Difficulty/personality comparisons without model inference |
| `corepack pnpm test:playthrough:rehearsal:production -- --ticks=72000 --seed=37 --population=120 --map=open_frontier` | Compiled ordinary-resource scripted policies without live networking |

The real-model command needs an operator-configured endpoint and may consume provider usage. It clearly fails when unconfigured. Never treat mocked completions as real-model compatibility. The four-age progression harness alone does not establish complete eight-age playability.

The compiled rehearsal requires a fresh build. Its unfinished matches are censored and unmet goals return a nonzero result. It does not qualify networking, persistence, models or production timing. Source and compiled AI-regression variants are available as separate package scripts.

## Load and networking

```sh
corepack pnpm test:load
corepack pnpm test:load:production
corepack pnpm test:network-load:production -- --seconds=60 --drop=.01 --latency-ms=75 --jitter-ms=10 --seed=37
```

Compiled commands require a fresh build. Reports identify source versus compiled execution and actual workload. [Performance](PERFORMANCE.md) explains larger fixtures and why a short smoke does not establish maximum capacity.

A network runner can use `--endpoint=none|mock|real`, profiles `starting|capacity|playthrough` and populations 120/200. Real endpoint mode uses only your explicit configuration and an owned proxy for outage testing; it does not change the model service. Application-frame loss/delay is not real TCP packet loss.

## Packaging and startup

```sh
node scripts/release-smoke.mjs --plan
corepack pnpm test:release
```

The release smoke uses an explicit source allowlist in an isolated temporary directory, an offline frozen-lock install, fresh build, production startup and asset/integrity checks. Populate the pinned Corepack/pnpm caches with a successful installation first. `release:prepare` prepares a local package; it does not publish one.

For a manual host smoke, follow [self-hosting](SELF_HOSTING.md): open the built game, authenticate locally, join, gather, build, train, save, pause/resume and restore with new invitations.

Keep generated results, logs, private configuration and screenshots containing secrets out of commits. A failure report should name the command, runtime/browser, relevant settings, fixed error code and whether the failure blocks the behavior being tested.
