# Remote Dispatch - Current State

This document describes **what the codebase actually does right now** (the "is"),
based on the local branch - 51 commits ahead of upstream `trunk` (1.7.0). It is a
snapshot, not a plan. For intended direction, see `docs/VISION.md` (if present).

- Branch: `trunk`, 51 commits ahead of `origin/trunk` (merge-base `f4c3f21`, "publish 1.7.0")
- Upstream: https://github.com/domroutley/dv-remote-dispatch
- Local remotes: `origin` (domroutley), `fork` (rassiMC)

> Breaking up the bigger picture: the stable, released features (cars, players,
> jobs, junctions, loco control, core signals readout) are inherited from
> upstream. The local commits are almost entirely **switchboard** work - a
> second-screen dispatch UI with occupancy, signal control, and block-level
> pathing/staging. That is the part of the codebase that is WIP and poorly
> documented; this file goes deepest there.

---

## 1. Big picture & runtime flow

The mod is a C# UnityModManager plugin for Derail Valley. It embeds a web
frontend (Leaflet + the `switchboard-*.js` modules), serves it over HTTP from
the game process, and pushes real-time updates over a tag/event mechanism.

```
Main.Load()                       # entry point (UnityModManager)
  -> OnToggle(on)  HttpServer.Start()  (HTTP on Main.settings.serverPort,
                                          default 7245)
  -> Updater.Create()             # coroutine-driven data loops
  -> CarUpdater.Start()           # train dirty-tracking + Harmony patches
  -> SignalsShim.Initialize()     # reflectively load Signals API bridge
```

On disable (`OnToggle(off)`): `CarUpdater.Stop()`, `Updater.Destroy()`,
`HttpServer.Destroy()`, `SignalsShim.Teardown()`, clear occupancy mapping +
paths.

### Update / push architecture
- The backend runs a **session/tag** model (`Server/Sessions`). A browser polls
  `/updates/{sessionId}`; sessions carry an `AsyncSet` of *pending tags* plus a
  base set on connect.
- Code calls `Sessions.AddTag("...")` whenever something the frontend cares
  about changes. The next poll then returns only changed "tags" (each resolved
  to fresh JSON). 5-minute inactivity timeout per session.
- Known tag names: `cars`, `carsWithLocomotives`, `jobs`, `junctions`,
  `player`, `playerNull`, `signals`, `paths`, `occupancy`, `modconfig`.

### Updater coroutines (`Engine/Updater.cs`)
| coroutine                | interval       | does |
|--------------------------|----------------|------|
| `CheckPlayerTransformCoro` | 0.1s          | push player transform (`PlayerData`) |
| `CheckTrainsetsCoro`        | every frame   | mark moving trainsets dirty |
| `DeferredEventsCoro`        | every frame   | drain `RunOnMainThread` queue |
| `CheckOccupancyCoro`        | 0.5s          | recompute occupancy if mapping present, tag on change |
| `CheckStagingCoro`          | 0.5s          | advance path staging if `enablePathing` |

`Updater.RunOnMainThread()` is the standard mechanism for safely touching game
state from the HTTP thread.

---

## 2. Filesystem & what's real vs. stale

Source layout under `RemoteDispatch/`:

