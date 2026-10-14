/**
 * Browser session for GitHub URDF inspect and fetch.
 * A newer request aborts the previous one and drops its response.
 */

import { storagePost } from "../../client/storageClient.js";
import { readUrdfPackage } from "./urdfPackage.js";

function decodeBase64(value) {
    const text = String(value ?? "");
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const encoded = typeof Buffer !== "undefined" ? Buffer.from(bytes).toString("base64") : btoa(binary);
    if (encoded !== text) throw new Error("GitHub file bytes must be canonical base64.");
    return bytes;
}

function decodePackage(pkg) {
    return readUrdfPackage({
        entryPath: pkg.entryPath,
        source: pkg.source,
        files: (pkg.files ?? []).map((file) => ({ path: file.path, bytes: decodeBase64(file.bytes) })),
    });
}

export class GitHubUrdfSession {
    constructor({ fetchImpl = globalThis.fetch } = {}) {
        this.fetchImpl = fetchImpl;
        this.generation = 0;
        this.controller = null;
        this.review = null;
        this.package = null;
        this.result = null;
        this.error = null;
    }

    inspect(url) {
        return this.#run("vehicle-urdf/github/inspect", { url });
    }

    fetch(url, entryPath) {
        return this.#run("vehicle-urdf/github/fetch", { url, ...(entryPath ? { entryPath } : {}) });
    }

    async #run(path, body) {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        const generation = ++this.generation;
        this.review = null;
        this.package = null;
        this.result = null;
        this.error = null;
        try {
            const payload = await storagePost(path, body, { signal: controller.signal, fetchImpl: this.fetchImpl });
            if (generation !== this.generation) return { ignored: true };
            this.review = payload?.review ?? null;
            this.package = payload?.package ? decodePackage(payload.package) : null;
            this.result = payload;
            return { ignored: false, result: payload };
        } catch (error) {
            if (generation !== this.generation || error?.name === "AbortError") return { ignored: true };
            this.error = error;
            return { ignored: false, error };
        }
    }
}
