# Modding and extension

Frontier Sovereigns is modified through its source and static content. There is no general runtime mod loader or browser-side rule override.

## Balance and content

`data/balance.v1.json` supplies the base rules and Ages I–IV. `data/balance.legendary-ages.v1.json` adds Ages V–VIII. `packages/shared/src/content.ts` resolves the continuous current game and computes content identity.

For numerical changes, edit data and run:

```sh
corepack pnpm content:validate
corepack pnpm test
corepack pnpm build
```

The validator checks strict shapes, IDs, prerequisites and reachable content dependencies. Adding a unit, building or technology also requires updating the closed TypeScript unions/content schema, command and AI enums where relevant, producers, assets and tests. See `packages/shared/src/types.ts`, `content-schema.ts` and `schemas/`.

## Rules and presentation

Put authoritative economy, construction, movement, combat or visibility changes in `packages/simulation/src/`. Preserve deterministic ordering, save/replay behavior and filtered recipient views. Add tests that exercise legal and illegal commands, rather than only testing a helper in isolation.

React controls and Babylon.js rendering belong in `apps/client/src/`. The UI should explain authoritative requirements and display receipts; it must not independently authorize costs or damage. Keep sensitive enemy fields out of shared view types.

Maps are generated under `packages/simulation/src/map*.ts` and associated resource/connectivity modules. Validate spawn space, reachable resources, large building sites and wall/gate navigation across seeds and rosters after changing them.

## Assets

`data/asset-requirements.json` declares required geometry, states, animations and UI/audio inventory. Generators are in `packages/assets/src/`.

```sh
corepack pnpm assets:build
corepack pnpm build
```

Inspect `/asset-gallery` and actual gameplay, including selection, damage, ages, gates, deployment and quality presets. A manifest or checksum pass does not establish visual quality. Generated output is rebuilt rather than treated as source. Resolve redistribution rights using [asset licensing](../assets/LICENSE.md) before publishing new material.

## Commands and AI

Update canonical JSON schemas and shared contracts together, then regenerate validators with `corepack pnpm protocol:build`. Add admission, secrecy, persistence and client compatibility coverage.

Model transports and provider profiles belong on the server; [AI commander API](AI_COMMANDER_API.md) lists the implementation points. Keep ordinary tactical fallback available when a model fails.

Content and engine changes can alter save/replay identity. Keep a previous matching build for existing saves, and do not claim automatic migration unless an explicit tested migration exists.
