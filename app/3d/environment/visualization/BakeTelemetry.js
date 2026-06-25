const DEFAULT_EVENT_LIMIT = 5;

function nowMs() {
    return Date.now();
}

function serializeError(error) {
    if (!error) return null;
    if (typeof error === "string") return error;
    return error.message || String(error);
}

export function calculateBakeTotalSamples(paths = [], deltaDistance = 1) {
    const step = Number(deltaDistance);
    if (!Number.isFinite(step) || step <= 0) return 0;

    return paths.reduce((total, path) => {
        if (!path || !Array.isArray(path.vertices) || path.vertices.length === 0) {
            return total;
        }

        const length = Number(path.totalLength ?? 0);
        if (!Number.isFinite(length) || length <= 0) return total + 1;
        return total + Math.floor(length / step) + 1;
    }, 0);
}

export function calculateBakePercent(completedSamples = 0, totalSamples = 0) {
    const total = Number(totalSamples);
    if (!Number.isFinite(total) || total <= 0) return 0;

    const completed = Math.max(0, Math.min(total, Number(completedSamples) || 0));
    return Math.round((completed / total) * 1000) / 10;
}

export function calculateBakeEtaMs(elapsedMs = 0, completedSamples = 0, totalSamples = 0) {
    const elapsed = Number(elapsedMs);
    const completed = Number(completedSamples);
    const total = Number(totalSamples);

    if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
    if (!Number.isFinite(completed) || completed <= 0) return null;
    if (!Number.isFinite(total) || total <= completed) return 0;

    return Math.max(0, Math.round((elapsed / completed) * (total - completed)));
}

export function appendBakeEvent(events = [], event = {}, limit = DEFAULT_EVENT_LIMIT) {
    const entry = {
        id: event.id || `${event.type || "event"}-${event.at || nowMs()}-${Math.random().toString(36).slice(2, 7)}`,
        at: event.at || nowMs(),
        type: event.type || "event",
        severity: event.severity || "info",
        message: event.message || "",
        detail: event.detail ?? null,
    };

    return [...events, entry].slice(-Math.max(1, limit));
}

export function createBakeTelemetrySnapshot(options = {}) {
    const at = options.now ?? nowMs();

    return {
        status: options.status || "idle",
        stage: options.stage || "Idle",
        runId: options.runId || "",
        percent: 0,
        startedAt: options.startedAt ?? null,
        finishedAt: options.finishedAt ?? null,
        elapsedMs: 0,
        etaMs: null,
        activePathIndex: 0,
        frameIndex: 0,
        currentFrameIndex: null,
        currentSampleId: null,
        nextFrameIndex: 0,
        nextSampleId: null,
        nextDistance: 0,
        totalPaths: 0,
        totalSamples: 0,
        completedSamples: 0,
        sampleId: null,
        viewId: null,
        lastImage: null,
        mask: null,
        lidar: null,
        splat: null,
        server: {
            host: options.server?.host || "",
            endpoint: options.server?.endpoint || "/bake",
            healthy: null,
            useModel: Boolean(options.server?.useModel),
            awaitingModel: false,
            lastLatencyMs: null,
        },
        control: {
            manualAdvance: false,
            pendingManualSamples: 0,
        },
        warnings: [],
        error: null,
        recentEvents: [],
        updatedAt: at,
    };
}

export function applyBakeTelemetryPatch(snapshot, patch = {}, event = null, options = {}) {
    const at = options.now ?? nowMs();
    const startedAt = patch.startedAt ?? snapshot.startedAt;
    const finishedAt = patch.finishedAt ?? snapshot.finishedAt;
    const elapsedMs = startedAt
        ? Math.max(0, (finishedAt ?? at) - startedAt)
        : 0;

    let recentEvents = snapshot.recentEvents || [];
    let warnings = snapshot.warnings || [];

    if (event) {
        recentEvents = appendBakeEvent(recentEvents, { ...event, at }, options.eventLimit);
        if (event.severity === "warning" || event.severity === "error") {
            warnings = appendBakeEvent(warnings, { ...event, at }, options.eventLimit);
        }
    }

    const completedSamples = patch.completedSamples ?? snapshot.completedSamples ?? 0;
    const totalSamples = patch.totalSamples ?? snapshot.totalSamples ?? 0;
    const status = patch.status ?? snapshot.status;
    const etaMs = status === "stopped" || status === "error"
        ? null
        : calculateBakeEtaMs(elapsedMs, completedSamples, totalSamples);

    return {
        ...snapshot,
        ...patch,
        server: {
            ...snapshot.server,
            ...(patch.server ?? {}),
        },
        control: {
            ...snapshot.control,
            ...(patch.control ?? {}),
        },
        lastImage: patch.lastImage === undefined ? snapshot.lastImage : patch.lastImage,
        mask: patch.mask === undefined ? snapshot.mask : patch.mask,
        lidar: patch.lidar === undefined ? snapshot.lidar : patch.lidar,
        splat: patch.splat === undefined ? snapshot.splat : patch.splat,
        startedAt,
        finishedAt,
        elapsedMs,
        completedSamples,
        totalSamples,
        percent: calculateBakePercent(completedSamples, totalSamples),
        etaMs,
        recentEvents,
        warnings,
        updatedAt: at,
    };
}

export function markBakeStopped(snapshot, options = {}) {
    const at = options.now ?? nowMs();
    return applyBakeTelemetryPatch(
        snapshot,
        {
            status: "stopped",
            stage: "Stopped",
            finishedAt: at,
            etaMs: null,
        },
        {
            type: "stopped",
            severity: "warning",
            message: "Bake run stopped",
        },
        { now: at },
    );
}

export function markBakeErrored(snapshot, error, options = {}) {
    const at = options.now ?? nowMs();
    const message = serializeError(error) || "Bake run failed";

    return applyBakeTelemetryPatch(
        snapshot,
        {
            status: "error",
            stage: "Error",
            error: message,
            finishedAt: at,
            etaMs: null,
        },
        {
            type: "error",
            severity: "error",
            message,
        },
        { now: at },
    );
}
