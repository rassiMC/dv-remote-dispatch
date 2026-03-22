using System;
using UnityEngine;

namespace DvMod.RemoteDispatch.Signals
{
    public static class Bootstrap
    {
        private static SignalsBridge? _bridge;

        public static void Initialize()
        {
            try
            {
                _bridge = new SignalsBridge();
                _bridge.Register();
                Debug.Log("[RemoteDispatch.Signals] Signals bridge initialized.");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[RemoteDispatch.Signals] Initialize failed: {ex.Message}\n{ex.StackTrace}");
            }
        }

        public static void Teardown()
        {
            try
            {
                _bridge?.Unregister();
                _bridge = null;
                Debug.Log("[RemoteDispatch.Signals] Signals bridge torn down.");
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[RemoteDispatch.Signals] Teardown failed: {ex.Message}\n{ex.StackTrace}");
            }
        }
    }
}