import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { resolveSupervisorConfig, SUPERVISOR_PRESETS } from "../headless/SupervisorConfig.js";
import { queuePositionFor } from "../headless/HeadlessExperimentQueue.js";

const EnqueueSchema = z.object({
    suiteId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative().optional(),
    resultId: z.string().min(1).optional(),
    failFast: z.boolean().optional(),
    artifactProfile: z.enum(["evaluation", "training", "disabled"]).optional(),
});

const PreflightSchema = z.object({
    suiteId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative().optional(),
    artifactProfile: z.enum(["evaluation", "training", "disabled"]).optional(),
});

function sanitizeCase(entry = {}) {
    return {
        id: entry.id,
        key: entry.key,
        ordinal: entry.ordinal,
        scenarioId: entry.scenarioId,
        manifestId: entry.manifestId,
        seed: entry.seed,
        status: entry.status,
        completed: entry.completed,
        passed: entry.passed,
        metrics: entry.metrics ?? {},
        resolvedHash: entry.resolvedHash ?? null,
        runId: entry.runId ?? null,
        episodeHash: entry.episodeHash ?? null,
        trajectoryHash: entry.trajectoryHash ?? null,
        logId: entry.logId ?? null,
        failureReason: entry.failureReason ?? null,
        artifactWarnings: entry.artifactWarnings ?? [],
        artifacts: (entry.artifacts ?? []).map((artifact) => ({
            name: artifact.name,
            mimeType: artifact.mimeType ?? null,
            sizeBytes: artifact.sizeBytes ?? null,
            sha256: artifact.sha256 ?? null,
            catalogUri: artifact.catalogUri ?? null,
        })),
        startedAt: entry.startedAt ?? null,
        finishedAt: entry.finishedAt ?? null,
    };
}

function sanitizeResult(result, { queuePosition = null, liveHealth = null } = {}) {
    if (!result) return null;
    return {
        id: result.id,
        suiteId: result.suiteId,
        status: result.status,
        execution: result.execution ?? null,
        revision: result.revision,
        summary: result.summary ?? null,
        createdAt: result.createdAt ?? null,
        startedAt: result.startedAt ?? null,
        finishedAt: result.finishedAt ?? null,
        queuePosition,
        liveHealth,
        cases: (result.cases ?? []).map(sanitizeCase),
    };
}

function assertSameOrigin(req) {
    const origin = String(req.headers.origin || "").trim();
    if (!origin) return;
    const host = String(req.headers.host || "").trim();
    if (!host) return;
    const expected = `${req.protocol}://${host}`;
    if (origin !== expected) {
        throw new Error("Cross-origin headless control requests are not allowed.");
    }
}

