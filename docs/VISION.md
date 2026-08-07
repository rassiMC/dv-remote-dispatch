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
  required switch alignments and the signals to clear.
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

### On hold / later
- Full UI polish (WIP but not release-blocking).
- **HB Bravo Yard misdrawn switches**: in both the single-track and DoubleTrack
  layouts, some switches in HB Bravo Yard are drawn incorrectly. Cosmetic
  layout-data bug; not needed before the upcoming release.
- A **switchboard legend**: a visible colour key for block states (clear/path/occupied).
  The block colouring scheme itself is defined and implemented (see below), but a legend
  needs dedicated UI time and is intentionally deferred.
- A **DoubleTrack 2.0-ready layout**: will need a new switchboard layout once
   the scope of the next DoubleTrack release is known.
- Path-conflict *resolution* (as opposed to prevention).

---

## 2a. Block colouring scheme (accepted)

The unified, single-source-of-truth palette for switchboard blocks. `Occupied`
always wins regardless of path membership; a block claimed by an active path is
Green even if another upcoming path also includes it.

| Block situation                                  | Colour |
|--------------------------------------------------|--------|
| Not occupied, no pathing info                    | Gray |
| Claimed by an active path (staging current/lookahead window) | Green |
| Will be in exactly one upcoming path             | Light Blue |
| Will be in more than one path                    | Yellow |
| Occupied (regardless of path membership)         | Red |

Priority: Red (occupied) > Green (claimed) > Yellow (>1 upcoming) > Light Blue
(exactly 1 upcoming) > Gray. Draft path-selection highlighting (start/dest
hover) is transient UX and independent of this scheme.

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
