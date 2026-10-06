# Multiplayer

The roster allows **five remote humans**, **one optional host-player** and **up to five AI**: eleven factions. The host can administer without playing. Five-versus-five, six-versus-five, free-for-all and custom teams are available. Roster limits are independent of performance on a particular host.

## Join and start

1. Start the host following [self-hosting](SELF_HOSTING.md).
2. The host signs in at a loopback address, configures map, teams, AI policies/models, population and maximum age.
3. Share the game address and lobby invitation code with players. Never share the host bootstrap token.
4. Each person opens their own browser session, enters a name and code, joins and marks ready.
5. The host starts when the roster is ready. At least two opposing teams are required.

Changing map or team settings clears readiness. Clients load matching content before the countdown. The host's optional player slot is distinct from the five remote slots; rejoining an existing slot does not add another faction.

Open Frontier and River Divide support configurable map sizes. Shared vision is a lobby setting. The full placement seed is host-only. Players exchange chat, team pings and typed cooperation requests; pings do not reveal hidden entities.

## Disconnect and return

Current unit tasks continue when a player disconnects. Optional caretaker control starts after thirty seconds and uses rule-based Medium policy. At 180 seconds the host can keep the slot reserved, surrender it or continue caretaker control. Rejoining ends caretaker authority.

When `pauseWhenNoHumans` is enabled, the server pauses thirty seconds after the last human disconnects. Intentional AI-only matches are exempt. Closing the host browser does not stop the server process.

## Restore a saved match

The host loads a compatible save while paused (or from lobby recovery), confirms replacement and issues a fresh invitation for each saved human slot. Invitations expire after 180 seconds. Previous player credentials cannot reclaim restored slots; the host-player slot also requires host authority.

After restored humans have rejoined, the host resumes. Model credentials remain in the local catalog rather than the portable save; recheck available model assignments when restoring on another installation.

## Network troubleshooting

Clients derive their WebSocket address from the page origin. Remote players should use the host's LAN/public address, not their own `localhost`.

A join failure may be an expired invitation, full roster, origin mismatch, incompatible content or blocked WebSocket upgrade. After rebuilding, refresh clients together. Reverse proxies must forward WebSocket upgrades and preserve the browser's intended origin; see [self-hosting](SELF_HOSTING.md) for administrative route restrictions.
