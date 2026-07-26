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

        public static string AddPath(JObject pathEntry)
        {
            var id = $"p{nextId++}";
            pathEntry["id"] = id;
            lock (paths)
            {
                paths.Add((JObject)pathEntry.DeepClone());
            }
            Sessions.AddTag("paths");
            return id;
        }

        public static bool RemovePath(string id)
        {
            bool removed;
            lock (paths)
            {
                var count = paths.RemoveAll(p => p.Value<string>("id") == id);
                removed = count > 0;
            }
            if (removed)
                Sessions.AddTag("paths");
            return removed;
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
