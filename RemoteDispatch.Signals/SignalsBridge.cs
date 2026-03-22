using System;
using System.Collections.Generic;
using UnityEngine;

namespace DvMod.RemoteDispatch.Signals
{
    internal class SignalsBridge
    {
        internal void Register()
        {
            // Hook into Signals events here once you know the API surface, e.g.:
            // SignalController.OnAspectChanged += HandleAspectChanged;
        }

        internal void Unregister()
        {
            // Unhook anything registered in Register()
        }

        /// <summary>Returns the current aspect of a signal by its ID, or null if not found.</summary>
        internal string? GetSignalAspect(string signalId)
        {
            try
            {
                // e.g. return SignalManager.Instance.GetSignal(signalId)?.CurrentAspect.ToString();
                throw new NotImplementedException("Wire up to the Signals API");
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
                // e.g.:
                // foreach (var signal in SignalManager.Instance.AllSignals)
                //     result[signal.Id] = signal.CurrentAspect.ToString();
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
                // e.g.:
                // var signal = SignalManager.Instance.GetSignal(signalId);
                // if (signal == null) return false;
                // signal.SetAspect(Enum.Parse<SignalAspect>(aspect));
                // return true;
                throw new NotImplementedException("Wire up to the Signals API");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[RemoteDispatch.Signals] SetSignalAspect({signalId}, {aspect}) failed: {ex.Message}");
                return false;
            }
        }
    }
}