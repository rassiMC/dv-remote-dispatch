using System;

namespace DvMod.RemoteDispatch.Signals
{
    internal static class LoggingReturn
    {
        // Nullable fields allow runtime initialization - the initial null is safe.
        // Initialized in SignalsShim.Initialize() which passes actual logging callbacks.
        internal static Action<string>? Log;
        internal static Action<string>? DebugLog;
        internal static Action<string>? Warning;
    }
}
