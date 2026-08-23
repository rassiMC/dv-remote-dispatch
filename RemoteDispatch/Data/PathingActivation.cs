using Newtonsoft.Json.Linq;
using System.Collections.Generic;

namespace DvMod.RemoteDispatch
{
    public static class PathingActivation
    {
        /// <summary>
        /// Sets a signal to its blocking (stop) state. The aspect is resolved per signal:
        /// the user-configured stop aspect for the signal's type, else the pack entry's
        /// DisallowPassing aspect, else the classic "S1". Falls back through the list so a
        /// configured aspect that isn't present on a particular signal never leaves it unblocked.
        /// </summary>
        public static void SetSignalToStop(string signalId, string? signalType = null)
        {
            if (string.IsNullOrEmpty(signalType))
                signalType = GetSignalType(signalId);

            var candidates = new List<string>();
            var configured = PackTableStore.GetConfiguredStopAspect(signalType ?? "");
            if (!string.IsNullOrEmpty(configured))
                candidates.Add(configured);
            var detected = PackTableStore.DetectStopAspect(signalId);
            if (!string.IsNullOrEmpty(detected) && !candidates.Contains(detected))
                candidates.Add(detected);
            candidates.Add("S1");

            SignalsShim.SetSignalMode(signalId, "Manual");
            foreach (var aspect in candidates)
            {
                if (SignalsShim.SetSignalAspect(signalId, aspect))
                    return;
            }
            Main.Warning($"PathingActivation: no stop aspect could be set on signal {signalId} (tried {string.Join(", ", candidates)})");
        }

        /// <summary>
        /// Resolves a signal's type string from the current signals payload, or null if unknown.
        /// </summary>
        private static string? GetSignalType(string signalId)
        {
            var allSignalsData = SignalsShim.GetAllSignalsData() as JObject;
            if (allSignalsData == null) return null;
            if (allSignalsData[signalId] is JObject signalData)
                return signalData["Type"]?.ToString();
            return null;
        }

        public static void ActivatePathingMode()
        {
            Main.Log("PathingActivation: Activating pathing mode...");

            var detectedJunctionIds = OccupancyData.GetDetectedJunctionIds();
            bool hasMapping = detectedJunctionIds.Count > 0;

            var allSignalsData = SignalsShim.GetAllSignalsData();
            if (allSignalsData == null)
                return;

            var signalsObj = allSignalsData as JObject;
            if (signalsObj == null)
                return;

            int detectedCount = 0;
            int undetectedCount = 0;
            int distantSkipped = 0;

            foreach (var prop in signalsObj.Properties())
            {
                var signalId = prop.Name;
                var signalData = prop.Value as JObject;
                if (signalData == null) continue;

                var junctionId = signalData["JunctionId"]?.ToString() ?? "";
                var type = signalData["Type"]?.ToString() ?? "";

                bool isDistant = type == "Distant";

                if (!string.IsNullOrEmpty(junctionId) && detectedJunctionIds.Contains(junctionId))
                {
                    Main.DebugLog($"PathingActivation: Detected signal {signalId} (junction {junctionId})");
                    SetSignalToStop(signalId, type);
                    detectedCount++;
                }
                else if (hasMapping && !isDistant)
                {
                    Main.DebugLog($"PathingActivation: Undetected signal {signalId} - releasing to automatic");
                    SignalsShim.SetSignalMode(signalId, "Automatic");
                    undetectedCount++;
                }
                else
                {
                    distantSkipped++;
                }
            }

            Main.Log($"PathingActivation: {detectedCount} detected -> Manual+S1, {undetectedCount} undetected -> Automatic, {distantSkipped} distant skipped");
            Sessions.AddTag("signals");
        }

        public static void DeactivatePathingMode()
        {
            Main.Log("PathingActivation: Deactivating pathing mode...");

            // Release claims first while stored paths still exist so SetSignalToStop
            // can resolve each block's guard signal back to Manual+S1.
            StagingData.ClearAll();
            PathingData.ClearPaths();
            SweepSignalsToAutomatic();
        }

        private static void SweepSignalsToAutomatic()
        {
            var allSignalsData = SignalsShim.GetAllSignalsData();
            if (allSignalsData == null)
                return;

            var signalsObj = allSignalsData as JObject;
            if (signalsObj == null)
                return;

            int restoredCount = 0;
            int distantSkipped = 0;

            foreach (var prop in signalsObj.Properties())
            {
                var signalId = prop.Name;
                var signalData = prop.Value as JObject;
                if (signalData == null) continue;

                var type = signalData["Type"]?.ToString() ?? "";
                if (type == "Distant")
                {
                    distantSkipped++;
                    continue;
                }

                Main.DebugLog($"PathingActivation: Restoring signal {signalId} to Automatic");
                SignalsShim.SetSignalMode(signalId, "Automatic");
                restoredCount++;
            }

            Main.Log($"PathingActivation: {restoredCount} signals restored to Automatic, {distantSkipped} distant skipped");
            Sessions.AddTag("signals");
        }

        public static void ClearRouteSignals(List<string> signalIds)
        {
            int count = 0;
            foreach (var signalId in signalIds)
            {
                Main.DebugLog($"PathingActivation: Clearing signal {signalId}");
                SignalsShim.SetSignalMode(signalId, "Automatic");
                count++;
            }
            Main.Log($"PathingActivation: Cleared {count} signals along route");
            Sessions.AddTag("signals");
        }

        public static void RevertRouteSignals(List<string> signalIds)
        {
            int count = 0;
            foreach (var signalId in signalIds)
            {
                Main.DebugLog($"PathingActivation: Reverting signal {signalId}");
                SetSignalToStop(signalId);
                count++;
            }
            Main.Log($"PathingActivation: Reverted {count} signals along route");
            Sessions.AddTag("signals");
        }

        public static void RevertAllRouteSignals()
        {
            var paths = PathingData.GetPaths();
            var allJunctionIds = new List<string>();
            foreach (var path in paths)
            {
                var switches = path["switches"] as JArray;
                if (switches == null) continue;
                foreach (var sw in switches)
                {
                    allJunctionIds.Add(sw.ToString());
                }
            }
            RevertRouteSignals(allJunctionIds);
        }

        private static Dictionary<string, string> GetOutSignalIdsByJunction()
        {
            var result = new Dictionary<string, string>();
            var allSignalsData = SignalsShim.GetAllSignalsData() as JObject;
            if (allSignalsData == null) return result;

            foreach (var prop in allSignalsData.Properties())
            {
                var signalData = prop.Value as JObject;
                if (signalData == null) continue;

                var junctionId = signalData["JunctionId"]?.ToString() ?? "";
                var direction = signalData["Direction"]?.ToString() ?? "";

                if (!string.IsNullOrEmpty(junctionId) && direction == "Out")
                {
                    result[junctionId] = prop.Name;
                }
            }
            return result;
        }
    }
}
