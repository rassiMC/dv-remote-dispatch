# Contributing to RemoteDispatch

Thanks for your interest in contributing. This document covers how to get set up, how the codebase is organised, and what to keep in mind when submitting changes.

---

## Project overview

The three main moving parts:

- **The game watchers** (`Engine/`) hook into Unity events and Harmony patches to detect when something changes.
- **The session system** (`Server/Session.cs`, `Server/AsyncSet.cs`) tracks which data each connected client (web browser session) still needs to receive, using a tag-based long-poll mechanism rather than constant polling.
- **The HTTP server** (`Server/HttpServer.cs`) serialises game state to JSON and pushes it out to the client, and routes incoming control commands back into the game on the main thread.

There is also an optional **Signals sub-project** (`RemoteDispatch.Signals/`) — a separate assembly that integrates with the [DVSignals](https://github.com/Fuggschen/dv-signals-test) mod if it is installed. It is loaded at runtime via reflection by `SignalsShim.cs` in the main project, so the core mod has no compile-time dependency on it.

---

## Setting up

### Prerequisites:

- [Derail Valley](https://www.derailvalley.com/) with [UnityModManager](https://www.nexusmods.com/site/mods/21) installed
- [dotnet SDK](https://dotnet.microsoft.com/download) version 6 or later
  (`dotnet --version` to confirm its on your PATH)

#### Optional, but these are our recommendations:

- [Windows Only] [Full Interactive Developer Environment] [Visual Studio Community](https://visualstudio.microsoft.com/vs/community/) is free for open source use
  During installation, select the **.NET desktop development** workload as this includes the Dotnet SDK and everything else needed to build the mod
- [Text editor] [Visual Studio Code]()
  Install the [C# Dev Kit extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit) and point it at the `.sln` file


### Building for the first time

1. Clone the repository
2. Create a `Directory.Build.props` file from this example in the root of the repo, this is a personal file and should not be committed back to the repo:
    ```xml
    <Project>
        <PropertyGroup>
            <!-- Replace this with the path to Derail Valley on your machine -->
            <DvInstallDir>C:\Program Files\Steam\steamapps\common\Derail Valley</DvInstallDir>
        </PropertyGroup>
    </Project>
    ```
3. With your terminal in the root of the repo (same directory as the `RemoteDispatch.slnx` file), run this command:
    `dotnet build -v detailed`
4. This will give you an output something like this:
    ```
    Restore complete (0.3s)
        Determining projects to restore...
        All projects are up-to-date for restore.
      RemoteDispatch.Signals netstandard2.0 succeeded (0.1s) → RemoteDispatch.Signals\bin\Debug\netstandard2.0\RemoteDispatch.Signals.dll
      RemoteDispatch netstandard2.0 succeeded (0.8s) → RemoteDispatch\bin\Debug\netstandard2.0\RemoteDispatch.dll
        Deployed to: C:\Program Files\Steam\steamapps\common\Derail Valley\Mods\RemoteDispatch

    Build succeeded in 1.4s
    ```
5. Go into your RemoteDispatch mod folder (DerailValley location, /Mods/RemoteDispatch), and make sure there is no .cache file, delete it if there is one as this will be an _older_ version of the mod.
6. Run the game and make sure RemoteDispatch is enabled in UMM

#### Linux users

Part of the build process is the package script, this will not run for you by default and you will need to manually grab the .DLLs and copy them to your mods folder. Installing powershell core and running the package script manually will work, and if you want to commit a change to the RemoteDispatch.csproj file to invoke this for Linux as well I would appreciate it.

#### Release builds

Run `dotnet build -c Release -v detailed` and the package script will create a zip file in a dist folder.

---

## Code organisation

```
RemoteDispatch/
├── Main.cs            # Mod entry point, lifecycle (enable/disable/reload)
├── Settings.cs        # Port, password, per-user permissions, in-game GUI
├── Engine/
│   ├── CarUpdater.cs       # Harmony hooks on car spawn/despawn and control changes
│   ├── JunctionPatches.cs  # Harmony hook on Junction.Switch
│   ├── LocoControl.cs      # Sends throttle/brake/reverser commands to RemoteControllerModule
│   └── Updater.cs          # Unity coroutines; RunOnMainThread bridge for async code
├── Data/
│   ├── CarData.cs          # Snapshots car and loco state to JSON-serialisable objects
│   ├── JobData.cs          # Job and task data; Harmony hooks on job state changes
│   ├── PlayerData.cs       # Player position and Steam name
│   └── RailTracks.cs       # Track geometry and junction positions, baked to lat/lon
└── Server/
│   ├── AsyncSet.cs         # Thread-safe set with async TakeAsync, used for pending tags
│   ├── HttpServer.cs       # HttpListener; routes requests, handles auth and gzip
│   └── Session.cs          # Per-client sessions; tag-based change notification
└── Shims/
│   └── SignalsShim.cs      # Optional runtime integration with the DVSignals mod
└── frontend/
    └── *                   # Frontend code

RemoteDispatch.Signals/     # Separate assembly, only loaded if DVSignals mod is installed
├── Bootstrap.cs            # Public entry point called by SignalsShim via reflection
└── SignalsBridge.cs        # Stubs for reading/writing signal aspects
```

---

## How the update system works

Understanding this makes it much easier to add new data types.

When something in the game changes, the relevant watcher calls `Sessions.AddTag("some-tag")`. This queues the tag in every active client session's `AsyncSet<string>`. Clients long-poll `GET /updates/<sessionId>` — if there are pending tags they get them immediately; otherwise the request suspends for up to one minute waiting.

When the server assembles the response, it calls `GetUpdateForTag(tag)` to serialise the current state for each pending tag into a JSON object, keyed by tag name.

To add a new data type:

1. Add a serialiser in `Data/` that returns a `JObject` or `JToken`.
2. Add a case to `GetUpdateForTag` in `Session.cs`.
3. Add whatever game-side watcher calls `Sessions.AddTag("your-tag")` when the data changes — either a Harmony patch in `Engine/`, an event subscription in `CarUpdater.cs`, or a coroutine in `Updater.cs`.
4. Add an HTTP endpoint in `HttpServer.cs` if you also want clients to be able to fetch the data on demand (outside of the update stream).

---

## Harmony patches

All patches are applied when the mod is enabled and removed when it is disabled or toggled off.

If you add a new patch class, place it in the file most relevant to what it's patching (`CarUpdater.cs` for car/loco patches, `JunctionPatches.cs` for junction patches, `JobData.cs` for job patches).

---

## The optional Signals integration

`SignalsShim.cs` loads `RemoteDispatch.Signals.dll` at runtime via reflection if the DVSignals mod is present. The main project has no compile-time dependency on Signals. If your change touches signal-related behaviour, it belongs in the separate Signals integration assembly, not in the core project.

---

## Submitting changes

- **Keep pull requests focused.** One feature or fix per PR makes review much easier.
- **Test in-game** with at least one connected client before submitting. The update loop, auth, and gzip path are all worth exercising.
- **Don't break the HTTP contract.** The JSON shape returned by each endpoint is consumed by the frontend and potentially by third-party tools. Additive changes (new fields) are fine; removing or renaming fields is a breaking change and needs a discussion first.

## AI

Using AI to help you write the code is fine, using AI to explain the code to you is fine, using AI to write all the code is fine.

Using AI to write code that you have not read and do not understand is not fine.

Rule of thumb: *Only use AI to help you write code that you could have written without AI.* This means you can use it to speed you up, or to learn, but please do not just try to vibe-code an entire feature.
