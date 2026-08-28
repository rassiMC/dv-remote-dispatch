# Remote Dispatch - Vision

This is the **target** document (the "where"). It describes where the project
is heading and the intended switchboard/pathing experience, distilled from the
maintainer. It intentionally sets out what the final product *should* feel
like, separate from `docs/CURRENT-STATE.md`, which records what the code does
today.

> Not a promise of timeline; a shared north star so contributors and agents plan
> toward the same thing.

---

## 1. Positioning

- Remote Dispatch is a **derail-valley dispatcher tool**: players/operators
  interact with the game world on a second screen (browser).
- The **switchboard is the centerpiece** of the flagship "dispatcher" workflow -
  a standalone mode a user opts into. It is:
  - **Optional, never forced.** Users who only want the classic map view
    (cars, players, jobs) keep that workflow untouched.
  - **Self-contained.** Cars, players, and locomotives are **not** shown in the
    switchboard. The switchboard focuses on track topology, switches, signals,
    occupancy, and paths; not individual cars or players.
- The switchboard is a **manual, human-curated board** (like a physical panel):
  its layout is a hand-crafted, quality-controlled artifact that artists/
  maintainers ship, not something generated at runtime.

---

## 2. Switchboard experience (target)

A dispatcher looking at the switchboard should be able to, at a glance:

- See the **entire track network** as *blocks* and *switches*, laid out to
  match the real game map, readable and stable.
- Tell **which block is physically occupied** by a train (Direct occupancy),
  in real time, at a glance.
- See each **switch's current alignment** and the **signal aspects** guarding
  it, and click a switch to throw it (permission-gated).
- **Route a train**: pick an occupied block as the start, pick a destination -
  the tool proposes a path through consecutive blocks/switches, with the
  required switch alignments and the signals to clear. Growing a route is
  primarily done by **extending** an existing locked path (⊕ in the sidebar:
  it anchors at the route's end and chains unclaimed sections through the same
  drafting UI), which is the intended replacement for the waypoint-driven
  new-path flow.
- **Commit a route**: the route lives **server-side** (inside the mod), is
  ranked/queued, and the backend *stages* the path - clearing signals and
  aligning switches block-by-block as the train advances, holding a look-ahead
  window, and releasing claimed blocks behind the train.
- Watch the train progress along the route with the claimed/occupied/waiting
  states updating, and override manually (claim-next / delete / advance).

### Principles the switchboard must honour
- **No freezes** - in-game or web. Performance (both the game thread and the
  browser) is a hard requirement, not a nice-to-have.
- **Backend-owned route state.** Paths and staging are authoritative on the
  server; the frontend renders what the server reports.
- **Block-level, not switch-level, routing.** The unit of a route is the
  block; switches are aligned as a consequence of the block path.
- **Physical occupancy is the ground truth** for Direct mode (Signals API). The
  aspect-inferred "Hardcore" mode is a fun extra (gimmick), explicitly not the
  supported path.

---

## 3. Feature goals (by status)

### Done / considered complete for the release intent
- Direct block occupancy.
- Switch → in-game junction mapping (single-track and DoubleTrack).
- Server-side path CRUD and the staging/claim engine.
- Clean pathing enable/disable **state handling**: toggling `enablePathing` off
  releases claims and reverts all guard signals to Automatic; the map ⇄
  switchboard view toggle keeps active pathing running and server-synced in the
  background. (Note: the enable/disable *sweep itself still freezes the game* -
  every non-distant signal is mutated on the main thread in one frame; see
  CURRENT-STATE item 14. The teardown logic is clean, the performance is not.)
- Block colouring unified: occupied always reads as occupied regardless of path
  membership (single-source `resolveBlockColor` table; see §2a). The GF
  mapping fix and the crossover leg-swap fixes are done too.

### Blockers - must be fixed before a widespread release
1. **Path conflicts** between trains: no complete live-resolution exists yet.
   Conflict *prevention* is implemented in the claim engine (`StagingData`
   `TryClaimFrom` / `CalcRange` / `IsOpposing`: a path refuses to claim past
   opposing/upcoming traffic on a shared span, backing off and retrying).
   Live *resolution* of conflicts remains on hold; validate the prevention
   behaviour in real multi-train use before release.
   The **initial-claim hole** is closed: `TryClaimFrom`'s Case 2 branch
   (`opposingPaths.Count > 0`) no longer claims the next block unconditionally
   - it is merged into Case 1 and goes through the same `CalcRange` walk, so
   an extension claims only up to the point where no more opposing paths are
   detected (CURRENT-STATE item 16), and path seeding routes through the
   conflict-aware `TryClaimSeed` (item 12).
