import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import { VISUAL_ASSET_ERROR_CODES, visualAssetError } from "../StorageErrors.js";

const WORKER_PATH = fileURLToPath(new URL("./gltfValidatorWorker.js", import.meta.url));

export function runGltfValidator(bytes, { uri, resources = {}, timeoutMs, memoryMb } = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const worker = new Worker(WORKER_PATH, {
            resourceLimits: {
                maxOldGenerationSizeMb: memoryMb ?? 512,
                maxYoungGenerationSizeMb: 64,
            },
        });
        const timer = setTimeout(() => {
            finish(visualAssetError(
                VISUAL_ASSET_ERROR_CODES.VALIDATION_TIMEOUT,
                `glTF validation exceeded ${timeoutMs} ms.`,
            ));
            worker.terminate();
        }, timeoutMs ?? 60_000);

        const finish = (error, report) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(report);
        };

        worker.once("message", (message) => {
            worker.terminate();
            if (!message?.ok) {
                finish(visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH,
                    message?.error?.message || "glTF validator rejected the asset.",
                ));
                return;
            }
            if ((message.report?.issues?.numErrors ?? 0) > 0) {
                const first = message.report.issues?.messages?.find((entry) => entry.severity === 0);
                finish(visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH,
                    first?.message || "glTF validator reported errors.",
                ));
                return;
            }
            finish(null, message.report);
        });
        worker.once("error", (error) => {
            finish(visualAssetError(
                VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH,
                error.message || "glTF validator worker failed.",
            ));
        });
        worker.once("exit", (code) => {
            if (!settled && code !== 0) {
                finish(visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH,
                    `glTF validator worker exited with code ${code}.`,
                ));
            }
        });
        worker.postMessage({
            bytes: Buffer.from(bytes),
            uri,
            resources: Object.fromEntries(
                Object.entries(resources).map(([key, value]) => [key, Buffer.from(value)]),
            ),
        });
    });
}
