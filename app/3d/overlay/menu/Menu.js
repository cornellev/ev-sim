'use client';

import { useMemo, useRef } from "react";
import {
    IconAdjustments,
    IconCar,
    IconChartHistogram,
    IconCode,
    IconCube,
    IconHistory,
    IconFiles,
    IconLink,
    IconPlayerPlay,
    IconRoute,
    IconFlask2,
    IconTerminal2,
    IconWorld,
    IconX,
} from "@tabler/icons-react";
import { Dialog } from "radix-ui";

import { IconButton } from "../../../ui";
import { APP_VIEWS, THREE_D_MODES } from "../../viewState";

const ICON_PROPS = { size: 16, stroke: 1.75 };

export default function Menu({
    activeView = APP_VIEWS.SCRIPTING,
    activeThreeDMode = THREE_D_MODES.SIMULATION,
    onSimulation,
    onEnvironmentEditor,
    onConfig,
    onVehicleEditor,
    onScenarios,
    onExperiments,
    onHeadlessRuns,
    onScripting,
    onBindings,
    onReplay,
    onLogs,
    onAnalysis,
    onClose,
    instant = false,
}) {
    const selectedRef = useRef(null);
    const sections = useMemo(() => [
        {
            label: "Build and run",
            items: [
                { key: "simulation", label: "Simulation", hint: "Run vehicles, sensors, and scenarios", icon: IconPlayerPlay, active: activeView === APP_VIEWS.THREE_D && activeThreeDMode === THREE_D_MODES.SIMULATION, onSelect: onSimulation },
                { key: "environment", label: "Environment Editor", hint: "Edit environments and scenes", icon: IconWorld, active: activeView === APP_VIEWS.THREE_D && activeThreeDMode === THREE_D_MODES.ENVIRONMENT, onSelect: onEnvironmentEditor },
                { key: "vehicles", label: "Vehicle Editor", hint: "Create and inspect vehicle manifests", icon: IconCar, active: activeView === APP_VIEWS.VEHICLE_EDITOR, onSelect: onVehicleEditor },
                { key: "config", label: "Run Configuration", hint: "Edit simulation manifests", icon: IconAdjustments, active: activeView === APP_VIEWS.CONFIG, onSelect: onConfig },
                { key: "scenarios", label: "Scenarios", hint: "Create test scenarios", icon: IconRoute, active: activeView === APP_VIEWS.SCENARIOS, onSelect: onScenarios },
                { key: "experiments", label: "Experiment Suite", hint: "Experiment with scenarios", icon: IconFlask2, active: activeView === APP_VIEWS.EXPERIMENTS, onSelect: onExperiments },
                { key: "headless-runs", label: "Headless Runs", hint: "Queue and monitor server runs", icon: IconTerminal2, active: activeView === APP_VIEWS.HEADLESS_RUNS, onSelect: onHeadlessRuns },
            ],
        },
        {
            label: "Logic",
            items: [
                { key: "scripting", label: "Scripting Canvas", hint: "Build simulation logic", icon: IconCode, active: activeView === APP_VIEWS.SCRIPTING, onSelect: onScripting },
                { key: "bindings", label: "Bindings", hint: "Bind scripts to signals", icon: IconLink, active: activeView === APP_VIEWS.BINDINGS, onSelect: onBindings },
            ],
        },
        {
            label: "Inspect",
            items: [
                { key: "replay", label: "Replay", hint: "Inspect recorded simulations", icon: IconHistory, active: activeView === APP_VIEWS.REPLAY, onSelect: onReplay },
                                { key: "analysis", label: "Analysis", hint: "Graph live data", icon: IconChartHistogram, active: activeView === APP_VIEWS.ANALYSIS, onSelect: onAnalysis },
                { key: "logs", label: "Logs", hint: "Organize recorded simulations", icon: IconFiles, active: activeView === APP_VIEWS.LOGS, onSelect: onLogs },
            ],
        },
    ], [
        activeThreeDMode,
        activeView,
        onAnalysis,
        onBindings,
        onConfig,
        onExperiments,
        onHeadlessRuns,
        onEnvironmentEditor,
        onLogs,
        onReplay,
        onScripting,
        onSimulation,
        onScenarios,
        onVehicleEditor,
    ]);

    return (
        <Dialog.Root open onOpenChange={(open) => !open && onClose?.()}>
            <Dialog.Portal>
                <Dialog.Overlay className="sf-dialog-overlay" data-instant={instant || undefined} />
                <Dialog.Content
                    className="sf-dialog sf-workspace-menu"
                    data-instant={instant || undefined}
                    onOpenAutoFocus={(event) => {
                        event.preventDefault();
                        selectedRef.current?.focus();
                    }}
                >
                    <header className="sf-dialog__header">
                        <div>
                            <Dialog.Title className="sf-dialog__title">Workspaces</Dialog.Title>
                        </div>
                        <Dialog.Close asChild>
                            <IconButton label="Close workspaces" tooltip="Close">
                                <IconX {...ICON_PROPS} />
                            </IconButton>
                        </Dialog.Close>
                    </header>
                    <div className="sf-workspace-menu__body">
                        {sections.map((section) => (
                            <section className="sf-workspace-menu__section" key={section.label}>
                                <h2 className="sf-workspace-menu__section-title">{section.label}</h2>
                                <div className="sf-workspace-menu__items">
                                    {section.items.map((item) => {
                                        const Icon = item.icon || IconCube;
                                        return (
                                            <button
                                                key={item.key}
                                                ref={item.active ? selectedRef : undefined}
                                                type="button"
                                                className="sf-workspace-menu__item mx-1"
                                                data-active={item.active || undefined}
                                                aria-current={item.active ? "page" : undefined}
                                                onClick={() => item.active ? onClose?.() : item.onSelect?.()}
                                            >
                                                <Icon className="sf-workspace-menu__icon" {...ICON_PROPS} aria-hidden="true" />
                                                <span className="sf-workspace-menu__copy">
                                                    <span className="sf-workspace-menu__label">{item.label}</span>
                                                    <span className="sf-workspace-menu__hint">{item.hint}</span>
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>
                        ))}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
