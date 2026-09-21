import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { HeadlessRunnerError } from "../headless/HeadlessRunnerErrors.js";
import { encodePcapGlobalHeader } from "./PcapEncoder.js";

function artifactFailure(message, cause) {
    return new HeadlessRunnerError("ARTIFACT_FAILURE", message, null, cause ? { cause } : {});
}

export class PcapWriter {
    constructor({ filePath, maxQueueBytes = 0 } = {}) {
        this.filePath = filePath;
        this.maxQueueBytes = Math.max(0, Number(maxQueueBytes) || 0);
        this.handle = null;
        this.queue = [];
        this.queuedBytes = 0;
        this.writtenBytes = 0;
        this.failed = null;
        this.finalized = false;
        this.aborted = false;
        this.digest = createHash("sha256");
        this.sha256 = null;
    }

    get outputBytes() {
        return this.writtenBytes + this.queuedBytes;
    }

    _fail(error) {
        this.failed = error instanceof HeadlessRunnerError
            ? error
            : artifactFailure(error.message, error);
        return this.failed;
    }

    _guard() {
        if (this.failed) throw this.failed;
        if (this.aborted) throw artifactFailure("PCAP writer has been aborted.");
        if (this.finalized) throw artifactFailure("PCAP writer has already been finalized.");
    }

    async open() {
        this._guard();
        try {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            this.handle = await fs.open(this.filePath, "wx");
            const header = encodePcapGlobalHeader();
            await this.handle.write(header);
            this.digest.update(header);
            this.writtenBytes += header.byteLength;
        } catch (error) {
            throw this._fail(artifactFailure(`Could not create PCAP file ${this.filePath}: ${error.message}`, error));
        }
        return this;
    }

    enqueue(record) {
        this._guard();
        if (!(record instanceof Uint8Array)) throw artifactFailure("PCAP records must be Uint8Array bytes.");
        if (!this.handle) throw artifactFailure("PCAP writer is not open.");
        if (this.maxQueueBytes > 0 && this.queuedBytes + record.byteLength > this.maxQueueBytes) {
            const error = new HeadlessRunnerError(
                "RESOURCE_LIMIT",
                `PCAP queue used ${this.queuedBytes + record.byteLength} bytes, exceeding the ${this.maxQueueBytes}-byte limit.`,
                { queuedBytes: this.queuedBytes + record.byteLength, maxQueueBytes: this.maxQueueBytes },
            );
            throw this._fail(error);
        }
        this.queue.push(record);
        this.queuedBytes += record.byteLength;
        return this.queuedBytes;
    }

    async drain() {
        if (this.failed) throw this.failed;
        if (this.aborted || this.finalized || !this.handle || this.queue.length === 0) return this.writtenBytes;
        const pending = this.queue;
        this.queue = [];
        this.queuedBytes = 0;
        try {
            for (const record of pending) {
                await this.handle.write(record);
                this.digest.update(record);
                this.writtenBytes += record.byteLength;
            }
        } catch (error) {
            throw this._fail(artifactFailure(`Could not write PCAP file ${this.filePath}: ${error.message}`, error));
        }
        return this.writtenBytes;
    }

    async finalize() {
        if (this.failed) throw this.failed;
        if (this.aborted) throw artifactFailure("PCAP writer has been aborted.");
        if (this.finalized) return this.snapshot();
        this._guard();
        try {
            await this.drain();
            await this.handle.sync?.();
            await this.handle.close();
            this.handle = null;
            this.finalized = true;
            this.sha256 = this.digest.digest("hex");
            return this.snapshot();
        } catch (error) {
            if (this.failed) throw this.failed;
            throw this._fail(artifactFailure(`Could not finalize PCAP file ${this.filePath}: ${error.message}`, error));
        }
    }

    async abort() {
        this.aborted = true;
        const handle = this.handle;
        this.handle = null;
        this.queue = [];
        this.queuedBytes = 0;
        if (handle) {
            try {
                await handle.close();
            } catch {
                // Preserve the original failure; staging cleanup removes the file.
            }
        }
    }

    snapshot() {
        return Object.freeze({
            filePath: this.filePath,
            sizeBytes: this.writtenBytes,
            sha256: this.sha256,
            queuedBytes: this.queuedBytes,
        });
    }
}
