# Browser/server protocol

The current browser protocol version is **2**. The AI plan schema independently remains version **1**. Authoritative contracts are [shared types](../packages/shared/src/types.ts), [validation](../packages/shared/src/validation.ts) and [client-command.schema.json](../schemas/client-command.schema.json).

## Sessions

`GET /api/session` returns the protocol/content identity, lobby and current session information, including a CSRF token when authenticated. The server uses an HttpOnly, SameSite=Strict `fs_session` cookie; HTTPS-origin sessions receive a Secure cookie.

`POST /api/bootstrap` accepts a one-use token only from a direct loopback connection with a loopback origin. `POST /api/join` accepts a name and lobby invitation, or the optional host-player request for an authenticated host. Mutating requests require an allowed Origin and, when a session exists, its `x-csrf-token`.

The server exposes host-only routes for lobby configuration, endpoint/catalog management, diagnostics, saves, replay and pause. Player routes include readiness, chat/pings/cooperation, reconnection and AI Pilot. These routes have individual strict validators; inspect `server.ts` and shared contracts when writing a client rather than treating this overview as a complete OpenAPI specification.

## WebSocket lifecycle

Connect to `/ws` using the session cookie and allowed page Origin. The delivered client opts into chunked deltas with `/ws?deltaChunks=1`. Binary messages are rejected; incoming JSON frames are bounded to 16 KiB. The server rate-limits requests.

After matching content loads, send:

```json
{
  "type": "loaded",
  "contentHash": "current-content-hash",
  "matchId": "current-match-id",
  "matchEpoch": 1
}
```

Use the actual identifiers from the received state. To request a fresh authorized view, send `{"type":"resync"}`.

## Gameplay commands

A command envelope contains no caller-selected player identity:

```json
{
  "protocolVersion": 2,
  "matchId": "current-match-id",
  "matchEpoch": 1,
  "clientCommandId": "command-1",
  "clientSequence": 1,
  "command": {
    "kind": "move",
    "unitIds": ["owned-unit-id"],
    "target": { "xMm": 20000, "zMm": 24000 },
    "queued": false
  }
}
```

Replace identifiers and coordinates with valid values from the current view. Positions are integer millimetres on X/Z; building origins use grid cells. The canonical schema enumerates all command variants and bounds.

`command_received` acknowledges transport/admission progress, not successful execution. A `receipt` contains accepted/rejected status, command ID, simulation tick, sequence and an optional fixed rejection code or missing-resource information.

Keep command IDs and sequences stable when retrying an uncertain submission. The authoritative deduplication path prevents a repeated paid command from charging again. New commands must use the correct current match and epoch. Pause/load transitions can invalidate old requests; do not replay old-epoch commands as new work.

## Snapshots and deltas

The server sends `snapshot`, `delta`, `snapshot_chunk` or `delta_chunk`, plus lobby, receipt, error and communication messages.

A `PlayerViewDelta` names its `baseSequence`, creates/updates, conceals/removals and fog differences. Apply it only against the matching completed base. Chunked messages carry a transfer ID, identity, sequence, index/count, byte length and SHA-256; delta chunks also name their base sequence. Validate and assemble the complete bounded transfer before replacing state. Use the shared view-stream implementation rather than exposing partial assemblies.

Views are filtered for the recipient before encoding. Enemy private orders, queues, cargo and undisclosed entities are not normal client fields. Remembered objects can be marked as ghosts with last-seen ticks. Movement/visual traces describe only authorized past samples; clients must not infer hidden paths from them.

Schemas validate structure; the simulation independently validates ownership, fog, resources, prerequisites, placement, timing and duplicates. Neither schema validity nor a client-side prediction authorizes a world mutation.
