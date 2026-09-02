import { getLogAttachments, getLogAutonomySnapshot, getLogPoseSeries } from "../logging/LogClient.js";
import { simplifyTrajectory, poseSampleFromValue } from "./trajectorySimplify.js";
import { discoverVehiclePosePaths } from "./spatialLogModel.js";
import { environmentDocumentFrom } from "../scenarios/route/index.js";

const autonomySnapshotInflight = new Map();
let fetchAutonomySnapshot = getLogAutonomySnapshot;

export function __testOnly_setAutonomySnapshotFetcher(fetcher) {
    fetchAutonomySnapshot = fetcher || getLogAutonomySnapshot;
}

export function parseEnvironmentAttachment(dataset) {
    const raw = dataset?.jsonAttachment?.("environment.json");
    if (!raw) return null;
    return environmentDocumentFrom(raw);
}

export async function ensureAttachments(dataset, names) {
    const missing = names.filter((name) => !dataset.attachment(name));
    if (!missing.length) return;
    const result = await getLogAttachments(dataset.id, { names: missing });
    for (const attachment of result.attachments) {
        if (!dataset.attachment(attachment.name)) dataset.attachments.push(attachment);
    }
}

export async function loadSpatialEnvironment(dataset) {
    if (!dataset) return null;
    let document = parseEnvironmentAttachment(dataset);
    if (!document && dataset.lazy) {
        await ensureAttachments(dataset, ["environment.json", "run-manifest.json"]);
        document = parseEnvironmentAttachment(dataset);
    }
    if (!document && dataset.resolvedRun?.environment) {
        document = environmentDocumentFrom(dataset.resolvedRun.environment);
    }
    return document;
}

export async function loadVehicleTrails(dataset, { maxPoints = 2000 } = {}) {
    if (!dataset) return [];
    const paths = discoverVehiclePosePaths(dataset.descriptors);
    const trails = [];
    for (const [index, entry] of paths.entries()) {
        try {
            const samples = await loadPoseSeriesForDataset(dataset, entry.path, { maxPoints });
            if (!samples.length) continue;
            trails.push({
                ...entry,
                color: ["#38bdf8", "#34d399", "#f59e0b", "#fb7185"][index % 4],
                samples,
            });
        } catch {
            // Skip pose paths that are unavailable in this log.
        }
    }
    return trails;
}

export async function loadPoseSeriesForDataset(dataset, path, options = {}) {
    if (!dataset || !path) return [];
    if (!dataset.paths().includes(path)) return [];
    dataset._poseSeriesCache ||= new Map();
    const cacheKey = `${path}:${options.fromUs || 0}:${options.toUs || dataset.durationUs}:${options.maxPoints || 2000}`;
    if (dataset._poseSeriesCache.has(cacheKey)) return dataset._poseSeriesCache.get(cacheKey);

    let samples = [];
    const eagerSamples = dataset.series?.get(path) || [];
    if (!dataset.lazy && eagerSamples.length) {
        samples = simplifyTrajectory(
            eagerSamples.map((sample) => poseSampleFromValue(sample.timeUs, sample.cycle, sample.value)),
            options.maxPoints || 2000,
        );
    } else {
        try {
            const result = await getLogPoseSeries(dataset.id, {
                path,
                fromUs: options.fromUs ?? 0,
                toUs: options.toUs ?? dataset.durationUs,
                maxPoints: options.maxPoints ?? 2000,
            });
            samples = result.samples || [];
        } catch {
            samples = [];
        }
    }

    dataset._poseSeriesCache.set(cacheKey, samples);
    return samples;
}

export async function loadAutonomySnapshotForDataset(dataset, timeUs, options = {}) {
    if (!dataset) return null;
    if (!dataset.lazy && dataset.series?.size) {
        return dataset.autonomySnapshotAt(timeUs, options);
    }
    const exactSync = Boolean(options.exactSync);
    const cacheKey = `${dataset.id}:${Math.round(Number(timeUs) || 0)}:${exactSync}`;
    if (autonomySnapshotInflight.has(cacheKey)) {
        return autonomySnapshotInflight.get(cacheKey);
    }
    const promise = fetchAutonomySnapshot(dataset.id, timeUs, options)
        .then((result) => result.snapshot)
        .finally(() => {
            autonomySnapshotInflight.delete(cacheKey);
        });
    autonomySnapshotInflight.set(cacheKey, promise);
    return promise;
}
