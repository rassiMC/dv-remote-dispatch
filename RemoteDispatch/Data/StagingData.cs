#nullable disable
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;

namespace DvMod.RemoteDispatch
{
    public static class StagingData
    {
        private static readonly object lockObj = new object();

        private const int DefaultLookAhead = 5;

        private class PathStaging
        {
            public string pathId;
            public string[] blocks;
            public int currentBlockIndex;
            public int lookAhead;
            public string status; // "Active", "Completed", "Cancelled"

            public PathStaging(string pathId, string[] blocks, int lookAhead)
            {
                this.pathId = pathId;
                this.blocks = blocks;
                this.currentBlockIndex = 0;
                this.lookAhead = lookAhead;
                this.status = "Active";
            }
        }

        private static Dictionary<string, PathStaging> _pathProgress = new Dictionary<string, PathStaging>();
        private static Dictionary<string, List<string>> _blockQueues = new Dictionary<string, List<string>>();
        private static Dictionary<string, string> _activeBlocks = new Dictionary<string, string>();

        private static List<string> GetQueue(string blockId)
        {
            if (!_blockQueues.TryGetValue(blockId, out var queue))
            {
                queue = new List<string>();
                _blockQueues[blockId] = queue;
            }
            return queue;
        }

        public static void InitializeFromPaths(List<JObject> paths)
        {
            lock (lockObj)
            {
                _pathProgress.Clear();
                _blockQueues.Clear();
                _activeBlocks.Clear();

                foreach (var path in paths)
                {
                    var pathId = path.Value<string>("id");
                    if (pathId == null) continue;
                    var blocks = path["blocks"] as JArray;
                    if (blocks == null || blocks.Count == 0) continue;
                    var blocksArr = blocks.ToObject<string[]>();
                    var lookAhead = path.Value<int?>("lookAhead") ?? DefaultLookAhead;

                    var staging = new PathStaging(pathId, blocksArr, lookAhead);
                    _pathProgress[pathId] = staging;

                    foreach (var blockId in blocksArr)
                    {
                        var queue = GetQueue(blockId);
                        if (!queue.Contains(pathId))
                            queue.Add(pathId);
                    }
                }
            }
        }

        public static void AddPath(string pathId, JArray blocksArray, int lookAhead = DefaultLookAhead)
        {
            lock (lockObj)
            {
                var blocksArr = blocksArray.ToObject<string[]>();
                var staging = new PathStaging(pathId, blocksArr, lookAhead);
                _pathProgress[pathId] = staging;

                foreach (var blockId in blocksArr)
                {
                    var queue = GetQueue(blockId);
                    if (!queue.Contains(pathId))
                        queue.Add(pathId);
                }

                var occupancy = OccupancyData.GetOccupancyData();
                if (blocksArr.Length > 0 && occupancy.TryGetValue(blocksArr[0], out var occ) && occ == true)
                {
                    if (blocksArr.Length > 1)
                        ActivateLookAhead(staging, occupancy);
                }
            }
        }

        public static void ClearAll()
        {
            lock (lockObj)
            {
                foreach (var kvp in _activeBlocks.ToList())
                    ReleaseBlock(kvp.Key);
                _pathProgress.Clear();
                _blockQueues.Clear();
                _activeBlocks.Clear();
            }
        }

        public static void RemovePath(string pathId)
        {
            lock (lockObj)
            {
                if (_pathProgress.TryGetValue(pathId, out var staging))
                {
                    foreach (var blockId in staging.blocks)
                    {
                        if (_blockQueues.TryGetValue(blockId, out var queue))
                        {
                            queue.Remove(pathId);
                            if (queue.Count == 0)
                                _blockQueues.Remove(blockId);
                        }
                        if (_activeBlocks.TryGetValue(blockId, out var claimingPath) && claimingPath == pathId)
                        {
                            ReleaseBlock(blockId);
                        }
                    }
                    _pathProgress.Remove(pathId);
                }
            }
        }

        public static void UpdatePath(string pathId, JArray newBlocksArray)
        {
            lock (lockObj)
            {
                if (!_pathProgress.TryGetValue(pathId, out var staging))
                    return;

                var oldBlocks = staging.blocks;
                foreach (var blockId in oldBlocks)
                {
                    if (_blockQueues.TryGetValue(blockId, out var queue))
                    {
                        queue.Remove(pathId);
                        if (queue.Count == 0)
                            _blockQueues.Remove(blockId);
                    }
                    if (_activeBlocks.TryGetValue(blockId, out var claimingPath) && claimingPath == pathId)
                    {
                        ReleaseBlock(blockId);
                    }
                }

                var newBlocks = newBlocksArray.ToObject<string[]>();
                staging.blocks = newBlocks;
                staging.currentBlockIndex = 0;
                staging.status = "Active";

                foreach (var blockId in newBlocks)
                {
                    var queue = GetQueue(blockId);
                    if (!queue.Contains(pathId))
                        queue.Add(pathId);
                }
            }
        }

