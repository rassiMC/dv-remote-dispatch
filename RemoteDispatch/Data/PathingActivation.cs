using Newtonsoft.Json.Linq;
using System.Collections.Generic;

namespace DvMod.RemoteDispatch
{
    public static class PathingActivation
    {
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
                    SignalsShim.SetSignalMode(signalId, "Manual");
                    SignalsShim.SetSignalAspect(signalId, "S1");
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
        }

        public static void ClearRouteSignals(List<string> signalIds)
        {
            int count = 0;
            foreach (var signalId in signalIds)
            {
                Main.DebugLog($"PathingActivation: Clearing signal {signalId}");
                SignalsShim.SetSignalMode(signalId, "Manual");
                SignalsShim.SetSignalAspect(signalId, "S2");
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
                SignalsShim.SetSignalMode(signalId, "Manual");
                SignalsShim.SetSignalAspect(signalId, "S1");
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
