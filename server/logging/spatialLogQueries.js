import { decodeRecordStream } from "../../app/logging/SFLogCodec.js";
import { simplifyTrajectory, poseSampleFromValue } from "../../app/spatial/trajectorySimplify.js";

function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function buildAutonomySnapshotFromSeries(seriesMap, timeUs, { exactSync = false, captureTimeNs = null } = {}) {
    const cursorNs = Number.isFinite(captureTimeNs) ? captureTimeNs : Math.round(Number(timeUs) * 1000);

    const valueAtCaptureTime = (path) => {
        const samples = seriesMap.get(path) || [];
        if (samples.length === 0) return { value: undefined, ageNs: null, matched: false };
        const target = Number(cursorNs);
        let best = null;
        for (const sample of samples) {
            const stamp = Number(
                sample.value?.captureTimeNs
                ?? sample.value?.estimate?.captureTimeNs
                ?? sample.value?.applyTimeNs
                ?? (sample.timeUs * 1000),
            );
            if (!Number.isFinite(stamp)) continue;
            if (exactSync) {
                if (stamp === target) {
                    return { value: clone(sample.value), ageNs: 0, matched: true };
                }
                continue;
            }
            if (stamp <= target) best = { sample, stamp };
            else break;
        }
        if (exactSync || !best) return { value: undefined, ageNs: null, matched: false };
        return {
            value: clone(best.sample.value),
            ageNs: Math.max(0, target - best.stamp),
            matched: true,
        };
    };

    const perception = valueAtCaptureTime("visualization.perception.candidate");
    const oracle = valueAtCaptureTime("visualization.perception.oracle");
    const localization = valueAtCaptureTime("visualization.localization.candidate");
    const localizationError = valueAtCaptureTime("visualization.localization.error");
    const status = valueAtCaptureTime("visualization.perception.status");
    const controls = valueAtCaptureTime("visualization.controls.snapshot");

    return {
        captureTimeNs: cursorNs,
        exactSync,
        perception: {
            ...(perception.value || {}),
            oracle: oracle.value || { detections2d: [], detections3d: [], lanes: [] },
            status: status.value?.status || perception.value?.status || "ok",
            statusCode: status.value?.statusCode || perception.value?.statusCode || null,
            ageNs: perception.ageNs,
        },
        localization: {
            ...(localization.value || {}),
            error: localizationError.value ?? localization.value?.error ?? null,
            ageNs: localization.ageNs,
        },
        controls: controls.value || null,
        ages: {
            perceptionNs: perception.ageNs,
            localizationNs: localization.ageNs,
            controlsNs: controls.ageNs,
        },
    };
}

export async function collectAttachments(service, idValue, { names = null } = {}) {
    const wanted = names ? new Set(names.map(String)) : null;
    const found = new Map();
    const index = await service.getIndex(idValue);
    const schemas = new Map(index.schemas.map((schema) => [schema.id, schema]));

    for await (const chunk of service.iterateChunks(idValue)) {
        const decoded = decodeRecordStream(chunk.raw, schemas, {
            includeUpdates: false,
            includeCheckpointValues: false,
            includeEvents: false,
        });
        for (const attachment of decoded.attachments) {
            if (wanted && !wanted.has(attachment.name)) continue;
            found.set(attachment.name, attachment);
            if (wanted && [...wanted].every((name) => found.has(name))) {
                return [...found.values()];
            }
        }
    }

    return [...found.values()];
}

export async function readPoseSeries(service, idValue, {
    path: signalPath,
    fromUs = 0,
    toUs = Number.POSITIVE_INFINITY,
    maxPoints = 2000,
} = {}) {
    if (!signalPath) throw new Error("A pose signal path is required.");
    const index = await service.getIndex(idValue);
    const descriptor = index.schemas.find((schema) => schema.path === signalPath);
    const boundedToUs = Number.isFinite(toUs) ? toUs : index.durationUs;
    if (!descriptor || descriptor.type !== "pose3") {
        return {
            path: signalPath,
            fromUs,
            toUs: boundedToUs,
            totalSamples: 0,
            samples: [],
            simplified: false,
        };
    }

    const schemas = new Map(index.schemas.map((schema) => [schema.id, schema]));
    const rawSamples = [];
    const decodeOptions = {
        includeUpdates: (schema) => schema.path === signalPath,
        includeCheckpointValues: false,
        includeEvents: false,
        includeAttachments: false,
    };
    for await (const chunk of service.iterateChunks(idValue, { fromUs, toUs, verifyCrc: false })) {
        if (Array.isArray(chunk.schemaIds) && chunk.schemaIds.length && !chunk.schemaIds.includes(descriptor.id)) continue;
        const decoded = decodeRecordStream(chunk.raw, schemas, decodeOptions);
        for (const update of decoded.updates) {
            if (update.path !== signalPath || update.timeUs < fromUs || update.timeUs > toUs) continue;
            const sample = poseSampleFromValue(update.timeUs, update.cycle, update.value);
            if (sample) rawSamples.push(sample);
        }
    }

    const limit = Math.min(2000, Math.max(2, Math.floor(Number(maxPoints) || 2000)));
    const samples = simplifyTrajectory(rawSamples, limit);
    return {
        path: signalPath,
        fromUs,
        toUs: Number.isFinite(toUs) ? toUs : index.durationUs,
        totalSamples: rawSamples.length,
        samples,
        simplified: samples.length < rawSamples.length,
    };
}

export async function readAutonomySnapshot(service, idValue, timeUs = 0, { exactSync = false, captureTimeNs = null } = {}) {
    const index = await service.getIndex(idValue);
    const cursorUs = Math.min(index.durationUs, Math.max(0, Number(timeUs) || 0));
    const paths = [
        "visualization.perception.candidate",
        "visualization.perception.oracle",
        "visualization.localization.candidate",
        "visualization.localization.error",
        "visualization.perception.status",
        "visualization.controls.snapshot",
    ];
    const schemas = new Map(index.schemas.map((schema) => [schema.id, schema]));
    const seriesMap = new Map(paths.map((path) => [path, []]));
    const pathSet = new Set(paths);
    const wantedIds = new Set(index.schemas.filter((schema) => pathSet.has(schema.path)).map((schema) => schema.id));

    for await (const chunk of service.iterateChunks(idValue, { fromUs: 0, toUs: cursorUs, verifyCrc: false })) {
        if (wantedIds.size && Array.isArray(chunk.schemaIds) && chunk.schemaIds.length && !chunk.schemaIds.some((schemaId) => wantedIds.has(schemaId))) continue;
        const decoded = decodeRecordStream(chunk.raw, schemas, {
            includeUpdates: (schema) => pathSet.has(schema.path),
            includeCheckpointValues: false,
            includeEvents: false,
            includeAttachments: false,
        });
        for (const update of decoded.updates) {
            if (!pathSet.has(update.path) || update.timeUs > cursorUs) continue;
            const samples = seriesMap.get(update.path);
            samples.push({ timeUs: update.timeUs, cycle: update.cycle, value: update.value });
        }
    }

    for (const samples of seriesMap.values()) {
        samples.sort((a, b) => a.timeUs - b.timeUs);
    }

    return {
        timeUs: cursorUs,
        snapshot: buildAutonomySnapshotFromSeries(seriesMap, cursorUs, { exactSync, captureTimeNs }),
    };
}

export { buildAutonomySnapshotFromSeries };
