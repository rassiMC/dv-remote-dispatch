using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;

namespace DvMod.RemoteDispatch
{
    internal static class SignalsShimHelpers
    {

        /// <summary>
        /// Converts the raw world coordinates of a signal to lat/lng, applying the WorldMover offset.
        /// The Signals mod provides signal positions in raw world coordinates (x, z), so we need to convert them to lat/lng for our use.
        /// This method takes care of that conversion and also applies the WorldMover offset to ensure the positions are correct relative to the player's current location.
        /// The converted position is stored back in the adjustedData dictionary under the same signal key.
        /// </summary>
        /// <param name="worldOffset"></param>
        /// <param name="metersToDegrees"></param>
        /// <param name="adjustedData"></param>
        /// <param name="signal"></param>
        internal static void ConvertSignalPositionToLatLng(UnityEngine.Vector3 worldOffset,
                                                           double metersToDegrees,
                                                           Dictionary<string, object> adjustedData,
                                                           KeyValuePair<string, object> signal)
        {
            try
            {
                // Convert the anonymous object to JObject to manipulate it
                var signalObject = JObject.FromObject(signal.Value);

                // Get raw world coordinates (x, z) from the bridge
                var positionArray = signalObject["Position"] as JArray;
                if (positionArray != null && positionArray.Count == 2)
                {
                    double x = positionArray[0].Value<double>();
                    double z = positionArray[1].Value<double>();

                    // Apply WorldMover offset, then convert to lat/lng
                    // z is north-south (latitude), x is east-west (longitude)
                    signalObject["Position"] = new JArray
                    {
                        (z - worldOffset.z) * metersToDegrees,  // latitude
                        (x - worldOffset.x) * metersToDegrees   // longitude
                    };
                }

                adjustedData[signal.Key] = signalObject;
            }
            catch (Exception ex)
            {
                Main.DebugLog($"Failed to adjust signal position for {signal.Key}: {ex.Message}");
                adjustedData[signal.Key] = signal.Value;
            }
        }
    }
}
