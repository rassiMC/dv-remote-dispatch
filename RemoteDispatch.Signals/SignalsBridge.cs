	using System;
	using System.Collections.Generic;
	using System.Linq;
	using System.Reflection;
	using Signals.API;
	using Newtonsoft.Json;
	using UnityEngine;

namespace DvMod.RemoteDispatch.Signals
{
	internal class SignalsBridge
	{
		/// <summary>Callbacks to invoke on event</summary>
		private readonly Action<string, string>? _onAspectChanged;
		private readonly Action<string, string>? _onModeChanged;

		/// <summary>Constructor - inject callbacks for forward compat</summary>
		internal SignalsBridge(Action<string, string>? onAspectChanged = null, Action<string, string>? onModeChanged = null)
		{
			_onAspectChanged = onAspectChanged;
			_onModeChanged = onModeChanged;
		}

		/// <summary>
		/// Registers event handlers for the SignalsAPI loaded and unloaded events.
		/// </summary>
		/// <remarks>Call this method to enable automatic handling of SignalsAPI lifecycle events within
		/// the current context. This method should be called only once per instance to avoid multiple
		/// registrations.</remarks>
		internal void Register()
		{
			// When SignalsAPI is Loaded, run OnSignalsLoaded
			SignalsAPI.Loaded += OnSignalsLoaded;
			// When SignalsAPI is Unloaded, run OnSignalsUnloaded
			SignalsAPI.Unloaded += OnSignalsUnloaded;

			// If SignalsAPI is already loaded before we registered, we missed the event.
			// Subscribe to instance events directly now.
			if (SignalsAPI.Instance != null)
			{
				OnSignalsLoaded();
			}
		}

		/// <summary>
		/// Unregisters event handlers from the SignalsAPI to stop receiving signal-related notifications.
		/// </summary>
		/// <remarks>Call this method to detach previously registered event handlers and prevent further
		/// callbacks from the SignalsAPI. This is typically used during cleanup to avoid memory leaks or unintended
		/// behavior after the object is no longer needed.</remarks>
		internal void Unregister()
		{
			// Make sure to undo everything we did in Register
			SignalsAPI.Loaded -= OnSignalsLoaded;
			SignalsAPI.Unloaded -= OnSignalsUnloaded;
			if (SignalsAPI.Instance != null)
			{
				// Also remove the handlers if the API is still around
				SignalsAPI.Instance.SignalAspectChanged -= OnAspectChanged;
				SignalsAPI.Instance.SignalModeChanged -= OnModeChanged;
			}
		}

		/// <summary>
		/// Initializes event handlers for signal aspect and mode changes after the Signals API has been loaded.
		/// </summary>
		private void OnSignalsLoaded()
		{
			SignalsAPI.Instance!.SignalAspectChanged += OnAspectChanged;
			SignalsAPI.Instance!.SignalModeChanged += OnModeChanged;
			LoggingReturn.DebugLog?.Invoke("Signals API loaded, ready to interact with signals.");
		}

		/// <summary>
		/// Handles cleanup operations when the Signals API is unloaded.
		/// </summary>
		private void OnSignalsUnloaded()
		{
			LoggingReturn.DebugLog?.Invoke("Signals API unloaded, cleaned up handlers.");
		}

		/// <summary>
		/// Handles changes to the aspect of the specified signal state.
		/// </summary>
		/// <param name="state">The signal state whose aspect has changed. Contains information about the signal's current and previous
		/// aspects.</param>
		private void OnAspectChanged(SignalState state)
		{
			LoggingReturn.DebugLog?.Invoke($"Signals Action triggered: Aspect changed: {state.Id} -> {state.CurrentAspectId ?? "OFF"}");
			_onAspectChanged?.Invoke(state.Id, state.CurrentAspectId ?? "OFF");
		}

		/// <summary>
		/// Handles changes to the mode of the specified signal.
		/// </summary>
		/// <param name="signalId"></param>
		/// <param name="newMode"></param>
		private void OnModeChanged(string signalId, SignalMode newMode)
		{
			LoggingReturn.DebugLog?.Invoke($"Signals Action triggered: Mode changed: {signalId} -> {newMode}");
			_onModeChanged?.Invoke(signalId, newMode.ToString());
		}

		/// <summary>
		/// Returns the current aspect of a signal by its ID, or null if not found.
		/// </summary>
		internal string? GetSignalAspect(string signalId)
		{
			try
			{
				return SignalsAPI.GetSignal(signalId)?.CurrentAspectId;
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"GetSignalAspect({signalId}) failed: {ex.Message}");
				return null;
			}
		}

