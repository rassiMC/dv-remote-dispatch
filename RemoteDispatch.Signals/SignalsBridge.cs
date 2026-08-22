using System;
using System.Collections.Generic;
using System.Linq;
using Signals.Game;
using Signals.Game.Aspects;
using Signals.Game.Controllers;
using Signals.Game.Railway;
using UnityEngine;

using SgSignal = Signals.Game.Signal;

namespace DvMod.RemoteDispatch.Signals
{
    /// <summary>
    /// Bridge to the new Signals mod (WhistleWiz/dv-signals, GUID "DVSignals", no Signals.API).
    /// Talks to Signals.Game public classes directly: SignalManager, BasicSignalController,
    /// Signal, JunctionSignalController, TrackBlock, TrackReserver.
    /// Produces the same Dictionary&lt;string signalId, object&gt; projection that
    /// RemoteDispatch.Shims.SignalsShim expects (see SignalsShimHelpers.MinimalSignalDataProjection).
    /// </summary>
    internal class SignalsBridge
    {
        /// <summary>Callbacks to invoke on event</summary>
        private readonly Action<string, string>? _onAspectChanged;
        private readonly Action<string, string>? _onModeChanged;

        // Track which signals we've subscribed to, so we can clean up.
        private readonly HashSet<SgSignal> _subscribedSignals = new HashSet<SgSignal>();

        // The main thread (captured in Register, which runs during mod load on the
        // Unity main thread). Signal.UpdateAspect touches Unity display objects and
        // must only run there; GetAllSignals may be invoked from the HTTP thread.
        private int _mainThreadId = -1;

        /// <summary>Constructor - inject callbacks for forward compat</summary>
        internal SignalsBridge(Action<string, string>? onAspectChanged = null, Action<string, string>? onModeChanged = null)
        {
            _onAspectChanged = onAspectChanged;
            _onModeChanged = onModeChanged;
        }

        /// <summary>
        /// Registers event handlers on the SignalManager static events and subscribes to already-existing signals.
        /// </summary>
        /// <remarks>Call this method to enable automatic handling of Signals.Game lifecycle events within
        /// the current context. This method should be called only once per instance to avoid multiple
        /// registrations.</remarks>
        internal void Register()
        {
            _mainThreadId = System.Threading.Thread.CurrentThread.ManagedThreadId;
            SignalManager.AspectChanged += OnSignalAspectChanged;
            SignalManager.OperationModeChanged += OnSignalOperationModeChanged;
            SignalManager.OverrideChanged += OnSignalOverrideChanged;

            SubscribeToExistingSignals();

            LoggingReturn.DebugLog?.Invoke("Signals bridge registered.");
        }

        /// <summary>
        /// Unregisters event handlers from the SignalManager static events and unsubscribes from signals.
        /// </summary>
        /// <remarks>Call this method to detach previously registered event handlers and prevent further
        /// callbacks from the SignalManager. This is typically used during cleanup to avoid memory leaks or unintended
        /// behavior after the object is no longer needed.</remarks>
        internal void Unregister()
        {
            SignalManager.AspectChanged -= OnSignalAspectChanged;
            SignalManager.OperationModeChanged -= OnSignalOperationModeChanged;
            SignalManager.OverrideChanged -= OnSignalOverrideChanged;

            if (SignalManager.Instance != null)
            {
                foreach (var signal in _subscribedSignals)
                {
                    UnsubscribeFromSignal(signal);
                }
            }

            _subscribedSignals.Clear();
        }

        private void SubscribeToExistingSignals()
        {
            if (SignalManager.Instance == null) return;

            foreach (var controller in SignalManager.Instance.AllControllers)
            {
                foreach (var signal in controller.AllSignals)
                {
                    SubscribeToSignal(signal);
                }
            }
        }

        private void SubscribeToSignal(SgSignal signal)
        {
            if (!_subscribedSignals.Add(signal)) return;

            signal.AspectChanged += OnInstanceAspectChanged;
            signal.OperationModeChanged += OnInstanceModeChanged;
            signal.OverrideChanged += OnInstanceOverrideChanged;
        }

        private void UnsubscribeFromSignal(SgSignal signal)
        {
            if (signal.Definition != null)
            {
                signal.AspectChanged -= OnInstanceAspectChanged;
                signal.OperationModeChanged -= OnInstanceModeChanged;
                signal.OverrideChanged -= OnInstanceOverrideChanged;
            }
        }

        // Static (SignalManager-level) handlers.
        private void OnSignalAspectChanged(SgSignal signal, IAspect? aspect)
        {
            if (signal.Definition == null) return;
            _onAspectChanged?.Invoke(signal.Name, aspect?.Id ?? "OFF");
        }

