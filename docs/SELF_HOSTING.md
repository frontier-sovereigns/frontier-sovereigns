# Self-hosting

The delivered source contains the browser client, authoritative server, simulation, AI integration and asset generators. It needs no hosted project service or external database. Models are optional and supplied by the operator.

## Build and run

Install Node.js **22.23.2** with Corepack. Run from the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start
```

Keep the working directory at the repository root so relative asset and data paths resolve. The server serves built browser files and the API together; a separate Vite process is unnecessary.

For explicit local configuration, create a private `.env`:

```dotenv
NODE_ENV=production
GAME_BIND=127.0.0.1
GAME_PORT=3000
GAME_LAN_MODE=false
GAME_DATA_DIR=./runtime-data
```

All these variables have defaults. `start` reads `.env` if present. Keep `HOST_ADMIN_BOOTSTRAP_TOKEN` empty for a fresh random one-use token at each startup. Open http://127.0.0.1:3000 and enter the terminal token in Host access within ten minutes. Background starts write it to `GAME_DATA_DIR/host-bootstrap.txt` without printing it into redirected logs.

Check `http://127.0.0.1:3000/api/health`, then join a practice match, gather, construct, train, save, pause and resume. A health response alone does not test gameplay.

## LAN

Change the local environment to:

```dotenv
NODE_ENV=production
GAME_BIND=0.0.0.0
GAME_LAN_MODE=true
GAME_PORT=3000
GAME_DATA_DIR=./runtime-data
```

Restart your game process and give players the displayed LAN address plus the lobby invitation code. Administer through the direct loopback page on the host. A LAN-address page presents the player Join/Rejoin flow even on that computer.

Allow the chosen port through the host's private-network firewall if necessary. The application does not change firewall, router, tunnel or model-service settings. Binding to all interfaces alone does not establish Internet reachability. No port beyond the game port needs to be exposed to players; model HTTP calls originate from the server.

## Existing TLS reverse proxy

Public hosting has not been fully qualified. An operator-managed TLS proxy can forward game HTTP and WebSocket upgrades to the game port. Set `GAME_PUBLIC_ORIGIN` to the exact external origin, for example `https://game.example.com`. `GAME_ALLOWED_ORIGINS` accepts additional comma-separated exact origins. HTTPS-origin sessions receive Secure cookies.

**Deny `/api/bootstrap` and every `/api/host/` route at the public proxy.** Administer through direct loopback. A local proxy can make remote connections appear local to the server; the bootstrap token remains necessary, but the direct-network locality check cannot distinguish the remote source in this arrangement. Forwarding headers are not authentication, and the server does not enable `trustProxy`.

Proxy users also share IP-based rate-limit buckets. Test ordinary joining, reconnection, WSS, origins, cookies and rate limits with your actual setup. Do not expose model ports or bootstrap files.

## Models

Configure the host catalog through **AI endpoint & diagnostics** while in the lobby or paused, then assign entries to commanders or AI Pilot. See [model integration](MODEL_INTEGRATION.md). A separate model service is optional; fallback AI remains available without it.

## Data, save and restore

`GAME_DATA_DIR` defaults to `runtime-data`. Keep the directory writable by the game process and private to its operator. It contains saves, recordings, local endpoint/catalog credentials and bootstrap material.

Use **Saves and recordings** to create a named save. Autosaves run every sixty simulation seconds and retain the latest five valid autosaves. To restore, pause or use lobby recovery, choose a compatible save, confirm, issue fresh human-slot invitations and resume after rejoining. Rejoin invitations expire after 180 seconds.

Saves are validated against the engine, content and runtime identity. Preserve a matching build for older saves. Exact cross-version playback and silent save migration are unsupported; different source/build identities, including other installations, are not assumed compatible.

Back up the private data directory and your local `.env` securely with the server stopped. Portable game saves omit endpoint credentials, but can still disclose authoritative game state and communications. Do not publish runtime backups.

## Shutdown and updates

Save first, then press Ctrl+C in the game terminal. Closing a browser leaves the host running. For a source update, stop your server, preserve its build/configuration/data, install from the lockfile, rebuild and restart. Refresh every client. Verify save compatibility before depending on an older save.

A port conflict requires choosing another port or stopping your own previous host. If assets fail integrity checks, rebuild from source rather than disabling validation. Repeated overload requires a smaller workload or performance investigation; see [performance](PERFORMANCE.md).

The scripts support source hosting without machine-specific installation paths. Platform/browser support and throughput must be verified on the operator's actual system; these instructions do not assert that every OS/proxy combination has been tested.
