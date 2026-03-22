using System;
using System.IO;
using System.Reflection;

namespace DvMod.RemoteDispatch
{
    internal static class SignalsShim
    {
        private static MethodInfo? _teardownMethod;

        internal static bool IsInitialized { get; private set; }

        internal static void Initialize()
        {
            // Check if Signals mod is present and enabled
            var signalsMod = UnityModManagerNet.UnityModManager.FindMod("DVSignals");

            Assembly? signalsAssembly = null;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    if (asm.GetName().Name == "Signals.Game")
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
                    Main.DebugLog(() => "Signals mod not found or not enabled, signal integration disabled.");
                    return;
                }

                if (signalsAssembly == null)
                {
                    Main.mod?.Logger.Warning("Signals mod is enabled but Signals.Game assembly not loaded.");
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
                _teardownMethod?.Invoke(null, null);
            }
            catch (Exception ex)
            {
                Main.mod?.Logger.Warning($"Failed to teardown Signals integration.\r\n{ex.Message}\r\n{ex.StackTrace}");
            }

            _teardownMethod = null;
            IsInitialized = false;
        }
    }
}