        private void OnSignalOperationModeChanged(SgSignal signal, SignalOperationMode mode)
        {
            if (signal.Definition == null) return;
            _onModeChanged?.Invoke(signal.Name, ModeToString(mode));
        }

        private void OnSignalOverrideChanged(SgSignal signal, int _)
        {
            if (signal.Definition == null) return;
            _onAspectChanged?.Invoke(signal.Name, signal.CurrentAspect?.Id ?? "OFF");
        }

        // Instance-level handlers.
        private void OnInstanceAspectChanged(IAspect? _)
        {
            // The instance handlers only fire for the owning bridge instance; the static
            // SignalManager handlers already cover the changes, so a direct callback is
            // not needed here. The Signal is captured via the per-signal subscription.
        }

        private void OnInstanceModeChanged(SignalOperationMode _)
        {
        }

        private void OnInstanceOverrideChanged(int _)
        {
        }

        private static string ModeToString(SignalOperationMode mode)
        {
            // Old API surfaced SignalMode.Manual / SignalMode.Automatic. The new mod has four
            // operation modes; any manual-ish mode is reported to the frontend as "Manual".
            switch (mode)
            {
                case SignalOperationMode.Automatic:
                    return "Automatic";
                case SignalOperationMode.TempOverride:
                case SignalOperationMode.SemiManual:
                case SignalOperationMode.FullManual:
                    return "Manual";
                default:
                    return "Automatic";
            }
        }

        /// <summary>
        /// Returns the current aspect ID of a signal by its display name, or null if not found.
        /// </summary>
        internal string? GetSignalAspect(string signalId)
        {
            var signal = FindSignalByName(signalId);
            if (signal == null) return null;
            return signal.CurrentAspect?.Id ?? "OFF";
        }

        /// <summary>
        /// Returns all signals with raw world coordinates (not yet converted to lat/lng).
        /// </summary>
        internal Dictionary<string, object> GetAllSignals()
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);

