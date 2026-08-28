# Remote Dispatch - Current State

This document describes **what the codebase actually does right now** (the "is"),
based on the local branch - 90 commits ahead of upstream `trunk` (1.7.0). It is a
snapshot, not a plan. For intended direction, see `docs/VISION.md` (if present).

- Branch: `trunk`, 90 commits ahead of `origin/trunk` (merge-base `f4c3f21`, "publish 1.7.0")
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
  -> SignalsShim.Initialize()     # reflectively load Signals bridge (new or MP fork)
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
│   └── SignalsShim.cs    # reflection bridge to RemoteDispatch.Signals(.MP).dll
└── frontend/             # embedded web assets (served from /res/)
    ├── main.js
    ├── index.html / style.css / icon.svg
    ├── switchboard-data.js / switchboard-renderer.js / switchboard-mapper.js
    ├── switchboard-signals.js / switchboard-occupation.js / switchboard-pathing.js
    └── ST_2.1-hotfix.json / DT_2.1-hotfix.json # static switchboard layouts (single / DoubleTrack)

RemoteDispatch.Signals/      # separate DLL (NEW Signals mod: Signals.Game, no API)
├── Bootstrap.cs            # public static API surface (Initialize/Teardown/...)
├── SignalsBridge.cs        # subscribes to SignalManager/Signal events, registry Signal.Id keys
└── LoggingReturn.cs        # 3 logging callbacks forwarded from main mod

RemoteDispatch.SignalsMP/   # separate DLL (OLD Signals mod forks: Signals.API)
├── Bootstrap.cs            # identical public static API surface
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
| `/path` | GET/POST/PATCH/DELETE | PathingData/StagingData | path CRUD |
| `/path/{id}/note` | PATCH | PathingData | set a path's note text |
| `/path/{id}/lookahead` | PATCH | PathingData/StagingData | set a path's claim-ahead threshold (+/- stepper; + claims immediately, - only lowers the threshold) |
| `/path/{id}/color` | PATCH | PathingData | set a path's display colour (hue slider) |
| `/path/{id}/unclaim` | POST | PathingData/StagingData | release a path's clearance (first delete press; sets lookAhead 0) |
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
Two-layer reflection chain (no compile-time dependency from the main mod):

```
RemoteDispatch (Shims/SignalsShim)
    --reflection--> RemoteDispatch.Signals.dll  (new fork: Bootstrap → SignalsBridge → Signals.Game)
    --reflection--> RemoteDispatch.SignalsMP.dll (old fork: Bootstrap → SignalsBridge → Signals.API)
```

- `SignalsShim.Initialize()` finds the `DVSignals` UMM mod. Two Signals mods share
  that Id, so it discriminates by **version string**: a `-mp` suffix
  (`1.1.3-mp` / `1.1.4-mp`, old fork with `Signals.API.dll`) loads
  `RemoteDispatch.SignalsMP.dll`; any other version (`1.0.0`, WhistleWiz rebuild
  with no API) loads `RemoteDispatch.Signals.dll`. If `Signals.API` is still in
  the AppDomain the API bridge is preferred as a fallback. It caches `MethodInfo`s
  for: `GetAllSignals`, `GetSignalAspect`, `SetSignalAspect`, `SetSignalMode`,
  `IsTrackOccupied`, `Teardown`.
- Both bridge DLLs expose the **same static surface**
  (`Bootstrap.Initialize/Teardown/GetAllSignals/GetSignalAspect/SetSignalAspect/
  SetSignalMode/IsTrackOccupied`) and both project signal data into the identical
  `Dictionary<string signalId, object>` shape (`Id`, `Type`, `Mode`,
  `CurrentAspectId`, `IsOn`, `Direction`, `JunctionId`, `RequiredBranch`,
  `SelectedBranch`, `YardId`, `TrackId`, `Position[x,z]`), so `SignalsShim` and
  the frontend are backend-agnostic. Both register event callbacks that push
  `Sessions.AddTag("signals")` on aspect/mode changes.
- Old-fork `SignalsBridge.cs` subscribes to `SignalsAPI.Loaded/Unloaded` + instance
  `SignalAspectChanged`/`SignalModeChanged`, and **force-updates** all signal
  aspects before every read (`ForceUpdateAllSignalAspects`, throttled to 5s), with
  a reflection `UpdateAspect` fallback over `Signals.Game` for API versions that
  lack `ForceUpdateAllSignals(bool)`.
