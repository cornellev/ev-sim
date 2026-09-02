import { randomUUID } from "node:crypto";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { decodeRecordStream } from "../../app/logging/SFLogCodec.js";
import { globMatches } from "../../app/logging/LogProfiles.js";
import { storageEvents } from "./events.js";
import { fail, ok } from "./toolResult.js";

const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4];
const MAX_STATE_FIELDS = 200;
const MAX_SERIES_SAMPLES = 2000;

const RecordingRuleSchema = z.object({
    pattern: z.string().min(1),
    enabled: z.boolean().optional(),
    sampling: z.enum(["every-update", "on-change", "fixed-rate", "disabled"]).optional(),
    rateHz: z.number().positive().nullable().optional(),
});

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function getNested(value, field) {
    if (!field) return value;
    return String(field).split(".").reduce((current, key) => current?.[key], value);
}

function jsonValue(value, depth = 0) {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (depth > 8) return { type: "depth-limit" };
    if (ArrayBuffer.isView(value)) {
        const preview = Array.from(value.subarray?.(0, 64) || []).map((item) => jsonValue(item, depth + 1));
        return value.length <= 64 ? preview : { type: value.constructor.name, length: value.length, preview };
    }
    if (Array.isArray(value)) {
        const preview = value.slice(0, 64).map((item) => jsonValue(item, depth + 1));
        return value.length <= 64 ? preview : { type: "array", length: value.length, preview };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child, depth + 1)]));
}

function matchesAny(path, patterns) {
    return !patterns?.length || patterns.some((pattern) => globMatches(pattern, path));
}

function snapshotAt(data, timeUs) {
    let values = {};
    let checkpointTimeUs = 0;
    for (const checkpoint of data.checkpoints) {
        if (checkpoint.timeUs > timeUs) break;
        values = { ...checkpoint.values };
        checkpointTimeUs = checkpoint.timeUs;
    }
    for (const update of data.updates) {
        if (update.timeUs < checkpointTimeUs) continue;
        if (update.timeUs > timeUs) break;
        values[update.path] = update.value;
    }
    return values;
}

function downsample(samples, limit) {
    if (samples.length <= limit) return samples;
    const selected = [];
    const seen = new Set();
    for (let index = 0; index < limit; index += 1) {
        const sourceIndex = Math.round(index * (samples.length - 1) / (limit - 1));
        if (seen.has(sourceIndex)) continue;
        seen.add(sourceIndex);
        selected.push(samples[sourceIndex]);
    }
    return selected;
}

function command(domain, action, id, data = {}) {
    const requestId = randomUUID();
    const event = storageEvents.publish({ domain, action, id, requestId, data });
    return { accepted: true, requestId, command: event };
}

async function getLogOverview(logService, logId, includeSignals = true) {
    const metadata = await logService.getMetadata(logId);
    if (metadata.status === "recording") {
        return {
            log: metadata,
            index: { available: false, reason: "Recording has not been finalized." },
            signals: includeSignals ? [] : undefined,
        };
    }
    try {
        const index = await logService.getIndex(logId);
        return {
            log: metadata,
            index: {
                available: true,
                durationUs: index.durationUs,
                chunkCount: index.chunks.length,
                checkpointCount: index.checkpoints.length,
                checkpoints: index.checkpoints,
            },
            signals: includeSignals ? index.schemas : undefined,
        };
    } catch (error) {
        return {
            log: metadata,
            index: { available: false, reason: error.message },
            signals: includeSignals ? [] : undefined,
        };
    }
}

/** Decode one finalized log into a read-only replay dataset for MCP inspection. */
export async function loadReplayData(logService, logId) {
    const index = await logService.getIndex(logId);
    const decoded = {
        schemas: new Map((index.schemas || []).map((schema) => [schema.id, schema])),
        updates: [],
        events: [],
        checkpoints: [],
    };
    for await (const chunk of logService.iterateChunks(logId, { fromUs: 0 })) {
        const part = decodeRecordStream(chunk.raw, decoded.schemas);
        decoded.schemas = part.schemas;
        decoded.updates.push(...part.updates);
        decoded.events.push(...part.events);
        decoded.checkpoints.push(...part.checkpoints);
    }
    return {
        metadata: await logService.getMetadata(logId),
        durationUs: index.durationUs || 0,
        descriptors: [...decoded.schemas.values()].sort((a, b) => a.path.localeCompare(b.path)),
        updates: decoded.updates.sort((a, b) => a.timeUs - b.timeUs),
        events: decoded.events.sort((a, b) => a.timeUs - b.timeUs),
        checkpoints: decoded.checkpoints.sort((a, b) => a.timeUs - b.timeUs),
    };
}