```
RemoteDispatch/
├── Main.cs               # mod lifecycle (Load/OnToggle/Start/Stop)
├── Settings.cs           # server port/password, Permissions, FeatureFlags
├── Data/
│   ├── CarData.cs        # car/loco JSON + dirty tracking
│   ├── JobData.cs        # job data + PersistentJobs interop (JobPatches)
│   ├── OccupancyData.cs  # *NEW* block<->junction mapping + occupancy compute
│   ├── PathingActivation.cs # *NEW* pathing-mode signal switching helpers
│   ├── PathingData.cs    # *NEW* path CRUD: add/update/remove/clear
│   ├── PlayerData.cs     # player blip JSON
│   ├── RailTracks.cs     # Junctions: graph build + inbound signal map
│   └── StagingData.cs    # *NEW* server-side path staging/claims/lookahead
├── Engine/
│   ├── CarUpdater.cs     # trainset dirty marks + Harmony patches
│   ├── JunctionPatches.cs# Harmony postfix -> tag "junctions" on switch
│   ├── LocoControl.cs    # remote controller command exec
│   └── Updater.cs        # coroutine loops + RunOnMainThread
├── Server/
│   ├── AsyncSet.cs       # thread-safe set with awaitable take
│   ├── HttpServer.cs     # all HTTP endpoints + resource renderer
│   └── Session.cs        # Sessions + tag bookkeeping
├── Shims/
│   └── SignalsShim.cs    # reflection bridge to RemoteDispatch.Signals.dll
└── frontend/             # embedded web assets (served from /res/)
    ├── main.js
    ├── index.html / style.css / icon.svg
    ├── switchboard-data.js / switchboard-renderer.js / switchboard-mapper.js
    ├── switchboard-signals.js / switchboard-occupation.js / switchboard-pathing.js
    └── ST_2.1-hotfix.json / DT_2.1-hotfix.json # static switchboard layouts (single / DoubleTrack)

RemoteDispatch.Signals/     # separate DLL loaded at runtime via reflection
├── Bootstrap.cs            # public static API surface (Initialize/Teardown/...)
├── SignalsBridge.cs        # subscribes to Signals.API events, force-update hacks
└── LoggingReturn.cs        # 3 logging callbacks forwarded from main mod
```

### Stale / potentially-confusing things
- `switchboard/` at repo root (with `data.js`, `renderer.js`, `data/*.json`) is
  an **early prototype** superseded by `RemoteDispatch/frontend/switchboard-*.js`.
  It is not wired into the mod and is not an embedded resource. The hotfix
  layout sources live under `switchboard/data/` and are copied into
  `RemoteDispatch/frontend/` before release.
- The older static layouts (`RD_1.0.4/1.0.7/1.0.8.json`,
  `DoubbleTrack1.0_1.4.3.json`) and the root-level
  `DvMod.RemoteDispatch.frontend.RD_1.0.4.json` duplicate have been **removed**;
  `main.js` now loads the `ST_2.1-hotfix.json` / `DT_2.1-hotfix.json` files.
- `RemoteDispatch/RemoteDispatch.csproj` embeds the real frontend via
  `frontend.*` fully-qualified resource names.
- `AGENTS.md` mentions `RemoteDispatch.Tests/`, `RemoteDispatch.Signals.Tests/`,
  and a `.slnx`, but those are **not present** (no test projects exist; the
  solution is `RemoteDispatch.sln`).
- `TODO.txt` and `SWITCHBOARD_REDO_TODO.txt` are **stale** (they pre-date the
  block-based rework in `2dd3fa0`). `DESIGNREQUIREMENTS.md` is the original
  switchboard requirements sketch.
- There is **no automated test suite** in the repo.

---

## 3. HTTP surface

Server: `Server/HttpServer.cs` (port from `Main.settings.serverPort`, default
7245). All requests gated by basic-auth password (`Anonymous | Basic` schemas).

| path | method | owner | purpose |
|------|--------|-------|---------|
| `/` | GET | HttpServer | serve `frontend.index.html` |
| `/res/{file}` | GET | HttpServer | serve embedded frontend asset |
| `/car`, `/car/{guid}`, `/car/{guid}/control` | GET/POST | CarData/LocoControl | car data, single car, loco command |
| `/junction`, `/junction/{idx}/toggle` | GET/POST | RailTracks/Junctions | junction list + toggle (permission-gated) |
| `/track` | GET | RailTracks | track points JSON |
| `/graph` | GET | RailTracks/Junctions | `BuildTrackGraph()` - junction graph for switchboard mapping |
| `/player` | GET | PlayerData | player blips (permission-gated) |
| `/updates/{sessionId}` | GET | Sessions | long-polling update push |
| `/signals` | GET | Sessions/SignalsShim | all-signals data (gated by `enableSignals`) |
| `/occupancy` | GET/POST | OccupancyData | occupancy JSON; POST sets mapping/mode |
| `/path` | GET/POST/PATCH/DELETE | PathingData/StagingData | path CRUD + `…/advance` |
| `/staging` | GET | StagingData | path staging state JSON |
| `/pathing/activate` | POST | PathingActivation | enter pathing mode + seed staging |
| `/signal/control` | POST | SignalsShim | set signal aspect/mode (permission-gated) |
| `/modconfig` | GET | HttpServer | config flags for frontend (`doubleTrack`, `enablePathing`) |

