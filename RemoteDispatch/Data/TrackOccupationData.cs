using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using UnityEngine;

namespace DvMod.RemoteDispatch
{
    public static class TrackOccupationData
    {
        private static readonly object cacheLock = new object();

        private static Dictionary<string, bool> _lastOccupation = new Dictionary<string, bool>();
        private static Dictionary<string, bool> _currentOccupation = new Dictionary<string, bool>();
        private static RailTrack[]? _cachedTracks;

        /// <summary>
        /// Computes track occupation by calling IsTrackOccupied for all RailTracks via the Signals bridge.
        /// Must be called from the Unity main thread.
        /// </summary>
        private static void ComputeOccupation()
        {
            var result = new Dictionary<string, bool>();

            if (!SignalsShim.IsInitialized)
            {
                lock (cacheLock)
                {
                    _currentOccupation = result;
                }
                return;
            }

            try
            {
                if (_cachedTracks == null || _cachedTracks.Length == 0)
                {
                    _cachedTracks = UnityEngine.Object.FindObjectsOfType<RailTrack>();
                    Main.DebugLog($"TrackOccupationData: cached {_cachedTracks.Length} RailTracks.");
                }

                foreach (var track in _cachedTracks)
                {
                    string trackId;
                    try
                    {
                        trackId = track.LogicTrack().ID.ToString();
                    }
                    catch
                    {
                        continue;
                    }
                    if (string.IsNullOrEmpty(trackId)) continue;
                    result[trackId] = SignalsShim.IsTrackOccupied(track);
                }
            }
            catch (Exception ex)
            {
                Main.Warning($"TrackOccupationData.ComputeOccupation failed: {ex.Message}");
            }

            lock (cacheLock)
            {
                _currentOccupation = result;
            }
        }

        public static Dictionary<string, bool> GetOccupancyData()
        {
            lock (cacheLock)
            {
                return new Dictionary<string, bool>(_currentOccupation);
            }
        }

        public static bool CheckChanged()
        {
            ComputeOccupation();

            lock (cacheLock)
            {
                bool changed = false;

                foreach (var kvp in _currentOccupation)
                {
                    if (!_lastOccupation.TryGetValue(kvp.Key, out var prev) || prev != kvp.Value)
                    {
                        changed = true;
                        break;
                    }
                }

                if (!changed && _lastOccupation.Count != _currentOccupation.Count)
                    changed = true;

                if (changed)
                    _lastOccupation = new Dictionary<string, bool>(_currentOccupation);

                return changed;
            }
        }

        public static string GetTrackOccupationJSON()
        {
            return JsonConvert.SerializeObject(GetOccupancyData());
        }
    }
}
