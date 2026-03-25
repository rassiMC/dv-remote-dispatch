using System;
using System.Collections.Generic;
using Signals.API;
using UnityEngine;

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
                // Also remove the aspect changed handler if the API is still around
                SignalsAPI.Instance.SignalAspectChanged -= OnAspectChanged;
            }
        }

        private void OnSignalsLoaded()
        {
            // We subscribe to SignalAspectChanged so we get notified any time a signal changes (e.g. from STOP to OPEN).
            SignalsAPI.Instance!.SignalAspectChanged += OnAspectChanged;
            Debug.Log("[RemoteDispatch.Signals] Signals API loaded, ready to interact with signals.");
        }

        private void OnSignalsUnloaded()
        {
            Debug.Log("[RemoteDispatch.Signals] Signals API unloaded, cleaned up handlers.");
        }

        private void OnAspectChanged(SignalState state)
        {
            Debug.Log($"[RemoteDispatch.Signals] Aspect changed: {state.Id} -> {state.CurrentAspectId}");
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
                Debug.LogWarning($"[RemoteDispatch.Signals] GetSignalAspect({signalId}) failed: {ex.Message}");
                return null;
            }
        }

        /// <summary>Returns all signal IDs and their current aspects.</summary>
        internal Dictionary<string, string> GetAllSignals()
        {
            var result = new Dictionary<string, string>();
            try
            {
                var signals = SignalsAPI.GetAllSignals();
                if (signals == null) return result;

                foreach (var signal in signals)
                {
                    // Dont bother to record signals that are off, since they dont have a meaningful aspect
                    if (signal.IsOn)
                    {
#pragma warning disable CS8601 // If a signals is off, then CurrentAspectId is null. IsOn = CurrentAspectId != null
                        result[signal.Id] = signal.CurrentAspectId;
#pragma warning restore CS8601 // Possible null reference assignment.
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[RemoteDispatch.Signals] GetAllSignals failed: {ex.Message}");
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
                Debug.LogWarning($"[RemoteDispatch.Signals] SetSignalAspect({signalId}, {aspect}) failed: {ex.Message}");
                return false;
            }
        }
    }
}