export function createHeadlessRouter(headlessExperimentService) {
    const router = express.Router();
    const artifactRoot = path.resolve(headlessExperimentService.artifactRoot);

    router.get("/capabilities", handle(async () => {
        let safetyLimits = SUPERVISOR_PRESETS.safety.limits;
        let maxWorkers = SUPERVISOR_PRESETS.safety.maxWorkers;
        try {
            const config = resolveSupervisorConfig(headlessExperimentService.supervisor.config);
            safetyLimits = config.limits;
            maxWorkers = config.maxWorkers;
        } catch {
            // Embedded supervisors may omit listener metadata; expose preset limits.
        }
        const capabilities = await headlessExperimentService.supervisor.getCapabilities({});
        return {
            ok: true,
            queueMode: "fifo-single-case",
            managedExperiments: true,
            runtimeVersion: capabilities.runtimeVersion,
            platform: capabilities.platform,
            architecture: capabilities.architecture,
            safetyLimits,
            maxWorkers,
            ready: !headlessExperimentService.closing,
        };
    }));

    router.post("/preflight", handle(async (req) => {
        assertSameOrigin(req);
        const payload = PreflightSchema.parse(req.body ?? {});
        const summary = await headlessExperimentService.preflight(payload);
        return { ok: true, ...summary };
    }));

    router.get("/runs", handle(async () => {
        const queue = await headlessExperimentService.getQueue();
        const liveHealth = headlessExperimentService.getLiveHealth();
        const runs = [];
        for (const entry of queue.entries) {
            const result = await headlessExperimentService.storage.getExperimentResult(entry.resultId);
            if (!result || result.execution?.backend !== "headless") continue;
            runs.push(sanitizeResult(result, {
                queuePosition: entry.queuePosition,
                liveHealth: entry.active ? liveHealth : null,
            }));
        }
        const recent = [];
        for (const summary of await headlessExperimentService.storage.listExperimentResults()) {
            if (summary.execution?.backend !== "headless") continue;
            if (runs.some((entry) => entry.id === summary.id)) continue;
            if (!["completed", "cancelled", "interrupted", "error"].includes(summary.status)) continue;
            const result = await headlessExperimentService.storage.getExperimentResult(summary.id);
            if (result) recent.push(sanitizeResult(result));
        }
        recent.sort((left, right) => String(right.finishedAt || right.createdAt).localeCompare(String(left.finishedAt || left.createdAt)));
        return {
            ok: true,
            queue: {
                revision: queue.revision,
                pumpRunning: queue.pumpRunning,
                active: queue.active,
            },
            runs,
            recent: recent.slice(0, 50),
            liveHealth,
        };
    }));

    router.get("/runs/:resultId", handle(async (req) => {
        const result = await headlessExperimentService.storage.getExperimentResult(req.params.resultId);
        if (!result || result.execution?.backend !== "headless") {
            throw new Error(`Headless run "${req.params.resultId}" does not exist.`);
        }
        const queue = await headlessExperimentService.getQueue();
        const position = queuePositionFor(await headlessExperimentService.storage.getHeadlessExperimentQueue(), result.id);
        const active = headlessExperimentService.active?.resultId === result.id;
        return {
            ok: true,
            result: sanitizeResult(result, {
                queuePosition: position,
                liveHealth: active ? headlessExperimentService.getLiveHealth() : null,
            }),
        };
    }));

    router.post("/runs", handle(async (req) => {
        assertSameOrigin(req);
        const payload = EnqueueSchema.parse(req.body ?? {});
        const started = await headlessExperimentService.enqueue(payload);
        return {
            ok: true,
            ...started,
            result: sanitizeResult(started.result, { queuePosition: started.queuePosition }),
        };
    }));

    router.post("/runs/:resultId/cancel", handle(async (req) => {
        assertSameOrigin(req);
        const cancelled = await headlessExperimentService.cancel(req.params.resultId);
        return {
            ok: true,
            result: sanitizeResult(cancelled),
        };
    }));

    router.get("/runs/:resultId/cases/:caseIndex/artifacts/:artifactName", async (req, res) => {
        try {
            const result = await headlessExperimentService.storage.getExperimentResult(req.params.resultId);
            if (!result || result.execution?.backend !== "headless") {
                res.status(404).json({ error: `Headless run "${req.params.resultId}" does not exist.` });
                return;
            }
            const caseIndex = Number(req.params.caseIndex);
            const caseEntry = result.cases?.[caseIndex];
            const artifact = (caseEntry?.artifacts ?? []).find((entry) => entry.name === req.params.artifactName);
            if (!artifact?.uri) {
                res.status(404).json({ error: "Artifact not found." });
                return;
            }
            const resolved = path.resolve(String(artifact.uri));
            if (resolved !== artifactRoot && !resolved.startsWith(`${artifactRoot}${path.sep}`)) {
                res.status(403).json({ error: "Artifact path is outside the managed headless artifact root." });
                return;
            }
            const buffer = await fs.readFile(resolved);
            res.setHeader("Content-Type", artifact.mimeType || "application/octet-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.send(buffer);
        } catch (error) {
            if (error.code === "ENOENT") {
                res.status(404).json({ error: "Artifact file is missing." });
                return;
            }
            console.error(`[headless] GET ${req.originalUrl} failed:`, error);
            res.status(400).json({ error: error.message });
        }
    });

    return router;
}

function handle(fn) {
    return async (req, res) => {
        try {
            const result = await fn(req);
            res.json(result ?? null);
        } catch (error) {
            console.error(`[headless] ${req.method} ${req.originalUrl} failed:`, error);
            const status = /cross-origin/i.test(error.message) ? 403 : 400;
            res.status(status).json({ error: error.message, details: error.details ?? null });
        }
    };
}
