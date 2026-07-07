using DV.PointSet;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using UnityEngine;

namespace DvMod.RemoteDispatch
{
	public static class World
	{
		public readonly struct Position
		{
			public readonly float x;
			public readonly float z;

			public Position(float x, float z)
			{
				this.x = x;
				this.z = z;
			}

			public Position(Vector3 position) : this(position.x, position.z) { }
			public Position(Transform transform) : this(transform.position) { }

			public LatLon ToLatLon() => LatLon.From(this);
		}

		public readonly struct LatLon
		{
			private const int DECIMAL_PLACES = 8; // 1.11 mm
			private const float EARTH_CIRCUMFERENCE = 40e6f;
			private const float DEGREES_PER_METER = 360f / EARTH_CIRCUMFERENCE;

			public readonly float latitude;
			public readonly float longitude;

			public LatLon(float latitude, float longitude)
			{
				this.latitude = (float)Math.Round(latitude, DECIMAL_PLACES);
				this.longitude = (float)Math.Round(longitude, DECIMAL_PLACES);
			}

			public static LatLon From(Position p) => new LatLon(DEGREES_PER_METER * p.z, DEGREES_PER_METER * p.x);

			public JToken ToJson() => new JArray(latitude, longitude);
		}
	}

	public static class RailTracks
	{
		private const float SIMPLIFIED_RESOLUTION = 40f;

		private static IEnumerable<World.LatLon> NormalizeTrackPoints(IEnumerable<World.Position> positions) => positions.Select(p => p.ToLatLon());

		public static Dictionary<RailTrack, IEnumerable<World.LatLon>> GetNormalizedTrackCoordinates() =>
			GetAllTrackPoints().ToDictionary(kvp => kvp.Key, kvp => NormalizeTrackPoints(kvp.Value));

		public static Dictionary<RailTrack, IEnumerable<World.Position>> GetAllTrackPoints(float resolution = SIMPLIFIED_RESOLUTION)
		{
			if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
				throw new Exception("World not yet loaded");
			var tracks = Component.FindObjectsOfType<RailTrack>();
			Main.DebugLog($"Found {tracks.Length} RailTracks.");
			return tracks.ToDictionary(track => track, track => GetTrackPoints(track, resolution));
		}

		private static IEnumerable<World.Position> GetTrackPoints(RailTrack track, float resolution = SIMPLIFIED_RESOLUTION)
		{
			var pointSet = track.GetKinkedPointSet();
			EquiPointSet simplified = EquiPointSet.ResampleEquidistant(
				pointSet,
				Mathf.Min(resolution, (float)pointSet.span / 3));

			foreach (var pt in simplified.points)
				yield return new World.Position((float)pt.position.x, (float)pt.position.z);
		}

		private static string? trackPointJSON;

		private static string GenerateTrackPointJSON()
		{
			trackPointJSON = JsonConvert.SerializeObject(
				GetNormalizedTrackCoordinates().ToDictionary(
					kvp => kvp.Key.LogicTrack().ID,
					kvp => kvp.Value.Select(ll => ll.ToJson())));
			return trackPointJSON;
		}

		public static async Task<string> GetTrackPointJSON()
		{
			if (trackPointJSON != null)
				return trackPointJSON;
			if (!WorldStreamingInit.Instance)
				throw new Exception("World not yet loaded");

			if (WorldStreamingInit.IsLoaded)
				return GenerateTrackPointJSON();

			var tcs = new TaskCompletionSource<string>();
			WorldStreamingInit.LoadingFinished += () => tcs.TrySetResult(GenerateTrackPointJSON());
			if (WorldStreamingInit.IsLoaded)
				return GenerateTrackPointJSON();

			return await tcs.Task.ConfigureAwait(false);
		}
	}

	public static class Junctions
	{
		private const float CONNECTION_THRESHOLD = 1.5f;

		private static string junctionPointJSON = string.Empty;

		public static string GetJunctionPointJSON()
		{
			if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
				throw new Exception("World not yet loaded");
			if (string.IsNullOrEmpty(junctionPointJSON))
			{
				junctionPointJSON = JsonConvert.SerializeObject(
					RailTrackRegistry.Instance.OrderedJunctions.Select(j =>
					{
						var moved = j.position - WorldMover.currentMove;
						return new JObject(
							new JProperty("position", new World.Position(moved.x, moved.z).ToLatLon().ToJson()),
							new JProperty("branches", j.outBranches.Select(b => b.track.LogicTrack().ID.ToString())),
							new JProperty("id", j.junctionData.junctionIdLong)
						);
					})
				);
			}
			return junctionPointJSON;
		}

