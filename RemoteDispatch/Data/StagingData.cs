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
        private const int MaxAutoClaimAhead = 5;

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
        private static Dictionary<string, DateTime> _retryTimes = new Dictionary<string, DateTime>();
        private static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(20);

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
                _retryTimes.Clear();

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
                    ActivateBlock(blocksArr[0], staging);
                }

                _retryTimes[pathId] = DateTime.UtcNow;
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
                _retryTimes.Clear();
            }
        }

        public static bool ForceClaimNextBlock(string pathId)
        {
            lock (lockObj)
            {
                if (!_pathProgress.TryGetValue(pathId, out var staging))
                    return false;
                if (staging.status != "Active")
                    return false;

                var (_, _, b2Index) = GetClaimWindowEnd(staging);
                if (b2Index >= staging.blocks.Length)
                    return false;

                var occupancy = OccupancyData.GetOccupancyData();
                var (ok, count) = TryClaimFrom(staging, b2Index, int.MaxValue, occupancy, manualAdvance: true);
                if (ok)
                {
                    int claimedEnd = b2Index + count - 1;
                    int needed = claimedEnd - staging.currentBlockIndex;
                    if (needed > staging.lookAhead)
                        staging.lookAhead = needed;

                    _retryTimes.Remove(pathId);
                    Sessions.AddTag("paths");
                    return true;
                }

                _retryTimes[pathId] = DateTime.UtcNow + RetryInterval;
                return false;
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
                    _retryTimes.Remove(pathId);
                }
            }
        }

        public static void UpdatePath(string pathId, JArray newBlocksArray)
        {
            lock (lockObj)
            {
                if (!_pathProgress.TryGetValue(pathId, out var staging))
                    return;
                _retryTimes.Remove(pathId);

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

        /// Returns (b1Claimed, b1Index, b2Index): whether we hold a claim window,
        /// the index of the furthest contiguous claim (B1), and the next index (B2).
        /// If nothing is claimed, B1 is the current block (train location).
        private static (bool, int, int) GetClaimWindowEnd(PathStaging staging)
        {
            int b1 = staging.currentBlockIndex;
            bool claimed = false;

            for (int i = staging.currentBlockIndex + 1; i < staging.blocks.Length; i++)
            {
                if (_activeBlocks.TryGetValue(staging.blocks[i], out var claimer) && claimer == staging.pathId)
                {
                    b1 = i;
                    claimed = true;
                }
                else
                {
                    break;
                }
            }

            return (claimed, b1, b1 + 1);
        }

        /// <summary>
        /// Counts how many blocks the path has claimed strictly ahead of its
        /// current block (the contiguous lookahead window). Excludes the block
        /// the train currently occupies.
        /// </summary>
        private static int CountClaimedAhead(PathStaging staging)
        {
            var (claimed, b1Index, _) = GetClaimWindowEnd(staging);
            if (!claimed)
                return 0;
            return b1Index - staging.currentBlockIndex;
        }

        private static List<string> GetPathsWithBlockUpcoming(string blockId, string excludePathId)
        {
            var result = new List<string>();

            if (!_blockQueues.TryGetValue(blockId, out var queue))
                return result;

            foreach (var pathId in queue)
            {
                if (pathId == excludePathId)
                    continue;
                if (!_pathProgress.TryGetValue(pathId, out var other))
                    continue;
                if (other.status != "Active")
                    continue;
                if (_activeBlocks.TryGetValue(blockId, out var claimer) && claimer == pathId)
                    continue;

                bool upcoming = false;
                for (int i = other.currentBlockIndex + 1; i < other.blocks.Length; i++)
                {
                    if (other.blocks[i] == blockId)
                    {
                        upcoming = true;
                        break;
                    }
                }
                if (upcoming)
                    result.Add(pathId);
            }
            return result;
        }

        private static bool IsOpposing(PathStaging ours, PathStaging other, string b1BlockId, string b2BlockId)
        {
            int b1Idx = -1;
            int b2Idx = -1;
            for (int i = 0; i < other.blocks.Length; i++)
            {
                if (other.blocks[i] == b1BlockId) b1Idx = i;
                if (other.blocks[i] == b2BlockId) b2Idx = i;
            }

            if (b1Idx < 0 || b2Idx < 0)
                return false;

            // Opposing: they encounter B2 before B1 (they travel the shared section
            // in reverse order compared to us).
            return b2Idx < b1Idx;
        }

        private static void PrunePastBlocks(PathStaging staging)
        {
            int removeCount = staging.currentBlockIndex;
            if (removeCount <= 0) return;

            var pruned = new List<string>();
            for (int i = 0; i < removeCount; i++)
                pruned.Add(staging.blocks[i]);

            staging.blocks = staging.blocks.Skip(removeCount).ToArray();
            staging.currentBlockIndex = 0;

            foreach (var blockId in pruned)
            {
                if (_blockQueues.TryGetValue(blockId, out var queue))
                {
                    queue.Remove(staging.pathId);
                    if (queue.Count == 0)
                        _blockQueues.Remove(blockId);
                }
            }

            PathingData.RemovePrefixFromPath(staging.pathId, removeCount);
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

        /// <summary>
        /// Recursively walks our route forward from startIndex and returns how many
        /// blocks can be cleared before all conflicting paths have ended.
        /// Returns 0 if a claimed section or the end of our route (with opposing
        /// traffic still active) is hit before the conflicts resolve. An occupied
        /// block advances the clearance by one and the walk continues (blocked
        /// occupancy is not treated as a hard failure like a claimed one).
        /// </summary>
        private static int CalcRange(
            HashSet<string> newPaths,
            HashSet<string> opposingPaths,
            int startIndex,
            PathStaging staging,
            Dictionary<string, bool?> occupancy)
        {
            int clearCount = 0;

            for (int i = startIndex; i < staging.blocks.Length; i++)
            {
                var blockId = staging.blocks[i];

                if (_activeBlocks.TryGetValue(blockId, out var claimer) && claimer != staging.pathId)
                    return 0;

                clearCount++;

                var pathsHere = new HashSet<string>(GetPathsWithBlockUpcoming(blockId, staging.pathId));

                newPaths.RemoveWhere(p => !pathsHere.Contains(p));
                opposingPaths.RemoveWhere(p => !pathsHere.Contains(p));

                foreach (var p in pathsHere)
                {
                    if (!newPaths.Contains(p) && !opposingPaths.Contains(p))
                        newPaths.Add(p);
                }

                var ourNext = i + 1 < staging.blocks.Length ? staging.blocks[i + 1] : blockId;

                foreach (var p in newPaths.ToList())
                {
                    if (!_pathProgress.TryGetValue(p, out var other))
                    {
                        newPaths.Remove(p);
                        continue;
                    }

                    if (other.blocks[other.blocks.Length - 1] == blockId)
                    {
                        newPaths.Remove(p);
                        continue;
                    }

                    if (IsOpposing(staging, other, blockId, ourNext))
                    {
                        newPaths.Remove(p);
                        opposingPaths.Add(p);
                    }
                    else
                    {
                        newPaths.Remove(p);
                    }
                }

                opposingPaths.RemoveWhere(p =>
                {
                    if (!_pathProgress.TryGetValue(p, out var other))
                        return true;
                    return other.blocks[other.blocks.Length - 1] == blockId;
                });

                if (newPaths.Count == 0 && opposingPaths.Count == 0)
                    return clearCount;
            }

            return 0;
        }

        /// <summary>
        /// Conflict-aware claim attempt. Tries to claim blocks starting at
        /// startIndex, respecting opposing/upcoming paths and physical occupancy.
        /// When manualAdvance is true (the Claim Next block button) it claims a
        /// single block when nothing is in the way, and the full cleared range
        /// when clearing through opposing traffic. Otherwise it fills up to
        /// maxBlocks (the automatic lookahead window).
        /// Returns (success, claimedCount); claimedCount == 0 means nothing claimed.
        /// </summary>
        private static (bool, int) TryClaimFrom(
            PathStaging staging,
            int startIndex,
            int maxBlocks,
            Dictionary<string, bool?> occupancy,
            bool manualAdvance = false)
        {
            if (startIndex >= staging.blocks.Length)
                return (false, 0);

            var b1BlockId = staging.blocks[Math.Max(0, startIndex - 1)];
            var b2BlockId = staging.blocks[startIndex];

            var listA = new HashSet<string>(GetPathsWithBlockUpcoming(b1BlockId, staging.pathId));
            var listB = new HashSet<string>(GetPathsWithBlockUpcoming(b2BlockId, staging.pathId));

            var opposingPaths = new HashSet<string>();
            foreach (var p in listA.Where(x => listB.Contains(x)))
            {
                if (!_pathProgress.TryGetValue(p, out var other))
                    continue;
                if (IsOpposing(staging, other, b1BlockId, b2BlockId))
                    opposingPaths.Add(p);
            }

            var newPaths = new HashSet<string>(listB.Where(x => !listA.Contains(x)));

            if (newPaths.Count > 0)
            {
                foreach (var p in newPaths)
                {
                    if (_activeBlocks.TryGetValue(b2BlockId, out var claimer) && claimer == p)
                        return (false, 0);
                }

                int clearCount = CalcRange(
                    new HashSet<string>(newPaths),
                    new HashSet<string>(opposingPaths),
                    startIndex,
                    staging,
                    occupancy);

                if (clearCount == 0)
                    return (false, 0);

                int claimLimit = Math.Min(clearCount, maxBlocks);
                int claimCount = 0;
                for (int i = startIndex; i < staging.blocks.Length && (i - startIndex) < claimLimit; i++)
                {
                    var blockId = staging.blocks[i];
                    if (_activeBlocks.TryGetValue(blockId, out var claimer) && claimer != staging.pathId)
                        break;
                    if (occupancy.TryGetValue(blockId, out var occ) && occ == true)
                        break;
                    ActivateBlock(blockId, staging);
                    claimCount++;
                }

                if (claimCount == 0)
                    return (false, 0);

                return (true, claimCount);
            }
            else if (opposingPaths.Count > 0)
            {
                if (_activeBlocks.ContainsKey(b2BlockId))
                    return (false, 0);
                if (occupancy.TryGetValue(b2BlockId, out var occ) && occ == true)
                    return (false, 0);

                ActivateBlock(b2BlockId, staging);
                return (true, 1);
            }
            else
            {
                int bound = manualAdvance ? 1 : maxBlocks;
                int claimCount = 0;

                for (int i = startIndex; i < staging.blocks.Length; i++)
                {
                    if ((i - startIndex) >= bound)
                        break;
                    var blockId = staging.blocks[i];
                    if (_activeBlocks.ContainsKey(blockId))
                        break;
                    if (occupancy.TryGetValue(blockId, out var occ) && occ == true)
                        break;
                    ActivateBlock(blockId, staging);
                    claimCount++;
                }
                return (claimCount > 0, claimCount);
            }
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
                            PrunePastBlocks(staging);
                            changed = true;
                            Main.DebugLog($"StagingData: path {staging.pathId} advanced to block {nextBlockId} (index {nextIdx})");

                            int windowStart = staging.currentBlockIndex + 1;
                            if (windowStart >= staging.blocks.Length)
                            {
                                staging.status = "Completed";
                                Main.DebugLog($"StagingData: path {staging.pathId} completed, cleaning up");
                                changed = true;
                                continue;
                            }
                        }
                    }

                    if (staging.status != "Active")
                        continue;

                    var (_, b1Index, _) = GetClaimWindowEnd(staging);
                    int ws = b1Index + 1;

                    if (ws < staging.blocks.Length)
                    {
                        bool canTry = true;

                        if (CountClaimedAhead(staging) >= MaxAutoClaimAhead)
                        {
                            canTry = false;
                        }
                        else if (_retryTimes.TryGetValue(staging.pathId, out var retryTime)
                                 && DateTime.UtcNow < retryTime)
                        {
                            canTry = false;
                        }

                        if (canTry)
                        {
                            int maxBlocks = MaxAutoClaimAhead - CountClaimedAhead(staging);

                            var (claimed, _) = TryClaimFrom(staging, ws, maxBlocks, occupancy);
                            _retryTimes[staging.pathId] = DateTime.UtcNow + RetryInterval;

                            if (claimed)
                            {
                                changed = true;
                            }
                        }
                    }
                }

                var completed = _pathProgress.Where(kvp => kvp.Value.status == "Completed").Select(kvp => kvp.Key).ToList();
                foreach (var pathId in completed)
                {
                    var staging = _pathProgress[pathId];
                    var lastBlock = staging.blocks[staging.blocks.Length - 1];
                    if (_activeBlocks.TryGetValue(lastBlock, out var cp) && cp == pathId)
                        ReleaseBlock(lastBlock);
                    else
                        SetSignalToStop(lastBlock, pathId);
                    _pathProgress.Remove(pathId);
                    PathingData.RemovePathFromStoredList(pathId);
                    Main.DebugLog($"StagingData: path {pathId} fully cleaned up from server");
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
