'use client';

import { useEffect, useMemo } from "react";

import { runMcpCommandOnce } from "../client/mcpCommandClaim.js";
import { subscribeStorageEvents } from "../client/storageEvents.js";
import {
    getExperimentResult,
    getExperimentSuite,
    validateExperimentSuiteOnServer,
} from "./ExperimentClient.js";
import { normalizeExperimentResult } from "./ExperimentResult.js";
import { getExperimentRunController } from "./ExperimentRunController.js";
import { normalizeExperimentSuite } from "./ExperimentSuite.js";

function documentFrom(value, key) {
    return value?.[key] ?? value?.document ?? value;
}

async function loadSuite(suiteId) {
    const suite = normalizeExperimentSuite(documentFrom(await getExperimentSuite(suiteId), "suite"));
    const validation = await validateExperimentSuiteOnServer(suiteId, suite);
    if (validation?.ok === false) {
        throw new Error(validation.issues?.[0]?.message || `Experiment suite "${suiteId}" is invalid.`);
    }
    return { suite, validation };
}

/** Executes MCP experiment queue commands in exactly one initialized browser tab. */
export default function McpExperimentBridge({ onOpenWorkspace }) {
    const controller = useMemo(() => getExperimentRunController(), []);

    useEffect(() => subscribeStorageEvents((event) => {
        if (event.domain !== "experiment-run") return;
        if (!["start", "pause", "resume", "cancel"].includes(event.action)) return;
        const requestId = event.requestId || `${event.action}:${event.at}`;
        runMcpCommandOnce(requestId, async () => {
            try {
                if (event.data?.openWorkspace !== false) onOpenWorkspace?.();
                const snapshot = controller.getSnapshot();
                const requestedResultId = event.data?.resultId || null;
                const activeResultId = snapshot.result?.id || null;
                if (requestedResultId && activeResultId && requestedResultId !== activeResultId) {
                    throw new Error(`Experiment result guard mismatch: active result is "${activeResultId}".`);
                }

                if (event.action === "start") {
                    if (["running", "paused"].includes(snapshot.status)) {
                        throw new Error(`Experiment result "${activeResultId}" is already ${snapshot.status}.`);
                    }
                    const suiteId = event.data?.suiteId || event.id;
                    const { suite, validation } = await loadSuite(suiteId);
                    const cases = validation.matrix?.cases || [];
                    if (cases.length === 0) throw new Error("The experiment suite has no compatible cases to run.");
                    await controller.start({
                        suite,
                        cases,
                        resultId: requestedResultId || `${suite.id}-result-${Date.now().toString(36)}`,
                        failFast: event.data?.failFast,
                    });
                    return;
                }

                if (!controller.getSnapshot().result && requestedResultId) {
                    const result = normalizeExperimentResult(documentFrom(await getExperimentResult(requestedResultId), "result"));
                    const { suite } = await loadSuite(result.suiteId);
                    await controller.load(result, { suite, persist: false });
                }
                if (event.action === "pause") await controller.pause();
                if (event.action === "cancel") await controller.cancel();
                if (event.action === "resume") {
                    const result = controller.getSnapshot().result;
                    if (!result) throw new Error("No experiment result is loaded to resume.");
                    const { suite } = await loadSuite(result.suiteId);
                    await controller.resume({ suite });
                }
            } catch (error) {
                console.warn(`[experiments] MCP ${event.action} failed:`, error);
            }
        }).catch((error) => console.warn("[experiments] MCP command lock failed:", error));
    }), [controller, onOpenWorkspace]);

    return null;
}
