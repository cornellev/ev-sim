const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function bindShutdownSignals(emitter, onSignal) {
    if (typeof onSignal !== "function") throw new TypeError("Shutdown signal handler must be a function.");
    const handler = (signal) => { onSignal(signal); };
    for (const name of SIGNALS) emitter.on(name, handler);
    return handler;
}

// shortcut: startup and a second interrupt force-exit at 1.5s, which can leave the detached Zenoh router; the next launch reaps it.
export function createShutdownHandler({ abort, isStarting, shutdown, exit, forceExitMs = 1500, schedule = setTimeout }) {
    return (signal) => {
        if (abort.signal.aborted) {
            exit(130);
            return;
        }
        abort.abort();
        if (isStarting() || signal === "SIGINT") {
            schedule(() => exit(130), forceExitMs).unref?.();
        }
        shutdown();
    };
}

export function unbindShutdownSignals(emitter, handler) {
    for (const name of SIGNALS) emitter.removeListener(name, handler);
}