        private static void ActivateLookAhead(PathStaging staging, Dictionary<string, bool?> occupancy)
        {
            int windowStart = staging.currentBlockIndex + 1;
            int windowEnd = Math.Min(staging.currentBlockIndex + staging.lookAhead, staging.blocks.Length - 1);

            for (int i = windowStart; i <= windowEnd; i++)
            {
                var blockId = staging.blocks[i];
                if (_activeBlocks.ContainsKey(blockId))
                    continue;
                if (!_blockQueues.TryGetValue(blockId, out var queue) || queue.Count == 0 || queue[0] != staging.pathId)
                    continue;
                if (!occupancy.TryGetValue(blockId, out var occ) || occ != false)
                    continue;

                ActivateBlock(blockId, staging);
            }
        }

        private static void ActivateBlock(string blockId, PathStaging staging)
        {
            var paths = PathingData.GetPaths();
            var path = paths.FirstOrDefault(p => p.Value<string>("id") == staging.pathId);
            if (path == null) return;

            var blockSignals = path["blockSignals"] as JObject;
            if (blockSignals != null && blockSignals[blockId] != null)
            {
                var sigId = blockSignals[blockId].ToString();
                Main.DebugLog($"StagingData: signal {sigId} -> Automatic for path {staging.pathId} on block {blockId}");
                SignalsShim.SetSignalMode(sigId, "Automatic");
            }

            if (OccupancyData.TryGetOwnSwitchIndex(blockId, out var jIdx) && jIdx >= 0 && jIdx < RailTrackRegistry.Instance.OrderedJunctions.Length)
            {
                var switchAssignments = path["switchAssignments"] as JObject;
                if (switchAssignments != null && switchAssignments[blockId] != null)
                {
                    var neededBranch = (byte)(switchAssignments[blockId].Value<int>());
                    var junction = RailTrackRegistry.Instance.OrderedJunctions[jIdx];
                    if (junction.selectedBranch != neededBranch)
                    {
                        Main.DebugLog($"StagingData: toggling J-{jIdx} for path {staging.pathId} on block {blockId}");
                        junction.Switch(Junction.SwitchMode.REGULAR);
                    }
                }
            }

            _activeBlocks[blockId] = staging.pathId;
            if (_blockQueues.TryGetValue(blockId, out var queue))
                queue.Remove(staging.pathId);

            Sessions.AddTag("signals");
        }

        private static void SetSignalToStop(string blockId, string pathId)
        {
            var paths = PathingData.GetPaths();
            var path = paths.FirstOrDefault(p => p.Value<string>("id") == pathId);
            if (path == null) return;
            var blockSignals = path["blockSignals"] as JObject;
            if (blockSignals != null && blockSignals[blockId] != null)
            {
                var sigId = blockSignals[blockId].ToString();
                Main.DebugLog($"StagingData: signal {sigId} -> Manual+S1 for path {pathId} on block {blockId}");
                SignalsShim.SetSignalMode(sigId, "Manual");
                SignalsShim.SetSignalAspect(sigId, "S1");
            }
        }

        private static void ReleaseBlock(string blockId)
        {
            if (_activeBlocks.TryGetValue(blockId, out var pathId))
            {
                SetSignalToStop(blockId, pathId);
                _activeBlocks.Remove(blockId);
                Sessions.AddTag("signals");
            }
        }

