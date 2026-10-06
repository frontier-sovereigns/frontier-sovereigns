# Performance

Roster and content limits are supported by the game rules, but maximum-capacity timing and endurance are not fully qualified. Later-age mixtures, large settlements, browser rendering and model inference need measurements on the actual host and clients. This guide describes current controls and harnesses without claiming a passed capacity benchmark.

## Runtime execution

The default authoritative frame interval is **300 ms**. Adaptive pacing can increase it to 450/600 ms and slow wall-clock game speed under sustained overload. The optional 50 ms profile is selected with `FRONTIER_FRAME_MS=50`; it is a different workload, not a guaranteed performance improvement.

| Variable | Meaning |
| --- | --- |
| `FRONTIER_PATH_WORKERS` | Persistent path worker count, 0–8; production default 2 |
| `FRONTIER_VISION_WORKERS` | Visibility workers for the 50 ms profile, 0–8; configured default 2 |
| `FRONTIER_COARSE_VISION_WORKERS` | Opt-in visibility workers for 300 ms frames; default 0 |
| `FRONTIER_PUBLICATION_WORKER` | Dedicated recipient-view encoder: 1 default, 0 inline |
| `FRONTIER_OVERLOAD_POLICY` | `adaptive` default, or `pause` |
| `FRONTIER_FRAME_MS` | Starting profile: 300 default, or 50 |

Zero path/visibility workers selects inline execution. More workers can add communication overhead and compete with browser rendering or model inference. Save and restart the game process to change these settings. They do not reconfigure the model service or grant gameplay bonuses.

Host diagnostics expose worker activity, queues, timing and recovery state. Measure command latency, simulation progress, publication, browser response and model requests separately.

## Reproducible measurements

Build before using compiled harnesses:

```sh
corepack pnpm build
corepack pnpm test:load:production
corepack pnpm test:network-load:production -- --seconds=60 --drop=.01 --latency-ms=75 --jitter-ms=10 --seed=37
```

`test:load` and `test:network-load` are source/tsx alternatives. Reports distinguish `source-tsx` from `bundled-production`; do not compare them as identical execution modes.

The headless load harness supports `LOAD_MAP=open_frontier|river_divide`, `LOAD_FACTIONS`, `LOAD_AI`, `LOAD_TICKS`, `LOAD_SEED` and `LOAD_PROFILE`. For a short larger fixture in PowerShell:

```powershell
$env:LOAD_PROFILE = 'capacity120'
$env:LOAD_TICKS = '1200'
corepack pnpm test:load:production
Remove-Item Env:LOAD_PROFILE, Env:LOAD_TICKS
```

`capacity120` and `capacity200` use synthetic fixtures with 1,320/2,200 one-population units at eleven factions. They include 80 non-wall buildings and 160 wall-equivalent cells per faction and 8,000 resource nodes. `mixed120`/`mixed200` use multi-population units and report smaller actual unit counts. These fixtures do not cover every current building/resource limit or every later-age composition.

For a sixty-minute paced diagnostic, use `LOAD_MINUTES=60` instead of `LOAD_TICKS`. `LOAD_AI_POLICY=1` enables autonomous AI in capacity fixtures; the default uses scripted duties. Keep builds and other heavy tests separate from timing runs.

`LOAD_STAGE_PROFILE=1` and any enabled `LOAD_NAV_CENSUS`, `LOAD_NAV_LINE_CENSUS`, `LOAD_ACTIVITY_CENSUS` or `LOAD_REPLICATION_CENSUS` add instrumentation and make a run ineligible for timing qualification. Leave them unset for uninstrumented timing comparisons.

## Scope of results

A headless simulation run does not measure live models, browsers, network sessions or the complete production worker path. A starting-settlement smoke does not establish late-game capacity. The network harness adds authenticated sessions, impairment and optional endpoint outage testing, but its simulated frame loss is not actual TCP loss.

Longer network runs inspect activity, income, autosaves, memory trends and recovery. The playthrough profile additionally attempts progression, combat, reconnect and save/load; its reports distinguish observed goals from unfinished ones. A terminal recording requires verified replay checkpoints.

Reports under `runtime-data/qualification` include workload and execution provenance. Exit code 2 can mean qualification remains incomplete even when local checks pass. Keep real endpoint location and hardware explicit; a loopback URL alone does not prove where inference executes.
