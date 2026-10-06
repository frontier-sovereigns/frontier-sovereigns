# Gameplay

A normal match starts in Age I and can progress continuously through Age VIII. The host can lower the maximum age. There is no separate expansion selector.

| Age | Name |
| --- | --- |
| I | Founding |
| II | Settlement |
| III | Fortress |
| IV | Empire |
| V | Citadel |
| VI | Runic |
| VII | Colossus |
| VIII | Eternal |

The current catalog contains 19 unit types, 35 building types and 41 technologies. Costs, prerequisites, durations and statistics are defined in `data/balance.v1.json` and `data/balance.legendary-ages.v1.json`; these values remain subject to balance testing.

## Economy and progression

Select Villagers and right-click a visible resource to gather food, wood, gold or stone. Carried cargo becomes spendable only after deposit at an appropriate drop-off. Build housing to support population and completed production buildings to train units.

Use a Town Center's **Research & ages** tab to advance after meeting building and resource requirements. Research and training share producer queues; costs are charged when queued. The interface shows blocked prerequisites and cancellation refunds. Technologies affect existing and future units.

Farms support one farmer each. Idle Villagers can seek nearby visible resources; Stop or Hold disables automatic gathering until another work or movement order, and Hold also sets Stand Ground. Resources are physical nodes. Long War adds more ordinary nodes rather than increasing each node's yield.

## Controls

These are default bindings; **Settings & controls** supports remapping.

| Input | Action |
| --- | --- |
| WASD / arrows | Pan camera |
| Mouse wheel / middle drag | Zoom / rotate |
| Click or drag; Shift-select | Select; add to selection |
| Right-click | Contextual move, gather, attack, build, repair, garrison or producer rally |
| Shift-order | Queue orders, up to sixteen per unit |
| H / period | Cycle Town Centers / idle Villagers |
| Ctrl+1–9 / 1–9 | Assign / recall control group |
| B / P / X / J | Attack-move / patrol / stop / hold |
| Alt / Escape | Show health bars / cancel placement or clear selection |
| Home | Reset camera |
| Minimap click / right-click | Move camera / issue order |

Hovering previews the contextual action. The explicit Attack tool rejects allied targets. Stances govern automatic engagement; Hold/Stand Ground keeps its movement restrictions.

## Defenses and combat

Drag connected walls from the fortification palette; Ctrl changes the bend axis. Place gates on clear ground with Q/E rotation, or use the separate replacement action on matching completed wall segments. Original gates replace three segments; broad later gates replace five.

A completed gate supports AUTO, LOCKED and OPEN. An open passage can admit enemies. Later ages add larger citadels, broader fortifications, wards, siege weapons and colossal units. Deployment, packing, ammunition and support structures impose ordinary costs and tactical constraints; inspect each unit/building's controls and requirements.

For Conquest, a faction is eliminated when it has no surviving unit and no Town Center; the last surviving team wins. The host may also enable Monument victory. The Monument must meet the match's age requirement and remain standing for its hold duration. Team settings, shared vision and victory options are selected in the lobby.

## AI and accessibility

AI factions have Easy/Medium/Hard policies and Builder/Raider/Marshal/Steward/Diplomat personalities. Model commanders supply strategic goals; rule controllers continue when no usable model plan exists.

A human can enable **AI Pilot**, select a host-approved model, reserve resources, pause assistance and release manually protected units back to AI control. Ownership stays with the human. Manual orders take priority.

**Guided quiet practice** teaches the economy and combat through nine lessons using ordinary costs and fog. Its opponent defends itself without strategic endpoint requests.

Settings include quality presets, interface scaling, reduced motion, edge pan, keyboard remapping, mute and separate music/effects levels. Alerts also appear as text. The **Asset gallery** at `/asset-gallery` displays generated assets and their supported actions/states.

See [multiplayer](MULTIPLAYER.md) for disconnect behavior and [self-hosting](SELF_HOSTING.md) for saves and recovery.
