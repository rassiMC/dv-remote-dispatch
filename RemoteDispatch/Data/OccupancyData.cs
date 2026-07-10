using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Linq;

namespace DvMod.RemoteDispatch
{
    public static class OccupancyData
    {
        private static readonly object cacheLock = new object();

        private static Dictionary<string, List<(string junctionId, string port, int junctionIndex)>>? _blockJunctionMap;
        private static HashSet<string>? _allBlockIds;
        private static Dictionary<string, bool?> _lastOccupancy = new Dictionary<string, bool?>();
        private static Dictionary<string, bool?> _currentOccupancy = new Dictionary<string, bool?>();
        private static bool _mappingInitialized = false;

        private static readonly HashSet<string> OccupiedAspects = new HashSet<string> { "S1", "S1r", "S1c" };
        private static readonly HashSet<string> ClearAspects = new HashSet<string> { "S2", "S4", "S6" };

        public static bool HasMapping => _blockJunctionMap != null && _blockJunctionMap.Count > 0;

        public static void SetBlockMapping(Dictionary<string, List<(string junctionId, string port, int junctionIndex)>> mapping)
        {
            lock (cacheLock)
            {
                if (_mappingInitialized)
                {
                    Main.Log($"OccupancyData: ignoring duplicate mapping update ({mapping.Count} blocks).");
                    return;
                }
                _blockJunctionMap = mapping;
                _allBlockIds = new HashSet<string>(mapping.Keys);
                _lastOccupancy.Clear();
                _currentOccupancy.Clear();
                _mappingInitialized = true;
                Main.Log($"OccupancyData: set mapping for {mapping.Count} blocks.");
            }
        }

        public static void ClearMapping()
        {
            lock (cacheLock)
            {
                _blockJunctionMap = null;
                _allBlockIds = null;
                _lastOccupancy.Clear();
                _currentOccupancy.Clear();
                _mappingInitialized = false;
            }
        }

        private static void ComputeOccupancy()
        {
            var result = new Dictionary<string, bool?>();

            if (_allBlockIds == null)
            {
                _currentOccupancy = result;
                return;
            }

            var signalAspects = SignalsShim.GetJunctionSignalAspects();
            var junctionStates = Junctions.GetAllJunctionStates().ToArray();

            int occupiedCount = 0;
            int nullCount = 0;
            int noSignalCount = 0;
            int misalignedSkipCount = 0;
            int totalEntries = 0;
            int blocksWithEntries = 0;
            int blocksWithoutEntries = 0;

            foreach (var blockId in _allBlockIds)
            {
                if (_blockJunctionMap == null || !_blockJunctionMap.TryGetValue(blockId, out var entries) || entries.Count == 0)
                {
                    result[blockId] = null;
                    nullCount++;
                    blocksWithoutEntries++;
                    continue;
                }

                blocksWithEntries++;
                totalEntries += entries.Count;

                bool foundOccupied = false;
                bool foundClear = false;
                bool foundAnySignal = false;

                foreach (var (junctionId, port, junctionIndex) in entries)
                {
                    if (port != "common")
                    {
                        if (junctionIndex < 0 || junctionIndex >= junctionStates.Length)
                        {
                            misalignedSkipCount++;
                            continue;
                        }
                        byte currentBranch = junctionStates[junctionIndex];
                        bool isSelected = (port == "left" && currentBranch == 0) ||
                                          (port == "right" && currentBranch == 1);
                        if (!isSelected)
                        {
                            misalignedSkipCount++;
                            continue;
                        }
                    }

                    if (!signalAspects.TryGetValue(junctionId, out var signalList))
                    {
                        noSignalCount++;
                        continue;
                    }

                    string requiredDirection = port == "common" ? "In" : "Out";

                    foreach (var (aspectId, direction) in signalList)
                    {
                        if (direction != requiredDirection)
                            continue;

                        foundAnySignal = true;

                        if (OccupiedAspects.Contains(aspectId))
                            foundOccupied = true;
                        if (ClearAspects.Contains(aspectId))
                            foundClear = true;
                    }
                }

                if (foundAnySignal)
                {
                    bool occupied;
                    if (foundClear)
                        occupied = false;
                    else if (foundOccupied)
                        occupied = true;
                    else
                    {
                        result[blockId] = null;
                        nullCount++;
                        continue;
                    }
                    result[blockId] = occupied;
                    if (occupied) occupiedCount++;
                }
                else
                {
                    result[blockId] = null;
                    nullCount++;
                }
            }

            Main.Log($"OccupancyData.ComputeOccupancy: {occupiedCount} occupied, {nullCount} null/unknown, {result.Count - occupiedCount - nullCount} clear, {signalAspects.Count} signals. {blocksWithEntries} blocks with entries ({totalEntries} total entries), {blocksWithoutEntries} blocks without entries. Entry stats: {noSignalCount} no-signal, {misalignedSkipCount} misaligned-skip");

            _currentOccupancy = result;
        }

        public static Dictionary<string, bool?> GetOccupancyData()
        {
            lock (cacheLock)
            {
                return new Dictionary<string, bool?>(_currentOccupancy);
            }
        }

        public static bool CheckChanged()
        {
            ComputeOccupancy();

            lock (cacheLock)
            {
                bool changed = false;

                foreach (var kvp in _currentOccupancy)
                {
                    if (!_lastOccupancy.TryGetValue(kvp.Key, out var prev) || prev != kvp.Value)
                    {
                        changed = true;
                        break;
                    }
                }

                if (!changed && _lastOccupancy.Count != _currentOccupancy.Count)
                    changed = true;

                if (changed)
                    _lastOccupancy = new Dictionary<string, bool?>(_currentOccupancy);

                return changed;
            }
        }

        public static string GetOccupancyJSON()
        {
            return JsonConvert.SerializeObject(GetOccupancyData());
        }
    }
}