- New-fork `SignalsBridge.cs` instead subscribes to the `SignalManager` static
  events (`AspectChanged`, `OperationModeChanged`, `OverrideChanged`) plus per-`Signal`
  events, and drives a throttled `Signal.UpdateAspect(false)` sweep for freshness.
  New-fork signal keys are the numeric **registry `Signal.Id`** (parity with
  upstream `b230c83`): entry signals often share display names like "A"/"B"
  across yards, and name-keying silently dropped them from `/signals`. The
  display name is now a separate `Name` projection field (also carried through
  `MinimalSignalData`, alongside `YardId`), which the frontend uses for marker
  titles/popups; `-mp` signal ids are unchanged (name-embedded). Signal ids are
  **per-run, not persistent** - `signalpacks/*.json` tables are keyed by the
  numeric id from the current session.
  `SignalOperationMode` is folded back to the legacy
  `Manual`/`Automatic` strings that the frontend and pathing code expect, and the
  new richer `SignalType` is folded back to the old `Mainline/IntoYard/Shunting/
  Distant/Other` names. Direct occupancy uses
  `RailTrackOnTrackBogiesExtensions.BogiesOnTrack` (public Assembly-CSharp helper
  the new mod's internal `HasBogies` wraps).
  - **Direction is the controller's facing semantic, not signal names.**
    The old fork's names carried a `{junctionId}:F/:B1/:B2` suffix that encoded
    junction + facing; the new fork's `Signal.Name` does not. The bridge reads
    `TrackSignalController.Direction` (set by the Signals mod at creation:
    junction signals = `Out`, branch signals = `In`) and maps it to
    `"Out"`/`"In"`. (Upstream's `signal.Controller == junctionController`
    comparison only ever matches the Out controller, so it classified branch
    controllers as `Out`; this fork deliberately keeps the placement-derived
    facing - upstream's switchboard doesn't attach In signals, so it never
    needed the branch case.) The owning junction is read off
    `controller.GroupJunction` on **every** controller so In/branch signals
    still carry a `JunctionId` (the switchboard depends on this), and for In
    signals the bridge additionally emits `RequiredBranch` (0 = left,
    1 = right) from the controller's **index in `Junction.outBranches`**
    (matched by `StartingTrack`), which matches the switchboard graph's
    left/right port assignment - the frontend uses it to assign `LeftIn`/
    `RightIn`. (The group's `BranchSignals` list can skip small tracks, so its
    index is *not* the port index.)
  - Both bridges guard `SetSignalAspect`/`SetSignalMode` with a **main-thread
    check** (thread id captured in `Register`); off-thread calls warn and no-op
    instead of touching Unity state.

### 4.3 Junction graph (`Data/RailTracks.cs → Junctions`)
`BuildTrackGraph()` derives a **junction graph** from `RailTrackRegistry` each
time it's requested (cached JSON). Per junction: `junctionIndex`,
`position` (lat/lon), `incomingTracks`, `outgoingTracks`, `currentBranch`,
`neighbors`, `degree`, and `commonNeighbor` / `leftNeighbor` / `rightNeighbor`
(port-neighbor mapping via `TraceToJunctions`, matching track endpoints by
**position proximity**: endpoints are grouped by exact `Vector2`, and the walk
collects every group within the `CONNECTION_THRESHOLD` (1.5f) of a point).
**`neighbors` is capped at degree 3** (the physical switch limit): in dense
double-track areas such as the DT-SJX1 crossovers, parallel track endpoints sit
close enough that `TraceToJunctions` links a spurious fourth continuation,
which would otherwise produce impossible junction signatures in `/graph`.
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
  (blockId → signal id), plus `lookAhead` and an optional `note` (free text,
  preserved across path updates via `UpdatePathNote`). Paths are visible to the
  frontend via `/path` GET and enriched with per-block `blockStates` from
  `StagingData`.
  CRUD: `AddPath`, `RemovePath`, `UpdatePath`, `RemovePrefixFromPath`,
  `RemovePathFromStoredList`, `ClearPaths`, `UpdatePathNote`.
- `StagingData` - the **route-claim engine**. Models each path's progress as
  `PathStaging { blocks[], currentBlockIndex, lookAhead, status }` and keeps
  per-block queues (`_blockQueues`, pathId per block) plus `_activeBlocks`
  (blockId → claiming pathId) and per-path `_retryTimes`.
  `Process()` runs every 0.5s while pathing is enabled:
  - advances the current block when the *next* block is **claimed by this path**
    **and** becomes occupied (an unclaimed-but-occupied next block is a hint to
    claim it, not to advance),
  - prunes already-traversed blocks (removing them from the stored path too),
  - runs the **single advancing function** (`Advance`, StagingData.cs:426) for
    every active path. `Advance` is the one entry point for all claiming: it
    detects train movement, ensures the train's own block is claimed (the seed,
    refusing to steal it from another active path), and extends the lookahead
    window **conflict-aware** via `TryClaimFrom`/`CalcRange`. It is called from
    the periodic `Process()` check, from path creation/restore (the **startup
    check**: `AddPath` and `InitializeFromPaths` run `Advance` once
    synchronously so a new path's seed *and* lookahead window are claimed
    immediately, not on the next tick), from route extension (`UpdatePath`),
    and from a **growing** lookahead (`SetLookAhead`, the `+` button).
    Restoring existing paths (page reload / pathing re-activation via
    `InitializeFromPaths`) **preserves the live staging state**: already-tracked
    paths keep their claims as they were, and only genuinely new paths get the
    startup `Advance`.
  Claims are gated by `CalcRange`, which walks the route ahead and refuses to
  claim more than the range until all **opposing / upcoming** paths share the
  section have ended (`IsOpposing` detects reverse-direction travellers over a
  shared span). Non-opposing paths dequeue as they pass through; physical
  occupancy blocks a claim only for that block (walk continues past it).
  The **5s pacing timer** (`ClaimInterval` on `_retryTimes`) only paces the
  ordinary automatic extension so it does not all happen at once. The per-path
  **`lookAhead` value bounds the window** (default 5, set by the sidebar `+`/`-`
  stepper; `0` claims nothing ahead): auto-extension claims up to `lookAhead`
  blocks and the train-advance extension re-fills to it, with no hard upper cap
  beyond the route length. A train **advancing** onto the next block, a detected
  conflict probe (`conflictingAhead`, only within the lookahead window), or a
  **growing** lookahead (`+`, which clears the timer and claims synchronously)
  run **immediately**, bypassing the timer; conflict probes do not refresh the
  timer, so a path whose opposing traffic clears is never locked out for a full
  interval. The `-` button only **lowers the threshold** at which *new* blocks
  are claimed - it never releases already-held claims (those stay until the
  train passes them); removing a clearance is done by the **delete button's
  first press**, which calls `UnclaimPath` (`POST /path/{id}/unclaim`): it
  releases every claim the path holds (guard signals revert to stop) and sets
  its `lookAhead` to 0 so it does not reclaim itself, leaving the path active
  and re-clearable with the `+` button; a second delete press removes it.
  The **initial claim** of a new/restored path is deliberately **one section
  ahead only** (`Advance(staging, claimCap: 1)` from `AddPath` /
  `InitializeFromPaths`) - the rest of the window is filled by the 5s cooldown
  instead of being blasted at creation.
  Each `ActivateBlock` sets the block's guard signal to **Automatic** and throws
  its switch to the needed branch (`junction.Switch(REGULAR)`); releasing sets
  the signal back to **Manual+S1**.
  States exposed per block: `occupied`, `claimed`, `waiting`, `unclaimed`,
  `completed`.
  - **All Unity-touching mutations run on the main thread.** `ActivateBlock`
    mutates Unity objects (`junction.Switch`, DVSignals `ChangeOperationMode`/
    `ChangeAspect`), so every HTTP-triggered entry point - `POST /path`
    (`AddPath`), `PATCH /path/{id}` (`UpdatePath`), `PATCH /path/{id}/lookahead`
    (`SetLookAhead`, which can release/claim blocks), `POST /path/{id}/unclaim`
    (`UnclaimPath`, which releases claims), `DELETE /path`
    (`ClearPaths`/`RemovePath` + `RevertRouteSignals`) and `/signal/control`
    (`SetSignalMode`/`SetSignalAspect`) - now `await Updater.RunOnMainThread(...)`
    before touching the staging/pathing state (matching the activation endpoint).
    The `Process()`
    staging loop already runs on the main thread via `CheckStagingCoro`. This
    fixed a game freeze when setting a path: `AddPath` used to run `Junction.Switch`
    from the HTTP threadpool thread while the main thread waited on the staging
    lock.
  - **Lock ordering is `lockObj` → `paths` (never the reverse).**
    `PathingData.GetPathsJson` used to take the `paths` lock then
    `StagingData.GetStagingData` (which takes `lockObj`), while the main-thread
    `Process()` holds `lockObj` then takes `paths` via `PathingData.GetPaths` -
    a classic deadlock pair. `GetPathsJson` now snapshots staging data *before*
    acquiring the `paths` lock, so both threads acquire the locks in the same
    order.
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
   every non-distant signal back to **Automatic** (paced, see below) and pushes a
   `signals` tag. It is called when the `enablePathing` flag is toggled off (on the
   main thread) and on mod disable. `RevertRouteSignals` / `ClearRouteSignals`
   remain as per-path teardown helpers.
   - **Sweeps are paced across frames** (`PacedSignalSweep`, hosted on the
     `Updater` main-thread component): `ActivatePathingMode` /
     `SweepSignalsToAutomatic` collect a `List<Action>` of per-signal mutations and
     apply ~24 of them per frame instead of mutating the whole map in one frame -
     this removed the enable/disable game freeze (see §7 item 14, now resolved).
     `SetSignalToStop` additionally refuses to run against a Distant signal (they
     can't hold a stop aspect), so a future call site can never force one under
     Manual control.

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
| `switchboard-signals.js` | `SwitchboardSignals` | per-switch signal mapping, `VirtualSignal` forward/composition of aspects, lamp-based dot colouring |
| `switchboard-occupation.js` | `SwitchboardOccupancy` | occupancy mode (direct/hardcore) → POST `/occupancy` |
| `switchboard-pathing.js` | `PathingController` | interactive path select + A*-style block routing on frontend, then POST `/path`; displays locked paths, block chips, claim-ahead stepper + colour hue slider, delete/extend; colours claimed/waiting blocks |
| `main.js` | - | map set-up, sidebar tabs, jobs/cars tables, and switchboard bootstrap (`initSwitchboard`, `loadSampleTrackData`, `buildSwitchMapping`, `sendBlockOccupancyMapping`) |

### Switchboard view
- Toggled via **"Show Switchboard"** button → toggles `body.switchboard-active`
  and `#switchboard-view`; the map pane is swapped. The toggle is a purely
  cosmetic view swap - it keeps active pathing running in the background,
  still syncing `blockStates` and rendering to the hidden switchboard map, so
  returning to the board shows up-to-date paths.
- `#switchboard-map` uses `L.CRS.Simple` with
  `preferCanvas: true` (all existing `L.polyline`/`L.rectangle`/`L.circle`
  layers created without an explicit renderer adopt the map's canvas renderer;
  the original map with job/track overlays keeps its own `L.canvas()`).
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
- After the walk, `repairMapping()` runs a post-pass that re-scans the edges
  flagged by `validateMapping()` and swaps two graph-adjacent switches' junction
  assignments when the exchange strictly improves both switches' adjacency
  scores, iterating to a stable minimum. This corrects residual crossover
  leg-swaps that the BFS + eviction leaves behind (e.g. the MF J-632/J-546 and
  J-636/J-638 pairs) without regressing the reciprocal-eviction guarantees.
- `GRAPH_OVERRIDES` is now **empty** (all hardcoded junction overrides removed:
  the old J539–J542, J404/J403/J18/J370, and J125 entries were redundant against
  the live graph and deleted along with the earlier J26 fix).

### Switchboard signal dots
- Each switch draws a dot per port signal that has a real signal mapped: the
  inbound (common) port's `Out` signal plus the two branch ports' `LeftIn`/
  `RightIn` signals (`rawSignals` in `switchboard-signals.js`). Ports without a
  mapped signal fall back to neighbour-forwarding (`forwardMissingSignals`) and
  virtual signals; virtuals (`In`/`LeftOut`/`RightOut`) compose aspects but are
  not drawn as separate dots.
- **Dot colour comes from the lit lamps, not the aspect id.** A single aspect can
  light several lamps of different colours (e.g. a multi-aspect signal), so
  `SwitchboardSignals.signalDotColor(signal)` classifies every lamp lit by the
  signal's current aspect (from the `/signalpack` table: `entry.Aspects[aspect]
  .Lit` names matched against `entry.Lamps[i].Colour`) and picks the highest-
  precedence colour present: **red > blue > green > white > yellow**.
  `classifyLampColour` uses generous RGB-dominance thresholds (white = all
  channels ≥180; red = R≥150, G/B≤120; blue = B≥150, R/G≤120; green = G≥130,
  R/B≤140; else yellow). Blinking lamps are included in `Lit` (the backend folds
  `Blinking` into `Lit` at capture time), so a blinking green lamp still reads as
  green. When no pack data has been captured for a signal yet, the dot falls back
  to the old aspect-set mapping (S1/S1r/S1c → red, S6/S7 → yellow, S2/S4/S6 →
  green).
- Dots repaint through the coalesced repaint path: `updateAllSignals` calls
  `switchboardRepaint.markAllSwitches()` when any signal's aspect/mode changes,
  and `refreshPackTable` refreshes each marker's `.entry` reference when the pack
  table grows.

### Pathing UX (frontend)
- Backed by `PathingController`. To create a new path: start must be an
  *occupied* block; destination is any block that is path-reachable. A*
  over the block graph (built as "block nodes, edge via common junction/switch
  ports"). The chosen path is converted to `{blocks, switchAssignments,
  signalIds, blockSignals}` and POSTed to `/path`. The server assigns the path
  an id and seeding; the frontend keeps server-side `blockStates` in sync via
  `syncFromServer`, rendering colours via `TrackRenderer.resolveBlockColor`:
  each locked path has a stable random **blue-dominant** colour
  (`randomPathColor`); a block in one upcoming path shows that path's colour,
  a block in several shows the per-channel blend (`blendColor`), a **claimed**
  block shows the path colour boosted green (`claimColor`), and an **occupied**
  block is always red and wins over path colouring. Draft path-selection
  highlighting (start/dest hover) is transient UX with its own colours.
- **Waypoints** (right-click on a segment/switch while drafting) force the
  draft route through intermediate blocks: the draft is chained over
  `[start, ...waypoints, dest]` (`computePathWithWaypoints`, merging boundary
  blocks). Waypoints are draft-only - not sent to the server - and are cleared
  when the path is confirmed. Right-click on empty map cancels the draft. The
path search behind this (`computeBlockPath` → `_ensurePathTree`) is a
   per-source **memoized Dijkstra tree** that is invalidated whenever occupancy
   changes (`invalidatePathTree`), so edge costs stay current. The search is
   **two-tier**: a **valid** tier hard-blocks occupied through-blocks (source
   exempt) so a clear detour always wins over an occupied shortcut, and a
   **soft** tier (occupied-block penalty) is used only when the valid tier
   cannot reach the destination - so a dispatcher is never dead-ended while a
   clear route is still preferred (see the VISION blocker note).
- **Extending a locked path** (⊕ button in the sidebar, `beginExtendPath`) is
  the **favoured way to grow a route**: the path's last block becomes the
  anchor, the same hover/A*/waypoint drafting draws a section from it, and
  confirming PATCHes the merged route (`extendPath` → `PATCH /path/{id}`),
  staying in extend mode so further sections chain on. Self-overlap is rejected
  (`extendPath` refuses a section that loops back through an existing block
  other than the anchor); staging conflicts with other paths are handled
  server-side by the claim engine. Esc / right-click cancels extend mode.
  Because extend keeps the route anchored and re-anchors at the new end each
  time, it is intended to replace the waypoint-driven *new path* flow as the
  primary routing UX.
- **Path notes**: each locked path has a sidebar note field ("locomotive /
  destination / note") saved via `PATCH /path/{id}/note`
  (`PathingData.UpdatePathNote`) and preserved across path updates.
- `PathingController` is armed by the `enablePathing` flag via the `modconfig`
  tag (not by the view toggle). Activation (`POST /pathing/activate`) is only
  sent once a real switch→junction mapping exists; if the flag is on before the
  switchboard is ever opened, `enableFromMapping()` fires the activation as soon
  as the board builds its mapping.
- The sidebar `#pathList` renders each locked path with block chips, a note
  field, a **− N +** **claim-ahead stepper** (`PATCH /path/{id}/lookahead`: the
  `+` grows the threshold and claims it immediately, skipping the 5s pacing
  timer; the `−` only lowers the threshold at which *new* blocks are claimed
  and never releases held claims), a **hue slider** for the path colour
  (`PATCH /path/{id}/color`,
  `PathingController._changePathHue` - rotates the hue of the path's colour,
  kept server-side in the `color` field so it survives reloads), a **two-stage
  delete** button (first press with claims calls `POST /path/{id}/unclaim` to
  pull the clearance and set `lookAhead` 0; second press deletes the path), and
  a ⊕ **extend** button. The row being extended is highlighted with
  a green border.

### Switchboard performance notes
- The switchboard map uses `preferCanvas: true` (§ "Switchboard view"), so all
  ~1.5–1.7k track segments + switches render to one canvas instead of thousands
  of SVG DOM nodes.
- Repaints are **coalesced** through `switchboardRepaint` (`main.js`): tag
  handlers (`occupancy`, `paths`, `signals`, `junctions`) mutate state and mark
  dirty blocks/switches; a single `requestAnimationFrame` pass renders the union
  once, and multiple tags in one poll (or consecutive 100ms polls) collapse into
  one pass. While the board is hidden (`!body.switchboard-active`) painting is
  skipped; the show-toggle full repaint catches up. The path-list sidebar DOM is
  only rebuilt when its signature (ids/blocks/`blockStates`) changes.
- Per-block colouring now reads a precomputed block → `{claimed,
  claimedPaths, upcomingCount, upcomingPaths}` table
  (`PathingController.rebuildPathStatusTable`, rebuilt once per paths sync)
  instead of scanning every locked path per segment, and
  `TrackData.getBlockForSegment` is O(1) via `_segmentBlockMap`.
  `renderSegment`/`rerenderBlocks` operate on `block.segmentIds`, so a changed
  block re-renders only its own segments. `randomPathColor`/`claimColor`/
  `blendColor` live in `TrackRenderer` and derive per-path colours from the
  table; the path's assigned colour is cached in `_pathColors` (persists across
  polls and reloads).
