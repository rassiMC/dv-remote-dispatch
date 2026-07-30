using Newtonsoft.Json.Linq;
using System.Collections.Generic;
using System.Linq;

namespace DvMod.RemoteDispatch
{
    public static class PathingData
    {
        private static readonly List<JObject> paths = new List<JObject>();
        private static int nextId = 1;

        public static JArray GetPathsJson()
        {
            lock (paths)
            {
                return new JArray(paths.Select(p => (JToken)p.DeepClone()));
            }
        }

        public static List<JObject> GetPaths()
        {
            lock (paths)
            {
                return paths.ToList();
            }
        }

        public static List<string> GetAllSignalIds()
        {
            lock (paths)
            {
                var result = new List<string>();
                foreach (var p in paths)
                {
                    var arr = p["signalIds"] as JArray;
                    if (arr != null)
                        result.AddRange(arr.ToObject<List<string>>());
                }
                return result;
            }
        }

        public static List<string> GetSignalIdsForPath(string id)
        {
            lock (paths)
            {
                var p = paths.FirstOrDefault(x => x.Value<string>("id") == id);
                if (p == null) return new List<string>();
                var arr = p["signalIds"] as JArray;
                return arr?.ToObject<List<string>>() ?? new List<string>();
            }
        }

        public static bool HasSignalIds(string id)
        {
            lock (paths)
            {
                var p = paths.FirstOrDefault(x => x.Value<string>("id") == id);
                if (p == null) return false;
                return p["signalIds"] != null;
            }
        }

        public static string AddPath(JObject pathEntry)
        {
            var id = $"p{nextId++}";
            pathEntry["id"] = id;
            lock (paths)
            {
                paths.Add((JObject)pathEntry.DeepClone());
            }
            var blocks = pathEntry["blocks"] as JArray;
            if (blocks != null)
                BlockPathing.AddPathToQueues(id, blocks);
            Sessions.AddTag("paths");
            return id;
        }

        public static bool RemovePath(string id)
        {
            bool removed;
            JObject? removedPath = null;
            lock (paths)
            {
                removedPath = paths.FirstOrDefault(p => p.Value<string>("id") == id);
                var count = paths.RemoveAll(p => p.Value<string>("id") == id);
                removed = count > 0;
            }
            if (removed && removedPath != null)
            {
                BlockPathing.RemovePathFromQueues(id);
                Sessions.AddTag("paths");
            }
            return removed;
        }

        public static void UpdatePath(JObject pathEntry)
        {
            var id = pathEntry.Value<string>("id");
            JObject? oldPath = null;
            lock (paths)
            {
                var existing = paths.FirstOrDefault(p => p.Value<string>("id") == id);
                if (existing != null)
                {
                    oldPath = (JObject)existing.DeepClone();
                    paths[paths.IndexOf(existing)] = (JObject)pathEntry.DeepClone();
                }
            }
            if (oldPath != null)
            {
                var oldBlocks = oldPath["blocks"] as JArray;
                if (oldBlocks != null)
                    BlockPathing.RemovePathFromQueuesAllBlocks(id, oldBlocks);
                var newBlocks = pathEntry["blocks"] as JArray;
                if (newBlocks != null)
                    BlockPathing.AddPathToQueues(id, newBlocks);
                Sessions.AddTag("paths");
            }
        }

        public static void ClearPaths()
        {
            lock (paths)
            {
                paths.Clear();
            }
            Sessions.AddTag("paths");
        }
    }
}
