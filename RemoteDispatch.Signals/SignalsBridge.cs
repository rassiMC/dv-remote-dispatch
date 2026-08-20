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
            if (SignalManager.Instance == null) return result;

            try
            {
                ForceUpdateAllSignalAspects();

                foreach (var controller in SignalManager.Instance.AllControllers)
                {
                    if (!controller.Exists) continue;

                    var junctionController = controller as JunctionSignalController;

                    foreach (var signal in controller.AllSignals)
                    {
                        if (signal.Definition == null) continue;

                        // Keep an up-to-date subscription map open so event-driven
                        // signals pushes keep working.
                        SubscribeToSignal(signal);

                        var block = signal.Block;
                        var junctionId = junctionController?.Junction.junctionData.junctionIdLong;
                        var direction = GetDirection(signal, junctionController);
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
                            SelectedBranch = junctionController?.Junction.selectedBranch,
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

        private static string GetDirection(SgSignal signal, JunctionSignalController? junctionController)
        {
            if (junctionController != null)
            {
                // Reflect the junction signal's facing. A junction signal protects the
                // diverging (out) branches; branch signals protect the converging (in) track.
                return signal.Controller == junctionController ? "Out" : "In";
            }

            // Heuristic fallback: match the old API suffix convention
            // ({junctionId}:F = Out, {junctionId}:B{1,2} = In).
            var pos = signal.Definition.transform.position;
            var name = signal.Name;
            var colonIdx = name.LastIndexOf(':');
            if (colonIdx > 0 && colonIdx < name.Length - 1)
            {
                var suffix = name.Substring(colonIdx + 1);
                if (suffix == "F" || suffix == "T") return "Out";
                if (suffix.StartsWith("B")) return "In";
            }

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
