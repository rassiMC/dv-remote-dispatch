using System;
using System.Collections.Generic;
using System.Reflection;
using UnityModManagerNet;

// THIS FILE WAS AI GENERATED

namespace DvMod.RemoteDispatch
{
  internal class MultiplayerHook
  {
    private static object _cachedServer = null;
    private static Type _cachedLifecycleType = null;

    /// <summary>
    /// Retrieves the NetworkLifecycle type from the dv-multiplayer mod assembly using reflection.
    /// Result is cached after the first successful lookup since the assembly never changes at runtime.
    /// </summary>
    /// <returns>The NetworkLifecycle Type if dv-multiplayer is installed, otherwise null.</returns>
    private static Type GetMultiplayerLifecycleType()
    {
      if (_cachedLifecycleType != null)
        return _cachedLifecycleType;

      _cachedLifecycleType = UnityModManager.FindMod("Multiplayer")
          ?.Assembly
          ?.GetType("Multiplayer.Components.Networking.NetworkLifecycle");

      return _cachedLifecycleType;
    }

    /// <summary>
    /// Retrieves the NetworkServer instance from the dv-multiplayer mod using reflection,
    /// so that this mod can function without a hard dependency on dv-multiplayer.
    /// The server reference is cached after the first successful lookup to avoid
    /// repeated reflection overhead. The cache is validated on each call using
    /// NetworkLifecycle.IsServerRunning, and cleared if the server has stopped.
    /// </summary>
    /// <returns>The NetworkServer object if dv-multiplayer is installed and a server is running, otherwise null.</returns>
    private static object GetMultiplayerServer()
    {
      try
      {
        var lifecycleType = GetMultiplayerLifecycleType();
        if (lifecycleType == null)
          return null;

        var instance = lifecycleType
            .GetProperty("Instance", BindingFlags.Public | BindingFlags.Static)
            ?.GetValue(null);
        if (instance == null)
          return null;

        // Use IsServerRunning to validate the cache — it returns Server?.IsRunning ?? false,
        // so it safely returns false when Stop() has set Server to null
        var isServerRunning = instance.GetType()
            .GetProperty("IsServerRunning", BindingFlags.Public | BindingFlags.Instance)
            ?.GetValue(instance) as bool?;

        if (isServerRunning != true)
        {
          // Server has stopped or was never started — clear stale cache
          _cachedServer = null;
          return null;
        }

        // Cache is still valid, return it
        if (_cachedServer != null)
          return _cachedServer;

        // First successful lookup — cache the Server reference
        _cachedServer = instance.GetType()
            .GetProperty("Server", BindingFlags.Public | BindingFlags.Instance)
            ?.GetValue(instance);

        return _cachedServer;
      }
      catch (Exception e)
      {
        Main.DebugLog(() => $"GetMultiplayerServer: {e.Message}");
        return null;
      }
    }

    /// <summary>
    /// Retrieves the list of currently connected players from the dv-multiplayer server.
    /// </summary>
    /// <returns>The ServerPlayers collection as untyped objects if available, otherwise null.</returns>
    public static IEnumerable<object> GetServerPlayers()
    {
      var server = GetMultiplayerServer();
      if (server == null)
        return null;

      return server.GetType()
          .GetProperty("ServerPlayers", BindingFlags.Public | BindingFlags.Instance)
          ?.GetValue(server) as IEnumerable<object>;
    }

    /// <summary>
    /// Retrieves the number of players currently connected to the dv-multiplayer server.
    /// </summary>
    /// <returns>The player count, or 0 if dv-multiplayer is not installed or no server is running.</returns>
    public static int GetPlayerCount()
    {
      var server = GetMultiplayerServer();
      if (server == null)
        return 0;

      return (int)(server.GetType()
          .GetProperty("PlayerCount", BindingFlags.Public | BindingFlags.Instance)
          ?.GetValue(server) ?? 0);
    }
  }
}