import { Worker } from "node:worker_threads";

/** Run the actual browser worker entry with Node's structured-clone transport. */
export function createCpuLidarTestWorker() {
    const entry = new URL("../../app/3d/devices/cpuLidarCapture.worker.js", import.meta.url).href;
    const source = `
        import { parentPort } from "node:worker_threads";
        globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
        await import(${JSON.stringify(entry)});
        parentPort.on("message", (data) => self.onmessage({ data }));
    `;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
    const listeners = new Map();
    const replies = [];
    const adapter = {
        hold: false,
        addEventListener(name, listener) { listeners.set(name, listener); },
        postMessage(message, transfers) { worker.postMessage(message, transfers); },
        terminate() { return worker.terminate(); },
        flush() {
            adapter.hold = false;
            for (const data of replies.splice(0)) listeners.get("message")?.({ data });
        },
        fail() { listeners.get("error")?.({ message: "test worker failure" }); },
    };
    worker.on("message", (data) => {
        if (adapter.hold) replies.push(data);
        else listeners.get("message")?.({ data });
    });
    worker.on("error", (error) => listeners.get("error")?.(error));
    return adapter;
}
