const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function bindShutdownSignals(emitter, onSignal) {
    if (typeof onSignal !== "function") throw new TypeError("Shutdown signal handler must be a function.");
    const handler = () => { onSignal(); };
    for (const name of SIGNALS) emitter.on(name, handler);
    return handler;
}

export function unbindShutdownSignals(emitter, handler) {
    for (const name of SIGNALS) emitter.removeListener(name, handler);
}