export async function inspectReplay(logService, logId, options = {}) {
    const data = await loadReplayData(logService, logId);
    const cursorUs = clamp(options.timeUs, 0, data.durationUs);
    const patterns = options.paths || [];
    const allEntries = Object.entries(snapshotAt(data, cursorUs))
        .filter(([path]) => matchesAny(path, patterns))
        .sort(([a], [b]) => a.localeCompare(b));
    const selected = allEntries.slice(0, MAX_STATE_FIELDS);
    const eventWindowUs = clamp(options.eventWindowUs ?? 500_000, 0, 60_000_000);
    const events = options.includeEvents === false ? [] : data.events
        .filter((event) => Math.abs(event.timeUs - cursorUs) <= eventWindowUs)
        .slice(-200)
        .map((event) => jsonValue(event));
    return {
        log: data.metadata,
        cursorUs,
        durationUs: data.durationUs,
        state: Object.fromEntries(selected.map(([path, value]) => [path, jsonValue(value)])),
        stateFieldCount: allEntries.length,
        stateTruncated: allEntries.length > selected.length,
        events,
    };
}

export async function readReplaySeries(logService, logId, options) {
    const data = await loadReplayData(logService, logId);
    const descriptor = data.descriptors.find((entry) => entry.path === options.path);
    if (!descriptor) throw new Error(`Signal "${options.path}" does not exist in log "${logId}".`);
    const fromUs = clamp(options.fromUs ?? 0, 0, data.durationUs);
    const toUs = clamp(options.toUs ?? data.durationUs, fromUs, data.durationUs);
    const limit = Math.min(MAX_SERIES_SAMPLES, Math.max(2, options.maxSamples || 500));
    const matching = data.updates
        .filter((update) => update.path === options.path && update.timeUs >= fromUs && update.timeUs <= toUs)
        .map((update) => ({ timeUs: update.timeUs, cycle: update.cycle, value: jsonValue(getNested(update.value, options.field)) }));
    const samples = downsample(matching, limit);
    return {
        logId,
        descriptor,
        field: options.field || null,
        fromUs,
        toUs,
        totalSamples: matching.length,
        returnedSamples: samples.length,
        downsampled: samples.length < matching.length,
        samples,
    };
}

/**
 * Register backend log management, browser recording control, and headless replay tools.
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {import("../logging/LogService.js").LogService} logService
 */
