using System;
using System.Collections.Generic;
using Signals.API;
using Newtonsoft.Json;

namespace DvMod.RemoteDispatch.Signals
{
    internal class SignalsBridge
    {
        /// <summary>
        /// Registers event handlers for the SignalsAPI loaded and unloaded events.
        /// </summary>
        /// <remarks>Call this method to enable automatic handling of SignalsAPI lifecycle events within
        /// the current context. This method should be called only once per instance to avoid multiple
        /// registrations.</remarks>
        internal void Register()
        {
            // When SignalsAPI is Loaded, run OnSignalsLoaded
            SignalsAPI.Loaded += OnSignalsLoaded;
            // When SignalsAPI is Unloaded, run OnSignalsUnloaded
            SignalsAPI.Unloaded += OnSignalsUnloaded;
        }

        /// <summary>
        /// Unregisters event handlers from the SignalsAPI to stop receiving signal-related notifications.
        /// </summary>
        /// <remarks>Call this method to detach previously registered event handlers and prevent further
        /// callbacks from the SignalsAPI. This is typically used during cleanup to avoid memory leaks or unintended
        /// behavior after the object is no longer needed.</remarks>
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

        /// <summary>
        /// Initializes event handlers for signal aspect and mode changes after the Signals API has been loaded.
        /// </summary>
        private void OnSignalsLoaded()
        {
            SignalsAPI.Instance!.SignalAspectChanged += OnAspectChanged;
            SignalsAPI.Instance!.SignalModeChanged += OnModeChanged;
            LoggingReturn.DebugLog("Signals API loaded, ready to interact with signals.");
        }

        /// <summary>
        /// Handles cleanup operations when the Signals API is unloaded.
        /// </summary>
        private void OnSignalsUnloaded()
        {
            LoggingReturn.DebugLog("Signals API unloaded, cleaned up handlers.");
        }

        /// <summary>
        /// Handles changes to the aspect of the specified signal state.
        /// </summary>
        /// <param name="state">The signal state whose aspect has changed. Contains information about the signal's current and previous
        /// aspects.</param>
        private void OnAspectChanged(SignalState state)
        {
            LoggingReturn.DebugLog($"Aspect changed: {state.Id} -> {state.CurrentAspectId}");
            // TODO: forward to main mod
        }

        /// <summary>
        /// Handles changes to the mode of the specified signal.
        /// </summary>
        /// <param name="signalId"></param>
        /// <param name="newMode"></param>
        private void OnModeChanged(string signalId, SignalMode newMode)
        {
            LoggingReturn.DebugLog($"Mode changed: {signalId} -> {newMode}");
            // TODO: forward to main mod
        }

        /// <summary>
        /// Returns the current aspect of a signal by its ID, or null if not found.
        /// </summary>
        internal string? GetSignalAspect(string signalId)
        {
            try
            {
                return SignalsAPI.GetSignal(signalId)?.CurrentAspectId;
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning($"GetSignalAspect({signalId}) failed: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Returns all signals with raw world coordinates (not yet converted to lat/lng).
        /// </summary>
        internal Dictionary<string, object> GetAllSignals()
        {
            var result = new Dictionary<string, object>();
            try
            {
                var signals = SignalsAPI.GetAllSignals();
                if (signals == null)
                {
                    LoggingReturn.DebugLog("GetAllSignals returned null.");
                    return result;
                }

                foreach (var signal in signals)
                {
                    var aspect = signal.CurrentAspectId ?? "OFF";
                    LoggingReturn.DebugLog($"Found signal: {signal.Id} at {signal.Position} with aspect {aspect} and mode {signal.Mode}");

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
                LoggingReturn.Warning($"[RemoteDispatch.Signals] GetAllSignals failed: {ex.Message}");
            }
            return result;
        }

        /// <summary>
        /// Sets a signal to the specified aspect. Returns true on success.
        /// </summary>
        internal bool SetSignalAspect(string signalId, string aspect)
        {
            try
            {
                return SignalsAPI.SetSignalAspect(signalId, aspect);
            }
            catch (Exception ex)
            {
                LoggingReturn.Warning($"[RemoteDispatch.Signals] SetSignalAspect({signalId}, {aspect}) failed: {ex.Message}");
                return false;
            }
        }
    }
}