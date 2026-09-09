import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

import { decodeRecordStream } from "../../app/logging/SFLogCodec.js";
import { LogDataset } from "../../app/logging/LogDataset.js";
import { LogService } from "../logging/LogService.js";
import { sha256ExactBytes } from "../../app/simulation/visual/VisualLayer.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { renderSceneProviderRegistry } from "../../app/simulation/render/RenderSceneProviderRegistry.js";
import { verifyRunBundleBytes, verifyRunBundleIntegrity, runBundleBytes } from "./RunBundle.js";
import { verifyRunPackageArchive } from "./VisualAssetPack.js";

async function readJson(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
        throw new HeadlessRunnerError("INVALID_REQUEST", `Could not read JSON from ${filePath}: ${error.message}`, null, { cause: error });
    }
}

export function inspectRunBundle(bundle) {
    const verified = verifyRunBundleIntegrity(bundle);
    const renderScene = verified.resolved.renderScene ?? null;
    const provider = renderScene?.description?.provider ?? null;
    const capability = provider
        ? renderSceneProviderRegistry.runtimeCapabilities().find((entry) => (
            entry.id === provider.id && entry.version === provider.version
        )) ?? null
        : null;
    const visualEvidence = verified.resolved.evidence?.visualAssets ?? null;
    const correspondence = verified.resolved.evidence?.correspondence ?? null;
    return {
        kind: "cev-sim.headless.bundle-inspection",
        version: 1,
        manifestId: verified.resolved.manifest.id,
        manifestName: verified.resolved.manifest.name,
        environmentId: verified.resolved.manifest.environment?.id ?? null,
        scenarioId: verified.resolved.scenario?.scenario?.id ?? null,
        bundleBytesHash: sha256ExactBytes(runBundleBytes(bundle)),
        identityVersion: verified.identityVersion,
        requiredProtocolMinor: verified.requiredProtocolMinor,
        resolvedHash: verified.resolvedHash,
        simulationSemanticHash: verified.simulationSemanticHash,
        worldHash: verified.resolved.world.hash,
        renderScene: renderScene ? {
            hash: renderScene.hash,
            provider,
            productProfile: renderScene.description.productProfile ?? null,
            visualLayerHash: renderScene.description.visualLayerHash ?? null,
            recipeHash: renderScene.description.recipeHash ?? null,
            assetClosureHash: renderScene.description.assetClosureHash ?? null,
            assetCount: renderScene.description.assetClosure?.assets?.length ?? 0,
        } : null,
        execution: {
            supported: provider === null || capability?.available === true,
            reason: provider === null || capability?.available === true
                ? null
                : capability?.unavailableReason ?? "No selected render runtime capability is available.",
        },
        visualEvidence: visualEvidence ? {
            accessHash: visualEvidence.accessHash,
            useCount: visualEvidence.uses.length,
            resolutionOperations: visualEvidence.permissions.operations,
            correspondenceReportHash: correspondence?.reportHash ?? null,
            correspondenceStatus: correspondence?.status ?? null,
            offlineLimitations: [
                "Inspection does not establish current asset availability or rights.",
                "An attached correspondence digest is not a validated or managed-eligible report.",
            ],
        } : null,
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

export async function inspectRunPackage(filePath) {
    try {
        const verified = await verifyRunPackageArchive(createReadStream(filePath));
        return {
            kind: "cev-sim.headless.package-inspection",
            version: 1,
            packageManifestHash: verified.packageManifestHash,
            archiveHash: verified.archiveHash,
            bundleBytesHash: verified.bundleBytesHash,
            resolvedHash: verified.resolvedHash,
            simulationSemanticHash: verified.simulationSemanticHash,
            assets: verified.manifest.assets,
            rights: { evaluated: false, reason: "Offline inspection has no trusted runtime source registry." },
            runtimeSupport: { evaluated: false, reason: "Offline inspection validates structure, not configured renderer availability." },
        };
    } catch (error) {
        throw new HeadlessRunnerError("INVALID_REQUEST", `Could not inspect run package ${filePath}: ${error.message}`, null, { cause: error });
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
            fs.readFile(path.join(absolute, "run-bundle.json")).then((bytes) => verifyRunBundleBytes(bytes, { execution: false }).bundle),
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
    const file = await fs.open(absolute, "r");
    const prefix = Buffer.alloc(4096);
    let length = 0;
    try {
        length = (await file.read(prefix, 0, prefix.length, 0)).bytesRead;
    } finally {
        await file.close();
    }
    const first = prefix.subarray(0, length).find((byte) => ![0x09, 0x0a, 0x0d, 0x20].includes(byte));
    if (first !== 0x7b) return inspectRunPackage(absolute);
    return inspectRunBundle(verifyRunBundleBytes(await fs.readFile(absolute), { execution: false }).bundle);
}