export function registerLoggingTools(server, logService) {
    server.registerTool("log_list", {
        title: "List simulation logs",
        description: "List persisted SFLog recordings, optionally filtering by status or tag.",
        inputSchema: {
            status: z.enum(["recording", "complete", "incomplete", "corrupt"]).optional(),
            tag: z.string().optional(),
        },
    }, async ({ status, tag }) => {
        try {
            const logs = (await logService.listLogs()).filter((entry) => (
                (!status || entry.status === status) && (!tag || entry.tags?.includes(tag))
            ));
            return ok({ ok: true, logs });
        } catch (error) { return fail(error); }
    });

    server.registerTool("log_get", {
        title: "Get simulation log",
        description: "Get SFLog metadata, chunk/checkpoint summary, and its typed signal catalog.",
        inputSchema: { logId: z.string().min(1), includeSignals: z.boolean().optional() },
    }, async ({ logId, includeSignals = true }) => {
        try {
            return ok({ ok: true, ...(await getLogOverview(logService, logId, includeSignals)) });
        } catch (error) { return fail(error); }
    });

    server.registerTool("log_update", {
        title: "Update simulation log",
        description: "Rename a persisted log, replace its human-editable tags, or move it between catalog folders.",
        inputSchema: {
            logId: z.string().min(1),
            name: z.string().min(1).optional(),
            tags: z.array(z.string()).max(100).optional(),
            folderId: z.string().nullable().optional(),
        },
    }, async ({ logId, name, tags, folderId }) => {
        try {
            const log = await logService.updateMetadata(logId, { name, tags, folderId });
            storageEvents.publish({ domain: "logging", id: logId, action: "updated", data: { log } });
            return ok({ ok: true, log });
        } catch (error) { return fail(error); }
    });

    server.registerTool("log_delete", {
        title: "Delete simulation log",
        description: "Permanently delete a finalized or recovered SFLog and its catalog sidecar.",
        inputSchema: { logId: z.string().min(1) },
    }, async ({ logId }) => {
        try {
            await logService.getMetadata(logId);
            await logService.deleteLog(logId);
            storageEvents.publish({ domain: "logging", id: logId, action: "deleted" });
            return ok({ ok: true, deleted: logId });
        } catch (error) { return fail(error); }
    });

    server.registerTool("log_catalog_get", {
        title: "Get log folder catalog",
        description: "Get the ordered single-level log folder catalog and its optimistic revision.",
        inputSchema: {},
    }, async () => {
        try { return ok({ ok: true, catalog: await logService.getCatalog() }); }
        catch (error) { return fail(error); }
    });

    server.registerTool("log_catalog_update", {
        title: "Update log folder catalog",
        description: "Replace the ordered log folder catalog using its expected optimistic revision. Removed folders unfile their logs.",
        inputSchema: {
            expectedRevision: z.number().int().nonnegative(),
            catalog: z.record(z.string(), z.any()),
        },
    }, async ({ expectedRevision, catalog }) => {
        try {
            const updated = await logService.putCatalog({ catalog, expectedRevision });
            storageEvents.publish({ domain: "logging", action: "catalog-updated", data: { revision: updated.revision } });
            return ok({ ok: true, catalog: updated });
        } catch (error) { return fail(error); }
    });

    server.registerTool("recording_status", {
        title: "Get recording status",
        description: "List backend SFLog sessions that are currently recording.",
        inputSchema: {},
    }, async () => {
        try {
            const recordings = (await logService.listLogs()).filter((entry) => entry.status === "recording");
            return ok({ ok: true, recordings, browserRequiredForControl: true });
        } catch (error) { return fail(error); }
    });

    server.registerTool("recording_start", {
        title: "Start simulator recording",
        description: "Ask the open simulator browser to start an SFLog recording. The simulator tab must be open and initialized.",
        inputSchema: {
            name: z.string().min(1).optional(),
            mode: z.enum(["replay-safe", "telemetry"]).optional(),
            profileId: z.string().min(1).optional(),
            rules: z.array(RecordingRuleSchema).max(500).optional(),
        },
    }, async ({ name, mode = "replay-safe", profileId, rules }) => {
        const profile = rules ? {
            kind: "fusion-log-profile",
            version: 1,
            id: profileId || `mcp-${mode}`,
            name: `MCP ${mode === "replay-safe" ? "Replay Safe" : "Telemetry"}`,
            mode,
            rules,
        } : null;
        return ok({ ok: true, ...command("logging", "start", null, { name, mode, profile }) });
    });

    server.registerTool("recording_stop", {
        title: "Stop simulator recording",
        description: "Ask the open simulator browser to flush and finalize its active SFLog recording.",
        inputSchema: {
            logId: z.string().min(1).optional().describe("Optional active session id guard"),
            openReplay: z.boolean().optional().describe("Open the finalized log in Replay"),
        },
    }, async ({ logId, openReplay = true }) => (
        ok({ ok: true, ...command("logging", "stop", logId || null, { logId, openReplay }) })
    ));

    server.registerTool("replay_open", {
        title: "Open log replay",
        description: "Open a persisted log in the browser Replay workspace at an optional timestamp.",
        inputSchema: {
            logId: z.string().min(1),
            timeUs: z.number().nonnegative().optional(),
            playing: z.boolean().optional(),
            speed: z.union(PLAYBACK_SPEEDS.map((speed) => z.literal(speed))).optional(),
        },
    }, async ({ logId, timeUs, playing = false, speed = 1 }) => {
        try {
            const index = await logService.getIndex(logId);
            const cursorUs = clamp(timeUs ?? 0, 0, index.durationUs);
            return ok({ ok: true, logId, cursorUs, ...command("replay", "open", logId, { logId, timeUs: cursorUs, playing, speed }) });
        } catch (error) { return fail(error); }
    });

    server.registerTool("replay_control", {
        title: "Control log replay",
        description: "Seek, play, pause, change speed, or toggle looping in the browser Replay workspace.",
        inputSchema: {
            logId: z.string().min(1),
            timeUs: z.number().nonnegative().optional(),
            playing: z.boolean().optional(),
            speed: z.union(PLAYBACK_SPEEDS.map((speed) => z.literal(speed))).optional(),
            loop: z.boolean().optional(),
        },
    }, async ({ logId, timeUs, playing, speed, loop }) => {
        try {
            const index = await logService.getIndex(logId);
            const data = { logId, playing, speed, loop };
            if (timeUs !== undefined) data.timeUs = clamp(timeUs, 0, index.durationUs);
            return ok({ ok: true, logId, ...command("replay", "control", logId, data) });
        } catch (error) { return fail(error); }
    });

    server.registerTool("replay_inspect", {
        title: "Inspect replay state",
        description: "Read exact recorded state and nearby events at a log timestamp without opening the browser UI. Paths accept glob patterns.",
        inputSchema: {
            logId: z.string().min(1),
            timeUs: z.number().nonnegative(),
            paths: z.array(z.string().min(1)).max(200).optional(),
            includeEvents: z.boolean().optional(),
            eventWindowUs: z.number().nonnegative().max(60_000_000).optional(),
        },
    }, async ({ logId, ...options }) => {
        try { return ok({ ok: true, ...(await inspectReplay(logService, logId, options)) }); }
        catch (error) { return fail(error); }
    });

    server.registerTool("replay_series", {
        title: "Read replay signal series",
        description: "Read a time-bounded, downsampled signal series from an SFLog for analysis.",
        inputSchema: {
            logId: z.string().min(1),
            path: z.string().min(1),
            field: z.string().optional(),
            fromUs: z.number().nonnegative().optional(),
            toUs: z.number().nonnegative().optional(),
            maxSamples: z.number().int().min(2).max(MAX_SERIES_SAMPLES).optional(),
        },
    }, async ({ logId, ...options }) => {
        try { return ok({ ok: true, ...(await readReplaySeries(logService, logId, options)) }); }
        catch (error) { return fail(error); }
    });

    server.registerResource("simulation-log-catalog", "fusion://logs", {
        title: "Simulation Log Catalog",
        description: "Current catalog of backend-persisted SFLog recordings.",
        mimeType: "application/json",
    }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await logService.listLogs(), null, 2) }] }));

    server.registerResource("log-folder-catalog", "fusion://log-folders", {
        title: "Log Folder Catalog",
        description: "Ordered single-level folder catalog for the Logs workspace.",
        mimeType: "application/json",
    }, async (uri) => ({
        contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(await logService.getCatalog(), null, 2),
        }],
    }));

    server.registerResource("simulation-log", new ResourceTemplate("fusion://logs/{logId}", {
        list: async () => ({
            resources: (await logService.listLogs()).map((entry) => ({
                uri: `fusion://logs/${encodeURIComponent(entry.id)}`,
                name: entry.name,
                description: `${entry.status} SFLog · ${entry.durationUs || 0} µs`,
                mimeType: "application/json",
            })),
        }),
        complete: {
            logId: async (value) => (await logService.listLogs()).map((entry) => entry.id).filter((id) => id.startsWith(value)),
        },
    }), {
        title: "Simulation Log",
        description: "Metadata, index summary, and typed signal catalog for an SFLog.",
        mimeType: "application/json",
    }, async (uri, variables) => {
        const logId = decodeURIComponent(String(variables.logId));
        const overview = await getLogOverview(logService, logId, true);
        return {
            contents: [{
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify(overview, null, 2),
            }],
        };
    });
}
