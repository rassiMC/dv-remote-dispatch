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
- Clean pathing enable/disable: toggling `enablePathing` off releases claims and
  reverts all guard signals to Automatic; the map ⇄ switchboard view toggle keeps
  active pathing running and server-synced in the background.
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
2. **Occupied-block shortcut path win** (route-seeking) - the switchboard route
   search can end up showing **no path at all** where a valid one exists.
   Occupancy only raises a block's step cost (`_edgeCost`, `OCCUPIED_PENALTY`),
   so an invalid route through an occupied through-block can beat a valid longer
   detour (e.g. +25 nodes) on raw cost. The invalid suggestion always "wins" the
   draw, is shown first, and is only *discarded afterwards*; the valid alternative
   is never suggested, and when the only valid route is long enough it is dropped
   too, leaving the dispatcher with no path. Fix intent: have the search treat
   occupied through-blocks as **blocked** (validate per-block, not by cost
   penalty), and fall back to the penalised-cost route only when no valid route
   exists, keeping the start/dest exemptions.
3. **Occupancy is treated as "advance" before a block is ever claimed** - the
   staging engine's `Process()` (StagingData.cs:585-614) advances a path's
   `currentBlockIndex` whenever the *next* block reads occupied, regardless of
   whether the path had claimed it. A path is seeded with only its start block
   claimed (`AddPath` claims just the first block up front); if the train moves
   into the next block before staging has claimed it (idle window, 20s retry
   backoff, or a claim refused by conflict-aware gating), occupancy alone is
   taken as `trainAdvanced` - the path jumps forward, prunes past blocks it never
   claimed, and the implicit claim window abandons the unclaimed span. Fix intent:
   only treat occupancy as advancement when the block was actually claimed by this
   path first; an unclaimed-but-occupied next block should be a signal to claim
   it, not to advance.
4. **Path creation claims one block via an ad-hoc path** - `PathingData.AddPath`
   seeds the new path by calling `StagingData.AddPath` (StagingData.cs:83-106),
   which claims the first block directly through a private **direct** call to
   `ActivateBlock`, bypassing the conflict-aware `TryClaimFrom` / `CalcRange`
   machinery. (The comment in §4.4 says "seeds a new path with only its start
   block claimed from `_retryTimes`" - the real code inlines that instead of
   delegating to a seed/claim entry point.) Consequence: the claim happens without
   the opposing/upcoming-traffic checks the rest of the engine applies. Fix intent:
   have path creation route the first-block claim through the same function the
   engine uses (`TryClaimFrom` with a "seed only" bound), so seeding gets the same
   conflict-aware validation instead of an unguarded `ActivateBlock`.

### On hold / later
- Full UI polish (WIP but not release-blocking).
- **HB Bravo Yard misdrawn switches**: in both the single-track and DoubleTrack
  layouts, some switches in HB Bravo Yard are drawn incorrectly. Cosmetic
  layout-data bug; not needed before the upcoming release.
- A **switchboard legend**: a visible colour key for block states
  (clear/path/occupied) and the per-path colour model. The block colouring
  scheme itself is defined and implemented (see §2a), but a legend needs
  dedicated UI time and is intentionally deferred.
- A **DoubleTrack 2.0-ready layout**: will need a new switchboard layout once
   the scope of the next DoubleTrack release is known.
- Path-conflict *resolution* (as opposed to prevention).

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
   prevention, disable Hardcore mode.
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