Unknown paths return 404. Large POST bodies capped at 512 KiB; GET responses
>128 bytes may be gzip-compressed if the client sends `Accept-Encoding: gzip`.

---

## 4. Data flow detail

### 4.1 Occupancy (`Data/OccupancyData.cs`) - the core new feature
Two modes, frontend-controlled:

- **Direct mode** (default, `OccupancyMode.Direct = 1`): uses the Signals API
  `IsTrackOccupied(RailTrack)`. The frontend builds a "block ➜ junction
  entries" map and POSTs it to `/occupancy`; the backend caches it
  (`_blockJunctionMap`). Per block it walks tracks from the junctions to find
  which RailTracks the block spans, then checks physical occupation. This is
  the **release path**.
- **Hardcore mode** (`OccupancyMode.Hardcore = 0`): infers occupancy from
  **signal aspects** (`S1/S1r/S1c` = occupied, `S2/S4/S6` = clear) per junction
  port, respecting branch alignment. **Currently disabled / intentionally a
  fun extra ("gimmick"), not a supported mode.** Not needed for release; do not
  treat aspect-inference as a first-class feature.

Public members: `SetMode`, `SetBlockMapping`, `GetDetectedJunctionIds`,
`ClearMapping`, `GetOccupancyData`, `CheckChanged` (used by the updater),
`TryGetOwnSwitchIndex`, `GetSwitchBlocksForPath`, `GetOwnSwitchSignalIdsForBlock`,
`GetOccupancyJSON`.

### 4.2 Signals integration
Two-layer reflection chain (no compile-time dependency):

```
RemoteDispatch (Shims/SignalsShim)
    --reflection--> RemoteDispatch.Signals.dll  (Bootstrap → SignalsBridge)
    --reflection--> Signals.API (the DVSignals mod)
```

- `SignalsShim.Initialize()` finds the `DVSignals` UMM mod + `Signals.API`
  assembly, loads `RemoteDispatch.Signals.dll` from the mod folder, and caches
  MethodInfos for: `GetAllSignals`, `GetSignalAspect`, `SetSignalAspect`,
  `SetSignalMode`, `IsTrackOccupied`, `Teardown`. It also registers event
  callbacks that push `Sessions.AddTag("signals")` on aspect/mode changes.
- `Bootstrap.cs` is the small static API surface; `SignalsBridge.cs` does the
  real work: subscribe to `SignalsAPI.Loaded/Unloaded`, forward
  `SignalAspectChanged`/`SignalModeChanged`, and - importantly - **force-update
  all signal aspects** before every read (`ForceUpdateAllSignalAspects`,
  throttled to 5s), so aspects are evaluated even far from the player. The
  initial `ForceUpdateAllSignals(bool)` API is preferred; a reflection
  `UpdateAspect` fallback over `Signals.Game` exists for older API versions.

### 4.3 Junction graph (`Data/RailTracks.cs → Junctions`)
`BuildTrackGraph()` derives a **junction graph** from `RailTrackRegistry` each
time it's requested (cached JSON). Per junction: `junctionIndex`,
`position` (lat/lon), `incomingTracks`, `outgoingTracks`, `currentBranch`,
`neighbors`, `degree`, and `commonNeighbor` / `leftNeighbor` / `rightNeighbor`
(port-neighbor mapping via `TraceToJunctions`, matching track endpoints by
**position proximity**: endpoints are grouped by exact `Vector2`, and the walk
collects every group within the `CONNECTION_THRESHOLD` (1.5f) of a point).
This graph feeds the frontend's switchboard mapping.