		/// <summary>
		/// Returns all signals with raw world coordinates (not yet converted to lat/lng).
		/// </summary>
		internal Dictionary<string, object> GetAllSignals()
		{
			var result = new Dictionary<string, object>();
			try
			{
				LoggingReturn.DebugLog?.Invoke("GetAllSignals: calling ForceUpdateAllSignalAspects...");
				ForceUpdateAllSignalAspects();

				var signals = SignalsAPI.GetAllSignals();
				if (signals == null)
				{
					LoggingReturn.DebugLog?.Invoke("GetAllSignals returned null.");
					return result;
				}

				foreach (var signal in signals)
				{
					var aspect = signal.CurrentAspectId ?? "OFF";

					result[signal.Id] = new
					{
						signal.Id,
						signal.Type,
						signal.Mode,
						signal.CurrentAspectId,
						signal.IsOn,
						Direction = signal.Direction.ToString(),
						signal.JunctionId,
						signal.SelectedBranch,
						signal.YardId,
						signal.TrackId,
						Position = new[] { signal.Position.x, signal.Position.z },
					};
				}
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"GetAllSignals failed: {ex.Message}");
				return result;
			}

			return result;
		}

		/// <summary>
		/// Checks whether the given track has any trains physically on it.
		/// </summary>
		internal bool IsTrackOccupied(RailTrack track)
		{
			try
			{
				return SignalsAPI.IsTrackOccupied(track);
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"IsTrackOccupied failed: {ex.Message}");
				return false;
			}
		}

		private static MethodInfo? _forceUpdateMethod;
		private static Type? _signalManagerType;
		private static PropertyInfo? _allSignalsProp;
		private static PropertyInfo? _instanceProp;
		private static bool _reflectionResolved;

		private static DateTime _lastForceUpdate = DateTime.MinValue;
		private static readonly TimeSpan _forceUpdateInterval = TimeSpan.FromSeconds(5);

		/// <summary>
		/// Forces all signals to evaluate their aspects regardless of player proximity.
		/// Tries the new SignalsAPI.ForceUpdateAllSignals(bool) if available,
		/// otherwise falls back to per-signal UpdateAspect via reflection.
		/// Throttled to avoid feedback loops.
		/// </summary>
		private void ForceUpdateAllSignalAspects()
		{
			var now = DateTime.UtcNow;
			if (now - _lastForceUpdate < _forceUpdateInterval) return;
			_lastForceUpdate = now;

			if (TryForceUpdateViaAPI()) return;
			ForceUpdateViaReflection();
		}

		private static MethodInfo? _apiForceUpdateMethod;
		private static bool _apiForceUpdateChecked;

		private bool TryForceUpdateViaAPI()
		{
			if (_apiForceUpdateChecked && _apiForceUpdateMethod == null) return false;
			_apiForceUpdateChecked = true;

			try
			{
				if (_apiForceUpdateMethod == null)
				{
					// Use runtime type, not compile-time reference, since the installed
					// Signals.API.dll may be newer than the one we compiled against.
					var runtimeType = SignalsAPI.Instance?.GetType() ?? typeof(SignalsAPI);
					_apiForceUpdateMethod = runtimeType.GetMethod("ForceUpdateAllSignals", BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance);
					if (_apiForceUpdateMethod == null)
					{
						// Search all loaded assemblies for the method
						foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
						{
							var t = asm.GetType("Signals.API.SignalsAPI");
							if (t != null)
							{
								_apiForceUpdateMethod = t.GetMethod("ForceUpdateAllSignals", BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance);
								if (_apiForceUpdateMethod != null) break;
							}
						}
					}
					if (_apiForceUpdateMethod == null) return false;
					LoggingReturn.DebugLog?.Invoke("ForceUpdate: found SignalsAPI.ForceUpdateAllSignals.");
				}

				var obj = _apiForceUpdateMethod.IsStatic ? null : SignalsAPI.Instance;
				_apiForceUpdateMethod.Invoke(obj, new object[] { false });
				return true;
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"ForceUpdate via API failed: {ex.Message}");
				return false;
			}
		}

		private void ForceUpdateViaReflection()
		{
			try
			{
				if (!_reflectionResolved)
				{
					_reflectionResolved = true;
					var signalsGameAsm = AppDomain.CurrentDomain.GetAssemblies()
						.FirstOrDefault(a => a.GetName().Name == "Signals.Game");
					if (signalsGameAsm == null)
					{
						LoggingReturn.DebugLog?.Invoke("ForceUpdate: Signals.Game assembly not found, skipping.");
						return;
					}

					_signalManagerType = signalsGameAsm.GetType("Signals.Game.SignalManager");
					if (_signalManagerType == null)
					{
						LoggingReturn.DebugLog?.Invoke("ForceUpdate: SignalManager type not found.");
						return;
					}

					_allSignalsProp = _signalManagerType.GetProperty("AllSignals");
					if (_allSignalsProp == null)
					{
						LoggingReturn.DebugLog?.Invoke("ForceUpdate: AllSignals property not found.");
						return;
					}

					var baseType = _signalManagerType.BaseType;
					while (baseType != null)
					{
						_instanceProp = baseType.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static);
						if (_instanceProp != null) break;
						baseType = baseType.BaseType;
					}
					if (_instanceProp == null)
					{
						LoggingReturn.DebugLog?.Invoke("ForceUpdate: Instance property not found on any base type.");
						return;
					}

					var controllerType = signalsGameAsm.GetType("Signals.Game.Controllers.BasicSignalController");
					if (controllerType == null)
					{
						LoggingReturn.DebugLog?.Invoke("ForceUpdate: BasicSignalController type not found.");
						return;
					}

					_forceUpdateMethod = controllerType.GetMethod("UpdateAspect", new[] { typeof(bool) });
					if (_forceUpdateMethod == null)
					{
						LoggingReturn.DebugLog?.Invoke("ForceUpdate: UpdateAspect method not found.");
						return;
					}

					LoggingReturn.DebugLog?.Invoke("ForceUpdate: reflection resolved successfully.");
				}

				if (_forceUpdateMethod == null || _signalManagerType == null) return;

				var instance = _instanceProp?.GetValue(null);
				if (instance == null) return;

				var allSignals = _allSignalsProp?.GetValue(instance) as System.Collections.IList;
				if (allSignals == null) return;

				int updated = 0;
				foreach (var signal in allSignals)
				{
					var exists = signal.GetType().GetProperty("Exists")?.GetValue(signal) as bool?;
					if (exists != true) continue;
					_forceUpdateMethod.Invoke(signal, new object[] { false });
					updated++;
				}
				LoggingReturn.DebugLog?.Invoke($"ForceUpdate: evaluated {updated} signals.");
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"ForceUpdate failed: {ex.Message}");
			}
		}

		/// <summary>
		/// Sets a signal to the specified aspect. Returns true on success.
		/// </summary>
		internal bool SetSignalAspect(string signalId, string aspect)
		{
			LoggingReturn.Log?.Invoke($"Attempting to set signal aspect: {signalId} -> {aspect}");
			try
			{
				return SignalsAPI.SetSignalAspect(signalId, aspect);
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"SetSignalAspect({signalId}, {aspect}) failed: {ex.Message}");
				return false;
			}
		}

		/// <summary>
		/// Sets a signal to the specified mode. Returns true on success.
		/// </summary>
		/// <param name="signalId">The ID of the signal</param>
		internal bool SetSignalMode(string signalId, string mode)
		{
			LoggingReturn.DebugLog?.Invoke($"Attempting to set signal mode: {signalId} -> {mode}");
			try
			{
				if (!Enum.TryParse<SignalMode>(mode, true, out var parsed))
				{
					LoggingReturn.DebugLog?.Invoke($"Failed to parse signal mode: {signalId} -> {mode}");
					return false;
				}
				return SignalsAPI.SetSignalMode(signalId, parsed);
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"SetSignalMode({signalId}, {mode}) failed: {ex.Message}");
				return false;
			}
		}

		/// <summary>
		/// Turns off a signal (no aspect displayed) and switches it to Manual mode.
		/// Returns true on success.
		/// </summary>
		/// <param name="signalId">The ID of the signal to turn off</param>
		internal bool TurnOffSignal(string signalId)
		{
			LoggingReturn.Log?.Invoke($"Attempting to turn off signal: {signalId}");
			try
			{
				return SignalsAPI.TurnOffSignal(signalId);
			}
			catch (Exception ex)
			{
				LoggingReturn.Warning?.Invoke($"TurnOffSignal({signalId}) failed: {ex.Message}");
				return false;
			}
		}
	}
}