            try
            {
                if (SignalManager.Instance == null) return result;

                // UpdateAspect touches Unity display objects and is main-thread-only.
                // From the HTTP thread we skip the sweep; the new fork's own 1s update
                // loop keeps aspects fresh, and SubscribeToExistingSignals (main thread)
                // already opened the subscription map for event-driven pushes.
                if (_mainThreadId == System.Threading.Thread.CurrentThread.ManagedThreadId)
                    ForceUpdateAllSignalAspects();

                foreach (var controller in SignalManager.Instance.AllControllers)
                {
                    if (!controller.Exists) continue;

                    // A junction group's BranchSignals are created in outBranches order
                    // (branch 0 = left, branch 1 = right), so the controller's index
                    // inside its group's branch list is the left/right discriminator
                    // for In (branch) signals.
                    var group = controller.Group;
                    int? branchIndex = null;
                    if (group?.BranchSignals != null && controller is TrackSignalController trackController)
                    {
                        var idx = group.BranchSignals.IndexOf(trackController);
                        if (idx >= 0)
                            branchIndex = idx;
                    }

                    foreach (var signal in controller.AllSignals)
                    {
                        if (signal.Definition == null) continue;

                        // Keep an up-to-date subscription map open so event-driven
                        // signals pushes keep working.
                        SubscribeToSignal(signal);

                        var block = signal.Block;
                        var junction = controller.GroupJunction;
                        var junctionId = junction?.junctionData.junctionIdLong;
                        var direction = GetDirection(controller);
                        var type = TypeToString(controller.Type);
                        var position = signal.Definition.transform.position;

                        result[signal.Name] = new
                        {
                            Id = signal.Name,
                            Type = type,
                            Mode = ModeToString(signal.Operation),
                            CurrentAspectId = signal.CurrentAspect?.Id ?? "OFF",
                            IsOn = signal.IsOn,
                            Direction = direction,
                            JunctionId = junctionId,
                            RequiredBranch = direction == "In" ? branchIndex : (int?)null,
                            SelectedBranch = junction?.selectedBranch,
                            YardId = block?.Yard,
                            TrackId = block?.TrackNumber,
                            Position = new[] { position.x, position.z },
                        };
                    }
                }
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"GetAllSignals failed: {ex.Message}");
            }

            return result;
        }

        private static string GetDirection(BasicSignalController controller)
        {
            // TrackDirection.Out/In is assigned per controller at placement time
            // (SignalPlacer), so it is the authoritative In/Out for every signal
            // type - no name-suffix parsing needed.
            if (controller.PlacementInfo is { } placement)
            {
                switch (placement.Direction)
                {
                    case TrackDirection.Out:
                        return "Out";
                    case TrackDirection.In:
                        return "In";
                }
            }

            // Signals placed on a junction's approach track are the Out (facing)
            // signal; anything else with no placement data is treated as Out.
            return "Out";
        }

        private static string TypeToString(SignalType type)
        {
            // Old API SignalType values: NotSet, Mainline, IntoYard, Shunting, Distant, Other.
            // The new mod's SignalType is richer; fold it back to the legacy names.
            switch (type)
            {
                case SignalType.Mainline:
                    return "Mainline";
                case SignalType.Entry:
                case SignalType.Exit:
                case SignalType.ExitPax:
                case SignalType.ExitMainline:
                case SignalType.Spacing:
                    return "IntoYard";
                case SignalType.Shunting:
                    return "Shunting";
                case SignalType.Distant:
                    return "Distant";
                default:
                    return "Other";
            }
        }

        /// <summary>
        /// Checks whether the given track has any trains physically on it.
        /// </summary>
        internal bool IsTrackOccupied(RailTrack track)
        {
            if (track == null) return false;
            try
            {
                // Equivalent to the old API's IsTrackOccupied / the new mod's internal
                // Extensions.HasBogies(). RailTrackOnTrackBogiesExtensions is a public
                // static helper in Assembly-CSharp (global namespace).
                return RailTrackOnTrackBogiesExtensions.BogiesOnTrack(track).Count > 0;
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"IsTrackOccupied failed: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Sets a signal to the specified aspect. Returns true on success.
        /// </summary>
        internal bool SetSignalAspect(string signalId, string aspect)
        {
            if (!IsMainThread())
            {
                LoggingReturn.Warning?.Invoke($"SetSignalAspect({signalId}, {aspect}) called off the Unity main thread - signal mutations must run there.");
                return false;
            }

            var signal = FindSignalByName(signalId);
            if (signal == null) return false;

            LoggingReturn.Log?.Invoke($"Attempting to set signal aspect: {signalId} -> {aspect}");

            try
            {
                // Resolve the aspect index by ID, then set FullManual + override so the
                // aspect sticks (mirrors old SetAspectById behaviour).
                for (int i = 0; i < signal.AllAspects.Length; i++)
                {
                    if (string.Equals(signal.AllAspects[i].Id, aspect, StringComparison.OrdinalIgnoreCase))
                    {
                        signal.ChangeOperationMode(SignalOperationMode.FullManual);
                        signal.SetAspectOverride(i);
                        var changed = signal.ChangeAspect(i);
                        signal.UpdateDisplays(changed);
                        signal.UpdateIndicators();
                        return true;
                    }
                }

                LoggingReturn.Warning?.Invoke($"Aspect '{aspect}' not found on signal '{signalId}'.");
                return false;
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"SetSignalAspect({signalId}, {aspect}) failed: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Sets a signal to the specified mode. Returns true on success.
        /// </summary>
        /// <param name="signalId">The ID of the signal</param>
        internal bool SetSignalMode(string signalId, string mode)
        {
            if (!IsMainThread())
            {
                LoggingReturn.Warning?.Invoke($"SetSignalMode({signalId}, {mode}) called off the Unity main thread - signal mutations must run there.");
                return false;
            }

            var signal = FindSignalByName(signalId);
            if (signal == null) return false;

            LoggingReturn.DebugLog?.Invoke($"Attempting to set signal mode: {signalId} -> {mode}");

            try
            {
                SignalOperationMode parsed;
                switch (mode)
                {
                    case "Manual":
                        parsed = SignalOperationMode.FullManual;
                        break;
                    case "Automatic":
                        parsed = SignalOperationMode.Automatic;
                        break;
                    default:
                        LoggingReturn.DebugLog?.Invoke($"Failed to parse signal mode: {signalId} -> {mode}");
                        return false;
                }

                return signal.ChangeOperationMode(parsed);
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"SetSignalMode({signalId}, {mode}) failed: {ex.Message}");
                return false;
            }
        }

        private bool IsMainThread()
        {
            return _mainThreadId < 0 || System.Threading.Thread.CurrentThread.ManagedThreadId == _mainThreadId;
        }

        private static SgSignal? FindSignalByName(string signalId)
        {
            if (string.IsNullOrEmpty(signalId) || SignalManager.Instance == null) return null;

            foreach (var controller in SignalManager.Instance.AllControllers)
            {
                foreach (var signal in controller.AllSignals)
                {
                    if (string.Equals(signal.Name, signalId, StringComparison.OrdinalIgnoreCase))
                    {
                        return signal;
                    }
                }
            }

            return null;
        }

        /// <summary>
        /// Resolves the pack file key for the current Signals.Game pack.
        /// Returns "DVSignalpack-default" when no custom pack is enabled, or
        /// "DVSignalpack-&lt;ModId&gt;" for an enabled custom pack.
        /// </summary>
        internal static string GetPackKey()
        {
            try
            {
                var pack = SignalManager.CurrentPack;
                if (pack == null) return "DVSignalpack-default";

                // A custom pack is enabled when the user selected one in the DVSignals settings.
                var custom = SignalsMod.Settings.CustomPack;
                if (string.IsNullOrEmpty(custom)) return "DVSignalpack-default";

                var modId = pack.ModId;
                if (string.IsNullOrEmpty(modId)) return "DVSignalpack-default";

                var sanitized = Sanitize(modId);
                return string.IsNullOrEmpty(sanitized) ? "DVSignalpack-default" : $"DVSignalpack-{sanitized}";
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"GetPackKey failed: {ex.Message}");
                return "DVSignalpack-default";
            }
        }

        internal static string Sanitize(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            var chars = value.ToCharArray();
            for (int i = 0; i < chars.Length; i++)
            {
                char c = chars[i];
                if (!char.IsLetterOrDigit(c) && c != '.' && c != '_' && c != '-')
                    chars[i] = '_';
            }
            return new string(chars);
        }

        /// <summary>
        /// Builds a capture snapshot for the given signal name. Must be called on the main thread.
        /// Returns null if the signal could not be found.
        /// The returned object serializes to:
        /// { PackId, PackVersion, PackName, Lamps: [{Name,Colour,Position:[x,y,z]}], CurrentAspectId, DisallowPassing, Lit: [], Blinking: [] }
        /// </summary>
        internal object? CaptureSignal(string signalName)
        {
            var signal = FindSignalByName(signalName);
            if (signal == null || signal.Definition == null) return null;

            try
            {
                var pack = SignalManager.CurrentPack;
                var packId = pack?.ModId ?? string.Empty;
                var packVersion = pack?.Version ?? string.Empty;
                var packName = pack?.ModName ?? string.Empty;

                var lamps = new List<object>();
                foreach (var light in signal.AllLights)
                {
                    var def = light.Definition;
                    if (def == null) continue;

                    var localPos = signal.Definition.transform.InverseTransformPoint(def.transform.position);
                    lamps.Add(new
                    {
                        Name = def.gameObject.name,
                        Colour = ColorUtility.ToHtmlStringRGBA(def.Colour),
                        Position = new[] { localPos.x, localPos.y, localPos.z },
                    });
                }

                var aspect = signal.CurrentAspect;
                string aspectId = aspect?.Id ?? "OFF";
                bool disallowPassing = false;
                var lit = new List<string>();
                var blinking = new List<string>();

                if (aspect != null)
                {
                    var def = aspect.GetDefinition();
                    disallowPassing = def.DisallowPassing;

                    foreach (var on in def.OnLights)
                    {
                        if (on != null && !lit.Contains(on.gameObject.name)) lit.Add(on.gameObject.name);
                    }
                    foreach (var blink in def.BlinkingLights)
                    {
                        if (blink == null) continue;
                        var name = blink.gameObject.name;
                        if (!lit.Contains(name)) lit.Add(name);
                        if (!blinking.Contains(name)) blinking.Add(name);
                    }
                    foreach (var seq in def.LightSequences)
                    {
                        if (seq == null || seq.Lights == null) continue;
                        foreach (var light in seq.Lights)
                        {
                            if (light != null && !lit.Contains(light.gameObject.name)) lit.Add(light.gameObject.name);
                        }
                    }
                }

                return new
                {
                    PackId = packId,
                    PackVersion = packVersion,
                    PackName = packName,
                    Lamps = lamps.ToArray(),
                    CurrentAspectId = aspectId,
                    DisallowPassing = disallowPassing,
                    Lit = lit.ToArray(),
                    Blinking = blinking.ToArray(),
                };
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning?.Invoke($"CaptureSignal({signalName}) failed: {ex.Message}");
                return null;
            }
        }

        private static DateTime _lastForceUpdate = DateTime.MinValue;
        private static readonly TimeSpan _forceUpdateInterval = TimeSpan.FromSeconds(5);

        /// <summary>
        /// Forces all signals to evaluate their aspects regardless of player proximity.
        /// The new Signals mod runs its own 1s update loop, but this keeps Dispatch's
        /// aspect snapshot fresh even when a player is far from a signal. Throttled.
        /// </summary>
        private void ForceUpdateAllSignalAspects()
        {
            var now = DateTime.UtcNow;
            if (now - _lastForceUpdate < _forceUpdateInterval) return;
            _lastForceUpdate = now;

            if (SignalManager.Instance == null) return;

            try
            {
                foreach (var controller in SignalManager.Instance.AllControllers)
                {
                    if (!controller.Exists) continue;

                    foreach (var signal in controller.AllSignals)
                    {
                        if (signal.Definition == null) continue;
                        signal.UpdateAspect(false);
                    }
                }
            }
            catch (Exception ex)
            {
                LoggingReturn.DebugLog?.Invoke($"ForceUpdateAllSignalAspects failed: {ex.Message}");
            }
        }
    }
}
