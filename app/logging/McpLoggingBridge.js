'use client';

import { useEffect, useMemo } from "react";
import { runMcpCommandOnce } from "../client/mcpCommandClaim.js";
import { subscribeStorageEvents } from "../client/storageEvents.js";
import { getTelemetryStore } from "../telemetry/TelemetryRuntime.js";
import { DEFAULT_REPLAY_PROFILE, DEFAULT_TELEMETRY_PROFILE, normalizeProfile } from "./LogProfiles.js";
import { getRecordingController } from "./RecordingController.js";
import { buildRecordingOptions } from "./RecordingOptions.js";

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
        runMcpCommandOnce(requestId, async () => {
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
