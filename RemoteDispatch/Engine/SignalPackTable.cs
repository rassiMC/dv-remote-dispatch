using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.IO;

namespace DvMod.RemoteDispatch
{
	/// <summary>
	/// Serializable description of one lamp on a signal (used by the frontend to render a signal face).
	/// </summary>
	public class SignalLamp
	{
		public string Name { get; set; } = string.Empty;
		public string Colour { get; set; } = string.Empty;
		public double[]? Position { get; set; }
	}

	/// <summary>
	/// Serializable description of one aspect's lamp usage.
	/// </summary>
	public class SignalAspect
	{
		public bool DisallowPassing { get; set; }
		public string[] Lit { get; set; } = Array.Empty<string>();
		public string[] Blinking { get; set; } = Array.Empty<string>();
	}

	/// <summary>
	/// Serializable description of a single signal: its lamps and the aspects seen so far.
	/// </summary>
	public class SignalEntry
	{
		public SignalLamp[] Lamps { get; set; } = Array.Empty<SignalLamp>();
		public Dictionary<string, SignalAspect> Aspects { get; set; } = new Dictionary<string, SignalAspect>(StringComparer.Ordinal);
	}

	/// <summary>
	/// Serializable pack table: the root object persisted as "signalpacks/DVSignalpack-*.json".
	/// </summary>
	public class PackTable
	{
		public string PackId { get; set; } = string.Empty;
		public string PackVersion { get; set; } = string.Empty;
		public string PackName { get; set; } = string.Empty;
		public Dictionary<string, SignalEntry> Signals { get; set; } = new Dictionary<string, SignalEntry>(StringComparer.Ordinal);
	}

	/// <summary>
	/// Caches the current pack table and handles persistence + serialization. Lives in the main
	/// mod project so the HTTP endpoints and update tags can read it without touching Unity.
	/// </summary>
	internal static class PackTableStore
	{
		private static readonly object s_lock = new object();

		private static PackTable? s_table;
		private static string? s_key;

		/// <summary>The directory where pack tables are persisted (signalpacks/ under the mod folder).</summary>
		internal static string? TableDirectory { get; set; }

		/// <summary>The currently active pack file key (e.g. "DVSignalpack-default"). Null until a capture has been observed.</summary>
		internal static string? CurrentKey => s_key;

		/// <summary>
		/// Returns the current table as JSON, or null if no table has been built yet.
		/// </summary>
		internal static string? GetCurrentJson()
		{
			lock (s_lock)
			{
				if (s_table == null) return null;
				return JsonConvert.SerializeObject(s_table);
			}
		}

		/// <summary>
		/// Resets the store (e.g. when the pack key changes) and loads the table from disk for the given key.
		/// </summary>
		internal static void Load(string key)
		{
			lock (s_lock)
			{
				s_key = key;
				s_table = null;

				if (string.IsNullOrEmpty(TableDirectory)) return;

				var path = Path.Combine(TableDirectory, key + ".json");
				if (!File.Exists(path)) return;

				try
				{
					var text = File.ReadAllText(path);
					s_table = JsonConvert.DeserializeObject<PackTable>(text);
				}
				catch (Exception ex)
				{
					Main.Warning($"Failed to load signal pack table '{path}': {ex.Message}");
					s_table = null;
				}
			}
		}

		/// <summary>
		/// Upserts a signal's lamps and the current aspect into the table. Returns true if the table changed.
		/// </summary>
		/// <param name="signalName">The signal name (matches the /signals Id).</param>
		/// <param name="lamps">Lamp descriptors. Passing null keeps any existing lamp list.</param>
		/// <param name="aspectId">The aspect id observed on this signal.</param>
		/// <param name="disallowPassing">Whether the aspect disallows passing.</param>
		/// <param name="lit">Names of lit lamps for this aspect.</param>
		/// <param name="blinking">Names of blinking lamps for this aspect.</param>
		internal static bool Upsert(string signalName, SignalLamp[]? lamps, string aspectId, bool disallowPassing, string[]? lit, string[]? blinking)
		{
			if (string.IsNullOrEmpty(signalName) || string.IsNullOrEmpty(aspectId)) return false;

			lock (s_lock)
			{
				if (s_table == null) s_table = new PackTable();

				if (!s_table.Signals.TryGetValue(signalName, out var entry))
				{
					entry = new SignalEntry();
					s_table.Signals[signalName] = entry;
				}

				bool changed = false;

				// Only set lamps if the caller supplied them (first time we see the signal).
				if (lamps != null)
				{
					entry.Lamps = lamps;
					changed = true;
				}

				if (!entry.Aspects.ContainsKey(aspectId))
				{
					entry.Aspects[aspectId] = new SignalAspect
					{
						DisallowPassing = disallowPassing,
						Lit = lit ?? Array.Empty<string>(),
						Blinking = blinking ?? Array.Empty<string>(),
					};
					changed = true;
				}

				return changed;
			}
		}

		/// <summary>
		/// Persists the current table to disk for the current key. Best-effort, never throws to callers.
		/// </summary>
		internal static void Flush()
		{
			lock (s_lock)
			{
				if (s_table == null || string.IsNullOrEmpty(s_key)) return;
				if (string.IsNullOrEmpty(TableDirectory)) return;

				try
				{
					if (!Directory.Exists(TableDirectory)) Directory.CreateDirectory(TableDirectory);

					var path = Path.Combine(TableDirectory, s_key + ".json");
					var tmp = path + ".tmp";
					var json = JsonConvert.SerializeObject(s_table);
					File.WriteAllText(tmp, json);
					if (File.Exists(path)) File.Delete(path);
					File.Move(tmp, path);
				}
				catch (Exception ex)
				{
					Main.Warning($"Failed to save signal pack table: {ex.Message}");
				}
			}
		}
	}
}