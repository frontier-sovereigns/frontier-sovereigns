# Getting started

Use **Node.js 22.23.2**, Corepack and **pnpm 10.30.3**, as pinned in `.node-version` and `package.json`. Play requires a desktop WebGL2 browser, mouse and keyboard; the server needs no display or GPU.

From the repository root:

```sh
node --version
corepack pnpm --version
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start
```

If Corepack is unavailable, install/enable it for your Node installation. On Windows, `corepack pnpm` avoids relying on a PowerShell pnpm shim.

The build generates validators and assets, validates content, checks TypeScript, bundles the server and builds the browser. `start` serves the client and API on port 3000 without Vite. With no `.env`, access is loopback-only and no model is configured.

## First match

1. Open **http://127.0.0.1:3000** on the server computer.
2. Enter the terminal's bootstrap token in **Host access**. Background/redirected starts write it to `runtime-data/host-bootstrap.txt`; keep it private. It expires after ten minutes.
3. Join the optional host-player slot. The host may also manage the lobby without playing.
4. Choose **Guided quiet practice**, or configure AI factions, teams, map and maximum age.
5. Mark humans ready and start. Practice lessons follow actual selection, gathering, construction, training, defenses, advancement and combat.

Host access appears only on a loopback page. A LAN-address visit shows player Join/Rejoin, including on the host computer. See [self-hosting](SELF_HOSTING.md) to invite other computers.

Models are optional. Ordinary AI factions use rule fallback when no endpoint is available. Practice uses a defensive opponent without strategic model requests.

## Development

After the first build:

```sh
corepack pnpm dev
```

Open http://127.0.0.1:5173. Vite proxies to `GAME_PORT` (3000 by default). The launcher reads `.env` for both processes and sets development mode. Stop it with Ctrl+C before starting another server on the same port.

## Troubleshooting

| Problem | Action |
| --- | --- |
| Port already in use | Stop your own previous host or select another `GAME_PORT`. |
| Incomplete/corrupt assets | Rerun `corepack pnpm build`; inspect the first build error. |
| Host access missing | Use the loopback URL on the host computer. |
| Bootstrap expired | Restart your host and use the newly written token. |
| Graphics unsupported | Follow the capability message and use an accelerated WebGL2 browser. |
| Old save rejected | Use its matching engine/content/runtime build; saves are not silently migrated. |

See [gameplay](GAMEPLAY.md) for controls and [testing](TESTING.md) for checks.