2. ~~**Occupied-block shortcut path win** (route-seeking)~~ - **resolved**: the
   switchboard route search now uses a **two-tier Dijkstra** in
   `PathingController.computeBlockPath` / `_ensurePathTree`:
   - **Valid tier** - occupied through-blocks are **hard-blocked** (except the
     source block itself) so a clear detour *always wins* over an occupied
     shortcut, however long the detour is.
   - **Soft tier** - same graph with the occupied-block penalty (extends the
     old `OCCUPIED_PENALTY` cost), used only when the valid tier cannot reach
     the destination (occupied destination, or genuinely no clear route), so a
     dispatcher is never dead-ended.
   The search still validates switch legality exactly as before (`_finalizePath`
   rejects wrong-way traversals), so no new invalid paths are shown. Both tiers
   share the per-source memoized cache and are invalidated together on
   occupancy change (`invalidatePathTree`). Known residual: switch-port data is
   incomplete for multi-switch blocks, so legibility enforcement is no worse
   than before (see CURRENT-STATE corresponding note).
3. **Occupancy is treated as "advance" before a block is ever claimed** -
   **fixed**: the staging engine's `Process()` now advances a path's
   `currentBlockIndex` only when the *next* block was **claimed by this path**
   and reads occupied; an unclaimed-but-occupied next block is treated as a hint
   to claim it, not to advance. Related restore bug also fixed: reloading /
   re-activating pathing (`InitializeFromPaths`) no longer blasts the whole
   lookahead window on the next tick - it seeds only the start block and arms
   the full 20s retry interval first. Residual: a train moving into a still-
   unclaimed block (before the seed window extends) stalls the path
   deliberately - the dispatcher can delete/recreate it. **Reload preservation
   (fixed)**: `InitializeFromPaths` no longer clears `_activeBlocks` - on a
   reload, already-tracked paths keep their claims exactly as they were and
   only genuinely new paths are seeded (CURRENT-STATE item 15).
