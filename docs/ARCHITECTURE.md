# Architecture

One Node.js process hosts the HTTP/WebSocket gateway, model schedulers and worker coordination. A simulation worker owns authoritative mutable game state. Each browser independently renders its authorized view with React, Vite and Babylon.js.

## Source map

| Path | Responsibility |
| --- | --- |
| `apps/client/src/World.ts`, `AssetRenderer.ts` | 3D world, input and generated asset presentation |
| `apps/client/src/useGame.ts`, `ViewStream.ts` | Session lifecycle and received state |
| `apps/server/src/server.ts`, `index.ts` | Fastify API, sessions, WebSockets and startup |
| `apps/server/src/bridge.ts`, `worker.ts` | Gateway-to-simulation messages and worker ownership |
| `packages/simulation/src/` | Deterministic game rules, navigation, visibility and AI execution |
| `packages/shared/src/`, `schemas/` | Shared contracts, content and strict validation |
| `apps/server/src/ai-endpoint.ts`, `ai-model-scheduler.ts`, `ai-scheduler.ts` | Model transport, catalog scheduling and asynchronous requests |
| `apps/server/src/save-store.ts`, `replay-store.ts` | Validated local persistence |
| `packages/assets/src/` | Procedural geometry, animation, icons and audio |

## Commands and views

A browser sends an intent using the versioned command envelope. Session identity determines the player; the request cannot choose another player. The gateway validates message shape and passes it to the simulation. Admission checks match identity, epoch, sequence, duplicates, ownership, current knowledge, resources, prerequisites and action legality before mutation.

The simulation produces a separate view for each recipient. Hidden enemies and private enemy orders, queues and resources are filtered before transport. Snapshots, deltas and chunked transfers carry authorized state, rather than a full world with a browser-only fog overlay. The client interpolates committed positions and authorized motion/visual traces; it does not decide damage or costs.

Persistent path workers compute navigation work; optional visibility workers and a publication worker support view production. The coordinator remains responsible for committing state and rejecting stale work. Worker settings alter execution placement rather than game rules. See [performance](PERFORMANCE.md).

The default authoritative frame spans 300 ms of game time. Adaptive pacing can use 450/600 ms frames and reduce wall-clock speed under overload. Contact, economy and combat retain their finer timing rules; changing the visible frame cadence is not a change to unit statistics.

## AI boundary

Strategic requests are prepared from the same filtered player view used by ordinary controllers. Each commander has its own observation, reference registry, memory and request binding. The gateway performs model HTTP calls asynchronously. Returned JSON is validated before the simulation installs goals; tactical controllers convert goals into ordinary validated commands.

Rule-based behavior continues during missing, failed or slow requests. A failed renewal can retain a still-valid prior plan until its original expiry. Difficulty changes policy, not fog access or resource/HP multipliers. [AI commander API](AI_COMMANDER_API.md) documents the actual contract.

AI Pilot uses the human faction's controller context while preserving human ownership, manual-order protections and configured resource reserves. It is not another faction or an unrestricted remote-control endpoint.

## Persistence and identity

`GAME_DATA_DIR` defaults to `runtime-data`. Local files contain saves, recordings, endpoint settings and the model catalog; no external database is required. Endpoint credentials are excluded from portable saves and recordings.

Save/load validation checks format, content, engine and runtime identity. A restored match receives a new epoch and requires fresh human-slot invitations. Recording playback uses the corresponding game implementation and checks recorded state; cross-version exact playback is unsupported. Retain a matching build for saved games. A private or differently built installation is not assumed compatible.

Unit and integration tests live beside packages and under `tests/`; Playwright exercises the built server/browser. [Testing](TESTING.md) describes commands and their limits.