- Path searching (`PathingController.computeBlockPath`) is now a **memoized
  single-source shortest-path tree** (binary-heap Dijkstra computed once per
  start block); each hover target is an O(path length) trace-back from the
  cached parent-pointer map.

### Permission model (frontend-facing)
`Permissions` in `Settings.cs`: per-user toggles for junctions, loco control,
player blips, loco visibility, and **signal control** (`canControlSignals`).
`HasPathingPermission = HasJunctionPermission && HasSignalControlPermission`.
New users auto-provision from `defaultPermissions` on first session.

---

## 6. Signals module (separate DLL) detail

Two separate bridge DLLs ship inside the mod folder (neither is a UMM mod), both
loaded at runtime by `SignalsShim` (see §4.2) and exposing the same `Bootstrap`
public surface:

- `RemoteDispatch.SignalsMP.csproj` compiles to `RemoteDispatch.SignalsMP.dll`
  and depends on the **old fork's `Signals.API`** (pinned in `refs/`). Its
  `SignalsBridge`:
  - `ForceUpdateAllSignalAspects()` (5s throttle) so aspects update even when
    no player is near the signal.
  - Falls back from the preferred `SignalsAPI.ForceUpdateAllSignals(bool)` to a
    reflection walk over `Signals.Game.SignalManager` +
    `BasicSignalController.UpdateAspect`.
  - Guards `SetSignalAspect`/`SetSignalMode` against off-main-thread calls.
