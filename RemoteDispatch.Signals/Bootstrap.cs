using Newtonsoft.Json;
using System;
using System.Collections.Generic;

namespace DvMod.RemoteDispatch.Signals
{
    public static class Bootstrap
    {
        private static SignalsBridge? _bridge;
        internal static Action<string> Log = noop => { };
        internal static Action<string> DebugLog = noop => { };
        internal static Action<string> Warning = noop => { };

        // Expose methods for the main mod to interact with signals without needing to reference SignalsAPI directly.
        public static Dictionary<string, object>? GetAllSignals() => _bridge?.GetAllSignals();
        public static string? GetSignalAspect(string signalId) => _bridge?.GetSignalAspect(signalId);
        public static bool SetSignalAspect(string signalId, string aspect) => _bridge?.SetSignalAspect(signalId, aspect) ?? false;

        public static void Initialize(Action<string> log, Action<string> debugLog, Action<string> warning)
        {
            Log = log;
            DebugLog = debugLog;
            Warning = warning;
            try
            {
                _bridge = new SignalsBridge();
                _bridge.Register();
                Log("Signals bridge initialized.");
            }
            catch (Exception ex)
            {
                Warning($"Signals Initialize failed: {ex.Message}\n{ex.StackTrace}");
            }
        }

        public static void Teardown()
        {
            try
            {
                _bridge?.Unregister();
                _bridge = null;
                Log("[RemoteDispatch.Signals - Raw log message] Signals bridge torn down.");
            }
            catch (Exception ex)
            {
                Warning($"[RemoteDispatch.Signals - Raw log message] Teardown failed: {ex.Message}\n{ex.StackTrace}");
            }
        }
    }
}