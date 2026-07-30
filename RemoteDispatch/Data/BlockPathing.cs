using Newtonsoft.Json.Linq;
using System.Collections.Generic;
using System.Linq;

namespace DvMod.RemoteDispatch
{
    public static class BlockPathing
    {
        private static readonly object lockObj = new object();
        private static Dictionary<string, List<string>> blockQueues = new Dictionary<string, List<string>>();
        private static HashSet<string> activeClearBlocks = new HashSet<string>();

        private static List<string> GetQueue(string blockId)
        {
            if (!blockQueues.TryGetValue(blockId, out var queue))
            {
                queue = new List<string>();
                blockQueues[blockId] = queue;
            }
            return queue;
        }

        public static void RebuildFromPaths(List<JObject> paths)
        {
            lock (lockObj)
            {
                blockQueues.Clear();
                activeClearBlocks.Clear();
                foreach (var path in paths)
                {
                    var pathId = path.Value<string>("id");
                    if (pathId == null) continue;
                    var blocks = path["blocks"] as JArray;
                    if (blocks == null || blocks.Count == 0) continue;
                    foreach (var blockToken in blocks)
                    {
                        var queue = GetQueue(blockToken.ToString());
                        if (!queue.Contains(pathId))
                            queue.Add(pathId);
                    }
                }
            }
        }

        public static void AddPathToQueues(string pathId, JArray blocksArray)
        {
            lock (lockObj)
            {
                var occupancy = OccupancyData.GetOccupancyData();
                var paths = PathingData.GetPaths();
                var path = paths.FirstOrDefault(p => p.Value<string>("id") == pathId);

                foreach (var blockToken in blocksArray)
                {
                    var blockId = blockToken.ToString();
                    var queue = GetQueue(blockId);
                    if (!queue.Contains(pathId))
                        queue.Add(pathId);
                }

                foreach (var blockToken in blocksArray)
                {
                    var blockId = blockToken.ToString();
                    var queue = GetQueue(blockId);
                    if (queue.Count == 0 || queue[0] != pathId) continue;
                    if (path == null) continue;
                    if (!occupancy.TryGetValue(blockId, out var occ) || occ != false) continue;

                    ActivatePathOnBlockInternal(blockId, path);
                    activeClearBlocks.Add(blockId);
                    Main.DebugLog($"BlockPathing: immediate activation of {blockId} for path {pathId}");
                }
            }
        }

        public static void RemovePathFromQueues(string pathId)
        {
            lock (lockObj)
            {
                var emptyBlocks = new List<string>();
                foreach (var kvp in blockQueues)
                {
                    kvp.Value.Remove(pathId);
                    if (kvp.Value.Count == 0)
                        emptyBlocks.Add(kvp.Key);
                }
                foreach (var blockId in emptyBlocks)
                    blockQueues.Remove(blockId);
                activeClearBlocks.RemoveWhere(b =>
                    !blockQueues.ContainsKey(b) || blockQueues[b].Count == 0);
            }
        }

        public static void RemovePathFromQueuesAllBlocks(string pathId, JArray blocksArray)
        {
            lock (lockObj)
            {
                foreach (var blockToken in blocksArray)
                {
                    var blockId = blockToken.ToString();
                    if (blockQueues.TryGetValue(blockId, out var queue))
                    {
                        queue.Remove(pathId);
                        if (queue.Count == 0)
                            blockQueues.Remove(blockId);
                    }
                    activeClearBlocks.Remove(blockId);
                }
            }
        }

        private static void ActivatePathOnBlockInternal(string blockId, JObject path)
        {
            if (!OccupancyData.TryGetOwnSwitchIndex(blockId, out var jIdx) || jIdx < 0)
                return;
            if (jIdx >= RailTrackRegistry.Instance.OrderedJunctions.Length)
                return;

            var switchAssignments = path["switchAssignments"] as JObject;
            if (switchAssignments != null && switchAssignments[blockId] != null)
            {
                var neededBranch = (byte)(switchAssignments[blockId].Value<int>());
                var junction = RailTrackRegistry.Instance.OrderedJunctions[jIdx];
                if (junction.selectedBranch != neededBranch)
                {
                    Main.DebugLog($"BlockPathing: toggling J-{jIdx} for path {path.Value<string>("id")} on block {blockId}");
                    junction.Switch(Junction.SwitchMode.REGULAR);
                }
            }

            var signalIds = OccupancyData.GetOwnSwitchSignalIdsForBlock(blockId);
            foreach (var sigId in signalIds)
            {
                Main.DebugLog($"BlockPathing: signal {sigId} -> Automatic for path {path.Value<string>("id")}");
                SignalsShim.SetSignalMode(sigId, "Automatic");
            }

            Sessions.AddTag("signals");
        }

        public static void CheckAndProcess()
        {
            var occupancy = OccupancyData.GetOccupancyData();
            var paths = PathingData.GetPaths();
            var pathsById = new Dictionary<string, JObject>();
            foreach (var p in paths)
            {
                var id = p.Value<string>("id");
                if (id != null) pathsById[id] = p;
            }

            bool changed = false;

            lock (lockObj)
            {
                foreach (var kvp in blockQueues.ToList())
                {
                    var blockId = kvp.Key;
                    var queue = kvp.Value;
                    if (queue.Count == 0) continue;

                    if (!occupancy.TryGetValue(blockId, out var occ)) continue;
                    bool isOccupied = occ == true;
                    bool isClear = occ == false;
                    bool isFlagged = activeClearBlocks.Contains(blockId);

                    if (isFlagged && isOccupied)
                    {
                        var poppedPathId = queue[0];
                        queue.RemoveAt(0);
                        activeClearBlocks.Remove(blockId);
                        changed = true;
                        Main.DebugLog($"BlockPathing: {blockId} occupied, popped {poppedPathId}");
                    }
                    else if (!isFlagged && isClear && queue.Count > 0)
                    {
                        var nextPathId = queue[0];
                        if (pathsById.TryGetValue(nextPathId, out var nextPath))
                        {
                            ActivatePathOnBlockInternal(blockId, nextPath);
                            activeClearBlocks.Add(blockId);
                            changed = true;
                            Main.DebugLog($"BlockPathing: {blockId} clear, activated {nextPathId}");
                        }
                    }

                    if (queue.Count == 0)
                        blockQueues.Remove(blockId);
                }

                activeClearBlocks.RemoveWhere(b =>
                    !blockQueues.ContainsKey(b) || blockQueues[b].Count == 0);
            }

            if (changed)
            {
                Sessions.AddTag("paths");
                Sessions.AddTag("signals");
            }
        }
    }
}
