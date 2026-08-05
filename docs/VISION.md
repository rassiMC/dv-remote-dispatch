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
- Switch → in-game junction mapping (single-track and DoubleTrack), modulo the
  known one-junction issue (see blockers).
- Server-side path CRUD and the staging/claim engine.
- Clean pathing enable/disable: toggling `enablePathing` off releases claims and
  reverts all guard signals to Automatic; the map ⇄ switchboard view toggle keeps
  active pathing running and server-synced in the background.

### Blockers - must be fixed before a widespread release
1. The one in-game junction that breaks a station's mapping on **both** the
   single-track and DoubleTrack layouts in GF. (Owner: maintainer.)
2. **Block colouring** - occupied blocks should always be identifiable as
   occupied. (currently paths just draw "over" blocks not checking that).
3. **Path conflicts** between trains: no complete live-resolution exists yet.
   For the upcoming release, **prevent conflicts entirely** (don't allow
   overlapping claims) rather than resolve them on the fly.

### On hold / later
- Full UI polish (WIP but not release-blocking).
- A **DoubleTrack 2.0-ready layout**: will need a new switchboard layout once
   the scope of the next DoubleTrack release is known.
- Path-conflict *resolution* (as opposed to prevention).

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
