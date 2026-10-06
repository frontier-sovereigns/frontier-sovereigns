# Contributing

Use Node.js 22.23.2 and pnpm 10.30.3 through Corepack:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm dev
```

Open http://127.0.0.1:5173. See [getting started](docs/GETTING_STARTED.md) for host access.

## Source layout

| Area | Location |
| --- | --- |
| Browser UI and Babylon.js rendering | `apps/client/src/` |
| Sessions, endpoint transport, scheduling and persistence | `apps/server/src/` |
| Simulation, navigation, economy, combat and tactical AI | `packages/simulation/src/` |
| Shared types, content and validation | `packages/shared/` |
| Gameplay values and asset requirements | `data/` |
| Canonical commands and model plans | `schemas/` |
| Procedural asset generators | `packages/assets/src/` |
| Cross-package and browser tests | `tests/` |

Keep rule state independent of rendering and sockets. Model calls belong in the asynchronous server scheduler, never in a simulation tick. Commands must retain schema, ownership, visibility, cost, prerequisite, epoch and duplicate checks. Browsers and models must not receive another faction's private state.

Edit balance data instead of duplicating prices or stats in UI code. New content may also require strict types, schemas, asset generators and focused tests. See [modding](docs/MODDING.md) and the [commander API](docs/AI_COMMANDER_API.md).

## Validation and review

```sh
corepack pnpm content:validate
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm test:e2e
```

`lint` currently runs TypeScript checking; there is no separate formatter or style-lint command. Match surrounding code and keep changes focused. Run relevant asset, browser, load or model checks for those changes; [testing](docs/TESTING.md) explains their scope.

A pull request should describe the problem, resulting behavior, tests actually run and remaining limitations. Bug reports should include reproduction steps, runtime/browser versions, map/player settings and sanitized error codes. Distinguish mock-only model results from real endpoint results.

Never commit keys, bootstrap tokens, cookies, `.env`, private saves/transcripts, installed dependencies or build output. Third-party code and assets need documented origins, redistribution terms and required attribution. Review [asset licensing](assets/LICENSE.md) before adding artwork or audio. Use [SECURITY.md](SECURITY.md) for sensitive reports.
