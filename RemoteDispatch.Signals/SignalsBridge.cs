using System;
using System.Collections.Generic;
using Signals.API;
using Newtonsoft.Json;

namespace DvMod.RemoteDispatch.Signals
{
    internal class SignalsBridge
    {
        internal void Register()
        {
            // When SignalsAPI is Loaded, run OnSignalsLoaded
            SignalsAPI.Loaded += OnSignalsLoaded;
            // When SignalsAPI is Unloaded, run OnSignalsUnloaded
            SignalsAPI.Unloaded += OnSignalsUnloaded;
        }

        internal void Unregister()
        {
            // Make sure to undo everything we did in Register
            SignalsAPI.Loaded -= OnSignalsLoaded;
            SignalsAPI.Unloaded -= OnSignalsUnloaded;
            if (SignalsAPI.Instance != null)
            {
                // Also remove the handlers if the API is still around
                SignalsAPI.Instance.SignalAspectChanged -= OnAspectChanged;
                SignalsAPI.Instance.SignalModeChanged -= OnModeChanged;
            }
        }

        private void OnSignalsLoaded()
        {
            SignalsAPI.Instance!.SignalAspectChanged += OnAspectChanged;
            SignalsAPI.Instance!.SignalModeChanged += OnModeChanged;
            Bootstrap.DebugLog("Signals API loaded, ready to interact with signals.");
        }

        private void OnSignalsUnloaded()
        {
            Bootstrap.DebugLog("Signals API unloaded, cleaned up handlers.");
        }

        private void OnAspectChanged(SignalState state)
        {
            Bootstrap.DebugLog($"Aspect changed: {state.Id} -> {state.CurrentAspectId}");
            // TODO: forward to main mod
        }

        private void OnModeChanged(string signalId, SignalMode newMode)
        {
            Bootstrap.DebugLog($"Mode changed: {signalId} -> {newMode}");
            // TODO: forward to main mod
        }

        /// <summary>Returns the current aspect of a signal by its ID, or null if not found.</summary>
        internal string? GetSignalAspect(string signalId)
        {
            try
            {
                return SignalsAPI.GetSignal(signalId)?.CurrentAspectId;
            }
            catch (Exception ex)
            {
                Bootstrap.Warning($"GetSignalAspect({signalId}) failed: {ex.Message}");
                return null;
            }
        }

        /// <summary>Returns all signals with raw world coordinates (not yet converted to lat/lng).</summary>
        internal Dictionary<string, object> GetAllSignals()
        {
            var result = new Dictionary<string, object>();
            try
            {
                var signals = SignalsAPI.GetAllSignals();
                if (signals == null)
                {
                    Bootstrap.DebugLog("GetAllSignals returned null.");
                    return result;
                }

                foreach (var signal in signals)
                {
                    var aspect = signal.CurrentAspectId ?? "OFF";
                    Bootstrap.DebugLog($"Found signal: {signal.Id} at {signal.Position} with aspect {aspect} and mode {signal.Mode}");

                    result[signal.Id] = new
                    {
                        signal.Id,
                        signal.Type,
                        signal.Mode,
                        signal.CurrentAspectId,
                        signal.IsOn,
                        signal.Direction,
                        signal.JunctionId,
                        signal.SelectedBranch,
                        signal.YardId,
                        signal.TrackId,
                        // Store raw world coordinates (x, z) - conversion to lat/lng happens in Session.cs
                        Position = new[] { signal.Position.x, signal.Position.z },
                    };
                }
            }
            catch (Exception ex)
            {
                Bootstrap.Warning($"[RemoteDispatch.Signals] GetAllSignals failed: {ex.Message}");
            }
            return result;
        }

        /// <summary>Sets a signal to the specified aspect. Returns true on success.</summary>
        internal bool SetSignalAspect(string signalId, string aspect)
        {
            try
            {
                return SignalsAPI.SetSignalAspect(signalId, aspect);
            }
            catch (Exception ex)
            {
                Bootstrap.Warning($"[RemoteDispatch.Signals] SetSignalAspect({signalId}, {aspect}) failed: {ex.Message}");
                return false;
            }
        }
    }
}