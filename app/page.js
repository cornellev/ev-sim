'use client';

import { useCallback, useEffect, useState } from 'react';
import { IconLayoutGrid } from '@tabler/icons-react';
import TotalScene from './3d/Scene';
import Scripting from './scripting/Scripting';
import BindingsPage from './scripting/bindings/BindingsPage';
import ReplayPage from './replay/ReplayPage';
import LogsPage from './logging/LogsPage';
import AnalysisPage from './analysis/AnalysisPage';
import ConfigPage from './config/ConfigPage';
import VehicleEditorPage from './vehicles/editor/VehicleEditorPage';
import ScenarioPage from './scenarios/ScenarioPage';
import ExperimentPage from './experiments/ExperimentPage';
import HeadlessPage from './headless/HeadlessPage';
import McpExperimentBridge from './experiments/McpExperimentBridge';
import { getExperimentRunController } from './experiments/ExperimentRunController';
import Menu from './3d/overlay/menu/Menu';
import { APP_VIEWS, THREE_D_MODES } from './3d/viewState';
import {
    getActiveEnvironmentId,
    listEnvironments,
    setActiveEnvironmentId,
} from './3d/environment/EnvironmentCatalogClient';
import { subscribeStorageEvents } from './client/storageEvents';
import { getRunSessionController } from './simulation/RunSessionController';
import { resolveRunManifest } from './simulation/RunManifestClient';
import { getTelemetryTabBridge } from './telemetry/TelemetryRuntime';
import {
    DesktopRequired,
    ShortcutProvider,
    UiProvider,
    WorkspaceGuardProvider,
    useShortcut,
    useWorkspaceNavigation,
} from './ui';


export default function Home() {
    return (
        <UiProvider>
            <ShortcutProvider>
                <WorkspaceGuardProvider>
                    <HomeContent />
                </WorkspaceGuardProvider>
            </ShortcutProvider>
        </UiProvider>
    );
}