        public static void Process()
        {
            var occupancy = OccupancyData.GetOccupancyData();
            bool changed = false;

            lock (lockObj)
            {
                foreach (var kvp in _pathProgress.ToList())
                {
                    var staging = kvp.Value;
                    if (staging.status != "Active")
                        continue;

                    int nextIdx = staging.currentBlockIndex + 1;
                    if (nextIdx < staging.blocks.Length)
                    {
                        var nextBlockId = staging.blocks[nextIdx];
                        if (occupancy.TryGetValue(nextBlockId, out var occ) && occ == true)
                        {
                            var prevBlockId = staging.blocks[staging.currentBlockIndex];

                            if (_activeBlocks.TryGetValue(prevBlockId, out var cp) && cp == staging.pathId)
                                _activeBlocks.Remove(prevBlockId);

                            if (prevBlockId != nextBlockId)
                                SetSignalToStop(prevBlockId, staging.pathId);

                            staging.currentBlockIndex = nextIdx;
                            changed = true;
                            Main.DebugLog($"StagingData: path {staging.pathId} advanced to block {nextBlockId} (index {nextIdx})");

                            int windowStart = staging.currentBlockIndex + 1;
                            if (windowStart >= staging.blocks.Length)
                            {
                                staging.status = "Completed";
                                continue;
                            }
                        }
                    }

                    if (staging.status != "Active")
                        continue;

                    int ws = staging.currentBlockIndex + 1;
                    int we = Math.Min(staging.currentBlockIndex + staging.lookAhead, staging.blocks.Length - 1);

                    var claimedByUs = new HashSet<string>();
                    foreach (var kvp2 in _activeBlocks)
                    {
                        if (kvp2.Value == staging.pathId)
                            claimedByUs.Add(kvp2.Key);
                    }

                    for (int i = ws; i <= we; i++)
                    {
                        var blockId = staging.blocks[i];
                        if (claimedByUs.Contains(blockId))
                        {
                            claimedByUs.Remove(blockId);
                            continue;
                        }
                        if (_activeBlocks.ContainsKey(blockId))
                            continue;
                        if (!_blockQueues.TryGetValue(blockId, out var queue) || queue.Count == 0 || queue[0] != staging.pathId)
                            continue;
                        if (!occupancy.TryGetValue(blockId, out var occ) || occ != false)
                            continue;

                        ActivateBlock(blockId, staging);
                        changed = true;
                    }

                    foreach (var staleId in claimedByUs)
                    {
                        ReleaseBlock(staleId);
                        changed = true;
                    }
                }

                _activeBlocks.RemoveWhere(kvp =>
                    !_pathProgress.Values.Any(p => p.pathId == kvp.Value && p.status == "Active"));
            }

            if (changed)
            {
                Sessions.AddTag("paths");
                Sessions.AddTag("signals");
            }
        }

        public static Dictionary<string, List<string>> GetStagingData()
        {
            lock (lockObj)
            {
                var occupancy = OccupancyData.GetOccupancyData();
                var result = new Dictionary<string, List<string>>();
                foreach (var kvp in _pathProgress)
                {
                    var staging = kvp.Value;
                    var blockStates = new List<string>();
                    for (int i = 0; i < staging.blocks.Length; i++)
                        blockStates.Add(GetBlockState(staging.blocks[i], i, staging, occupancy));
                    result[staging.pathId] = blockStates;
                }
                return result;
            }
        }

        public static string GetStagingStateJson()
        {
            lock (lockObj)
            {
                var occupancy = OccupancyData.GetOccupancyData();
                var result = new JObject();
                var pathsArray = new JArray();

                foreach (var kvp in _pathProgress)
                {
                    var staging = kvp.Value;
                    var pathObj = new JObject();
                    pathObj["id"] = staging.pathId;
                    pathObj["currentBlockIndex"] = staging.currentBlockIndex;
                    pathObj["status"] = staging.status;

                    var blocksArray = new JArray();
                    for (int i = 0; i < staging.blocks.Length; i++)
                    {
                        var blockId = staging.blocks[i];
                        var blockObj = new JObject();
                        blockObj["id"] = blockId;
                        blockObj["state"] = GetBlockState(blockId, i, staging, occupancy);
                        blocksArray.Add(blockObj);
                    }
                    pathObj["blocks"] = blocksArray;
                    pathsArray.Add(pathObj);
                }

                result["paths"] = pathsArray;
                return result.ToString();
            }
        }

        private static string GetBlockState(string blockId, int index, PathStaging staging, Dictionary<string, bool?> occupancy)
        {
            if (index < staging.currentBlockIndex)
            {
                if (occupancy.TryGetValue(blockId, out var occ) && occ == true)
                    return "occupied";
                return "completed";
            }

            if (index == staging.currentBlockIndex)
                return "occupied";

            if (_activeBlocks.TryGetValue(blockId, out var claimingPath))
            {
                if (claimingPath == staging.pathId)
                    return "claimed";
                return "waiting";
            }

            return "unclaimed";
        }
    }

    internal static class DictionaryExtensions
    {
        public static void RemoveWhere<K, V>(this Dictionary<K, V> dict, System.Func<KeyValuePair<K, V>, bool> predicate)
        {
            var keysToRemove = new List<K>();
            foreach (var kvp in dict)
            {
                if (predicate(kvp))
                    keysToRemove.Add(kvp.Key);
            }
            foreach (var key in keysToRemove)
                dict.Remove(key);
        }
    }
}
