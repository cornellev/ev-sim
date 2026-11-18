export const RUN_STOP_TIMEOUT_MS = 15_000;

export function runStopTimeout(stage) {
    return Object.assign(new Error(`Simulation shutdown timed out during ${stage}.`), {
        code: "RUN_STOP_TIMEOUT", infrastructureFailure: true, requiresReset: true,
    });
}

/** Fence the continuation even when the underlying operation ignores cancellation. */
export function abortable(value, signal) {
    if (!signal) return Promise.resolve(value);
    const pending = Promise.resolve(value);
    return new Promise((resolve, reject) => {
        const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
        if (signal.aborted) aborted();
        else signal.addEventListener("abort", aborted, { once: true });
        pending.then((result) => {
            signal.removeEventListener("abort", aborted);
            if (!signal.aborted) resolve(result);
        }, (error) => {
            signal.removeEventListener("abort", aborted);
            reject(error);
        });
    });
}

export async function abortableDelay(ms, signal) {
    let timer;
    try { await abortable(new Promise((resolve) => { timer = setTimeout(resolve, ms); }), signal); }
    finally { clearTimeout(timer); }
}
