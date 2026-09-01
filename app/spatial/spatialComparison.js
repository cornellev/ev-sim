import { TRAIL_COLORS } from "./spatialLogModel.js";

export const MAX_COMPARE_LOGS = 4;

export function compareWorldCompatibility(entries = []) {
    const hashes = entries.map((entry) => entry.worldHash).filter(Boolean);
    const unique = [...new Set(hashes)];
    return {
        compatible: unique.length <= 1,
        worldHashes: unique,
        reason: unique.length > 1 ? "Logs were recorded against different resolved runs or environments." : null,
    };
}

export function buildComparisonTrails(entries = [], { maxLogs = MAX_COMPARE_LOGS } = {}) {
    const limited = entries.slice(0, maxLogs);
    return limited.map((entry, index) => ({
        logId: entry.logId,
        label: entry.label || entry.logId,
        color: entry.color || TRAIL_COLORS[index % TRAIL_COLORS.length],
        offsetUs: Number(entry.offsetUs) || 0,
        samples: (entry.samples || []).map((sample) => ({
            ...sample,
            timeUs: sample.timeUs + (Number(entry.offsetUs) || 0),
        })),
        worldHash: entry.worldHash || null,
    }));
}

export function alignedComparisonTime(baseTimeUs, offsetUs = 0) {
    return Math.max(0, Number(baseTimeUs) - Number(offsetUs || 0));
}