4. **Path creation claims one block via an ad-hoc path (fixed)** -
   `PathingData.AddPath` seeds the new path through `StagingData.AddPath`, which
   now routes the first-block claim through the conflict-aware `TryClaimSeed`
   (StagingData.cs:352) instead of an unguarded `ActivateBlock`: it refuses to
   steal the start block when another active path holds it, while keeping the
   seed semantics (start block is the train's own occupied block).

### On hold / later
- Full UI polish (WIP but not release-blocking).
- **Switchboard layout fixes** (maintainer-owned, by hand): the **Bravo Yard
  section is still misplaced** in the single-track layout (`ST_2.1-hotfix.json`)
  and some Bravo Yard switches are drawn incorrectly in the DoubleTrack layout;
  also the **"Double track long switch near SW"** in the DT layout. Cosmetic
  layout-data bugs; not needed before the upcoming release.
- A **switchboard legend**: a visible colour key for block states
  (clear/path/occupied) and the per-path colour model. The block colouring
  scheme itself is defined and implemented (see §2a), but a legend needs
  dedicated UI time and is intentionally deferred.
- A **new DoubleTrack layout** for the (now released) new DoubleTrack mod
  version; scope/work owned by the maintainer.
- Path-conflict *resolution* (as opposed to prevention).

### Future plans (agreed backlog, not yet scheduled)

- **Custom path colours**: a colour picker per locked path in the sidebar
  (`renderPathList`), persisted server-side (a `color` field on the path
  payload + a `PATCH /path/{id}/color` endpoint mirroring the note endpoint);
  `pathsSignatureChanged` must become colour-aware so the sidebar repaints.
- **Path-choosing revamp**: creating a new path should use the *same* drafting
  flow as extending (anchored draft, hover preview, waypoints, chained
  sections - POST the first section, PATCH subsequent ones) instead of the
  current one-shot start/dest selection.
- **Claim-engine revamp**:
  - Initial claiming: on path creation, seed the start block and extend the
    lookahead window synchronously (mirroring the `UpdatePath` fix) instead of
    waiting for the next `Process()` tick. **(Done)** - a single `Advance`
    function now handles seed + window extension and runs synchronously from
    `AddPath` / `InitializeFromPaths` (startup check), `UpdatePath`, the manual
    claim button, and the periodic `Process()` check; the 5s `ClaimInterval`
    timer only paces the ordinary automatic extension.
  - Editable claiming amount: a per-path "blocks ahead" value in the sidebar,
    sent as `lookAhead` and actually used to bound that path's claim window
    (the field is currently vestigial; `MaxAutoClaimAhead`/`MaxTrainClaimAhead`
    rule today).
  - Claimed sections ending right before signals: claiming proceeds only when
    the whole section up to the next signal is good to claim. Details TBD when
    picked up.
- **Yard switches ignore short track sections between junctions** for Direct
  occupancy: skip short `outBranch` tracks that have a junction at the far end
  when checking switch-block occupancy (data already available via
  `_trackEndpointJunctionsCache` + track span).
- **Job active/inactive indicators**: Active vs Available only (uses the
  existing `isActive` field), shown in the sidebar job list and on map-view
  cars for cars on active jobs.
- **Job start/complete buttons** in the sidebar job list: a new `canControlJobs`
  permission flag; `POST /jobs/{id}/start` (`Job.TakeJob`) and
  `POST /jobs/{id}/complete` (validate-first via
  `JobsManager.TryToCompleteAJob`); main-thread marshalled, mirroring
  `/car/{guid}/control`.
- **`loco_list_RD` integration**: `../loco_list_RD` is a sibling directory
  holding an older fork of this mod; integration means porting the relevant
  functionality from that fork (feature to be identified when picked up).

---

## 2a. Block colouring scheme (accepted)

The single-source palette for switchboard blocks lives in
`TrackRenderer.resolveBlockColor`. Each **locked path** is assigned a stable,
random **blue-dominant** colour (generated by `randomPathColor`, with B ≥ G ≥ R
so a path never reads red or green; kept in `_pathColors` so it persists across
polls/reloads). Block colour derives from the paths that touch it:

- **Clear** (no path, and no occupancy) - gray.
- In **exactly one upcoming path** - that path's base colour.
- In **more than one upcoming path** - per-channel blend (`blendColor`) of each
  path's colour, still blue-dominant.
- **Claimed** by an active path (staging current/lookahead window) - the
  path's colour boosted toward green (`claimColor`, held below `#90f090`) so a
  claimed block stands out from upcoming ones.
- **Occupied** - red (`OCCUPIED_RED`), and it **always wins** regardless of
  path membership.

Priority: Red (occupied) > claimed (green-boosted path colour) > overlap blend
> single upcoming path colour > gray. Draft path-selection highlighting
(start/dest hover) is transient UX and independent of this scheme. The sidebar
path chips use the same `resolveBlockColor` result, so a chip matches its block
on the board.

---

## 4. Roadmap direction

1. **Ship** the release: fix the blockers above, keep pathing conflict-free by
   prevention, disable Hardcore mode. Before shipping: verify **parity with
   upstream's signal-integration work** (still in flux upstream - frequent
   progress checks + parity merges, CURRENT-STATE release blocker #4) and run
   **exhaustive testing across all currently available signal packs**
   (CURRENT-STATE release blocker #5), including DoubleTrack where the signal
   flip interaction is suspected.
2. **Make the switchboard layout an asset.** Move the anchor (and, eventually,
   more mapping metadata) *into the layout file*, so community members can
   author and upload their own switchboard layouts without code changes. Layouts
   remain hand-crafted for quality - not runtime-generated.
3. **Revisit path conflict resolution** properly once the release is stable,
   if cooperative (multi-train) routing is wanted.
4. Keep the switchboard as the home of future dispatcher features, always
   standalone and opt-in; cars, players, and locos stay on the classic map.

---

## 5. Explicit non-goals

- Runtime-generated switchboard layouts (kept hand-crafted for quality).
- Representing players in the switchboard.
- Making aspect-inference (Hardcore) a first-class/supported occupancy mode.
- Making the switchboard mandatory for any user.