- `RemoteDispatch.Signals.csproj` compiles to `RemoteDispatch.Signals.dll` and
  depends on **the new fork's `Signals.Game`/`Signals.Common`** (from the
  installed `DVSignals` mod folder). Its `SignalsBridge`:
  - Subscribes to `SignalManager` static events (`AspectChanged`,
    `OperationModeChanged`, `OverrideChanged`) and per-`Signal` events.
  - Keys everything by the numeric `Signal.Id` registry key (parity with
    upstream `b230c83`); the display name is carried as a separate `Name`
    field, as is `YardId`. See §4.2.
  - Derives direction from the controller's facing
    `TrackSignalController.Direction` (junction signals = Out, branch signals =
    In; upstream's junction-controller comparison can't classify branch
    controllers), junction from `GroupJunction`, and the In-signal left/right
    port from the controller's `Junction.outBranches` index (emitted as
    `RequiredBranch`). See §4.2.
  - Guards `SetSignalAspect`/`SetSignalMode` against off-main-thread calls.
  - Folds `SignalOperationMode` back to `Manual`/`Automatic` and the richer
    `SignalType` back to the legacy `Mainline/IntoYard/Shunting/Distant/Other`.
  - Direct occupancy uses `RailTrackOnTrackBogiesExtensions.BogiesOnTrack`
    (public Assembly-CSharp helper wrapping the new mod's internal `HasBogies`).
  - `ForceUpdateAllSignalAspects()` runs a throttled `Signal.UpdateAspect(false)`
    sweep over `SignalManager.AllControllers`.

---

## 7. Known limits / WIP / rough edges (what's clearly unfinished)

Derived from reading the code; not a plan. The most fragile points:

1. **Maintainer-acknowledged WIP**: Direct occupancy is done; Hardcore mode is
   a WIP gimmick (currently disabled, not needed for release); mapping is done
   (the known J-issue below being the exception); path conflict handling is
   undecided; UI is WIP.
2. **Frontend mapping is heuristic + hardcoded anchor**: `SwitchboardMapper`
   previously leaned on `GRAPH_OVERRIDES` and hardcoded junction overrides; those
   are now all removed (the graph endpoint produces correct topology, and
   junction degree is capped at 3). It still relies on a hardcoded anchor
   (`SWITCHBOARD_ANCHOR` = `s1677` → junction 0) to seed the fit, and there is
   no coordinate-based ground truth, so residual mismatches remain possible.
   The crossover swap bugs (double-slip legs swapped, e.g. MF J-632/J-546,
   J-636/J-638) were fixed by reciprocal-edge eviction in `findMatches`
   combined with the `repairMapping()` post-pass; see the mapping subsection in §5.
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
   to stay safe, but the boundaries are easy to break. The path-set freeze (see
   below) was the main violation; all HTTP-triggered Unity mutations are now
   marshalled to the main thread and the `paths`/`lockObj` lock order is
   consistent (see §4.4).
8. `OccupancyData` direct-mode caches track geometry once at startup
   (`EnsureTrackCache`) - if the world changes (scene load), stale cache can
   persist; `ClearMapping` exists on teardown only. (On hold: hasn't surfaced
   as a problem in practice; see VISION future plans.)
9. **Route search two-tier occupancy** (fix landed): the switchboard search
   (`PathingController.computeBlockPath` / `_ensurePathTree`) now runs a
   **valid** tier that hard-blocks occupied through-blocks (source exempt) so a
   clear detour always wins over an occupied shortcut, falling back to a
   **soft** tier (occupied-block penalty) only when the valid tier cannot reach
   the destination - so a dispatcher is never dead-ended but a clear route is
   still preferred. `_finalizePath` legality (wrong-way switch rejection) is
   unchanged and identical to before, so no new invalid paths are shown and
   reachability does not regress. Residual: switch-port data is incomplete for
   multi-switch blocks, so legibility enforcement is no better than before
   (see VISION blocker #2 "resolved" note).
10. **Restored paths claim the whole lookahead window at once** (fixed):
    reloading the page / re-activating pathing rebuilds `PathStaging` via
    `InitializeFromPaths`, which previously claimed nothing and cleared
    `_retryTimes`, so the next 0.5s `Process()` tick claimed up to 5 blocks per
    restored path instantly. It now seeds only the start block (mirroring
    `AddPath`) and arms the full 20s retry interval before the first extension.
11. **Staging advances on occupancy before a block is claimed first** (fixed):
    `StagingData.Process` treated a next-block occupancy read as `trainAdvanced`
    even when the path never claimed that block (seed claims only block 0). The
    path jumped, pruned unclaimed blocks, and vacated its implicit window.
    Advancement is now gated on the next block being claimed by this path; an
    unclaimed-but-occupied next block is a hint to claim it, not to advance.
12. **New-path seeding bypassed the claim engine (fixed)**: `StagingData.AddPath`
    used to claim the first block via a direct `ActivateBlock` call, skipping
    the conflict-aware checks. It now seeds through `TryClaimSeed`
    (StagingData.cs:352), which mirrors the `TryClaimFrom` entry point: it
    refuses to steal the start block when another active path holds it, while
    the occupancy break is relaxed because the seed block is the train's own
    occupied block (opposing/upcoming gating stays in the extension pass).
    (VISION blocker #4.) *(Superseded: the seed is now folded into the single
    `Advance` function - see §4.4 - which seeds the train's block and extends
    the window in one synchronous startup check.)*
13. **Some signals are mapped to the wrong spot / wrong side in the switchboard**:
    the direction logic previously classified *all* signals on a multi-signal
    switch as `Out` (a single dot at the base) - **fixed** by reading the
    controller's facing `TrackSignalController.Direction` (see §4.2); the
    left/right port now comes from the controller's `Junction.outBranches`
    index (was `JunctionSignalGroup.BranchSignals` index, which shifts when
    small tracks are skipped). Residual open suspects:
    - **DoubleTrack + Signals flip cancellation** (maintainer hypothesis,
      unconfirmed): the DoubleTrack mod and the Signals mod each mirror/flip
      signals on the second track, and the two flips cancel each other out for
      a subset of signals, leaving them with an inverted In/Out classification
      before RD ever reads them. Needs investigation against both mods'
      signal-placement behaviour.
    - Signals whose controller isn't a `TrackSignalController` (e.g. Distant)
      have no switchboard facing and fall back to `Out`; they carry no junction
      so they never attach to a switch.
    The `/signalpack` lamp table is built lazily from observed aspects, so a dot
    whose aspect hasn't been captured yet falls back to the aspect-set
    colouring, which can also make a mismatched signal harder to spot.
    (The residual suspects above are **ignored for now** per maintainer; see
    VISION future plans.)
14. **Enabling / disabling pathing froze the game (fixed).** The path-*set*
    freeze (HTTP thread vs staging lock) was fixed earlier; the enable/disable
    toggle froze for a second reason - both `ActivatePathingMode` and
    `DeactivatePathingMode` swept **every** non-distant signal in the world in a
    single main-thread frame (hundreds of per-signal mode/aspect mutations, each
    firing the aspect-changed callback). Two fixes removed it:
    - the aspect-change callback no longer flushes the pack table to disk per
      signal (`FlushThrottled`, 5s gate + one catch-up write, final flush on
      teardown - the on-disk copy lags ≤5s; `/signalpack` reads the live
      in-memory table);
    - the full-map sweeps are now **paced across frames** (`PacedSignalSweep`:
      mutations are collected up front and applied ~24 per frame on the main
      thread - measured <1s total, no hitch).
    Distant signals were never part of the freeze: all sweep paths already
    skipped them, and `SetSignalToStop` now additionally refuses to run on a
    `Distant` signal outright (they can't hold a stop aspect), so no future call
    site can force one under Manual control.
15. **Frontend reload / re-activation dropped a path's claimed parts (fixed).**
    `POST /pathing/activate` runs `StagingData.InitializeFromPaths`, which used
    to **clear `_activeBlocks`** and re-seed each path with only its start
    block claimed, deferring the first extension by the full 20s retry interval
    - so a reload released every claimed block and only regrew them at the
    auto-claim cadence. It now **preserves the live staging state**: on a
    reload, already-tracked paths keep their claims exactly as they were, and
    only genuinely new paths are seeded (start block + deferred 20s retry, via
    `TryClaimSeed`). First activation / re-enable-after-disable still seeds
    fresh because `DeactivatePathingMode` clears staging (`ClearAll`). Note:
    a path removed by another dispatcher while this client is open lingers in
    staging until the engine cleans it up, since reload no longer reclears.
    (VISION §3 residual.)
16. **Initial claiming for paths with opposing traffic is broken (fixed).** The
    first automatic extension of a newly created path that faces opposing
    traffic used to claim incorrectly: the **Case 2** branch of
    `StagingData.TryClaimFrom` (`opposingPaths.Count > 0`) claimed the single
    next block `b2` unconditionally (only checking it isn't active/occupied)
    instead of running the `CalcRange`/conflict walk the Case 1 (`newPaths`)
    branch used. Case 2 is now merged into Case 1, so an extension that
    detects opposing traffic walks `CalcRange` and claims **only up to the
    point where no more opposing paths are detected** (returning 0 and backing
    off on the retry when opposing holds the section). The conflict-aware
    gating applies to the lookahead grow (`+` button) the same way - it clears
    the full range up to where opposing paths end. (The manual "Claim next"
    button/endpoint that used to back this was removed in favour of the `+`
    stepper.)
17. **Manual signal control doesn't apply to in-game clients for every pack.**
    Setting a signal's aspect/mode manually (via the switchboard or
    `/signal/control`) takes effect for the web dispatcher but not for players
    in-game, regardless of the active pack. Suspect: the packs don't reflect a
    `FullManual` override / forced aspect the way expected, so the in-game
    display re-evaluates to its automatic aspect. Needs investigation of how
    the packs handle manual overrides vs the fork's `SetSignalAspect`/
    `SetSignalMode` path (`RemoteDispatch.Signals/SignalsBridge.cs`).
    **(Resolved)** - this was a bug in the Signals mod itself, fixed there; no
    change was needed in Remote Dispatch.

### Release blockers (per maintainer, April 2026)

Known before a wide release; unless explicitly marked "owner = maintainer",
they are fair game for agent help:

1. ~~**Block colouring mismatch**~~ - resolved: `resolveBlockColor` is the
   single source of truth and occupied always reads as occupied (see the
   "Resolved" note below).
2. **Path conflicts**: multi-train handling has no complete solution. For the
   upcoming release the plan is to *prevent* conflicts outright rather than
   resolve them live, to avoid issues. Conflict prevention now covers the
   initial claim (seed via `TryClaimSeed`, item 12) and the first extension
   into opposing traffic (Case 2 merged into the `CalcRange` walk, item 16).
   Live conflict *resolution* remains on hold. See VISION blocker #1/#4.
3. A **new DoubleTrack mod version** is planned; it will need a new
   switchboard layout, but work can only start once the scope of that release
   is known (coordinated with the maintainer).
4. **Upstream signal-integration work is not finished.** Upstream
   (domroutley/dv-remote-dispatch) is still actively merging Signals work, and
   this fork's signal handling (bridges, `RequiredBranch`, pack capture,
   `/signalpack`) must stay in parity with it. Frequent checks of upstream
   progress and **parity merges** are required before release - do not assume
   the 1.7.0 merge-base is the final signal surface.
5. **Exhaustive testing of all currently available signal packs** is required
   before release: default pack plus every custom pack this fork should
   support, covering lamp capture (`/signalpack`), lit-lamp dot colouring,
   per-type stop-aspect configuration (Settings stop-aspect rows), and the
   pathing-mode sweeps - especially on DoubleTrack where the signal flip
   interaction (item 13) is suspected.

> Resolved: block colouring is unified. `TrackRenderer.resolveBlockColor` is
> now the single source of truth for block colours. Each locked path gets a
> stable random blue-dominant colour; blocks show the path colour (blended for
> overlaps), **claimed** blocks get a green-boosted variant of the path colour,
> and **occupied** blocks are always red and win over path colouring.
> `PathingController.getOverridesForSegment` / `getSwitchRimColor` were removed;
> locked-path colouring now flows through `resolveBlockColor`, and the sidebar
> path chips use the same result.

> Resolved: pathing disable/re-enable is now a **clean operation** from a
> state/signal standpoint (`PathingActivation.DeactivatePathingMode()`), and the
> map ⇄ switchboard view toggle no longer tears down active pathing - it keeps
> running in the background. Corresponding VISION blockers removed. **However,
> the enable/disable toggle still freezes the game** because both activation and
> deactivation sweep every non-distant signal on the main thread (see known
> limit #14); the "clean" here refers to signal-state teardown, not performance.
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
> degree fallback with **reciprocal-edge eviction** in `findMatches`, removing
> the now-redundant `GRAPH_OVERRIDES` clusters (J539-542, J404/J403/J18/J370,
> J125), capping junction `degree` at 3 in `/graph` (dense crossovers like
> DT-SJX1 otherwise report a spurious fourth continuation), and adding the
> `repairMapping()` post-pass for residual leg-swaps (e.g. the MF J-632/J-546
> and J-636/J-638 pairs). The mapping is now a clean 641/641 bijection with
> zero consistency violations.
>
> Resolved: with the new Signals fork, signal names stopped carrying the old
> `{junctionId}:F/:B1/:B2` suffix, so `createSwitchSignals` could no longer
> attach most signals to their junction (direction/junction were parsed from the
> name). The new-fork bridge now derives direction from the controller's
> facing `TrackSignalController.Direction` (junction signals = Out, branch
> signals = In - a fork divergence from upstream's junction-controller
> comparison, which can't classify branch controllers), the owning junction
> from `GroupJunction`, and the In-signal left/right port from `RequiredBranch`
> (the controller's index in `Junction.outBranches`, matched by `StartingTrack`
> - the group's `BranchSignals` index shifts when small tracks are skipped),
> all surfaced through `MinimalSignalData`. The frontend keys off those fields
> with the old name-suffix parse kept only as an `-mp` fallback. See §4.2.
>
> Resolved: new-fork signals were previously keyed by `Signal.Name`, so
> identically-named entry signals across yards (e.g. "A"/"B") overwrote each
> other in the `/signals` dictionary and some were missing from the board
> entirely. Parity with upstream `b230c83` now keys the projection by the unique
> per-run `Signal.Id` (with `Name` and `YardId` as payload fields), so every
> signal appears exactly once. See §4.2.
>
> Resolved: setting a path in the switchboard froze the game. `POST /path`
> mutated Unity objects (`Junction.Switch`, signal aspects) from the HTTP
> threadpool thread while the main-thread staging loop held the staging lock, and
> `GetPathsJson` took the `paths` lock then the staging lock (inverting the order
> used by the main-thread `Process`). All HTTP-triggered path/signal mutations
> are now routed through `Updater.RunOnMainThread`, `GetPathsJson` snapshots
> staging data before taking the `paths` lock, and both bridges warn+no-op on
> off-main-thread signal mutation. See §4.4.
>
> Resolved: switchboard signal dots are now coloured from the lamps actually lit
> by the signal's current aspect (via the `/signalpack` table) instead of a
> single-aspect stop/caution/clear mapping, so multi-lamp aspects show the
> highest-precedence lit colour (red > blue > green > white > yellow). See the
> "Switchboard signal dots" subsection in §5.

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
