using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Steamworks;
using System;
using UnityEngine;
using static DvMod.RemoteDispatch.World;
using System.Linq;
using System.Collections.Generic;

namespace DvMod.RemoteDispatch
{
    public static class PlayerData
    {
        private static World.Position previousPosition;
        private static float previousRotation;

        public static void CheckTransform()
        {
            var transform = PlayerManager.PlayerTransform;
            if (transform == null)
                return;
            var position = new World.Position(transform.position - WorldMover.currentMove);
            var rotation = transform.eulerAngles.y;
            if (!(
                ApproximatelyEquals(previousPosition.x, position.x)
                && ApproximatelyEquals(previousPosition.z, position.z)
                && ApproximatelyEquals(previousRotation, rotation)))
            {
                Sessions.AddTag("player");
                previousPosition = position;
                previousRotation = rotation;
            }
        }

        private static bool ApproximatelyEquals(float f1, float f2)
        {
            var delta = f1 - f2;
            return delta > -1e-3 && delta < 1e-3;
        }

        private static string GetLocalSteamName()
        {
            try
            {
                // https://wiki.facepunch.com/steamworks/SteamClient
                return Steamworks.SteamClient.Name ?? string.Empty;
            }
            catch
            {
                return string.Empty;
            }
        }

        public static JObject GetPlayerData()
        {
            CheckTransform();
            var res = new JObject();

            res["host"] = new JObject(
                new JProperty("color", "aqua"),
                new JProperty("position", previousPosition.ToLatLon().ToJson()),
                new JProperty("rotation", Math.Round(previousRotation, 2)),
                new JProperty("name", $"{GetLocalSteamName()} - host")
            );

            IEnumerable<object> otherPlayers;
            try
            {
                otherPlayers = MultiplayerHook.GetServerPlayers();
            }
            catch (Exception e)
            {
                Main.DebugLog(() => $"Error getting server players: {e.Message}");
                return res;
            }
            Main.DebugLog(() => $"Player count: {MultiplayerHook.GetPlayerCount()}");

            if (otherPlayers != null)
            {
                Main.DebugLog(() => $"Other players found!");
                foreach (var player in otherPlayers)
                {
                    var type = player.GetType();
                     Main.DebugLog(() => $"Player properties: {string.Join(", ", type.GetProperties().Select(p => p.Name))}");
                    // https://github.com/AMacro/dv-multiplayer/blob/beta/Multiplayer/Networking/Data/ServerPlayer.cs
                    var absPos = (Vector3)type.GetProperty("AbsoluteWorldPosition").GetValue(player);
                    var position = new World.Position(absPos - WorldMover.currentMove);
                    var rotY = (float)type.GetProperty("WorldRotationY").GetValue(player);
                    var name = (string)type.GetProperty("Username").GetValue(player);
                    var guid = (Guid)type.GetProperty("Guid").GetValue(player);
                    var playerId = (byte)type.GetProperty("PlayerId").GetValue(player);

                    res[guid.ToString()] = new JObject(
                        new JProperty("color", "orange"),
                        new JProperty("position", position.ToLatLon().ToJson()),
                        new JProperty("rotation", Math.Round(rotY, 2)),
                        new JProperty("name", name ?? string.Empty)
                    );
                }
            }
            return res;
        }

        public static string GetPlayerDataJson()
        {
            return JsonConvert.SerializeObject(GetPlayerData());
        }
    }
}
