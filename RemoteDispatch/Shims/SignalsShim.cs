using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

namespace DvMod.RemoteDispatch
{
    internal static class SignalsShim
    {
        // Cache method infos for the API methods we want to call, so we don't have to do reflection every time.
        private static MethodInfo? _teardownMethod;
        private static MethodInfo? _getAllSignalsMethod;
        private static MethodInfo? _getSignalAspectMethod;
        private static MethodInfo? _setSignalAspectMethod;
        // SignalMode is a .NET enum (Manual/Automatic), need it for API invocation
        // Cache reflection info to avoid recompiling every call
        private static MethodInfo? _setSignalModeMethod;

        internal static bool IsInitialized { get; private set; }

        /// <summary>
        /// Sets up the integration with the Signals mod if it's present and enabled.
        /// This should be called during the main mod's initialization.
        /// </summary>
        internal static void Initialize()
        {
            if (IsInitialized) return;

            // Check if Signals mod is present and enabled
            var signalsMod = UnityModManagerNet.UnityModManager.FindMod("DVSignals");

            Assembly? signalsAssembly = null;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    if (asm.GetName().Name == "Signals.API")
                    {
                        signalsAssembly = asm;
                        break;
                    }
                }
                catch { }
            }

            try
            {
                if (signalsMod == null || !signalsMod.Enabled)
                {
                    Main.Warning("Signals mod not found or not enabled, signal integration disabled.");
                    return;
                }

                if (signalsAssembly == null)
                {
                    Main.Warning("Signals mod is enabled but Signals.API assembly not loaded.");
                    return;
                }

                var path = Path.Combine(Main.mod!.Path, "RemoteDispatch.Signals.dll");

                if (!File.Exists(path))
                {
                    Main.Warning("RemoteDispatch.Signals.dll not found, signal integration disabled.");
                    return;
                }

                var integrationAssembly = Assembly.LoadFile(path);
                var bootstrap = integrationAssembly.GetType("DvMod.RemoteDispatch.Signals.Bootstrap");

                if (bootstrap == null)
                {
                    Main.Warning("Failed to find DvMod.RemoteDispatch.Signals.Bootstrap, signal integration disabled.");
                    return;
                }

                var initMethod = bootstrap.GetMethod("Initialize", BindingFlags.Public | BindingFlags.Static);
                // Load reflection-wrapped methods from the Bootstrap class in RemoteDispatch.Signals
                // This preserves the dependency chain: SignalsAPI → RemoteDispatch.Signals → RemoteDispatch.Shims
                _teardownMethod = bootstrap.GetMethod("Teardown", BindingFlags.Public | BindingFlags.Static);
                _getAllSignalsMethod = bootstrap.GetMethod("GetAllSignals", BindingFlags.Public | BindingFlags.Static);
                _getSignalAspectMethod = bootstrap.GetMethod("GetSignalAspect", BindingFlags.Public | BindingFlags.Static);
                _setSignalAspectMethod = bootstrap.GetMethod("SetSignalAspect", BindingFlags.Public | BindingFlags.Static);
                
                // Retrieve SetSignalMode method from Bootstrap (in RemoteDispatch.Signals DLL)
                // This maintains the same dependency chain as SetSignalAspect:
                // Signals.API → RemoteDispatch.Signals (bridge logic) → RemoteDispatch.Shims (reflection wrapper)
                _setSignalModeMethod = bootstrap.GetMethod("SetSignalMode", BindingFlags.Public | BindingFlags.Static);

                initMethod?.Invoke(null, new object[]
                {
                    new Action<string>(msg => Main.Log(msg)),
                    new Action<string>(msg => Main.DebugLog(msg)),
                    new Action<string>(msg => Main.Warning(msg))

                });

                IsInitialized = true;
                Main.Log("Signals integration loaded.");
            }
            catch (Exception ex)
            {
                Main.Warning($"Failed to load Signals integration.\r\n{ex.Message}\r\n{ex.StackTrace}");
            }
        }

        /// <summary>
        /// Passes through the teardown call to the Signals integration, if it was initialized. This should be called during the main mod's shutdown to clean up any handlers in the Signals mod.
        /// </summary>
        internal static void Teardown()
        {
            if (!IsInitialized) return;

            try
            {
                // Do the teardown in a try/catch to avoid any exceptions from preventing the rest of the mod from unloading properly.
                _teardownMethod?.Invoke(null, null);
            }
            catch (Exception ex)
            {
                Main.Warning($"Failed to teardown Signals integration.\r\n{ex.Message}\r\n{ex.StackTrace}");
            }

            _teardownMethod = null;
            IsInitialized = false;
        }

        /// <summary>
        /// Returns all signals with their positions converted to lat/lng and adjusted for the WorldMover offset.
        /// If the Signals mod is not present or there is no signals data available, returns an empty JObject.
        /// </summary>
        /// <returns></returns>
        public static JToken? GetAllSignalsData()
        {
#if DEBUG
            Main.Log("Getting all signals data...");
#endif
            var signalsData = _getAllSignalsMethod?.Invoke(null, null);

            // Signals data is a bit special since it can be quite large and we don't want to fetch it if not necessary,
            // so we fetch it directly from the shim which will return null if the Signals mod is not present or if there is no signals data available.
            Main.DebugLog($"SignalsShim.GetAllSignalsData() returned: {(signalsData == null ? "null" : JsonConvert.SerializeObject(signalsData))}");
            if (signalsData is Dictionary<string, object> data)
            {
                // Convert raw world coordinates to lat/lng, applying WorldMover offset (same as PlayerData does)
                var worldOffset = WorldMover.currentMove;
                const double earthCircumference = 40e6;
                const double metersToDegrees = 360.0 / earthCircumference;

                var adjustedData = new Dictionary<string, object>();

                foreach (var signal in data)
                {
                    SignalsShimHelpers.ConvertSignalPositionToLatLng(worldOffset, metersToDegrees, adjustedData, signal);
                }

                return JObject.FromObject(adjustedData);
            }
            Main.DebugLog("Signals mod not available or no signals data");
            return new JObject();
        }

        internal static string? GetSignalAspect(string signalId) =>
            _getSignalAspectMethod?.Invoke(null, new object[] { signalId }) as string;

        internal static bool SetSignalAspect(string signalId, string aspect) =>
            _setSignalAspectMethod?.Invoke(null, new object[] { signalId, aspect }) is true;

        // Wrapper to expose Signals.API's SetSignalMode through reflection.
        // Accepts string mode (e.g. "Manual" or "Automatic"), forwards to RemoteDispatch.Signals.SignalsBridge.SetSignalMode().
        // Returns true on success, false on failure or 404 from API side.
        internal static bool SetSignalMode(string signalId, string mode) =>
            _setSignalModeMethod?.Invoke(null, new object[] { signalId, mode }) is true;

    }
}