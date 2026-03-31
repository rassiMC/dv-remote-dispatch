using System;

namespace DvMod.RemoteDispatch.Signals
{
    internal static class LoggingReturn
    {
        // Noop implementations to avoid null checks everywhere. These is replaced by main mod logging methods during initialization.
        internal static Action<string> Log = _ => { };
        internal static Action<string> DebugLog = _ => { };
        internal static Action<string> Warning = _ => { };
    }
}
