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
                var occupancy = OccupancyData.GetOccupancyData();
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
                    var firstBlock = blocks[0].ToString();
                    if (!occupancy.TryGetValue(firstBlock, out var occ) || occ != true)
                        activeClearBlocks.Add(firstBlock);
                }
            }
        }

        public static void AddPathToQueues(string pathId, JArray blocksArray)
        {
            lock (lockObj)
            {
                var occupancy = OccupancyData.GetOccupancyData();
                foreach (var blockToken in blocksArray)
                {
                    var queue = GetQueue(blockToken.ToString());
                    if (!queue.Contains(pathId))
                        queue.Add(pathId);
                }
                if (blocksArray.Count > 0)
                {
                    var firstBlock = blocksArray[0].ToString();
                    if (!occupancy.TryGetValue(firstBlock, out var occ) || occ != true)
                        activeClearBlocks.Add(firstBlock);
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
                var poppedPaths = new List<string>();

                foreach (var kvp in blockQueues.ToList())
                {
                    var blockId = kvp.Key;
                    var queue = kvp.Value;
                    if (queue.Count == 0) continue;

                    bool isFlagged = activeClearBlocks.Contains(blockId);
                    bool? occState = occupancy.TryGetValue(blockId, out var occ) ? occ : null;
                    if (occState == null) continue;

                    if (isFlagged && occState == true)
                    {
                        var activePathId = queue[0];
                        poppedPaths.Add(activePathId);
                        PopPathIdFromAllBlocks(activePathId);
                        changed = true;
                        Main.DebugLog($"BlockPathing: {blockId} occupied, popped path {activePathId}");
                    }
                    else if (!isFlagged && occState == false && queue.Count > 0)
                    {
                        var nextPathId = queue[0];
                        if (pathsById.TryGetValue(nextPathId, out var nextPath))
                        {
                            if (OccupancyData.TryGetOwnSwitchIndex(blockId, out var jIdx) && jIdx >= 0)
                            {
                                var switchAssignments = nextPath["switchAssignments"] as JObject;
                                if (switchAssignments != null && switchAssignments[blockId] != null)
                                {
                                    var neededBranch = (byte)(switchAssignments[blockId].Value<int>());
                                    if (jIdx < RailTrackRegistry.Instance.OrderedJunctions.Length)
                                    {
                                        var junction = RailTrackRegistry.Instance.OrderedJunctions[jIdx];
                                        if (junction.selectedBranch != neededBranch)
                                        {
                                            Main.DebugLog($"BlockPathing: toggling J-{jIdx} for path {nextPathId} on block {blockId}");
                                            junction.Switch(Junction.SwitchMode.REGULAR);
                                        }
                                    }
                                }
                                var signalIds = OccupancyData.GetOwnSwitchSignalIdsForBlock(blockId);
                                foreach (var sigId in signalIds)
                                {
                                    Main.DebugLog($"BlockPathing: signal {sigId} -> Automatic for path {nextPathId}");
                                    SignalsShim.SetSignalMode(sigId, "Automatic");
                                }
                            }
                            activeClearBlocks.Add(blockId);
                            changed = true;
                            Main.DebugLog($"BlockPathing: {blockId} clear, activated path {nextPathId}");
                        }
                    }

                    if (queue.Count == 0)
                        blockQueues.Remove(blockId);
                }

                foreach (var pathId in poppedPaths)
                {
                    if (pathsById.TryGetValue(pathId, out var path))
                    {
                        var blocks = path["blocks"] as JArray;
                        if (blocks != null && blocks.Count > 0)
                        {
                    var lastBlock = blocks[blocks.Count - 1].ToString();
                    blockQueues.TryGetValue(lastBlock, out var queue);
                            if (queue == null || !queue.Contains(pathId))
                            {
                                var signalIds = PathingData.GetSignalIdsForPath(pathId);
                                if (signalIds.Count > 0)
                                {
                                    foreach (var sigId in signalIds)
                                    {
                                        SignalsShim.SetSignalMode(sigId, "Manual");
                                        SignalsShim.SetSignalAspect(sigId, "S1");
                                    }
                                }
                                PathingData.RemovePath(pathId);
                                Main.DebugLog($"BlockPathing: path {pathId} reached destination, removed");
                            }
                        }
                    }
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

        private static void PopPathIdFromAllBlocks(string pathId)
        {
            var emptyBlocks = new List<string>();
            foreach (var kvp in blockQueues)
            {
                if (kvp.Value.Remove(pathId) && kvp.Value.Count == 0)
                    emptyBlocks.Add(kvp.Key);
            }
            foreach (var blockId in emptyBlocks)
                blockQueues.Remove(blockId);
            activeClearBlocks.RemoveWhere(b =>
                !blockQueues.ContainsKey(b) || blockQueues[b].Count == 0);
        }
    }
}
