using System;
using System.Collections.Generic;
using UnityEngine;

namespace DvMod.RemoteDispatch.Signals
{
    public static class Bootstrap
    {
        private static SignalsBridge? _bridge;

        // Expose methods for the main mod to interact with signals without needing to reference SignalsAPI directly.
        public static Dictionary<string, string>? GetAllSignals() => _bridge?.GetAllSignals();
        public static string? GetSignalAspect(string signalId) => _bridge?.GetSignalAspect(signalId);
        public static bool SetSignalAspect(string signalId, string aspect) => _bridge?.SetSignalAspect(signalId, aspect) ?? false;

        public static void Initialize()
        {
            try
            {
                _bridge = new SignalsBridge();
                _bridge.Register();
                Debug.Log("[RemoteDispatch.Signals] Signals bridge initialized.");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[RemoteDispatch.Signals] Initialize failed: {ex.Message}\n{ex.StackTrace}");
            }
        }

        public static void Teardown()
        {
            try
            {
                _bridge?.Unregister();
                _bridge = null;
                Debug.Log("[RemoteDispatch.Signals] Signals bridge torn down.");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[RemoteDispatch.Signals] Teardown failed: {ex.Message}\n{ex.StackTrace}");
            }
        }
    }
}