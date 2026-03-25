using Newtonsoft.Json;
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

        internal static bool IsInitialized { get; private set; }

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
                    Main.mod?.Logger.Warning("Signals mod not found or not enabled, signal integration disabled.");
                    return;
                }

                if (signalsAssembly == null)
                {
                    Main.mod?.Logger.Warning("Signals mod is enabled but Signals.API assembly not loaded.");
                    return;
                }

                var path = Path.Combine(Main.mod!.Path, "RemoteDispatch.Signals.dll");

                if (!File.Exists(path))
                {
                    Main.mod?.Logger.Warning("RemoteDispatch.Signals.dll not found, signal integration disabled.");
                    return;
                }

                var integrationAssembly = Assembly.LoadFile(path);
                var bootstrap = integrationAssembly.GetType("DvMod.RemoteDispatch.Signals.Bootstrap");

                if (bootstrap == null)
                {
                    Main.mod?.Logger.Warning("Failed to find DvMod.RemoteDispatch.Signals.Bootstrap, signal integration disabled.");
                    return;
                }

                var initMethod = bootstrap.GetMethod("Initialize", BindingFlags.Public | BindingFlags.Static);
                _teardownMethod = bootstrap.GetMethod("Teardown", BindingFlags.Public | BindingFlags.Static);
                _getAllSignalsMethod = bootstrap.GetMethod("GetAllSignals", BindingFlags.Public | BindingFlags.Static);
                _getSignalAspectMethod = bootstrap.GetMethod("GetSignalAspect", BindingFlags.Public | BindingFlags.Static);
                _setSignalAspectMethod = bootstrap.GetMethod("SetSignalAspect", BindingFlags.Public | BindingFlags.Static);

                initMethod?.Invoke(null, null);

                IsInitialized = true;
                Main.mod?.Logger.Log("Signals integration loaded.");
            }
            catch (Exception ex)
            {
                Main.mod?.Logger.Warning($"Failed to load Signals integration.\r\n{ex.Message}\r\n{ex.StackTrace}");
            }
        }

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
                Main.mod?.Logger.Warning($"Failed to teardown Signals integration.\r\n{ex.Message}\r\n{ex.StackTrace}");
            }

            _teardownMethod = null;
            IsInitialized = false;
        }

        internal static Dictionary<string, string>? GetAllSignals() =>
            _getAllSignalsMethod?.Invoke(null, null) as Dictionary<string, string>;

        public static string GetAllSignalsDataJson()
        {
            return JsonConvert.SerializeObject(GetAllSignals());
        }

        internal static string? GetSignalAspect(string signalId) =>
            _getSignalAspectMethod?.Invoke(null, new object[] { signalId }) as string;

        internal static bool SetSignalAspect(string signalId, string aspect) =>
            _setSignalAspectMethod?.Invoke(null, new object[] { signalId, aspect }) is true;

    }
}