> Note: a stricter "only proximity-link junction-owned endpoints" change to
> `FindEndpointGroups` was tried and **reverted** - on DoubleTrack it collapsed
> ~300 junctions to degree 1 and effectively disconnected the graph. The
> proximity matching in the released code remains the plain
> within-`CONNECTION_THRESHOLD` version.

`GetInboundSignalMap()` / `BuildInboundSignalMap()` additionally matches
"orphaned" signals (those the Signals API doesn't tag with `JunctionId`) to a
junction by **spatial proximity** (25f threshold) to its outBranch tracks, so
branch-entry ("In") signals can be attributed to a junction.

### 4.4 Pathing & staging (backend)
- `PathingData` - in-memory `List<JObject>` of "path" entries. Each path has:
  `id` (`p{n}`), `blocks` (`JArray` of block ids), `startBlock`, `destBlock`,
  `switchAssignments` (blockId → branch 0/1), `signalIds`, `blockSignals`
  (blockId → signal id), plus `lookAhead`. Paths are visible to the frontend
  via `/path` GET and enriched with per-block `blockStates` from `StagingData`.
  CRUD: `AddPath`, `RemovePath`, `UpdatePath`, `RemovePrefixFromPath`,
  `RemovePathFromStoredList`, `ClearPaths`.
- `StagingData` - the **route-claim engine**. Models each path's progress as
  `PathStaging { blocks[], currentBlockIndex, lookAhead, status }` and keeps
  per-block FIFO queues (`_blockQueues`) plus `_activeBlocks` (blockId →
  claiming pathId). `Process()` runs every 0.5s while pathing is enabled:
  - advances the current block when the *next* block becomes occupied,
  - prunes already-traversed blocks (removing them from the stored path too),
  - claims the lookahead window of unoccupied blocks for this path (block
    arbitration: only the head of a block's queue may claim it),
  - releases stale claims, cleans up completed paths.
  Each `ActivateBlock` sets the block's guard signal to **Automatic** and throws
  its switch to the needed branch (`junction.Switch(REGULAR)`); releasing sets
  the signal back to **Manual+S1**. `ForceClaimNextBlock` backs the manual
  "advance" button (`POST /path/{id}/advance`).
  States exposed per block: `occupied`, `claimed`, `waiting`, `unclaimed`,
  `completed`.
- `PathingActivation` - `ActivatePathingMode()` sweeps all signals: any with a
  junction the pathing mapping detected go **Manual+S1** (so the dispatcher is
  in control), everything else (non-distant) returns to **Automatic**.
  (Turning undetected signals - e.g. the #ROAD yard signals - fully **off**
  via `SignalsAPI.TurnOffSignal` was considered but dropped: the API leaves
  `Operation` in Automatic, so the next update re-lights them into a manual
  S1c "Expect caution + dispatch control lamp" state. Needs a Signals mod fix
  first; see §7.)
  `DeactivatePathingMode()` is the clean teardown: it releases staging claims
  (`StagingData.ClearAll()`, which reverts each claimed block's guard signal to
  Manual+S1 while stored paths still exist), clears stored paths, then sweeps
  every non-distant signal back to **Automatic** and pushes a `signals` tag.
  It is called when the `enablePathing` flag is toggled off (on the main thread)
  and on mod disable. `RevertRouteSignals` / `ClearRouteSignals` remain as
  per-path teardown helpers.

---

## 5. Frontend (embedded web UI + switchboard)

Script load order in `index.html`: `leaflet`, `leaflet-sidebar-v2`,
`leaflet.zoomhome`, `tablesort`, then
`switchboard-data.js`, `switchboard-renderer.js`, `switchboard-mapper.js`,
`switchboard-signals.js`, `switchboard-occupation.js`, `switchboard-pathing.js`,
and finally `main.js?v=...` (cache-busted with a date).

### Global objects / responsibilities
| file | global | responsibility |
|------|--------|----------------|
| `switchboard-data.js` | `TrackData` | nodes/segments/blocks data model, JSON load/save (localStorage), block grouping (flood fill), switch adjacency/graph building |
| `switchboard-renderer.js` | `TrackRenderer` | Leaflet rendering of nodes, segments, switch blocks, signal dots; colouring by occupancy/pathing |
| `switchboard-mapper.js` | `SwitchboardMapper` | fetch `/graph`, build switchboard graph, `runParallelWalk` to map switchboard switches → ingame junctions (strict port matching + reciprocal crossover eviction, no degree fallback) |
| `switchboard-signals.js` | `SwitchboardSignals` | per-switch signal mapping, `VirtualSignal` forward/composition of aspects |
| `switchboard-occupation.js` | `SwitchboardOccupancy` | occupancy mode (direct/hardcore) → POST `/occupancy` |
| `switchboard-pathing.js` | `PathingController` | interactive path select + A*-style block routing on frontend, then POST `/path`; displays locked paths, block chips, advance/delete; colours claimed/waiting blocks |
| `main.js` | - | map set-up, sidebar tabs, jobs/cars tables, and switchboard bootstrap (`initSwitchboard`, `loadSampleTrackData`, `buildSwitchMapping`, `sendBlockOccupancyMapping`) |

### Switchboard view
- Toggled via **"Show Switchboard"** button → toggles `body.switchboard-active`
  and `#switchboard-view`; the map pane is swapped. The toggle is a purely
  cosmetic view swap - it keeps active pathing running in the background,
  still syncing `blockStates` and rendering to the hidden switchboard map, so
  returning to the board shows up-to-date paths.
- `#switchboard-map` uses `L.CRS.Simple` with
  `TrackRenderer.coordsToLatLng(x, y) = L.latLng(y, x)` - i.e. switchboard
  "x/y" are treated as lng/lat directly (no fancy geographic projection).
- `loadSampleTrackData()` fetches `/modconfig` to learn `doubleTrack` +
  `enablePathing`, then loads the static layout JSON
  (`DT_2.1-hotfix.json` if DoubleTrack, else `ST_2.1-hotfix.json`) from
  `/res/`, runs `TrackData.fromJSON` → `groupIntoBlocks` → `renderAll`, and
  finally `buildSwitchMapping`.
- `buildSwitchMapping()` fetches the **live** `/graph`, builds the switchboard
  graph, runs the parallel-walk mapping from a hardcoded anchor
  (`SWITCHBOARD_ANCHOR = { switchboardId: 's1677', ingameJunctionIndex: 0 }`),
  prints unmapped switches/junctions + mapping-consistency violations, sends the
  block occupancy mapping to `/occupancy`, initializes signals, and enables
  `PathingController` if `enablePathing`.

### Switchboard mapping (switch ↔ ingame junction)
- The switchboard side is built by `TrackData.buildSwitchGraph()` (see
  `switchboard-data.js`), which walks from each switch port (merging/nl/nr)
  through connected tracks to its adjacent switch, recording both the *port
  being left* (`common`/`left`/`right`) and the *node of the target switch that
  is entered* (`entryNodeId` / `entryPort`: merging/nl/nr).
- The ingame side comes from the live `/graph` (see §4.3), which carries
  `commonNeighbor` / `leftNeighbor` / `rightNeighbor` per junction.
- `SwitchboardMapper.runParallelWalk()` maps the two graphs with a BFS from the
  anchor. For each visited switch it matches its switchboard neighbors in port
  order (**strict port match** first: the neighbor's port picks the ingame port
  target). If that target is already claimed, it checks whether the claimer
  shares a **reciprocal switchboard edge** with the neighbor being matched
  (`isReciprocalEdge`); if so, the imposter is **evicted** and the junction is
  re-assigned to the reciprocal leg. This is what fixes crossover / double-slip
  pairs (both legs of a switch collapse onto the same distant switch id, and a
  blind degree fallback would swap the two legs).
- There is **no degree/score fallback** any more: it re-claimed evicted
  junctions and re-swapped crossover legs.
- `GRAPH_OVERRIDES` is now **empty** (all hardcoded junction overrides removed:
  the old J539–J542, J404/J403/J18/J370, and J125 entries were redundant against
  the live graph and deleted along with the earlier J26 fix).

### Pathing UX (frontend)
- Backed by `PathingController`. Selecting a block: start must be an *occupied*
  block; destination is any block that is path-reachable. A* over the block
  graph (built as "block nodes, edge via common junction/switch ports"). The
  chosen path is converted to `{blocks, switchAssignments, signalIds,
  blockSignals}` and POSTed to `/path`. The server assigns the path an id and
  seeding; the frontend keeps server-side `blockStates` in sync via
  `syncFromServer`, rendering claimed (green), waiting (yellow), occupied
  (red) segments + switch rims.
- `PathingController` is armed by the `enablePathing` flag via the `modconfig`
  tag (not by the view toggle). Activation (`POST /pathing/activate`) is only
  sent once a real switch→junction mapping exists; if the flag is on before the
  switchboard is ever opened, `enableFromMapping()` fires the activation as soon
  as the board builds its mapping.
- The sidebar `#pathList` renders each locked path with block chips, a
  print-to-console button, a delete button, and a ▶**advance** button (backed
  by `/path/{id}/advance`).

### Permission model (frontend-facing)
`Permissions` in `Settings.cs`: per-user toggles for junctions, loco control,
player blips, loco visibility, and **signal control** (`canControlSignals`).
`HasPathingPermission = HasJunctionPermission && HasSignalControlPermission`.
New users auto-provision from `defaultPermissions` on first session.

---

## 6. Signals module (separate DLL) detail

- `RemoteDispatch.Signals.csproj` compiles to `RemoteDispatch.Signals.dll`,
  **shipped inside the mod folder** and loaded at runtime by `SignalsShim`
  (it is not a separate UMM mod). It depends on `Signals.API`.
- `Bootstrap` exposes only the handful of static methods `SignalsShim` needs
  (see §4.2), decoupling the main mod from a compile-time Signals dependency.
- `SignalsBridge` is where the "hack"-ish bits live:
  - `ForceUpdateAllSignalAspects()` (5s throttle) so aspects update even when
    no player is near the signal.
  - Falls back from the preferred `SignalsAPI.ForceUpdateAllSignals(bool)` to a
    reflection walk over `Signals.Game.SignalManager` +
    `BasicSignalController.UpdateAspect`.

---

## 7. Known limits / WIP / rough edges (what's clearly unfinished)

Derived from reading the code; not a plan. The most fragile points:

1. **Maintainer-acknowledged WIP**: Direct occupancy is done; Hardcore mode is
   a WIP gimmick (currently disabled, not needed for release); mapping is done
   (the known J-issue below being the exception); path conflict handling is
   undecided; UI is WIP.
2. **Frontend mapping is heuristic + hardcoded anchor**: `SwitchboardMapper`
   previously leaned on `GRAPH_OVERRIDES` and hardcoded junction overrides; those
   are now all removed (the graph endpoint produces correct topology). It still
   relies on a hardcoded anchor (`SWITCHBOARD_ANCHOR` = `s1677` → junction 0) to
   seed the fit, and there is no coordinate-based ground truth, so mismatches
   can still occur. The crossover swap bug (two switches on a double-slip
   getting their legs swapped) was fixed by reciprocal-edge eviction in
   `findMatches`; see the mapping subsection in §5.
3. **Static switchboard layouts** are baked JSON files
   (`ST_2.1-hotfix.json` single-track, `DT_2.1-hotfix.json` DoubleTrack) - the
   board itself is *not* derived from the live game; only switch/when mapping
   and occupancy are live. Layout edits require re-exporting these files (the
   sources live under `switchboard/data/`), and `loadSampleTrackData` is
   hardcoded to those two filenames.
4. **Turning off undetected signals** (e.g. the #ROAD yard signals) on pathing
   activation is **deferred for release**: `SignalsAPI.TurnOffSignal` sets
   `SetMode(Manual)` + `TurnOff()` but leaves the signal's `Operation` as
   Automatic, so on the next update it re-lights into the manual S1c "Expect
   caution" + dispatch-control-lamp state. Requires a Signals mod fix (set
   `SignalOperationMode.FullManual` inside `TurnOffSignal`); see §4.4.
5. **No tests.** Everything above is unverified by automated tests.
6. **Force-update hacks** in `SignalsBridge` depend on Signals internal types
   via reflection (`Signals.Game.SignalManager`, `BasicSignalController`) -
   brittle across Signals versions.
7. **Multi-threading**: `StagingData`/`OccupancyData` are touched from the HTTP
   thread and the main-thread coroutines; the code uses locks + `RunOnMainThread`
   to stay safe, but the boundaries are easy to break.
8. `OccupancyData` direct-mode caches track geometry once at startup
   (`EnsureTrackCache`) - if the world changes (scene load), stale cache can
   persist; `ClearMapping` exists on teardown only.

### Release blockers (per maintainer, April 2026)

Known before a wide release; unless explicitly marked "owner = maintainer",
they are fair game for agent help:

1. **Block colouring mismatch**: what the maintainer *wants* the block colours
   to mean differs from what the code currently renders. Must be resolved
   before release.
2. **Path conflicts**: multi-train handling has no complete solution. For the
   upcoming release the plan is to *prevent* conflicts outright rather than
   resolve them live, to avoid issues.
3. A **new DoubleTrack mod version** is planned; it will need a new
   switchboard layout, but work can only start once the scope of that release
   is known (coordinated with the maintainer).

> Resolved: pathing disable/re-enable is now a clean operation
> (`PathingActivation.DeactivatePathingMode()`), and the map ⇄ switchboard view
> toggle no longer tears down active pathing - it keeps running in the
> background. Corresponding VISION blockers removed.
>
> Resolved: the junction that broke a station's switch mapping in both
> single-track and DoubleTrack (GF) is fixed. `BuildTrackGraph`/`TraceToJunctions`
> now match track endpoints by position proximity instead of exact (rounded)
> coordinate strings, and the J26 `GRAPH_OVERRIDES` entry was removed. The
> single-track/DoubleTrack switchboard layouts were re-exported as the
> `ST_2.1-hotfix.json` / `DT_2.1-hotfix.json` files.
>
> Resolved: the DoubleTrack crossover swap - on the hotfix layout, at track
> crossovers/double-slips both legs of a switch collapsed onto the same distant
> switch id, and the old degree fallback swapped the two legs ("switches on one
> side correct, the other two swapped"). Fixed by recording the target's entry
> node (`entryNodeId`/`entryPort` in `buildSwitchGraph`) and replacing the
> degree fallback with **reciprocal-edge eviction** in `findMatches`, plus
> removing the now-redundant `GRAPH_OVERRIDES` clusters (J539-542, J404/J403/
> J18/J370, J125). Mapping went from 619/641 with 23 unmapped junctions to a
> full 641/641 bijection; the residual inconsistencies are ~11 crossover pairs
> where the layout genuinely has no counterpart junction in the ingame graph.

Softer / held: full UI polish is WIP but not blocking; Hardcore occupancy is
disabled and not blocking; everything else is on hold.

---

## 8. Supplemental notes for agents

- **Maintain the update-tag discipline**: if you add data that the frontend
  renders, push it via `Sessions.AddTag(...)` and add the resolver in
  `Session.GetUpdateForTag`, plus the tag name to `BaseTags`.
- **Don't touch game objects off the main thread.** Route mutating calls through
  `Updater.RunOnMainThread`.
- **Frontend resources are served from `frontend/` embedded at build time**
  (`RemoteDispatch.csproj`); edit there, not at repo root. Bump the `?v=`
  cache-buster in `index.html` when JS changes.
- Files marked *NEW* in §2 belong entirely to the local switchboard work; the
  rest came from upstream.
