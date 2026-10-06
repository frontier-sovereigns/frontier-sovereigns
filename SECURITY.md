# Security policy

**Private vulnerability reporting contact:** [jim@digitalpeakai.com](mailto:jim@digitalpeakai.com).

Do not disclose sensitive vulnerability details, working attacks, credentials or private player data in public issues before maintainer review. Email affected versions, a minimal reproduction, expected and observed behavior, and impact to the address above. Remove live secrets from reports.

In-scope areas include authentication and host access, API/WebSocket validation, cross-player visibility, command authorization, save/replay parsing, model credential isolation and endpoint responses.

Keep `.env` and `GAME_DATA_DIR` private. Saves and recordings can contain authoritative game state and player communications. Self-host operators also control the computer, proxy and model provider; see [self-hosting](docs/SELF_HOSTING.md) for the administrative boundary and proxy limitations.
