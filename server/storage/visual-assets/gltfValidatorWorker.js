import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(fileURLToPath(import.meta.url));
const validator = require("gltf-validator");

parentPort.on("message", async (message) => {
    try {
        const resources = new Map(
            Object.entries(message.resources ?? {}).map(([uri, bytes]) => [
                uri,
                Uint8Array.from(bytes),
            ]),
        );
        // gltf-validator reads external resources from the start of their backing
        // ArrayBuffer. Structured-cloned Node Buffers can retain a non-zero view
        // offset into a pooled buffer, so copy every input into a tight view first.
        const report = await validator.validateBytes(Uint8Array.from(message.bytes), {
            uri: message.uri ?? "asset.glb",
            maxIssues: 50,
            externalResourceFunction: (uri) => {
                const bytes = resources.get(uri);
                if (!bytes) {
                    return Promise.reject(new Error(`blocked external resource ${uri}`));
                }
                return Promise.resolve(bytes);
            },
        });
        parentPort.postMessage({ ok: true, report });
    } catch (error) {
        parentPort.postMessage({
            ok: false,
            error: { message: error?.message || String(error), name: error?.name || "Error" },
        });
    }
});
