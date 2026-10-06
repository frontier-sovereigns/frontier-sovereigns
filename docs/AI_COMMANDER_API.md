# AI commander API

The current integration asks an OpenAI-compatible **Chat Completions** endpoint for strategic JSON plans. It is an outbound server integration, not a public API that grants a model direct access to the simulation.

## Invocation and request

`apps/server/src/ai-model-scheduler.ts` routes each commander to its configured catalog model. `ai-scheduler.ts` schedules asynchronous requests with bounded concurrency, timeouts, cancellation, retries and adaptive backoff. Difficulty-specific intervals are configurable; they are scheduling inputs rather than guaranteed wall-clock request periods.

The simulation prepares an `AiDispatch` through the bridge. The exact request-side TypeScript interfaces are in [ai-observation.ts](../packages/simulation/src/ai-observation.ts): `AiRequestBinding`, `AiObservation`, `AiReferenceRegistry` and `AiDispatch`. There is no separate observation JSON Schema file. The canonical output schema is [ai-plan.schema.json](../schemas/ai-plan.schema.json).

`EndpointClient` sends `POST <baseUrl>/chat/completions` with:

```text
model: the configured model ID
messages:
  system: runtime strategic instructions and output constraints
  user: JSON.stringify(the bounded AiObservation)
stream: false
temperature: configured value
max_tokens: configured output budget
response_format: negotiated structured-output mode, when supported
```

The observation includes:

| Field | Meaning |
| --- | --- |
| `identity` | Match, epoch, player, request, observation, observed tick and controller generation |
| `player`, `objective` | Commander identity/policy and conquest objective |
| `economy`, `army`, `buildings`, `production` | Own resources, population, observed counts and paid work |
| `legalTechnologies`, `development`, `lateGame` | Current progression choices, prerequisites and later-age constraints |
| `references` | Allowed aliases for bases, squads, allies, resources, remembered enemies, frontiers and pings |
| `enemies`, `resources`, `emergencies`, `defense` | Bounded visible or remembered facts with observation timestamps |
| `goals`, `previousReceipts` | Accepted, pending, fulfilled, blocked, rejected or expired intentions and action feedback |
| `memory`, `requests` | Bounded provenance-aware memory and selected allied requests |

Only the recipient's authorized view is used. Enemy memories may be stale. A human message or ping is marked unverified and does not reveal hidden entities. References resolve through an immutable per-request registry; do not invent entity IDs or aliases. Own-base aliases are generated, while the main army alias is `army-main`.

Prompt construction may remove older or lower-priority detail to fit the input budget. Omission is not evidence that a goal or entity ceased to exist. Provider token counting is used where available; the fallback is an explicit UTF-8 estimate with a separate byte ceiling.

## Response

Return a single JSON object as the completion's string `choices[0].message.content`. Tool calls, refusals, truncated output, Markdown fences and non-JSON commentary are not accepted. The HTTP response must contain exactly one choice.

Example plan content:

```json
{
  "schemaVersion": 1,
  "observationId": "obs-example",
  "strategy": "Grow food and reinforce defense",
  "goals": [
    {
      "kind": "economy",
      "weights": { "food": 40, "wood": 30, "gold": 20, "stone": 10 },
      "targetVillagers": 36
    },
    { "kind": "ensure_units", "unitType": "spearman", "targetCount": 12 }
  ],
  "message": null
}
```

Replace `obs-example` with the exact current `identity.observationId`. All five top-level fields are required. `schemaVersion` is 1, `strategy` is 1–160 characters, `goals` has at most eight items, and additional properties are forbidden. Economy weights are integer percentages that must total 100. A non-null `message` contains an allowed allied `recipientRef` and `text` of at most 240 characters.

| Goal kind | Required fields after `kind` |
| --- | --- |
| `economy` | `weights`, `targetVillagers` (6–150) |
| `ensure_building` | `buildingType`, `targetCount` (1–80), `anchorRef` |
| `ensure_units` | `unitType`, `targetCount` (0–200) |
| `research` | `technologyId` |
| `advance_age` | `targetAge` (2–8, within match cap) |
| `develop` | `targetAge`, `anchorRef` |
| `army_order` | `squadRef`, `order`, `targetRef` |
| `scout` | `zoneRef` |
| `fortify` | `anchorRef`, `material`, `radiusM` (18–60) |
| `tribute` | `allyRef`, `resource`, `amount` (1–1000) |

Army orders are `defend`, `attack`, `raid`, `assist`, `retreat` and `rally`. Fortification materials are `palisade`, `stone`, `bastion`, `runestone`, `titan` and `eternal`, subject to age and match content. The schema enumerates valid unit/building/technology IDs; do not derive them from display names.

`develop` pursues paid prerequisites, infrastructure and upgrades toward its target age. `fortify` requests connected defenses while preserving usable routes. Both require a valid own-base reference. If no Town Center survives, the observation can provide `recovery-site` for a replacement `ensure_building` goal.

## Validation and execution

The server first validates JSON shape and semantic constraints. The simulation then checks the full active request binding, observation age, controller generation, content cap, allowed references and allied relationships. A stale response is rejected. Structurally valid plans can be partially accepted when individual goals have invalid references or incompatible content; rejected-goal feedback is included in later observations.

Accepted goals expire. The executor uses ordinary game commands, so resources, ownership, visibility, population, queue space, placement, navigation and prerequisites remain authoritative checks. An accepted intention is not proof that construction, an attack or tribute completed.

A missing/failed endpoint cannot block the simulation tick. Rule fallback continues; a failed renewal may leave the previous valid plan active until its original expiry. Feedback distinguishes planned, completed, blocked, declined and expired cooperation. AI Pilot adds human holds and resource reserves to the same execution boundary.

## Implementing another adapter

For an existing OpenAI-compatible service, configure a base URL/model in [model integration](MODEL_INTEGRATION.md); no code change is needed.

For a new provider profile, extend:

1. `apps/server/src/ai-endpoint.ts`: URL construction, provider option allowlist, response-format negotiation and response parsing.
2. Shared `EndpointSettings` types and validation in `packages/shared/`, plus host controls in `apps/client/src/EndpointPanel.tsx`.
3. Endpoint, scheduler, catalog and model-assistant tests.

For a non-compatible provider, supply a server-side translation to the same completion contract or adapt `EndpointClient` and its scheduler construction. `EndpointConfigSource` provides private settings/key snapshots and sanitized host state; it is not a client credential API. Keep deadlines, response-size bounds, redirect rejection, cancellation, fixed diagnostic codes and server-side secret handling.

Do not bypass `buildAiObservation`, `installAiPlan` or ordinary command admission. Test invalid schemas, stale bindings, wrong aliases, unauthorized visibility, slow/outage recovery and concurrent independent commanders before a real endpoint smoke.