		public static IEnumerable<byte> GetAllJunctionStates()
		{
			if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
				throw new Exception("World not yet loaded");
			return RailTrackRegistry.Instance.OrderedJunctions.Select(j => j.selectedBranch);
		}

		public static string GetJunctionStateJSON()
		{
			return JsonConvert.SerializeObject(GetAllJunctionStates());
		}

		public static Dictionary<string, JunctionGraphData> BuildTrackGraph()
		{
			if (!WorldStreamingInit.Instance || !WorldStreamingInit.IsLoaded)
				throw new Exception("World not yet loaded");

			var allTracks = RailTracks.GetAllTrackPoints();
			var junctions = RailTrackRegistry.Instance.OrderedJunctions;
			
			var trackToJunctionMap = new Dictionary<string, List<(int junctionIndex, World.Position endpoint)>>();
			
			foreach (var kvp in allTracks)
			{
				var trackId = kvp.Key.LogicTrack().ID.ToString();
				var points = kvp.Value.ToList();
				
				if (points.Count < 2)
					continue;

				var startPoint = points.First();
				var endPoint = points.Last();

				for (int j = 0; j < junctions.Length; j++)
				{
					var junction = junctions[j];
					var junctionPos = new World.Position(junction.position - WorldMover.currentMove);
					
					if (Vector3.Distance(new Vector3(startPoint.x, 0, startPoint.z), new Vector3(junctionPos.x, 0, junctionPos.z)) < CONNECTION_THRESHOLD)
					{
						if (!trackToJunctionMap.ContainsKey(trackId))
							trackToJunctionMap[trackId] = new List<(int, World.Position)>();
						trackToJunctionMap[trackId].Add((j, startPoint));
					}

					if (Vector3.Distance(new Vector3(endPoint.x, 0, endPoint.z), new Vector3(junctionPos.x, 0, junctionPos.z)) < CONNECTION_THRESHOLD)
					{
						if (!trackToJunctionMap.ContainsKey(trackId))
							trackToJunctionMap[trackId] = new List<(int, World.Position)>();
						trackToJunctionMap[trackId].Add((j, endPoint));
					}
				}
			}

			var graphData = new Dictionary<string, JunctionGraphData>();

			for (int i = 0; i < junctions.Length; i++)
			{
				var junction = junctions[i];
				var movedPos = junction.position - WorldMover.currentMove;
				
				var incomingTracks = new List<string>();
				foreach (var kvp in trackToJunctionMap)
				{
					if (kvp.Value.Count == 2 && kvp.Value.Any(x => x.junctionIndex == i))
					{
						incomingTracks.Add(kvp.Key);
					}
				}

				var outgoingTrackIds = junction.outBranches.Select(b => b.track.LogicTrack().ID.ToString()).ToList();

				var neighbors = new List<int>();
				var allTrackIds = new HashSet<string>(incomingTracks);
				allTrackIds.UnionWith(outgoingTrackIds);

				foreach (var trackId in allTrackIds)
				{
					if (trackToJunctionMap.TryGetValue(trackId, out var connectedJunctions))
					{
						foreach (var (otherIdx, _) in connectedJunctions)
						{
							if (otherIdx != i && !neighbors.Contains(otherIdx))
								neighbors.Add(otherIdx);
						}
					}
				}

				graphData[junction.junctionData.junctionIdLong.ToString()] = new JunctionGraphData
				{
					junctionIndex = i,
					position = new World.Position(movedPos.x, movedPos.z).ToLatLon(),
					incomingTracks = incomingTracks,
					outgoingTracks = outgoingTrackIds,
					currentBranch = junction.selectedBranch,
					neighbors = neighbors,
					degree = neighbors.Count
				};
			}

			return graphData;
		}

		public static string GetTrackGraphJSON()
		{
			return JsonConvert.SerializeObject(BuildTrackGraph());
		}
	}

	public class JunctionGraphData
	{
		public int junctionIndex { get; set; }
		public World.LatLon position { get; set; } = default!;
		public List<string> incomingTracks { get; set; } = new();
		public List<string> outgoingTracks { get; set; } = new();
		public byte currentBranch { get; set; }
		public List<int> neighbors { get; set; } = new();
		public int degree { get; set; }
	}
}
