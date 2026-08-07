# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] - 2026-08-06

### Added

- Switchboard block-level pathing/staging: server-side route claims, look-ahead
  windows, and per-block signal/switch control.
- Direct block occupancy via the Signals API `IsTrackOccupied`.
- Conflict-aware path claiming queue: `StagingData` now gates claims through
  `TryClaimFrom`/`CalcRange`, refusing to claim past opposing or upcoming
  traffic on a shared span (`IsOpposing`) and backing off with a 20s retry
  timer; new paths seed with only their start block, auto-claiming stops
  five blocks ahead. Manual "advance next" claims a single block when clear,
  or the cleared range when passing opposing traffic.

### Fixed

- GF switch mapping: `BuildTrackGraph`/`TraceToJunctions` now match track
  endpoints by position proximity instead of exact (rounded) coordinate
  strings, resolving the junction that broke a station's switch mapping on both
  the single-track and DoubleTrack layouts. The J26 `GRAPH_OVERRIDES` entry was
  removed.
- Removed the redundant `GRAPH_OVERRIDES` for J26.
- Switchboard layouts re-exported as `ST_2.1-hotfix.json` (single-track) and
  `DT_2.1-hotfix.json` (DoubleTrack); obsolete `RD_1.0.4/1.0.7/1.0.8` and
  `DoubbleTrack1.0_1.4.3` files removed.
- Residual DoubleTrack crossover leg-swaps (e.g. MF J-632/J-546, J-636/J-638)
  fixed: junction `degree` is now capped at 3 in `/graph` so dense crossovers
  no longer report a spurious fourth continuation, and `repairMapping()` runs
  after the parallel walk to correct any remaining swapped pairs. The switch
  mapping is now a clean 641/641 bijection with zero consistency violations.
- Switchboard block colours unified into a single source of truth
  (`TrackRenderer.resolveBlockColor`): gray clear, green claimed by an active
  path, light blue in exactly one upcoming path, yellow in more than one path,
  and red always wins for occupied blocks. Removed the per-file
  `PathingController.getOverridesForSegment`/`getSwitchRimColor` override
  path; switch segments now repaint correctly on path sync, and sidebar path
  chips use the same palette.

## [1.6.1] - 2026-04-04

### Fixed

- Fixed misalignment of junction icons introduced in 1.6.0

## [1.6.0] - 2026-04-04

### Added

- Junctions (switches/points) now display their in game names as shown when pointing at them with the comms radio
- Adds a search box ("go to box") in the top right that searches for Junctions, Locomotives, and Signals as you type, clicking on an option will "zoom" the view to the selected option.
- Adds beta Signals support. Default feature flag is "off"

## [1.5.1] - 2026-03-30

### Added

- [@radostin04] Add configurable default permissions for new users

## [1.5.0] - 2026-03-28

### Added

- [@radostin04] Add two new per-player configurable settings - Player Blips and Locomotive Visibility.
    - When Player Blips is disabled, users will not see players on the map, regardless of their frontend settings. If Player Blips is enabled, they can still choose to disable them on the frontend.
    - When Locomotive Visibility is disabled, locomotives will not show up on the map. Cars will still show up - this means that players could still keep track of a train's location by looking at the ways cars are moving, but they can't use player blips or highlighted locomotives to know where trains are.

## [1.4.1] - 2026-03-18

### Fixed

- Fixed an issue where a player leaving the game (or any other error in the Javascript) would stop the update loop from continuing.

## [1.4.0] - 2026-03-11

### Added

- Player icons now scale, there is a checkbox in the settings side-bar (cog) to toggle this on and off. Toggling this on will make the player icons visible from any level of zoom.
- Player names, there is a checkbox in the settings side-bar (cog) to toggle this on and off. Toggling this on will show the player name below and slightly to the right of the icon, making it easier to identify which player is which when multiple players are visible on the map at once. The player names are "pushed" from the Multiplayer Mod, so if you have renamed yourself in the multiplayer mod, that name will be used here as well.

## [1.3.0] - 2026-03-09

### Added

- Individual Locomotive scaling setting, allowing you to adjust the size of locomotives on the map independently from each other. Designed specifically to allow for dispatchers to track multiple trains at once over the whole map.

## [1.2.1] - 2025-04-28

For release 1.2.1 and before, see the original mod release history by [Zeibach](https://www.nexusmods.com/profile/Zeibach) on Nexus Mods: https://www.nexusmods.com/derailvalley/mods/328?tab=files or on GitHub: https://github.com/mspielberg/dv-remote-dispatch/releases
