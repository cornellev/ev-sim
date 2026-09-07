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
                bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
            ]),
        );
        const report = await validator.validateBytes(new Uint8Array(message.bytes), {
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
