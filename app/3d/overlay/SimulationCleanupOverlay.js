'use client';

import { useEffect, useMemo, useState } from "react";
import { IconLoader2 } from "@tabler/icons-react";
import { Dialog } from "radix-ui";

import { getRecordingController } from "../../logging/RecordingController.js";
import {
    shouldShowSimulationCleanup,
    simulationCleanupPendingBytes,
    simulationCleanupProgress,
} from "./simulationCleanup.js";

const CLEANUP_CONTROL_LOCK = "simulation-cleanup-overlay";

function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function blockDismiss(event) {
    event.preventDefault();
}

export function SimulationCleanupOverlay({ data }) {
    const sim = data?.simulation?.();
    const controller = useMemo(() => getRecordingController(), []);
    const [simState, setSimState] = useState(() => sim?.getSnapshot?.() ?? null);
    const [recording, setRecording] = useState(() => controller.getSnapshot());

    useEffect(() => {
        if (!sim?.subscribe) return undefined;
        return sim.subscribe(setSimState);
    }, [sim]);

    useEffect(() => controller.subscribe(setRecording), [controller]);

    const visible = shouldShowSimulationCleanup(simState, recording);
    const pendingBytes = simulationCleanupPendingBytes(recording);
    const progress = simulationCleanupProgress(recording);
    const percent = Math.round(progress * 100);
    const finalizing = visible && pendingBytes <= 0;

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(CLEANUP_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(CLEANUP_CONTROL_LOCK),
        };
    }, [data]);

    useEffect(() => () => controls.enable(), [controls]);

    useEffect(() => {
        if (!visible) {
            controls.enable();
            return undefined;
        }
        controls.disable();
        return () => controls.enable();
    }, [controls, visible]);

    return (
        <Dialog.Root open={visible}>
            <Dialog.Portal>
                <Dialog.Overlay className="sf-dialog-overlay" />
                <Dialog.Content
                    className="sf-dialog sf-cleanup-dialog"
                    aria-busy="true"
                    onPointerDownOutside={blockDismiss}
                    onFocusOutside={blockDismiss}
                    onInteractOutside={blockDismiss}
                    onEscapeKeyDown={blockDismiss}
                >
                    <header className="sf-dialog__header">
                        <div className="sf-cleanup-dialog__heading">
                            <IconLoader2 className="sf-cleanup-dialog__spinner" size={16} stroke={1.75} aria-hidden="true" />
                            <div>
                                <Dialog.Title className="sf-dialog__title">Cleaning up</Dialog.Title>
                                <Dialog.Description className="sf-dialog__description">
                                    The simulation is flushing the remaining log queue. Wait until this finishes before continuing.
                                </Dialog.Description>
                            </div>
                        </div>
                    </header>
                    <div className="sf-dialog__body">
                        <div
                            className="sf-cleanup-progress"
                            role="progressbar"
                            aria-label="Log cleanup progress"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={percent}
                        >
                            <div className="sf-cleanup-progress__meta">
                                <span>{finalizing ? "Finalizing log" : "Writing remaining log data"}</span>
                                <span>{finalizing ? "Finishing…" : `${formatBytes(pendingBytes)} remaining`}</span>
                            </div>
                            <div className="sf-cleanup-progress__track">
                                <span
                                    className="sf-cleanup-progress__fill"
                                    style={{ transform: `scaleX(${progress})` }}
                                />
                            </div>
                            <p className="sf-cleanup-progress__percent">{percent}%</p>
                        </div>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
