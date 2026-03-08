using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Steamworks;
using System;
using UnityEngine;

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
                new JProperty("name", GetLocalSteamName())
            );

            var otherPlayers = MultiplayerHook.GetServerPlayers();
            if (otherPlayers != null)
            {
                foreach (var player in otherPlayers)
                {
                    var type = player.GetType();
                    // https://github.com/AMacro/dv-multiplayer/blob/beta/Multiplayer/Networking/Data/ServerPlayer.cs
                    var absPos = (Vector3)type.GetProperty("AbsoluteWorldPosition").GetValue(player);
                    var rotY = (float)type.GetProperty("WorldRotationY").GetValue(player);
                    var name = (string)type.GetProperty("Username").GetValue(player);
                    var guid = (Guid)type.GetProperty("Guid").GetValue(player);
                    var playerId = (byte)type.GetProperty("PlayerId").GetValue(player);
                    res[guid.ToString()] = new JObject(
                        new JProperty("color", "orange"),
                        new JProperty("position", ((World.Position)player.GetType().GetProperty("Position").GetValue(player)).ToLatLon().ToJson()),
                        new JProperty("rotation", Math.Round((float)player.GetType().GetProperty("Rotation").GetValue(player), 2)),
                        new JProperty("name", player.GetType().GetProperty("Name").GetValue(player)?.ToString() ?? string.Empty)
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