function HomeContent() {
    const { requestNavigation } = useWorkspaceNavigation();
    const [view, setView] = useState(APP_VIEWS.THREE_D);
    const [threeDMode, setThreeDMode] = useState(THREE_D_MODES.SIMULATION);
    const [menuVisible, setMenuVisible] = useState(false);
    const [menuSource, setMenuSource] = useState("keyboard");
    const [activeEnvironmentId, setActiveEnvironment] = useState(null);
    const [selectedLogId, setSelectedLogId] = useState(null);
    const [replayCommand, setReplayCommand] = useState(null);
    const [desktopRequired, setDesktopRequired] = useState(false);
    const [experimentDiagnosticsViewport, setExperimentDiagnosticsViewport] = useState(null);
    const [experimentExecutionActive, setExperimentExecutionActive] = useState(false);
    const [headlessPreselectedSuiteId, setHeadlessPreselectedSuiteId] = useState(null);
    const [configInitialManifestId, setConfigInitialManifestId] = useState(null);
    const [experimentNavigation, setExperimentNavigation] = useState(null);

    useEffect(() => {
        const query = window.matchMedia("(max-width: 767px)");
        const sync = () => {
            setDesktopRequired(query.matches);
            if (query.matches) setMenuVisible(false);
        };
        sync();
        query.addEventListener("change", sync);
        return () => query.removeEventListener("change", sync);
    }, []);

    useEffect(() => {
        const bridge = getTelemetryTabBridge();
        return () => bridge.stop();
    }, []);

    useEffect(() => getExperimentRunController().subscribe((snapshot) => {
        setExperimentExecutionActive(snapshot.status === "running");
    }), []);

    useEffect(() => {
        const workspace = view === APP_VIEWS.THREE_D ? threeDMode : view;
        getTelemetryTabBridge().setContext({ workspace, environmentId: activeEnvironmentId });
    }, [activeEnvironmentId, threeDMode, view]);

    const closeMenu = useCallback(() => {
        setMenuVisible(false);
    }, []);

    const openWorkspaceSwitcher = useCallback((source = "pointer") => {
        setMenuSource(source);
        setMenuVisible(true);
    }, []);

    const requestWorkspace = useCallback((action) => {
        const changedImmediately = requestNavigation(action);
        if (!changedImmediately) setMenuVisible(false);
        return changedImmediately;
    }, [requestNavigation]);

    const goToSimulation = useCallback(() => {
        requestWorkspace(() => {
            setView(APP_VIEWS.THREE_D);
            setThreeDMode(THREE_D_MODES.SIMULATION);
            setMenuVisible(false);
        });
    }, [requestWorkspace]);

    const goToEnvironmentEditor = useCallback(() => {
        requestWorkspace(() => {
            setView(APP_VIEWS.THREE_D);
            setThreeDMode(THREE_D_MODES.ENVIRONMENT);
            setMenuVisible(false);
        });
    }, [requestWorkspace]);

    const goToScripting = useCallback(() => {
        requestWorkspace(() => {
            setView(APP_VIEWS.SCRIPTING);
            setMenuVisible(false);
        });
    }, [requestWorkspace]);

    const goToBindings = useCallback(() => {
        requestWorkspace(() => {
            setView(APP_VIEWS.BINDINGS);
            setMenuVisible(false);
        });
    }, [requestWorkspace]);

    const goToReplay = useCallback((logId = null) => {
        requestWorkspace(() => {
            if (typeof logId === "string") setSelectedLogId(logId);
            setView(APP_VIEWS.REPLAY);
            setMenuVisible(false);
        });
    }, [requestWorkspace]);

    const goToLogs = useCallback(() => {
        requestWorkspace(() => {
            setView(APP_VIEWS.LOGS);
            setMenuVisible(false);
        });
    }, [requestWorkspace]);

    const goToAnalysis = useCallback((logId = null) => {
        requestWorkspace(() => {
            if (typeof logId === "string") setSelectedLogId(logId);
            setView(APP_VIEWS.ANALYSIS);
            setMenuVisible(false);
        });
    }, [requestWorkspace]);

    const goToConfig = useCallback((manifestId = null) => {
        requestWorkspace(() => {
            setConfigInitialManifestId(typeof manifestId === "string" ? manifestId : null);
            setView(APP_VIEWS.CONFIG);
            setMenuVisible(false);
        });
    }, [requestWorkspace]);

    const goToVehicleEditor = useCallback(() => {
        requestWorkspace(() => {
            setView(APP_VIEWS.VEHICLE_EDITOR);
            setMenuVisible(false);
        });
    }, [requestWorkspace]);

    const goToScenarios = useCallback(() => {
        requestWorkspace(() => {
            setView(APP_VIEWS.SCENARIOS);
            setMenuVisible(false);
        });
    }, [requestWorkspace]);

    const goToExperiments = useCallback((target = null) => {
        requestWorkspace(() => {
            setExperimentNavigation(target && typeof target === "object" ? target : null);
            setView(APP_VIEWS.EXPERIMENTS);
            setThreeDMode(THREE_D_MODES.SIMULATION);
            setMenuVisible(false);
        });
    }, [requestWorkspace]);

    const goToHeadlessRuns = useCallback((suiteId = null) => {
        requestWorkspace(() => {
            setHeadlessPreselectedSuiteId(typeof suiteId === "string" ? suiteId : null);
            setView(APP_VIEWS.HEADLESS_RUNS);
            setThreeDMode(THREE_D_MODES.SIMULATION);
            setMenuVisible(false);
        });
    }, [requestWorkspace]);

    const updateExperimentDiagnosticsViewport = useCallback((nextViewport) => {
        setExperimentDiagnosticsViewport((current) => {
            if (!nextViewport) return current ? null : current;
            const next = {
                top: Number(nextViewport.top) || 0,
                left: Number(nextViewport.left) || 0,
                width: Math.max(1, Number(nextViewport.width) || 1),
                height: Math.max(1, Number(nextViewport.height) || 1),
            };
            if (current
                && current.top === next.top
                && current.left === next.left
                && current.width === next.width
                && current.height === next.height) return current;
            return next;
        });
    }, []);

    const selectEnvironment = useCallback((environmentId) => {
        setActiveEnvironment(environmentId);
        setActiveEnvironmentId(environmentId).catch((error) => {
            console.error("Could not persist active environment:", error);
        });
    }, []);

    useEffect(() => getRunSessionController().setEnvironmentHandler(selectEnvironment), [selectEnvironment]);

    const launchResolvedRun = useCallback((resolved) => {
        const environmentId = resolved?.manifest?.environment?.id;
        if (environmentId) selectEnvironment(environmentId);
        setView(APP_VIEWS.THREE_D);
        setThreeDMode(THREE_D_MODES.SIMULATION);
        setMenuVisible(false);
    }, [selectEnvironment]);

    useEffect(() => {
        let cancelled = false;
        Promise.all([getActiveEnvironmentId(), listEnvironments()])
            .then(([environmentId, environments]) => {
                const exists = environments?.some?.((environment) => environment.id === environmentId);
                if (!cancelled) setActiveEnvironment(exists ? environmentId : "igvc");
            })
            .catch((error) => {
                console.warn("Could not load active environment; using IGVC:", error);
                if (!cancelled) setActiveEnvironment("igvc");
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        return subscribeStorageEvents((event) => {
            if (event.domain === "environment" && event.action === "active" && event.id) {
                setActiveEnvironment(event.id);
                return;
            }
            if (event.domain === "run-manifest" && event.action === "launch" && event.id) {
                resolveRunManifest(event.id)
                    .then(async (resolved) => {
                        await getRunSessionController().prepare(resolved, {
                            autoplay: event.data?.autoplay === true,
                        });
                        launchResolvedRun(resolved);
                    })
                    .catch((error) => console.warn("Could not launch MCP run manifest:", error));
                return;
            }
            if (event.domain !== "replay" || !event.data?.logId) return;
            setSelectedLogId(event.data.logId);
            setReplayCommand({
                ...event.data,
                action: event.action,
                requestId: event.requestId || `${event.action}:${event.at}`,
            });
            setView(APP_VIEWS.REPLAY);
            setMenuVisible(false);
        });
    }, [launchResolvedRun]);

    useShortcut({
        id: "global-workspace-switcher",
        keys: "Escape",
        scope: "global",
        priority: 0,
        enabled: !menuVisible && !desktopRequired,
        handler: () => {
            if (window.__fusionEnvironmentEditorConsumesEscape) return false;
            openWorkspaceSwitcher("keyboard");
            return true;
        },
    });

    return (
        <div className="sf-application-root">
        <div
            className="sf-runtime-layer"
            aria-hidden={desktopRequired || undefined}
            inert={desktopRequired || undefined}
        >
        <McpExperimentBridge onOpenWorkspace={goToExperiments} />
        {
            menuVisible && (
                <Menu
                    activeView={view}
                    activeThreeDMode={threeDMode}
                    onClose={closeMenu}
                    onSimulation={goToSimulation}
                    onEnvironmentEditor={goToEnvironmentEditor}
                    onScripting={goToScripting}
                    onBindings={goToBindings}
                    onConfig={goToConfig}
                    onVehicleEditor={goToVehicleEditor}
                    onScenarios={goToScenarios}
                    onExperiments={goToExperiments}
                    onHeadlessRuns={goToHeadlessRuns}
                    onReplay={goToReplay}
                    onLogs={goToLogs}
                    onAnalysis={goToAnalysis}
                    instant={menuSource === "keyboard"}
                />
            )
        }
        {view === APP_VIEWS.THREE_D && (
            <button
                type="button"
                className="sf-canvas-workspace-button"
                onClick={() => openWorkspaceSwitcher("pointer")}
                aria-label="Open workspace switcher"
            >
                <IconLayoutGrid size={15} stroke={1.75} aria-hidden="true" />
                <span>{threeDMode === THREE_D_MODES.ENVIRONMENT ? "Environment Editor" : "Simulation"}</span>
            </button>
        )}
        {
            view === APP_VIEWS.SCRIPTING && <Scripting onOpenWorkspace={() => openWorkspaceSwitcher("pointer")} />
        }
        {
            view === APP_VIEWS.BINDINGS && <BindingsPage onOpenWorkspace={() => openWorkspaceSwitcher("pointer")} />
        }
        {
            view === APP_VIEWS.REPLAY && (
                <ReplayPage key={selectedLogId || "replay"} initialLogId={selectedLogId} mcpCommand={replayCommand} onOpenAnalysis={goToAnalysis} onOpenWorkspace={() => openWorkspaceSwitcher("pointer")} />
            )
        }
        {
            view === APP_VIEWS.LOGS && (
                <LogsPage
                    onOpenWorkspace={() => openWorkspaceSwitcher("pointer")}
                    onOpenReplay={goToReplay}
                    onOpenAnalysis={goToAnalysis}
                    onOpenManifest={goToConfig}
                    onOpenExperiment={goToExperiments}
                />
            )
        }
        {
            view === APP_VIEWS.ANALYSIS && (
                <AnalysisPage initialLogId={selectedLogId} onOpenReplay={goToReplay} onOpenWorkspace={() => openWorkspaceSwitcher("pointer")} />
            )
        }
        {
            view === APP_VIEWS.CONFIG && (
                <ConfigPage
                    key={configInitialManifestId || "config"}
                    initialManifestId={configInitialManifestId}
                    onLaunch={launchResolvedRun}
                    onOpenWorkspace={() => openWorkspaceSwitcher("pointer")}
                />
            )
        }
        {
            view === APP_VIEWS.VEHICLE_EDITOR && <VehicleEditorPage onOpenWorkspace={() => openWorkspaceSwitcher("pointer")} />
        }
        {
            view === APP_VIEWS.SCENARIOS && <ScenarioPage onOpenWorkspace={() => openWorkspaceSwitcher("pointer")} />
        }
        {
            view === APP_VIEWS.EXPERIMENTS && (
                <ExperimentPage
                    key={[
                        experimentNavigation?.suiteId || "",
                        experimentNavigation?.resultId || "",
                        experimentNavigation?.caseId || "",
                        experimentNavigation?.baselineId || "",
                        experimentNavigation?.tab || "",
                    ].join(":") || "experiments"}
                    initialNavigation={experimentNavigation}
                    onOpenWorkspace={() => openWorkspaceSwitcher("pointer")}
                    onOpenReplay={goToReplay}
                    onOpenAnalysis={goToAnalysis}
                    onOpenHeadlessRuns={goToHeadlessRuns}
                    onDiagnosticsViewportChange={updateExperimentDiagnosticsViewport}
                />
            )
        }
        {
            view === APP_VIEWS.HEADLESS_RUNS && <HeadlessPage onOpenWorkspace={() => openWorkspaceSwitcher("pointer")} onOpenReplay={goToReplay} onOpenAnalysis={goToAnalysis} preselectedSuiteId={headlessPreselectedSuiteId} />
        }
        {
            activeEnvironmentId && (
                <TotalScene
                    mode={threeDMode}
                    visible={view === APP_VIEWS.THREE_D || (view === APP_VIEWS.EXPERIMENTS && Boolean(experimentDiagnosticsViewport))}
                    environmentId={activeEnvironmentId}
                    onEnvironmentChange={selectEnvironment}
                    onOpenReplay={goToReplay}
                    embeddedViewport={view === APP_VIEWS.EXPERIMENTS ? experimentDiagnosticsViewport : null}
                    preservePlaybackWhenHidden={experimentExecutionActive}
                />
            )
        }
        </div>
        <DesktopRequired />
        </div>
    );
}
