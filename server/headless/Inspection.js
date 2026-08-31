import { promises as fs } from "node:fs";
import path from "node:path";

import { decodeRecordStream } from "../../app/logging/SFLogCodec.js";
import { LogDataset } from "../../app/logging/LogDataset.js";
import { LogService } from "../logging/LogService.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { verifyRunBundle } from "./RunBundle.js";

async function readJson(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
        throw new HeadlessRunnerError("INVALID_REQUEST", `Could not read JSON from ${filePath}: ${error.message}`, null, { cause: error });
    }
}

export function inspectRunBundle(bundle) {
    const verified = verifyRunBundle(bundle);
    return {
        kind: "cev-sim.headless.bundle-inspection",
        version: 1,
        manifestId: verified.resolved.manifest.id,
        manifestName: verified.resolved.manifest.name,
        environmentId: verified.resolved.manifest.environment?.id ?? null,
        scenarioId: verified.resolved.scenario?.scenario?.id ?? null,
        resolvedHash: verified.resolvedHash,
        simulationSemanticHash: verified.simulationSemanticHash,
        worldHash: verified.resolved.world.hash,
        backendSelections: verified.resolved.backendSelections,
        logging: verified.resolved.manifest.logging,
    };
}

export async function inspectSflog(filePath) {
    const absolute = path.resolve(filePath);
    const id = path.basename(absolute, ".sflog");
    const service = new LogService(path.dirname(absolute));
    try {
        const index = await service.getIndex(id);
        const decoded = { schemas: new Map(), updates: [], events: [], checkpoints: [], attachments: [] };
        for (const chunk of index.chunks) {
            const part = decodeRecordStream(await service.readChunk(id, chunk.index), decoded.schemas);
            decoded.schemas = part.schemas;
            decoded.updates.push(...part.updates);
            decoded.events.push(...part.events);
            decoded.checkpoints.push(...part.checkpoints);
            decoded.attachments.push(...part.attachments);
        }
        const dataset = new LogDataset(id, index, decoded);
        return {
            kind: "cev-sim.headless.sflog-inspection",
            version: 1,
            id,
            metadata: index.metadata,
            durationUs: String(index.durationUs),
            chunkCount: index.chunks.length,
            checkpointCount: decoded.checkpoints.length,
            signalPaths: dataset.paths(),
            attachments: decoded.attachments.map((entry) => ({
                name: entry.name,
                mimeType: entry.mime,
                sizeBytes: String(entry.bytes.byteLength),
            })),
            runResult: dataset.runResults,
            resolvedHash: dataset.resolvedRun?.resolvedHash ?? index.metadata?.resolvedHash ?? null,
        };
    } catch (error) {
        if (error instanceof HeadlessRunnerError) throw error;
        throw new HeadlessRunnerError("INVALID_REQUEST", `Could not inspect SFLog ${absolute}: ${error.message}`, null, { cause: error });
    }
}

export async function inspectTarget(target) {
    const absolute = path.resolve(target);
    let stat;
    try {
        stat = await fs.stat(absolute);
    } catch (error) {
        throw new HeadlessRunnerError("INVALID_REQUEST", `Inspection target does not exist: ${absolute}`, null, { cause: error });
    }
    if (stat.isDirectory()) {
        const [runResult, bundle, provenance] = await Promise.all([
            readJson(path.join(absolute, "run-results.json")),
            readJson(path.join(absolute, "run-bundle.json")),
            readJson(path.join(absolute, "provenance.json")),
        ]);
        const sflogPath = path.join(absolute, "run.sflog");
        let sflog = null;
        try {
            await fs.access(sflogPath);
            sflog = await inspectSflog(sflogPath);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        return {
            kind: "cev-sim.headless.output-inspection",
            version: 1,
            runResult,
            bundle: inspectRunBundle(bundle),
            provenance,
            sflog,
        };
    }
    if (absolute.endsWith(".sflog")) return inspectSflog(absolute);
    return inspectRunBundle(await readJson(absolute));
}
