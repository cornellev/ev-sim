'use client';

import { useEffect, useMemo } from "react";
import { subscribeStorageEvents } from "../client/storageEvents.js";
import { getTelemetryStore } from "../telemetry/TelemetryRuntime.js";
import { DEFAULT_REPLAY_PROFILE, DEFAULT_TELEMETRY_PROFILE, normalizeProfile } from "./LogProfiles.js";
import { getRecordingController } from "./RecordingController.js";
import { buildRecordingOptions } from "./RecordingOptions.js";

const FALLBACK_CLAIM_TTL_MS = 60_000;

async function runOnceAcrossTabs(requestId, task) {
    const lockName = `fusion-mcp-command:${requestId}`;
    const key = `fusion:mcp-command:${requestId}`;
    const tabId = sessionStorage.getItem("fusion:mcp-tab-id") || crypto.randomUUID();
    sessionStorage.setItem("fusion:mcp-tab-id", tabId);
    const runClaimed = async () => {
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, JSON.stringify({ tabId, at: Date.now() }));
        try {
            await task();
        } finally {
            window.setTimeout(() => {
                const current = JSON.parse(localStorage.getItem(key) || "null");
                if (current?.tabId === tabId) localStorage.removeItem(key);
            }, FALLBACK_CLAIM_TTL_MS);
        }
    };

    if (navigator.locks?.request) {
        await navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
            if (lock) await runClaimed();
        });
        return;
    }

    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({ tabId, at: Date.now() }));
    await Promise.resolve();
    const claim = JSON.parse(localStorage.getItem(key) || "null");
    if (claim?.tabId === tabId && Date.now() - claim.at < FALLBACK_CLAIM_TTL_MS) await task();
    window.setTimeout(() => {
        const current = JSON.parse(localStorage.getItem(key) || "null");
        if (current?.tabId === tabId) localStorage.removeItem(key);
    }, FALLBACK_CLAIM_TTL_MS);
}

/** Executes MCP recording commands in exactly one initialized simulator tab. */
export default function McpLoggingBridge({ data, onOpenReplay }) {
    const controller = useMemo(() => getRecordingController(), []);
    const store = useMemo(() => getTelemetryStore(), []);

    useEffect(() => {
        controller.attachSimulation(data?.simulation?.());
    }, [controller, data]);

    useEffect(() => subscribeStorageEvents((event) => {
        if (event.domain !== "logging" || !["start", "stop"].includes(event.action)) return;
        const requestId = event.requestId || `${event.action}:${event.at}`;
        runOnceAcrossTabs(requestId, async () => {
            try {
                if (event.action === "start") {
                    if (controller.getSnapshot().active) throw new Error("A log recording is already active.");
                    const mode = event.data?.mode === "telemetry" ? "telemetry" : "replay-safe";
                    const defaultProfile = mode === "telemetry" ? DEFAULT_TELEMETRY_PROFILE : DEFAULT_REPLAY_PROFILE;
                    const profile = normalizeProfile(event.data?.profile || defaultProfile);
                    await controller.start(buildRecordingOptions({ data, store, profile, name: event.data?.name }));
                    return;
                }

                const activeId = controller.getSnapshot().session?.id;
                if (event.data?.logId && activeId !== event.data.logId) return;
                const metadata = await controller.stop();
                if (event.data?.openReplay !== false && metadata?.id) onOpenReplay?.(metadata.id);
            } catch (error) {
                store.emitTelemetryEvent({
                    category: "logging",
                    name: "mcp-command-failed",
                    severity: "error",
                    payload: { requestId, action: event.action, error: error.message },
                });
                console.warn("[logging] MCP command failed:", error);
            }
        }).catch((error) => console.warn("[logging] MCP command lock failed:", error));
    }), [controller, data, onOpenReplay, store]);

    return null;
}
