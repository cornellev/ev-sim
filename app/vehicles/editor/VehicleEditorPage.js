'use client';

import { cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    IconArrowsMove,
    IconCube,
    IconPlus,
    IconRefresh,
    IconUpload,
} from "@tabler/icons-react";

import { deriveCompleteWheelbase } from "../axle/standardAxle.js";
import {
    createBlankVehicleManifest,
    deriveWheelbase,
    isValidVehicleId,
    resolveVehicleModelUrl,
} from "../VehicleManifest.js";
import {
    changeVehicleSensorType,
    createVehicleSensor,
    getSensorFieldValue,
    getSensorType,
    sensorTypeRegistry,
} from "../../3d/devices/SensorTypeRegistry.js";
import { createAuthoringSensorRuntimeRegistry } from "../../3d/devices/SensorRuntimeRegistry.js";
import { fetchPlantCatalog, fetchSensorCatalog } from "../../plugin/PluginClient.js";
import { BrowserSensorAuthoringSession } from "../../plugin/browser/BrowserSensorAuthoringSession.js";
import PluginSensorAuthoringPanel from "../../plugin/browser/PluginSensorAuthoringPanel.js";
import {
    pluginSensorCatalogEntryForType,
    sensorCatalogEntries,
    stampVehiclePluginPlantLock,
    stampVehiclePluginSensorLock,
} from "../../plugin/PluginSensorAuthoring.js";
import SensorTypeAdder from "../../ui/SensorTypeAdder.js";
import { subscribeStorageEvents } from "../../client/storageEvents.js";
import {
    getBuiltInVehicleManifest,
    isBuiltInVehicleManifest,
    listBuiltInVehicleManifests,
} from "../BuiltInVehicleManifests.js";
import {
    abandonVehicleStage,
    changeVehicleId,
    createVehicleManifest,
    createVehicleOperationId,
    createVehicleStage,
    deleteVehicleManifest,
    duplicateVehicleManifest,
    exportVehicleBundle,
    getVehicleManifest,
    importVehicleBundle,
    listVehicleManifests,
    readVehicleStageMember,
    renameVehicleManifest,
    saveVehicleManifest,
    uploadVehicleStageMember,
    validateVehicleManifestOnServer,
} from "../VehicleManifestClient.js";
import { VehicleEditorController } from "./VehicleEditorController.js";
import { editManifestFields, applyModelReplacement, applyPlacementChange, adoptStandardAxles, assignModelWheels, classifyWheel, copyWheelFromPartner, detachWheel, suppressSourceWheels } from "../document/vehicleCommands.js";
import { highlightedLinkIds, isBoundWheel, linkedPartnerId, resolveMotionLink, standardPartner } from "../document/wheelLink.js";
import { measurePlacedVehicleModel } from "../model/measurePlacedVehicle.js";
import { stageVehicleClosure, stageVehiclePlan } from "./stageVehicleClosure.js";
import { exportVehicleUrdf } from "../urdf/exportVehicleUrdf.js";
import { AxleFields, axleSummary, standardAxleCards } from "./AxleInspector.js";
import { DragNumber } from "./DragNumber.js";
import { VehiclePlanView } from "./VehiclePlanView.js";
import { PlacementAcceptanceDialog, WheelAssignmentDialog } from "./WheelAssignmentDialog.js";
import { canonicalVehicleGlb, rolesFromManifest } from "./wheelAssignmentState.js";
import { VehicleStudio } from "./VehicleStudio.js";
import { VehicleWorkspace } from "./workspace/VehicleWorkspace.js";
import { VehicleTopBar } from "./workspace/VehicleTopBar.js";
import { VehicleToolbar } from "./workspace/VehicleToolbar.js";
import { VehicleHierarchy } from "./workspace/VehicleHierarchy.js";
import { hierarchyNodesFromLease } from "./workspace/vehicleHierarchyModel.js";
import { VehiclePickerDialog, copyIdFor } from "./workspace/VehiclePickerDialog.js";
import { VehicleUrdfReviewDialog } from "./workspace/VehicleUrdfReviewDialog.js";
import { normalizeVehiclePaneLayout } from "./workspace/vehiclePaneLayout.js";
import { readVehicleEditorPreference, VEHICLE_EDITOR_PREFERENCE_KEYS, writeVehicleEditorPreference } from "../../ui/vehicleEditorPreferences.js";
import {
    AccordionItem,
    AccordionRoot,
    AdvancedFields,
    AuthoringModeProvider,
    AsyncState,
    Button,
    Disclosure,
    Field as SharedField,
    SegmentedControl,
    StatusMessage,
    Switch as SharedSwitch,
    TabsContent,
    TabsList,
    TabsRoot,
    TabsTrigger,
    useAuthoringMode,
    useShortcut,
    useWorkspaceGuard,
} from "../../ui";
import { degToRad, radToDeg } from "three/src/math/MathUtils.js";

const TABS = ["Model", "Body", "Wheels", "Sensors", "LiDAR Zone", "JSON"];
const WHEEL_ROLES = [
    { value: "", label: "Unclassified" },
    { value: "front:left", label: "Front left" },
    { value: "front:right", label: "Front right" },
    { value: "rear:left", label: "Rear left" },
    { value: "rear:right", label: "Rear right" },
];

function wheelPartner(wheels, wheel, mode) {
    if (!wheel?.axle || !wheel?.side) return null;
    if (mode === "mirror") {
        const side = wheel.side === "left" ? "right" : "left";
        return wheels.find((entry) => entry.id !== wheel.id && entry.axle === wheel.axle && entry.side === side) ?? null;
    }
    const axle = wheel.axle === "front" ? "rear" : "front";
    return wheels.find((entry) => entry.id !== wheel.id && entry.axle === axle && entry.side === wheel.side) ?? null;
}
const FaArrowsAlt = (props) => <IconArrowsMove size={14} stroke={1.75} {...props} />;
const FaCube = (props) => <IconCube size={14} stroke={1.75} {...props} />;
const FaPlus = (props) => <IconPlus size={14} stroke={1.75} {...props} />;
const FaSyncAlt = (props) => <IconRefresh size={14} stroke={1.75} {...props} />;
const FaUpload = (props) => <IconUpload size={14} stroke={1.75} {...props} />;

function vehicleIdFromName(name) {
    return String(name || "vehicle")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `vehicle-${Date.now().toString(36)}`;
}

function downloadBytes(name, bytes, mediaType) {
    const blob = new Blob([bytes], { type: mediaType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
}

function downloadJson(name, value) {
    downloadBytes(name, `${JSON.stringify(value, null, 2)}\n`, "application/json");
}

const stageClient = {
    createVehicleStage,
    uploadVehicleStageMember,
    readVehicleStageMember,
    abandonVehicleStage,
    saveVehicleManifest,
};

function round3(value) {
    return Math.round(value * 1000) / 1000;
}

function roundVec(vector) {
    return { x: round3(vector.x), y: round3(vector.y), z: round3(vector.z) };
}

export default function VehicleEditorPage({ onOpenWorkspace }) {
    const importRef = useRef(null);
    const modelFileRef = useRef(null);
    const assignButtonRef = useRef(null);
    const catalogButtonRef = useRef(null);
    const urdfButtonRef = useRef(null);
    const viewportRef = useRef(null);
    const studioRef = useRef(null);
    const studioHandlers = useRef({});
    const loadRequest = useRef(0);
    const sensorSessionRef = useRef(null);
    if (!sensorSessionRef.current) sensorSessionRef.current = new BrowserSensorAuthoringSession();
    const controllerRef = useRef(null);
    if (!controllerRef.current) {
        controllerRef.current = new VehicleEditorController({
            client: stageClient,
            resolveNormalizeOptions: () => ({ sensorRegistry: sensorSessionRef.current?.registry ?? sensorTypeRegistry }),
        });
    }

    const [catalog, setCatalog] = useState([]);
    const [loadState, setLoadState] = useState("loading");
    const [selectedId, setSelectedId] = useState(null);
    const [snapshot, setSnapshot] = useState(() => controllerRef.current.snapshot);
    const [tab, setTab] = useState("Model");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [gizmoMode, setGizmoMode] = useState("translate");
    const [assetVersion, setAssetVersion] = useState(0);
    const [zoneVisible, setZoneVisible] = useState(true);
    const [modelVisible, setModelVisible] = useState(true);
    const [voxelSize, setVoxelSize] = useState(0.2);
    const [fitTarget, setFitTarget] = useState({ length: 2.7, width: 1.25 });
    const [placementRevision, setPlacementRevision] = useState(0);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [urdfMode, setUrdfMode] = useState(null);
    const [urdfReport, setUrdfReport] = useState(null);
    const [serverValidation, setServerValidation] = useState(null);
    const [validatedStamp, setValidatedStamp] = useState(null);
    const [modelNodes, setModelNodes] = useState([]);
    const [layout, setLayout] = useState(() => normalizeVehiclePaneLayout(readVehicleEditorPreference(VEHICLE_EDITOR_PREFERENCE_KEYS.PANE_LAYOUT)));
    const [sensorCatalog, setSensorCatalog] = useState({ revision: 0, sensors: [] });
    const [plantCatalog, setPlantCatalog] = useState([]);
    const [sensorRegistryTick, setSensorRegistryTick] = useState(0);
    const [assignment, setAssignment] = useState(null);
    const [dismissedNotices, setDismissedNotices] = useState({});
    const [placementPrompt, setPlacementPrompt] = useState(null);
    const [steeringPreview, setSteeringPreview] = useState(0);
    const authoringOptions = () => ({
        sensorRegistry: sensorSessionRef.current?.registry ?? sensorTypeRegistry,
    });
    const bumpSensorRegistry = () => setSensorRegistryTick((value) => value + 1);
    const authoringRuntime = useMemo(() => {
        void sensorRegistryTick;
        return createAuthoringSensorRuntimeRegistry({ definitions: authoringOptions().sensorRegistry });
    }, [sensorRegistryTick]);

    const draft = snapshot.manifest;
    const draftStamp = useMemo(() => (draft ? JSON.stringify(draft) : ""), [draft]);
    const raw = snapshot.raw;
    const rawError = snapshot.rawError;
    const dirty = snapshot.dirty;
    const readOnly = snapshot.readOnly;
    const selection = snapshot.selection?.kind ? snapshot.selection : null;
    const validation = snapshot.validation;

    useEffect(() => controllerRef.current.subscribe(setSnapshot), []);
    useEffect(() => {
        writeVehicleEditorPreference(VEHICLE_EDITOR_PREFERENCE_KEYS.PANE_LAYOUT, layout);
    }, [layout]);
    const onLayoutChange = useCallback((producer) => {
        setLayout((current) => (typeof producer === "function" ? producer(current) : producer));
    }, []);

    const applyDocument = (id, document) => {
        controllerRef.current.open(document, { readOnly: isBuiltInVehicleManifest(id) });
        setSelectedId(id);
        setError(null);
        setSteeringPreview(0);
        setModelNodes([]);
    };

    const loadCatalog = async (preferredId = null) => {
        const requestId = ++loadRequest.current;
        setLoadState("loading");
        setError(null);
        try {
            const storedItems = (await listVehicleManifests()) || [];
            const builtInItems = listBuiltInVehicleManifests();
            const items = [...builtInItems, ...storedItems];
            if (requestId !== loadRequest.current) return;
            setCatalog(items);
            const nextId = items.some((entry) => entry.id === preferredId)
                ? preferredId
                : storedItems[0]?.id ?? builtInItems[0]?.id;
            if (!nextId) {
                controllerRef.current.close();
                setSelectedId(null);
                setLoadState("empty");
                return;
            }
            const document = getBuiltInVehicleManifest(nextId) ?? await getVehicleManifest(nextId);
            if (requestId !== loadRequest.current) return;
            if (!document) throw new Error(`Vehicle "${nextId}" no longer exists.`);
            applyDocument(nextId, document);
            setLoadState("ready");
        } catch (caught) {
            if (requestId !== loadRequest.current) return;
            setError(caught.message);
            setLoadState("error");
        }
    };

    useEffect(() => {
        loadCatalog();
        return () => { loadRequest.current += 1; };
        // The initial catalog load intentionally runs once.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!dirty) return undefined;
        const protect = (event) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", protect);
        return () => window.removeEventListener("beforeunload", protect);
    }, [dirty]);

    // --- Studio lifecycle ----------------------------------------------------

    const hasDraft = Boolean(draft);
    useEffect(() => {
        if (!hasDraft || !viewportRef.current || studioRef.current) return undefined;
        const studio = new VehicleStudio(viewportRef.current, {
            onTransform: (pick, transform) => studioHandlers.current.onTransform?.(pick, transform),
            onPlacementCommit: (pick, transform) => studioHandlers.current.onPlacementCommit?.(pick, transform),
            onSelect: (pick) => studioHandlers.current.onSelect?.(pick),
            onModelLease: (lease) => studioHandlers.current.onModelLease?.(lease),
            onWheelDragStart: (pick) => studioHandlers.current.onWheelDragStart?.(pick),
            onWheelDragEnd: (pick) => studioHandlers.current.onWheelDragEnd?.(pick),
            onWheelDragCancel: () => studioHandlers.current.onWheelDragCancel?.(),
            sensorRuntime: authoringRuntime,
        });
        studioRef.current = studio;
        return () => {
            studio.dispose();
            studioRef.current = null;
        };
        // Recreate only when a draft appears; runtime updates go through setSensorRuntime.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasDraft]);

    useEffect(() => {
        if (!studioRef.current || !draft) return;
        const url = resolveVehicleModelUrl(selectedId, draft.model.asset, { cacheBust: assetVersion });
        studioRef.current.setManifest(draft, url, controllerRef.current.snapshot.stagedResources);
    }, [draft, selectedId, assetVersion, snapshot.stagedResources]);

    useEffect(() => {
        studioRef.current?.setSteeringPreview(steeringPreview);
    }, [steeringPreview, draft]);

    useEffect(() => {
        studioRef.current?.setSensorRuntime(authoringRuntime);
    }, [authoringRuntime]);

    useEffect(() => () => {
        sensorSessionRef.current?.dispose();
        sensorSessionRef.current = null;
    }, []);

    useEffect(() => {
        let mounted = true;
        const refresh = async () => {
            try {
                const [snapshot, plants] = await Promise.all([
                    fetchSensorCatalog(),
                    fetchPlantCatalog().catch(() => ({ plants: [] })),
                ]);
                if (!mounted) return;
                sensorSessionRef.current?.registerCatalog(snapshot);
                setSensorCatalog(snapshot);
                setPlantCatalog(Array.isArray(plants?.plants) ? plants.plants : []);
                bumpSensorRegistry();
            } catch (caught) {
                if (mounted) setError(caught.message);
            }
        };
        refresh();
        return subscribeStorageEvents((event) => {
            if (event.domain === "plugin") refresh();
        });
    }, []);

    useEffect(() => {
        const session = sensorSessionRef.current;
        if (!session || !draft) return undefined;
        let cancelled = false;
        (async () => {
            for (const lock of draft.pluginLocks ?? []) {
                try {
                    await session.loadLock(lock);
                } catch {
                    // Missing packages remain visible as unresolved authoring state.
                }
                if (cancelled) return;
            }
            if (!cancelled) bumpSensorRegistry();
        })();
        return () => { cancelled = true; };
        // Locks are derived from pluginLocks, not the whole draft.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft?.pluginLocks, sensorCatalog.revision]);
    useEffect(() => {
        studioRef.current?.setSelection(readOnly ? null : selection);
        // A preview emits a new selection object with the same kind and id.
        // Rebinding on that object detaches the gizmo mid-drag.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selection?.kind, selection?.id, readOnly]);
    useEffect(() => { studioRef.current?.setGizmoMode(gizmoMode); }, [gizmoMode]);
    useEffect(() => {
        const partnerId = selection?.kind === "wheel" && draft
            ? linkedPartnerId(draft.wheels, selection.id, snapshot.wheelLink)
            : null;
        studioRef.current?.setLinkedWheel(partnerId);
    }, [draft, selection, snapshot.wheelLink]);
    useEffect(() => {
        const onKey = (event) => {
            if (event.key !== "Escape") return;
            if (!studioHandlers.current.cancelWheelGesture?.()) return;
            event.preventDefault();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, []);
    useEffect(() => { studioRef.current?.setZoneVisible(zoneVisible); }, [zoneVisible]);
    useEffect(() => { studioRef.current?.setModelVisible(modelVisible); }, [modelVisible]);

    const update = (path, value, options = {}) => {
        const controller = controllerRef.current;
        if (!path.length) {
            controller.execute(editManifestFields(value, options.historyKey || "document"), options.coalesce ? { coalesceKey: options.historyKey || "document" } : {});
            return;
        }
        controller.editField(path, value, {
            coalesce: options.coalesce ?? ["number", "string"].includes(typeof value),
            coalesceKey: options.historyKey || path.join("."),
        });
    };

    const setSelection = (pick) => {
        if (!pick?.kind) controllerRef.current.select(null);
        else controllerRef.current.select(pick.kind, pick.id ?? null);
    };

    const beginAxleGesture = (axle) => controllerRef.current.beginAxle(axle);
    const commitAxleGesture = () => controllerRef.current.commitAxle();
    const cancelAxleGesture = () => {
        controllerRef.current.cancelAxle();
        setError(null);
    };
    const previewAxleGesture = (axle, patch) => {
        const result = controllerRef.current.previewAxle(axle, patch);
        setError(result?.ok === false ? (result.issues?.[0]?.message ?? "Axle edit was rejected.") : null);
    };

    const syncStudio = (manifest = draft) => {
        if (!manifest) return;
        const url = resolveVehicleModelUrl(selectedId, manifest.model?.asset, { cacheBust: assetVersion });
        studioRef.current?.setManifest(manifest, url, controllerRef.current.snapshot.stagedResources);
    };

    const executeCommand = (command, { coalesceKey = null } = {}) => (
        controllerRef.current.execute(command, coalesceKey ? { coalesceKey } : {})
    );

    const boundWheels = (manifest) => (manifest?.wheels ?? []).some((wheel) => wheel.visual?.kind === "model-node");

    const commitPlacement = (patch, { coalesce = false, historyKey = "placement" } = {}) => {
        if (!draft || readOnly) return;
        const before = JSON.stringify(draft);
        const result = executeCommand(applyPlacementChange({
            ...patch,
            glbBytes: boundWheels(draft) ? (studioRef.current?.getModelLease?.()?.glbBytes ?? null) : null,
            acceptAdjustments: false,
        }), { coalesceKey: coalesce ? historyKey : null });
        if (result.ok) {
            if (JSON.stringify(result.manifest) === before) syncStudio(draft);
            return;
        }
        if (result.review?.withinTolerance && result.review?.needsAcceptance) {
            setPlacementPrompt({ patch, review: result.review });
            return;
        }
        setPlacementRevision((value) => value + 1);
        setError(result.issues?.[0]?.message || "Placement was rejected.");
        syncStudio(draft);
    };

    const placementFromTransform = (pick, transform) => {
        if (pick?.kind === "body") return { boundingBox: { center: { ...transform.position } } };
        const alignment = studioRef.current?.getModelAlignment?.() || { x: 0, y: 0, z: 0 };
        return {
            model: {
                offset: {
                    x: transform.position.x - alignment.x,
                    y: transform.position.y - alignment.y,
                    z: transform.position.z - alignment.z,
                },
                rotation: { ...transform.rotation, order: draft?.model?.rotation?.order || "XYZ" },
            },
        };
    };

    studioHandlers.current.onTransform = (pick, transform) => {
        const position = roundVec(transform.position);
        const rotation = { ...roundVec(transform.rotation), order: "XYZ" };
        if (pick.kind === "sensor") {
            const index = draft?.sensors.findIndex((entry) => entry.id === pick.id);
            if (index === undefined || index < 0) return;
            update(["sensors", index, "pose"], { position, rotation }, { coalesce: true });
        } else if (pick.kind === "wheel") {
            const live = controllerRef.current.snapshot;
            const wheel = live.manifest?.wheels.find((entry) => entry.id === pick.id);
            if (!wheel || wheel.visual?.kind === "model-node") return;
            const translating = studioRef.current?.gizmo?.mode !== "rotate";
            if (translating && resolveMotionLink(live.manifest.wheels, pick.id, live.wheelLink)) {
                const result = controllerRef.current.previewWheel(pick.id, position);
                setError(result?.ok === false ? (result.issues?.[0]?.message ?? "Wheel move was rejected.") : null);
                if (result?.ok === false) syncStudio(controllerRef.current.snapshot.manifest);
                return;
            }
            const index = live.manifest.wheels.findIndex((entry) => entry.id === pick.id);
            update(["wheels", index, "position"], position, { coalesce: true });
        } else if (pick.kind === "body") {
            commitPlacement(placementFromTransform(pick, transform), { coalesce: true, historyKey: "body-center" });
        } else if (pick.kind === "ego") {
            update(["egoCenter"], position, { coalesce: true });
        } else if (pick.kind === "model") {
            commitPlacement(placementFromTransform(pick, { ...transform, position: transform.position }), { coalesce: true, historyKey: "model-offset" });
        }
    };

    studioHandlers.current.onPlacementCommit = (pick, transform) => {
        if (!draft || readOnly) {
            syncStudio(draft);
            return;
        }
        commitPlacement(placementFromTransform(pick, transform), { historyKey: `placement-${pick?.kind || "model"}` });
    };

    const previewWheelMotion = (drivenId, position) => {
        const result = controllerRef.current.previewWheel(drivenId, position);
        setError(result?.ok === false ? (result.issues?.[0]?.message ?? "Wheel move was rejected.") : null);
        if (result?.ok === false) syncStudio(controllerRef.current.snapshot.manifest);
        return result;
    };
    const beginWheelMotion = (drivenId) => {
        const result = controllerRef.current.beginWheel(drivenId);
        if (result?.ok === false) setError(result.issues?.[0]?.message ?? "Could not move those wheels.");
        return result;
    };
    const commitWheelMotion = () => {
        if (controllerRef.current.snapshot.gesture?.kind !== "wheel-link") return { ok: true, empty: true };
        return controllerRef.current.commitWheel();
    };
    const cancelWheelMotion = () => {
        const result = controllerRef.current.cancelWheel();
        setError(null);
        syncStudio(controllerRef.current.snapshot.manifest);
        return result;
    };
    const setWheelLink = (link) => {
        const result = controllerRef.current.setWheelLink(link);
        setError(result?.ok === false ? (result.issues?.[0]?.message ?? "Could not link those wheels.") : null);
        return result;
    };

    studioHandlers.current.onWheelDragStart = (pick) => {
        if (readOnly || studioRef.current?.gizmo?.mode === "rotate") return;
        const live = controllerRef.current.snapshot;
        if (!resolveMotionLink(live.manifest?.wheels, pick.id, live.wheelLink)) return;
        beginWheelMotion(pick.id);
    };
    studioHandlers.current.onWheelDragEnd = () => {
        commitWheelMotion();
    };
    studioHandlers.current.onWheelDragCancel = () => {
        cancelWheelMotion();
    };
    studioHandlers.current.cancelWheelGesture = () => {
        if (controllerRef.current.snapshot.gesture?.kind !== "wheel-link") return false;
        if (studioRef.current?.gizmo?.dragging || studioRef.current?._wheelDrag) {
            studioRef.current.cancelDrag();
            return true;
        }
        cancelWheelMotion();
        return true;
    };

    const acceptPlacement = () => {
        const prompt = placementPrompt;
        if (!prompt || !draft) return;
        const result = executeCommand(applyPlacementChange({
            ...prompt.patch,
            glbBytes: boundWheels(draft) ? (studioRef.current?.getModelLease?.()?.glbBytes ?? null) : null,
            acceptAdjustments: true,
        }));
        setPlacementPrompt(null);
        if (!result.ok) {
            setError(result.issues?.[0]?.message || "Placement was rejected.");
            syncStudio(draft);
        }
    };

    const rejectPlacement = () => {
        setPlacementRevision((revision) => revision + 1);
        setPlacementPrompt(null);
        syncStudio(draft);
    };

    studioHandlers.current.onModelLease = (lease) => {
        const hidden = controllerRef.current.snapshot.manifest?.model?.hiddenNodeIndices ?? [];
        setModelNodes(hierarchyNodesFromLease(lease).map((node) => ({ ...node, hidden: hidden.includes(node.index) })));
    };

    studioHandlers.current.onSelect = (pick) => {
        if (readOnly) return;
        setSelection(pick);
        if (pick?.kind === "sensor") setTab("Sensors");
        if (pick?.kind === "wheel") setTab("Wheels");
        if (pick?.kind === "ego") setTab("Body");
    };

    // Drop a stale selection when its target leaves the draft.
    useEffect(() => {
        if (!selection || !draft) return;
        if (selection.kind === "sensor" && !draft.sensors.some((entry) => entry.id === selection.id)) setSelection(null);
        if (selection.kind === "wheel" && !draft.wheels.some((entry) => entry.id === selection.id)) setSelection(null);
        if (selection.kind === "model" && !draft.model.asset) setSelection(null);
    }, [draft, selection]);

    // --- Catalog operations ---------------------------------------------------

    const perform = async (operation, { nested = false } = {}) => {
        if (!nested) setBusy(true);
        setError(null);
        try {
            return await operation();
        } catch (caught) {
            setError(caught.message);
            throw caught;
        } finally {
            if (!nested) setBusy(false);
        }
    };

    const confirmDiscard = () => !controllerRef.current.snapshot.dirty || window.confirm("Discard unsaved vehicle changes?");

    const select = async (id) => {
        if (!confirmDiscard()) return;
        await perform(async () => {
            const document = getBuiltInVehicleManifest(id) ?? await getVehicleManifest(id);
            if (!document) throw new Error(`Vehicle "${id}" no longer exists.`);
            applyDocument(id, document);
            setLoadState("ready");
            setPickerOpen(false);
        });
    };

    const createNew = async () => {
        if (!confirmDiscard()) return;
        const baseName = "Untitled Vehicle";
        let id = vehicleIdFromName(baseName);
        const existing = new Set(catalog.map((entry) => entry.id));
        let suffix = 2;
        while (existing.has(id)) id = `${vehicleIdFromName(baseName)}-${suffix++}`;
        await perform(async () => {
            const created = await createVehicleManifest(
                createBlankVehicleManifest({ id, name: baseName }),
                { operationId: createVehicleOperationId() },
            );
            await loadCatalog(created.id);
            setPickerOpen(false);
        });
    };

    const rememberStored = (stored) => {
        if (!stored) return;
        setCatalog((items) => items.map((entry) => entry.id === stored.id
            ? { ...entry, name: stored.name, revision: stored.revision, definitionHash: stored.definitionHash, modelAsset: stored.model?.asset ?? null }
            : entry));
        setAssetVersion((version) => version + 1);
    };

    const save = async () => perform(async () => {
        const result = await controllerRef.current.save();
        rememberStored(result.stored);
        return result.stored;
    });

    const validate = async () => perform(async () => {
        const result = await validateVehicleManifestOnServer(selectedId, controllerRef.current.snapshot.manifest);
        setServerValidation(result);
        setValidatedStamp(JSON.stringify(controllerRef.current.snapshot.manifest ?? ""));
        if (!result.ok) throw new Error("Vehicle validation found issues.");
        return result;
    });

    const acknowledgedRevision = (entry) => (
        entry.id === selectedId && Number.isFinite(controllerRef.current.snapshot.revision)
            ? controllerRef.current.snapshot.revision
            : entry.revision
    );

    const duplicateEntry = (entry) => perform(async () => {
        if (entry.id === selectedId && !confirmDiscard()) return;
        const existing = new Set(catalog.map((item) => item.id));
        const id = copyIdFor(entry, existing);
        const created = entry.builtIn
            ? await createVehicleManifest({ ...getBuiltInVehicleManifest(entry.id), id, name: `${entry.name} Copy` }, { operationId: createVehicleOperationId() })
            : await duplicateVehicleManifest(entry.id, { id, name: `${entry.name} Copy`, expectedRevision: acknowledgedRevision(entry) });
        await loadCatalog(created.id);
        setPickerOpen(false);
    });

    const renameEntry = (entry, name) => perform(async () => {
        if (entry.id === selectedId && controllerRef.current.snapshot.dirty) throw new Error("Save or discard the open draft before renaming it.");
        const stored = await renameVehicleManifest(entry.id, { name, expectedRevision: acknowledgedRevision(entry), operationId: createVehicleOperationId() });
        if (selectedId === entry.id) applyDocument(entry.id, stored);
        else setCatalog((items) => items.map((item) => item.id === stored.id ? { ...item, name: stored.name, revision: stored.revision, definitionHash: stored.definitionHash } : item));
    });

    const deleteEntry = (entry) => perform(async () => {
        if (entry.id === selectedId && controllerRef.current.snapshot.dirty) throw new Error("Save or discard the open draft before deleting it.");
        await deleteVehicleManifest(entry.id, acknowledgedRevision(entry));
        if (selectedId === entry.id) {
            controllerRef.current.close();
            setSelectedId(null);
        }
        await loadCatalog(selectedId === entry.id ? null : selectedId);
    });

    const changeEntryId = (entry, nextId) => perform(async () => {
        if (!isValidVehicleId(nextId)) throw new Error("Vehicle id must use lowercase letters, numbers, and single hyphens.");
        if (entry.id === selectedId && controllerRef.current.snapshot.dirty) throw new Error("Save or discard the open draft before changing its id.");
        const stored = await changeVehicleId(entry.id, { id: nextId, expectedRevision: acknowledgedRevision(entry), operationId: createVehicleOperationId() });
        await loadCatalog(stored.id);
        setPickerOpen(false);
    });

    const exportBundle = (entry = null) => perform(async () => {
        const id = entry?.id ?? selectedId;
        if (id === selectedId && controllerRef.current.snapshot.dirty) throw new Error("Save the vehicle before exporting a bundle.");
        const bundle = await exportVehicleBundle(id);
        downloadJson(`${id}.vehicle-bundle.json`, bundle);
    });

    const importBundleFile = (event) => perform(async () => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        if (!confirmDiscard()) return;
        const created = await importVehicleBundle(JSON.parse(await file.text()));
        await loadCatalog(created.id);
        setPickerOpen(false);
    });

    useWorkspaceGuard("vehicle-editor", {
        dirty,
        label: "Vehicle editor",
        save,
        discard: () => controllerRef.current.discard(),
    });

    // --- Model tab operations -------------------------------------------------

    const uploadModelFile = (event) => perform(async () => {
        const selected = [...(event.target.files ?? [])];
        event.target.value = "";
        if (selected.length === 0 || !selectedId || readOnly) return;
        const files = await Promise.all(selected.map(async (file) => ({
            path: file.webkitRelativePath || file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
        })));
        const entry = files.find((file) => /\.(glb|gltf|obj|stl)$/i.test(file.path));
        if (!entry) throw new Error("Choose a .glb, .gltf, .obj, or .stl model.");
        const staged = await stageVehiclePlan(files, { entryPath: entry.path, client: stageClient });
        const result = controllerRef.current.replaceStagedModel({
            model: {
                asset: staged.plan.asset.name,
                dependencies: staged.plan.dependencies.map((file) => file.name),
            },
            stagedResources: staged.staged,
        });
        if (!result.ok) {
            await abandonVehicleStage(staged.staged.stageId);
            throw new Error(result.issues?.[0]?.message || "Could not replace the model.");
        }
    });

    const fitModelToSize = () => {
        const bounds = studioRef.current?.getModelBounds();
        if (!bounds) {
            setError("Import a model before fitting it to a size.");
            return;
        }
        const currentLength = bounds.size.x / (draft.model.scale || 1);
        const currentWidth = bounds.size.z / (draft.model.scale || 1);
        if (currentLength <= 0 || currentWidth <= 0) return;
        const scale = Math.min(fitTarget.length / currentLength, fitTarget.width / currentWidth);
        commitPlacement({ model: { scale: round3(scale) || draft.model.scale } }, { historyKey: "model-scale" });
    };

    const generateZone = () => {
        try {
            const zone = studioRef.current?.generateLidarZone(voxelSize);
            if (zone) update(["lidarZone"], zone);
            setError(null);
        } catch (caught) {
            setError(caught.message);
        }
    };

    const fitBodyToModel = () => {
        const bounds = studioRef.current?.getModelBounds();
        if (!bounds) {
            setError("Import a model before fitting the bounding box.");
            return;
        }
        commitPlacement({
            boundingBox: {
                size: roundVec(bounds.size),
                center: roundVec(bounds.center),
            },
        }, { historyKey: "body-fit" });
    };

    const replaceOrDetachModel = (asset) => {
        const result = executeCommand(applyModelReplacement({
            model: { asset, dependencies: asset ? draft.model.dependencies : [] },
        }));
        if (!result.ok) setError(result.issues?.[0]?.message || "Could not update the model.");
    };

    const openAssignment = () => {
        const lease = studioRef.current?.getModelLease?.();
        if (!lease?.glbBytes) {
            setError("The canonical model is still loading.");
            return;
        }
        try {
            const measurement = measurePlacedVehicleModel({
                glbBytes: lease.glbBytes,
                model: draft.model,
                boundingBox: draft.boundingBox,
                hiddenNodeIndices: draft.model.hiddenNodeIndices ?? [],
            });
            setAssignment({ measurement, catalog: measurement.catalog, token: Date.now() });
            setError(null);
        } catch (caught) {
            setError(caught.message);
        }
    };

    const acceptAssignment = (pairs) => {
        const lease = studioRef.current?.getModelLease?.();
        const result = executeCommand(assignModelWheels({
            pairs,
            glbBytes: lease?.glbBytes ?? null,
            acceptAdjustments: true,
        }));
        if (!result.ok) {
            setError(result.issues?.[0]?.message || "Could not assign those wheels.");
            return;
        }
        setAssignment((current) => (current ? { ...current, open: false } : null));
    };

    const suppressAssignment = (nodeIndices) => {
        const lease = studioRef.current?.getModelLease?.();
        const result = executeCommand(suppressSourceWheels({
            nodeIndices,
            glbBytes: lease?.glbBytes ?? null,
        }));
        if (!result.ok) {
            setError(result.issues?.[0]?.message || "Could not hide those parts.");
            return;
        }
        setAssignment((current) => (current ? { ...current, open: false } : null));
    };

    const detachBoundWheel = (wheelId) => {
        const result = executeCommand(detachWheel({ wheelId }));
        if (!result.ok) setError(result.issues?.[0]?.message || "Could not detach that wheel.");
    };

    const groupAxles = () => {
        const result = executeCommand(adoptStandardAxles());
        if (!result.ok) setError(result.issues?.[0]?.message || "Could not group those axles.");
    };

    const classifyWheelRole = (wheelId, role) => {
        const [axle, side] = role ? role.split(":") : [null, null];
        const result = executeCommand(classifyWheel({ wheelId, axle, side }));
        if (!result.ok) setError(result.issues?.[0]?.message || "Could not classify that wheel.");
    };

    const copyWheelPartner = (wheelId, mode) => {
        const result = executeCommand(copyWheelFromPartner({ wheelId, mode }));
        if (!result.ok) setError(result.issues?.[0]?.message || "Could not copy that wheel.");
    };

    const applyRaw = (value) => {
        controllerRef.current.applyRaw(value);
    };

    const stageClosure = async (closure) => {
        const staged = await stageVehicleClosure([closure.asset, ...closure.dependencies], stageClient);
        return staged;
    };

    const createFromUrdf = ({ manifest, closure }) => perform(async () => {
        if (!confirmDiscard()) return;
        const staged = await stageClosure(closure);
        try {
            const created = await createVehicleManifest(manifest, { operationId: createVehicleOperationId(), stageId: staged.stageId });
            await loadCatalog(created.id);
            setUrdfMode(null);
        } catch (error) {
            await abandonVehicleStage(staged.stageId);
            throw error;
        }
    });

    const applyReviewedUrdf = ({ patch, closure }) => perform(async () => {
        const staged = await stageClosure(closure);
        const result = controllerRef.current.applyUrdf({ patch, stagedResources: staged });
        if (!result.ok) {
            await abandonVehicleStage(staged.stageId);
            throw new Error(result.issues?.[0]?.message || "Could not apply the URDF.");
        }
        setUrdfMode(null);
    });

    const exportUrdf = () => perform(async () => {
        const manifest = controllerRef.current.snapshot.manifest;
        if (!manifest) return;
        const assets = {};
        const assetName = manifest.model?.asset;
        if (assetName) {
            const staged = controllerRef.current.snapshot.stagedResources;
            const stagedMember = staged?.members?.find((member) => member.name === assetName);
            if (stagedMember) {
                assets[assetName] = (await readVehicleStageMember(staged.stageId, assetName)).bytes;
            } else {
                const response = await fetch(resolveVehicleModelUrl(selectedId, assetName, { cacheBust: assetVersion }));
                if (!response.ok) throw new Error(`Could not read vehicle model "${assetName}".`);
                assets[assetName] = new Uint8Array(await response.arrayBuffer());
            }
        }
        const exported = exportVehicleUrdf(manifest, { assets });
        downloadBytes(exported.filename, exported.bytes, exported.mediaType);
        setUrdfReport(exported.report);
    });

    useShortcut({
        id: "vehicle-editor-save",
        keys: "Mod+s",
        priority: 30,
        allowInEditable: true,
        enabled: Boolean(draft) && !readOnly,
        handler: () => {
            save();
            return true;
        },
    });
    useShortcut({
        id: "vehicle-editor-undo",
        keys: "Mod+z",
        priority: 30,
        allowInEditable: true,
        enabled: Boolean(draft) && !readOnly,
        handler: () => {
            controllerRef.current.undo();
            return true;
        },
    });
    useShortcut({
        id: "vehicle-editor-redo",
        keys: ["Shift+Mod+z", "Ctrl+y"],
        priority: 30,
        allowInEditable: true,
        enabled: Boolean(draft) && !readOnly,
        handler: () => {
            controllerRef.current.redo();
            return true;
        },
    });

    const derivedWheelbase = draft ? deriveWheelbase(draft.wheels) : null;
    const shownValidation = (validatedStamp === draftStamp ? serverValidation : null) ?? validation;
    const nameValue = controllerRef.current.fieldValue(["name"]) ?? draft?.name ?? "";

    return (
        <AuthoringModeProvider>
        <main className="fixed inset-0 z-[1] overflow-hidden bg-[var(--slate-bg)] text-[var(--slate-fg)]">
            <input ref={importRef} hidden type="file" accept=".json,application/json" onChange={importBundleFile} />
            <VehicleWorkspace
                layout={layout}
                onLayoutChange={onLayoutChange}
                topBar={(
                    <VehicleTopBar
                        name={draft?.name}
                        readOnly={readOnly}
                        dirty={dirty}
                        saveState={snapshot.saveState}
                        saveMessage={snapshot.saveMessage || error}
                        catalogRef={catalogButtonRef}
                        onOpenWorkspace={onOpenWorkspace}
                        onOpenCatalog={() => setPickerOpen(true)}
                        onValidate={validate}
                        onSave={save}
                        validateDisabled={!draft || busy || readOnly}
                        saveDisabled={!draft || busy || readOnly || (!dirty && !snapshot.stagedResources)}
                    />
                )}
                toolbar={(
                    <VehicleToolbar
                        gizmoMode={gizmoMode}
                        onGizmoMode={setGizmoMode}
                        canUndo={snapshot.canUndo}
                        canRedo={snapshot.canRedo}
                        onUndo={() => controllerRef.current.undo()}
                        onRedo={() => controllerRef.current.redo()}
                        readOnly={readOnly}
                        modelVisible={modelVisible}
                        zoneVisible={zoneVisible}
                        onModelVisible={setModelVisible}
                        onZoneVisible={setZoneVisible}
                        urdfButtonRef={urdfButtonRef}
                        onCreateUrdf={() => setUrdfMode("create")}
                        onApplyUrdf={() => setUrdfMode("apply")}
                        createUrdfDisabled={busy}
                        applyUrdfDisabled={busy || !draft || readOnly}
                    />
                )}
                hierarchy={(
                    <VehicleHierarchy
                        manifest={draft}
                        nodes={modelNodes}
                        selection={selection}
                        linkedIds={draft ? highlightedLinkIds(draft.wheels, selection, snapshot.wheelLink) : []}
                        onSelect={(row, nextTab) => {
                            if (row.kind === "wheel" || row.kind === "sensor") setSelection({ kind: row.kind, id: row.id });
                            else if (row.kind === "axle") setSelection({ kind: "axle", id: row.id.replace(/^axle-/, "") });
                            else setSelection({ kind: row.kind === "model-node" ? "model" : row.kind, id: null });
                            setTab(nextTab);
                        }}
                    />
                )}
                center={(
                <section className="absolute inset-0 min-w-0 overflow-hidden bg-[var(--slate-bg)]">
                    {loadState === "loading" && <CenterState title="Loading vehicles…" detail="Reading the server-backed vehicle catalog." />}
                    {loadState === "error" && (
                        <CenterState error title="Could not load vehicles" detail={error || "The vehicle catalog is unavailable."} action={<Action icon={<IconRefresh size={14} stroke={1.75} />} label="Retry" onClick={() => loadCatalog(selectedId)} />} />
                    )}
                    {loadState === "empty" && (
                        <CenterState title="No vehicles" detail="Create the first vehicle manifest to open the studio." action={<Action primary icon={<IconPlus size={14} stroke={1.75} />} label="Create vehicle" onClick={createNew} disabled={busy} />} />
                    )}
                    {draft && (
                        <>
                            <div ref={viewportRef} className="absolute inset-0" />
                            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-end p-3">
                                {selection && (
                                    <div className="pointer-events-auto flex items-center gap-2 rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] px-2.5 py-1.5">
                                        <span className="text-[14px] font-medium text-[var(--slate-fg-2)]">{selectionLabel(selection)}</span>
                                        <button type="button" onClick={() => setSelection(null)} className="text-[12px] text-[var(--slate-muted)] hover:text-[var(--slate-fg)]">Deselect</button>
                                    </div>
                                )}
                            </div>
                            <p className="pointer-events-none absolute bottom-3 left-3 rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] px-2 py-1 text-[11px] text-[var(--slate-muted)]">
                                {readOnly ? "Orbit to inspect. Duplicate this vehicle to edit it." : "Click a marker to select it. Drag the gizmo to place it."}
                            </p>
                        </>
                    )}
                </section>
                )}
                inspector={(
                <div className="flex min-h-0 flex-1 flex-col">
                    {draft && (
                        <TabsRoot value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
                            <div className="border-b border-[var(--slate-border)] p-3">
                                <input className="sf-input mb-2" aria-label="Vehicle name" value={nameValue} disabled={readOnly} onChange={(event) => update(["name"], event.target.value)} onBlur={() => controllerRef.current.commitField(["name"])} />
                                <p className="truncate font-mono text-[11px] text-[var(--slate-muted)]">{draft.id}</p>
                            </div>
                            {readOnly && (
                                <div className="border-b border-[var(--slate-border)] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--slate-muted)]">
                                    This built-in vehicle is defined in code. Inspect its projected values here, or duplicate it to make an editable manifest.
                                </div>
                            )}
                            <TabsList aria-label="Vehicle editor sections" className="w-full flex-wrap border-b border-[var(--slate-border)] p-1.5">
                                {TABS.map((item) => <TabsTrigger key={item} value={item} className="whitespace-nowrap">{item}</TabsTrigger>)}
                            </TabsList>

                            <EditorNotices
                                error={error}
                                rawError={rawError}
                                validation={shownValidation}
                                urdfReport={urdfReport}
                                dismissed={dismissedNotices}
                                onDismiss={(key, token) => setDismissedNotices((current) => ({ ...current, [key]: token }))}
                                onDismissUrdf={() => setUrdfReport(null)}
                            />

                            <div className="mod-scrollbar min-h-0 flex-1 overflow-y-auto" tabIndex={0} aria-label="Vehicle editor fields">
                                <fieldset disabled={readOnly}>
                                    {TABS.map((item) => (
                                        <TabsContent key={item} value={item} forceMount className="p-3">
                                            {item === "Model" && (
                                                <ModelTab
                                                    draft={draft}
                                                    commitPlacement={commitPlacement}
                                                    busy={busy}
                                                    modelFileRef={modelFileRef}
                                                    uploadModelFile={uploadModelFile}
                                                    detachModel={() => replaceOrDetachModel("")}
                                                    selection={selection}
                                                    setSelection={setSelection}
                                                    modelVisible={modelVisible}
                                                    setModelVisible={setModelVisible}
                                                    fitTarget={fitTarget}
                                                    setFitTarget={setFitTarget}
                                                    fitModelToSize={fitModelToSize}
                                                    fieldReset={`${selectedId}:${placementRevision}`}
                                                />
                                            )}
                                            {item === "LiDAR Zone" && (
                                                <LidarZoneTab
                                                    draft={draft}
                                                    update={update}
                                                    voxelSize={voxelSize}
                                                    setVoxelSize={setVoxelSize}
                                                    generateZone={generateZone}
                                                    zoneVisible={zoneVisible}
                                                    setZoneVisible={setZoneVisible}
                                                />
                                            )}
                                            {item === "Sensors" && (
                                                <SensorsTab
                                                    draft={draft}
                                                    update={update}
                                                    selection={selection}
                                                    setSelection={setSelection}
                                                    catalog={sensorCatalog}
                                                    session={sensorSessionRef.current}
                                                    onError={setError}
                                                    bumpRegistry={bumpSensorRegistry}
                                                />
                                            )}
                                            {item === "Wheels" && (
                                                <WheelsTab
                                                    draft={draft}
                                                    update={update}
                                                    selection={selection}
                                                    setSelection={setSelection}
                                                    derivedWheelbase={derivedWheelbase}
                                                    plantCatalog={plantCatalog}
                                                    onError={setError}
                                                    assignButtonRef={assignButtonRef}
                                                    assignmentReady={draft.version === 3 && canonicalVehicleGlb(draft.model.asset)}
                                                    onAssign={openAssignment}
                                                    onDetach={detachBoundWheel}
                                                    readOnly={readOnly}
                                                    steeringPreview={steeringPreview}
                                                    onSteeringPreview={setSteeringPreview}
                                                    onBeginGesture={beginAxleGesture}
                                                    onPreviewGesture={previewAxleGesture}
                                                    onCommitGesture={commitAxleGesture}
                                                    onCancelGesture={cancelAxleGesture}
                                                    onGroupAxles={groupAxles}
                                                    onClassify={classifyWheelRole}
                                                    onCopyFromPartner={copyWheelPartner}
                                                    wheelLink={snapshot.wheelLink}
                                                    onSetWheelLink={setWheelLink}
                                                    onBeginWheel={beginWheelMotion}
                                                    onPreviewWheel={previewWheelMotion}
                                                    onCommitWheel={commitWheelMotion}
                                                    onCancelWheel={cancelWheelMotion}
                                                />
                                            )}
                                            {item === "Body" && <BodyTab draft={draft} update={update} commitPlacement={commitPlacement} selection={selection} setSelection={setSelection} fitBodyToModel={fitBodyToModel} fieldReset={`${selectedId}:${placementRevision}`} />}
                                            {item === "JSON" && (
                                                <div className="space-y-2">
                                                    <textarea aria-label="Raw vehicle manifest JSON" spellCheck={false} value={raw} onChange={(event) => applyRaw(event.target.value)} className="sf-input min-h-[480px] resize-y font-mono text-[12px] leading-relaxed" />
                                                    <p className="text-[11px] leading-relaxed text-[var(--slate-muted)]">Applies on every valid parse. The LiDAR zone arrays are baked data; regenerate them from the LiDAR Zone tab after moving the model.</p>
                                                </div>
                                            )}
                                        </TabsContent>
                                    ))}
                                </fieldset>
                            </div>
                        </TabsRoot>
                    )}
                </div>
                )}
            />
        </main>
        {assignment && (
            <WheelAssignmentDialog
                key={assignment.token}
                open={assignment.open !== false}
                catalog={assignment.catalog}
                measurement={assignment.measurement}
                initialRoles={rolesFromManifest(draft)}
                onOpenChange={(open) => {
                    if (!open) setAssignment((current) => (current ? { ...current, open: false } : null));
                }}
                onAccept={acceptAssignment}
                onSuppress={suppressAssignment}
                onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    assignButtonRef.current?.focus();
                }}
            />
        )}
        <PlacementAcceptanceDialog
            open={Boolean(placementPrompt)}
            review={placementPrompt?.review}
            onAccept={acceptPlacement}
            onReject={rejectPlacement}
        />
        <VehiclePickerDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            vehicles={catalog}
            selectedId={selectedId}
            dirty={dirty}
            busy={busy}
            returnFocusRef={catalogButtonRef}
            onOpenVehicle={(id) => select(id)}
            onCreateBlank={createNew}
            onImportBundle={() => importRef.current?.click()}
            onDuplicate={duplicateEntry}
            onRename={renameEntry}
            onDelete={deleteEntry}
            onChangeId={changeEntryId}
            onExportBundle={exportBundle}
            onExportUrdf={() => exportUrdf()}
        />
        <VehicleUrdfReviewDialog
            open={urdfMode != null}
            mode={urdfMode === "apply" ? "apply" : "create"}
            onOpenChange={(open) => { if (!open) setUrdfMode(null); }}
            busy={busy}
            defaultId={vehicleIdFromName(draft?.name || "urdf-vehicle")}
            defaultName={draft?.name || "URDF vehicle"}
            onCreate={createFromUrdf}
            onApply={applyReviewedUrdf}
            returnFocusRef={urdfButtonRef}
        />
        </AuthoringModeProvider>
    );
}

function ModelTab({ draft, commitPlacement, busy, modelFileRef, uploadModelFile, detachModel, selection, setSelection, modelVisible, setModelVisible, fitTarget, setFitTarget, fitModelToSize, fieldReset = 0 }) {    
    return (
        <div className="space-y-4">
            <Section title="Source model">
                <div className="flex items-center gap-2">
                    <Action compact icon={<FaUpload />} label={draft.model.asset ? "Replace model" : "Import GLB / GLTF"} onClick={() => modelFileRef.current?.click()} disabled={busy} />
                    <input ref={modelFileRef} hidden type="file" accept=".glb,.gltf,.obj,.stl,.mtl,.png,.jpg,.jpeg,.ktx2,model/gltf-binary,model/gltf+json" multiple onChange={uploadModelFile} />
                    {draft.model.asset && (
                        <button type="button" onClick={detachModel} className="text-[11px] text-[var(--slate-danger)]">Detach</button>
                    )}
                </div>
                <p className="mt-2 font-mono text-[11px] text-[var(--slate-muted)]">{draft.model.asset || "No model; a placeholder body is shown."}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--slate-muted)]">Use a self-contained .glb or .gltf.</p>
            </Section>

            <Section title="Placement">
                <div className="mb-2 flex items-center justify-between">
                    <Toggle label="Show model" value={modelVisible} onChange={setModelVisible} />
                    <Action
                        compact
                        icon={<FaArrowsAlt />}
                        label={selection?.kind === "model" ? "Gizmo active" : "Move with gizmo"}
                        onClick={() => setSelection(selection?.kind === "model" ? null : { kind: "model", id: null })}
                        disabled={!draft.model.asset}
                    />
                </div>
                <Field label="Scale">
                    <DragNumber min={0.0001} step={0.0001} precision={4} commitOnBlur value={draft.model.scale} onChange={(next) => commitPlacement({ model: { scale: next } }, { coalesce: true, historyKey: "model-scale" })} aria-label="Scale" />
                </Field>
                <VectorFields label="Rotation (deg)" degrees commitOnBlur value={draft.model.rotation} onChange={(axis, value) => commitPlacement({ model: { rotation: { [axis]: value } } }, { coalesce: true, historyKey: `model-rotation-${axis}` })} resetToken={fieldReset} />
                <VectorFields label="Offset (m)" value={draft.model.offset} onChange={(axis, value) => commitPlacement({ model: { offset: { [axis]: value } } }, { coalesce: true, historyKey: `model-offset-${axis}` })} scrub step={0.0001} resetToken={fieldReset} />
            </Section>

            <Section title="Fit to real size">
                <div className="grid grid-cols-2 gap-2">
                    <Field label="Target length (m, X)">
                        <DragNumber min={0.01} step={0.01} value={fitTarget.length} onChange={(next) => setFitTarget((current) => ({ ...current, length: next }))} aria-label="Target length (m, X)" />
                    </Field>
                    <Field label="Target width (m, Z)">
                        <DragNumber min={0.01} step={0.01} value={fitTarget.width} onChange={(next) => setFitTarget((current) => ({ ...current, width: next }))} aria-label="Target width (m, Z)" />
                    </Field>
                </div>
                <div className="mt-2"><Action compact icon={<FaCube />} label="Rescale model" onClick={fitModelToSize} disabled={!draft.model.asset} /></div>
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--slate-muted)]">(Matches the target length and width, preserving aspect ratio)</p>
            </Section>
        </div>
    );
}

function LidarZoneTab({ draft, update, voxelSize, setVoxelSize, generateZone, zoneVisible, setZoneVisible }) {
    const zone = draft.lidarZone;
    return (
        <div className="space-y-4">
            <Section title="Reduced-polygon collision mesh">
                <p className="text-[11px] leading-relaxed text-[var(--slate-muted)]">LiDAR and other GPU sensors raycast against this simplified mesh instead of the full model. Regenerate it after changing the model placement.</p>
                <div className="mt-3">
                    <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[11px] font-medium text-[var(--slate-fg-2)]">Voxel size</span>
                        <span className="font-mono text-[11px] text-[var(--slate-fg-2)]">{voxelSize.toFixed(2)} m</span>
                    </div>
                    <input aria-label="Voxel size" type="range" min="0.05" max="1" step="0.05" value={voxelSize} onChange={(event) => setVoxelSize(Number(event.target.value))} className="timeline-range w-full" />
                    <p className="mt-1 text-[11px] text-[var(--slate-muted)]">Larger voxels merge more vertices and produce fewer triangles.</p>
                </div>
                <div className="mt-3 flex items-center gap-2">
                    <Action compact primary icon={<FaSyncAlt />} label="Generate" onClick={generateZone} disabled={!draft.model.asset} />
                    {zone.triangles.length > 0 && (
                        <button type="button" onClick={() => update(["lidarZone"], { params: { voxelSize }, vertices: [], triangles: [] })} className="text-[11px] text-[var(--slate-danger)]">Clear</button>
                    )}
                </div>
            </Section>
            <Section title="Baked result">
                <div className="grid grid-cols-2 gap-2">
                    <Stat label="Vertices" value={zone.vertices.length} />
                    <Stat label="Triangles" value={zone.triangles.length} />
                </div>
                <p className="mt-2 font-mono text-[11px] text-[var(--slate-muted)]">Baked at voxel {zone.params.voxelSize} m</p>
                <div className="mt-2"><Toggle label="Show wireframe preview" value={zoneVisible} onChange={setZoneVisible} /></div>
            </Section>
        </div>
    );
}

function SensorsTab({
    draft,
    update,
    selection,
    setSelection,
    catalog = { sensors: [] },
    session = null,
    onError = () => {},
    bumpRegistry = () => {},
}) {
    const [openSensorIds, setOpenSensorIds] = useState([]);
    const selectedSensorId = selection?.kind === "sensor" ? selection.id : null;
    const shownSensorIds = selectedSensorId && !openSensorIds.includes(selectedSensorId)
        ? [...openSensorIds, selectedSensorId]
        : openSensorIds;
    const registry = session?.registry ?? sensorTypeRegistry;
    const catalogEntries = sensorCatalogEntries(catalog, registry);
    const addEntry = async (entry) => {
        try {
            const next = structuredClone(draft);
            if (entry.ownership && entry.ownership !== "builtin") {
                await session.loadLock({
                    pluginId: entry.ownership.pluginId,
                    version: entry.ownership.version,
                    packageHash: entry.ownership.packageHash,
                    runtimeHash: entry.ownership.runtimeHash,
                    sensorTypes: [entry.type],
                });
                bumpRegistry();
                next.pluginLocks = stampVehiclePluginSensorLock(next.pluginLocks, entry);
            }
            const definition = session?.registry.get(entry.type) || getSensorType(entry.type);
            const id = nextId(next.sensors, definition?.idPrefix || "sensor");
            const sensor = createVehicleSensor(entry.type, {
                id,
                pose: { position: { x: 0.3, y: 0.8, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
            }, next.sensors.length, session?.registry ?? registry);
            next.sensors = [...next.sensors, sensor];
            update([], next);
            setSelection({ kind: "sensor", id });
        } catch (caught) {
            onError(caught.message);
        }
    };
    return (
        <div className="space-y-3">
            <SensorTypeAdder entries={catalogEntries} onAdd={addEntry} />
            {draft.sensors.length === 0 && <p className="py-8 text-center text-[11px] text-zinc-600">No sensors on this vehicle.</p>}
            {draft.sensors.map((sensor, index) => {
                const selected = selection?.kind === "sensor" && selection.id === sensor.id;
                const change = (parts, value) => update(["sensors", index, ...parts], value);
                const definition = registry.get(sensor.type) || getSensorType(sensor.type);
                const plugin = definition?.pluginSensor;
                const unresolved = Boolean(plugin && session?.unresolvedLocks?.includes(plugin.ownership?.packageHash));
                const changeType = async (type) => {
                    try {
                        const entry = pluginSensorCatalogEntryForType(catalog, type);
                        const next = structuredClone(draft);
                        if (entry?.ownership && entry.ownership !== "builtin") {
                            await session.loadLock({
                                pluginId: entry.ownership.pluginId,
                                version: entry.ownership.version,
                                packageHash: entry.ownership.packageHash,
                                runtimeHash: entry.ownership.runtimeHash,
                                sensorTypes: [entry.type],
                            });
                            bumpRegistry();
                            next.pluginLocks = stampVehiclePluginSensorLock(next.pluginLocks, entry);
                        }
                        next.sensors[index] = changeVehicleSensorType(sensor, type, session?.registry ?? registry);
                        update([], next);
                    } catch (caught) {
                        onError(caught.message);
                    }
                };
                return (
                    <Disclosure
                        key={sensor.id}
                        className={selected ? "rounded-[var(--radius)] bg-[var(--slate-surface-3)]" : undefined}
                        label={sensor.id}
                        detail={definition?.label || sensor.type}
                        open={shownSensorIds.includes(sensor.id)}
                        onOpenChange={(open) => {
                            setOpenSensorIds((current) => (
                                open ? [...current.filter((id) => id !== sensor.id), sensor.id] : current.filter((id) => id !== sensor.id)
                            ));
                            if (open) setSelection({ kind: "sensor", id: sensor.id });
                        }}
                    >
                        <div className="grid grid-cols-2 gap-2">
                            <Field label="Stable ID">
                                <input
                                    value={sensor.id}
                                    onChange={(event) => {
                                        const nextId = event.target.value;
                                        change(["id"], nextId);
                                        if (selected) setSelection({ kind: "sensor", id: nextId });
                                    }}
                                />
                            </Field>
                            <Field label="Type">
                                <select value={sensor.type} onChange={(event) => changeType(event.target.value)}>
                                    {catalogEntries.map((entry) => (
                                        <option key={`${entry.type}:${entry.ownership?.packageHash || "builtin"}`} value={entry.type}>
                                            {entry.label || entry.type}
                                        </option>
                                    ))}
                                    {!definition && <option value={sensor.type}>{sensor.type} (unsupported)</option>}
                                </select>
                            </Field>
                        </div>
                        <VectorFields label="Position (m)" value={sensor.pose.position} onChange={(axis, value) => change(["pose", "position", axis], value)} scrub />
                        <div className="mt-3 grid grid-cols-2 gap-2">
                            {definition?.vehicle.fields.filter((field) => !field.advanced).map((field) => (
                                <VehicleSensorDefinitionField key={field.path.join(".")} field={field} sensor={sensor} change={change} />
                            ))}
                        </div>
                        <AdvancedFields label="Sensor orientation and calibration">
                            <VectorFields label="Rotation (deg)" degrees value={sensor.pose.rotation} onChange={(axis, value) => change(["pose", "rotation", axis], value)} />
                            <div className="mt-3 grid grid-cols-2 gap-2">
                                {definition?.vehicle.fields.filter((field) => field.advanced).map((field) => (
                                    <VehicleSensorDefinitionField key={field.path.join(".")} field={field} sensor={sensor} change={change} />
                                ))}
                            </div>
                        </AdvancedFields>
                        {plugin && (
                            <PluginSensorAuthoringPanel
                                context={{ kind: "vehicle" }}
                                sensor={sensor}
                                definition={definition}
                                diagnostic={session?.diagnosticFor(sensor.type)}
                                Component={session?.sensorViewFor(sensor.type)}
                                unresolved={unresolved}
                                sensorRegistry={registry}
                                onCommit={(next) => update(["sensors", index], next)}
                            />
                        )}
                        {!definition && <p className="mt-3 text-[11px] text-[var(--slate-warning)]">This sensor type is not registered. Its data is preserved, but this vehicle cannot run until a supported type is selected.</p>}
                        <button type="button" onClick={() => update(["sensors"], draft.sensors.filter((_, candidate) => candidate !== index))} className="mt-3 text-[11px] text-[var(--slate-danger)]">Remove sensor</button>
                    </Disclosure>
                );
            })}
        </div>
    );
}

function VehicleSensorDefinitionField({ field, sensor, change }) {
    const { advanced } = useAuthoringMode();
    if (field.advanced && !advanced) return null;
    const value = getSensorFieldValue(sensor, field.path);
    return (
        <Field label={field.label}>
            <input
                type={field.control === "number" ? "number" : "text"}
                min={field.min}
                max={field.max}
                step={field.step}
                value={value ?? ""}
                disabled={field.readOnly}
                onChange={(event) => change(field.path, field.control === "number" ? Number(event.target.value) : event.target.value)}
            />
        </Field>
    );
}

function WheelsTab({
    draft,
    update,
    selection,
    setSelection,
    derivedWheelbase,
    plantCatalog = [],
    onError = () => {},
    assignButtonRef,
    assignmentReady = false,
    onAssign,
    onDetach,
    readOnly = false,
    steeringPreview = 0,
    onSteeringPreview,
    onBeginGesture,
    onPreviewGesture,
    onCommitGesture,
    onCancelGesture,
    onGroupAxles,
    onClassify,
    onCopyFromPartner,
    wheelLink = null,
    onSetWheelLink,
    onBeginWheel,
    onPreviewWheel,
    onCommitWheel,
    onCancelWheel,
}) {
    const [wheelsOpen, setWheelsOpen] = useState(() => readVehicleEditorPreference(VEHICLE_EDITOR_PREFERENCE_KEYS.WHEELS_PANEL, null)?.open === true);
    const [openRows, setOpenRows] = useState(() => {
        const stored = readVehicleEditorPreference(VEHICLE_EDITOR_PREFERENCE_KEYS.WHEELS_PANEL, null);
        return Array.isArray(stored?.rows) ? stored.rows : [];
    });
    useEffect(() => {
        writeVehicleEditorPreference(VEHICLE_EDITOR_PREFERENCE_KEYS.WHEELS_PANEL, { open: wheelsOpen, rows: openRows });
    }, [wheelsOpen, openRows]);
    const pairComplete = (axle) => {
        const members = draft.wheels.filter((wheel) => wheel.axle === axle);
        return members.length === 2
            && members.some((wheel) => wheel.side === "left")
            && members.some((wheel) => wheel.side === "right");
    };
    let selectedRowId = null;
    if (selection?.kind === "axle" && pairComplete(selection.id)) selectedRowId = `axle-${selection.id}`;
    if (selection?.kind === "wheel" && selection.id) {
        const wheel = draft.wheels.find((entry) => entry.id === selection.id);
        if (wheel) selectedRowId = pairComplete(wheel.axle) ? `axle-${wheel.axle}` : `wheel-${wheel.id}`;
    }
    const shownWheelsOpen = wheelsOpen || Boolean(selectedRowId);
    const shownRows = selectedRowId && !openRows.includes(selectedRowId) ? [...openRows, selectedRowId] : openRows;
    useEffect(() => {
        if (!selectedRowId) return undefined;
        let cancelled = false;
        const handle = requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (!cancelled) document.querySelector(`[data-wheel-row="${selectedRowId}"]`)?.scrollIntoView({ block: "nearest" });
            });
        });
        return () => {
            cancelled = true;
            cancelAnimationFrame(handle);
        };
    }, [selectedRowId]);
    const selectDynamics = (value) => {
        const next = structuredClone(draft);
        try {
        if (!value) {
            const currentPlant = draft.dynamics?.plant;
            delete next.dynamics;
            next.pluginLocks = (next.pluginLocks ?? []).flatMap((lock) => {
                const plants = (lock.plants ?? []).filter((plantId) => plantId !== currentPlant);
                const record = { ...lock };
                if (plants.length > 0) record.plants = plants;
                else delete record.plants;
                if ((record.sensorTypes?.length ?? 0) === 0 && plants.length === 0) return [];
                return [record];
            });
            if (next.pluginLocks.length === 0) delete next.pluginLocks;
        } else {
            const entry = plantCatalog.find((plant) => `${plant.packageHash}:${plant.id}` === value);
            if (!entry) return;
            next.dynamics = { plant: entry.id };
            next.pluginLocks = stampVehiclePluginPlantLock(next.pluginLocks, entry);
        }
            update([], next);
        } catch (caught) {
            onError(caught.message);
        }
    };
    const dynamicsValue = draft.dynamics?.plant
        ? (plantCatalog.find((plant) => plant.id === draft.dynamics.plant)?.packageHash
            ? `${plantCatalog.find((plant) => plant.id === draft.dynamics.plant).packageHash}:${draft.dynamics.plant}`
            : "")
        : "";
    const add = (mirrored) => {
        const count = draft.wheels.length;
        const base = {
            position: { x: round3(0.75 - count * 0.2), y: 0.25, z: round3(0.55 + (count % 4) * 0.08) },
            radius: 0.25,
            width: 0.15,
            steerable: false,
        };
        const added = mirrored
            ? [
                { ...base, id: nextId(draft.wheels, "wheel"), position: { ...base.position } },
                { ...base, id: nextId(draft.wheels, "wheel", 2), position: { ...base.position, z: -base.position.z } },
            ]
            : [{ ...base, id: nextId(draft.wheels, "wheel") }];
        update(["wheels"], [...draft.wheels, ...added]);
        setSelection({ kind: "wheel", id: added[0].id });
        if (mirrored) onSetWheelLink?.({ ids: [added[0].id, added[1].id], mode: "mirror" });
    };
    const axles = draft.version === 3 ? standardAxleCards(draft.wheels) : [];
    const listedWheels = draft.wheels.map((wheel, index) => ({ wheel, index }));
    const completeWheelbase = draft.version === 3 ? deriveCompleteWheelbase(draft.wheels) : null;
    const groupable = ["front", "rear"].filter((axle) => {
        const left = draft.wheels.find((wheel) => wheel.id === `${axle}-left` && !wheel.axle);
        const right = draft.wheels.find((wheel) => wheel.id === `${axle}-right` && !wheel.axle);
        return Boolean(left && right);
    });
    const wheelSummary = (wheel) => {
        const tags = [wheel.steerable ? "steers" : "fixed"];
        if (!wheel.axle) tags.unshift("unclassified");
        if (wheel.visual?.kind === "model-node") tags.push("bound");
        return `r ${Number(wheel.radius).toFixed(2)} · ${tags.join(" · ")}`;
    };
    return (
        <div className="space-y-3" data-vehicle-wheels>
            <VehiclePlanView
                draft={draft}
                steeringPreview={steeringPreview}
                onSteeringPreview={onSteeringPreview}
                readOnly={readOnly}
                onBeginGesture={onBeginGesture}
                onPreviewGesture={onPreviewGesture}
                onCommitGesture={onCommitGesture}
                onCancelGesture={onCancelGesture}
            />
            {groupable.length > 0 && !readOnly && (
                <p className="text-[11px] leading-relaxed text-[var(--slate-muted)]">
                    Wheels are not grouped into axles.{" "}
                    <button type="button" className="text-[var(--slate-fg-2)]" onClick={onGroupAxles}>Group as standard axles</button>
                </p>
            )}
            <div className="flex flex-wrap gap-1.5">
                <Action compact icon={<FaPlus />} label="Add wheel" onClick={() => add(false)} />
                <Action compact icon={<FaPlus />} label="Add mirrored pair" onClick={() => add(true)} />
                <Button
                    ref={assignButtonRef}
                    size="compact"
                    disabled={!assignmentReady}
                    tooltip={assignmentReady ? undefined : "Needs a version 3 vehicle and a canonical model."}
                    onClick={onAssign}
                >
                    Assign wheels
                </Button>
            </div>
            {selection?.kind === "wheel" && (
                <WheelLinkControls
                    draft={draft}
                    wheelId={selection.id}
                    wheelLink={wheelLink}
                    onSetWheelLink={onSetWheelLink}
                />
            )}
            <Disclosure
                label="Wheels and axles"
                detail={`${draft.wheels.length} ${draft.wheels.length === 1 ? "wheel" : "wheels"}${axles.length ? ` · ${axles.length} ${axles.length === 1 ? "axle" : "axles"}` : ""}`}
                open={shownWheelsOpen}
                onOpenChange={setWheelsOpen}
            >
                <AccordionRoot value={shownRows} onValueChange={setOpenRows}>
                    {axles.map((axle) => {
                        const summary = axleSummary(axle);
                        return (
                            <AccordionItem key={axle.id} value={`axle-${axle.id}`} label={summary.title} detail={summary.detail}>
                                <AxleFields
                                    axle={axle}
                                    onBeginGesture={onBeginGesture}
                                    onPreviewGesture={onPreviewGesture}
                                    onCommitGesture={onCommitGesture}
                                    onCancelGesture={onCancelGesture}
                                    onDetach={onDetach}
                                />
                            </AccordionItem>
                        );
                    })}
                    {listedWheels.map(({ wheel, index }) => (
                        <AccordionItem key={wheel.id} value={`wheel-${wheel.id}`} label={wheel.id} detail={wheelSummary(wheel)}>
                            <WheelCard
                                draft={draft}
                                wheel={wheel}
                                index={index}
                                wheelLink={wheelLink}
                                selected={selection?.kind === "wheel" && selection.id === wheel.id}
                                update={update}
                                setSelection={setSelection}
                                onDetach={onDetach}
                                onClassify={onClassify}
                                onCopyFromPartner={onCopyFromPartner}
                                onBeginWheel={onBeginWheel}
                                onPreviewWheel={onPreviewWheel}
                                onCommitWheel={onCommitWheel}
                                onCancelWheel={onCancelWheel}
                            />
                        </AccordionItem>
                    ))}
                </AccordionRoot>
            </Disclosure>
            <Section title="Dynamics">
                <Field label="Plant">
                    <select aria-label="Dynamics" value={dynamicsValue} onChange={(event) => selectDynamics(event.target.value)}>
                        <option value="">Built-in bicycle</option>
                        {plantCatalog.map((plant) => (
                            <option key={`${plant.packageHash}:${plant.id}`} value={`${plant.packageHash}:${plant.id}`}>{plant.id}</option>
                        ))}
                    </select>
                </Field>
                {draft.dynamics?.plant ? <p className="mt-2 text-[11px] text-[var(--slate-muted)]">Plugin dynamics run only in a resolved run.</p> : null}
            </Section>
            <Section title="Drive and steering">
                <div className="grid grid-cols-2 gap-2">
                    {completeWheelbase != null ? (
                        <Field label="Wheelbase (m)">
                            <input readOnly aria-label="Wheelbase (m)" value={draft.kinematics.wheelbase} />
                        </Field>
                    ) : (
                        <LimitNumber label="Wheelbase (m)" min={0.01} step={0.01} value={draft.kinematics.wheelbase} onChange={(next) => update(["kinematics", "wheelbase"], next)} />
                    )}
                    <LimitNumber label="Max steering (deg)" min={0.5} step={0.5} precision={2} value={radToDeg(draft.kinematics.maxSteeringAngle)} onChange={(degrees) => update(["kinematics", "maxSteeringAngle"], degToRad(degrees))} />
                    <LimitNumber label="Max speed (m/s)" min={0.01} step={0.1} value={draft.kinematics.maxSpeed ?? 15} onChange={(next) => update(["kinematics", "maxSpeed"], next)} />
                    <LimitNumber label="Max steer rate (rad/s)" min={0.01} step={0.1} value={draft.kinematics.maxSteeringRate ?? 1.2} onChange={(next) => update(["kinematics", "maxSteeringRate"], next)} />
                </div>
                {completeWheelbase != null && (
                    <p className="mt-2 text-[11px] text-[var(--slate-muted)]">Derived from the standard axles.</p>
                )}
                {completeWheelbase == null && derivedWheelbase !== null && (
                    <div className="mt-2 flex items-center justify-between">
                        <p className="text-[11px] text-[var(--slate-muted)]">Derived from wheel placement: <span className="font-mono text-[var(--slate-fg-2)]">{derivedWheelbase.toFixed(3)} m</span></p>
                        <button type="button" onClick={() => update(["kinematics", "wheelbase"], round3(derivedWheelbase))} className="text-[11px] text-[var(--slate-fg-2)]">Use derived</button>
                    </div>
                )}
            </Section>
            <AdvancedFields label="Acceleration, jerk, and delay">
                <div className="grid grid-cols-2 gap-2">
                    <LimitNumber label="Max accel (m/s²)" min={0.01} step={0.1} value={draft.kinematics.maxAcceleration ?? 3} onChange={(next) => update(["kinematics", "maxAcceleration"], next)} />
                    <LimitNumber label="Max decel (m/s²)" min={0.01} step={0.1} value={draft.kinematics.maxDeceleration ?? 5} onChange={(next) => update(["kinematics", "maxDeceleration"], next)} />
                    <LimitNumber label="Max jerk (m/s³)" min={0.01} step={0.1} value={draft.kinematics.maxJerk ?? 10} onChange={(next) => update(["kinematics", "maxJerk"], next)} />
                    <LimitNumber label="Response delay (ns)" min={0} step={1000000} precision={0} value={draft.kinematics.responseDelayNs ?? 0} onChange={(next) => update(["kinematics", "responseDelayNs"], next)} />
                </div>
            </AdvancedFields>
        </div>
    );
}

function WheelLinkControls({ draft, wheelId, wheelLink, onSetWheelLink }) {
    const wheel = draft.wheels.find((entry) => entry.id === wheelId);
    if (!wheel) return null;
    const partner = standardPartner(draft.wheels, wheel.id);
    if (partner) {
        const locked = isBoundWheel(wheel) || isBoundWheel(partner);
        return (
            <p data-wheel-link className="text-[11px] leading-relaxed text-[var(--slate-muted)]">
                {`Mirrored with ${partner.id}.`}
                {locked ? " Detach the model-bound wheels before moving them." : ""}
            </p>
        );
    }
    if (isBoundWheel(wheel) || wheel.axle || wheel.side) return null;
    const candidates = draft.wheels.filter((entry) => entry.id !== wheel.id && !isBoundWheel(entry) && !entry.axle && !entry.side);
    const active = wheelLink?.ids?.includes(wheel.id) ? wheelLink : null;
    const partnerId = active?.ids.find((id) => id !== wheel.id) ?? "";
    const choose = (nextId) => {
        if (!nextId) {
            onSetWheelLink?.(null);
            return;
        }
        onSetWheelLink?.({ ids: [wheel.id, nextId], mode: active?.mode ?? "mirror" });
    };
    return (
        <div data-wheel-link className="space-y-2">
            <Field label="Link with">
                <select aria-label="Link with" value={partnerId} onChange={(event) => choose(event.target.value)}>
                    <option value="">Choose a wheel</option>
                    {candidates.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}</option>)}
                </select>
            </Field>
            {active && (
                <>
                    <SegmentedControl
                        label="Wheel link motion"
                        value={active.mode}
                        onValueChange={(mode) => onSetWheelLink?.({ ids: [...active.ids], mode })}
                        items={[
                            { value: "together", label: "Together" },
                            { value: "mirror", label: "Mirror" },
                        ]}
                    />
                    <button type="button" onClick={() => onSetWheelLink?.(null)} className="text-[11px] text-[var(--slate-fg-2)]">Unlink</button>
                </>
            )}
        </div>
    );
}

function WheelCard({
    draft,
    wheel,
    index,
    wheelLink = null,
    selected,
    update,
    setSelection,
    onDetach,
    onClassify,
    onCopyFromPartner,
    onBeginWheel,
    onPreviewWheel,
    onCommitWheel,
    onCancelWheel,
}) {
    const bound = wheel.visual?.kind === "model-node";
    const linked = Boolean(resolveMotionLink(draft.wheels, wheel.id, wheelLink));
    const change = (parts, value) => update(["wheels", index, ...parts], value);
    const role = wheel.axle && wheel.side ? `${wheel.axle}:${wheel.side}` : "";
    const mirrorSource = wheelPartner(draft.wheels, wheel, "mirror");
    const alignSource = wheelPartner(draft.wheels, wheel, "align");
    return (
        <div className={selected ? "rounded-[var(--radius)] bg-[var(--slate-surface-3)] p-1" : "p-1"}>
            <div className="grid grid-cols-2 gap-2">
                <Field label="Stable ID">
                    <input
                        value={wheel.id}
                        onChange={(event) => {
                            const nextWheelId = event.target.value;
                            change(["id"], nextWheelId);
                            if (selected) setSelection({ kind: "wheel", id: nextWheelId });
                        }}
                    />
                </Field>
                <Field label="Axle role">
                    <select aria-label={`${wheel.id} axle role`} value={role} disabled={bound} onChange={(event) => onClassify?.(wheel.id, event.target.value)}>
                        {WHEEL_ROLES.map((entry) => <option key={entry.value || "none"} value={entry.value}>{entry.label}</option>)}
                    </select>
                </Field>
                <Toggle label="Steerable" value={wheel.steerable} disabled={bound} onChange={(value) => change(["steerable"], value)} />
                <Field label="Radius (m)">
                    <DragNumber aria-label={`${wheel.id} radius (m)`} min={0.01} step={0.01} value={wheel.radius} disabled={bound} onChange={(next) => change(["radius"], next)} />
                </Field>
                <Field label="Width (m)">
                    <DragNumber aria-label={`${wheel.id} width (m)`} min={0.01} step={0.01} value={wheel.width} disabled={bound} onChange={(next) => change(["width"], next)} />
                </Field>
            </div>
            {bound && <p className="mt-2 text-[11px] text-[var(--slate-muted)]">Bound to model node {wheel.visual.nodeIndex}. Detach it before editing this geometry.</p>}
            {role && !mirrorSource && <p className="mt-2 text-[11px] text-[var(--slate-muted)]">Assign the other side to complete this axle.</p>}
            <VectorFields
                label="Position (m)"
                value={wheel.position}
                disabled={bound}
                onChange={(axis, value) => {
                    if (!linked) {
                        change(["position", axis], value);
                        return;
                    }
                    onPreviewWheel?.(wheel.id, { ...wheel.position, [axis]: value });
                }}
                onGestureStart={linked ? () => onBeginWheel?.(wheel.id) : undefined}
                onGestureEnd={linked ? () => onCommitWheel?.() : undefined}
                onGestureCancel={linked ? () => onCancelWheel?.() : undefined}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-3">
                    {bound && <button type="button" onClick={() => onDetach(wheel.id)} className="text-[11px] text-[var(--slate-fg-2)]">Detach</button>}
                    {mirrorSource && (
                        <button type="button" disabled={bound} onClick={() => onCopyFromPartner?.(wheel.id, "mirror")} className="text-[11px] text-[var(--slate-fg-2)] disabled:opacity-40">Mirror complementary</button>
                    )}
                    {alignSource && (
                        <button type="button" disabled={bound} onClick={() => onCopyFromPartner?.(wheel.id, "align")} className="text-[11px] text-[var(--slate-fg-2)] disabled:opacity-40">
                            {alignSource.axle === "front" ? "Align with front" : "Align with rear"}
                        </button>
                    )}
                </div>
                {!bound && <button type="button" onClick={() => update(["wheels"], draft.wheels.filter((_, candidate) => candidate !== index))} className="text-[11px] text-[var(--slate-danger)]">Remove</button>}
            </div>
        </div>
    );
}

function BodyTab({ draft, update, commitPlacement, selection, setSelection, fitBodyToModel, fieldReset = 0 }) {
    const bodySelected = selection?.kind === "body";
    const egoSelected = selection?.kind === "ego";
    return (
        <div className="space-y-4">
            <Section title="Bounding box">
                <p className="text-[11px] leading-relaxed text-[var(--slate-muted)]">Drives the physics AABB. The translucent box in the viewport previews it.</p>
                <div className="mt-2 flex items-center gap-2">
                    <Action compact icon={<FaArrowsAlt />} label={bodySelected ? "Gizmo active" : "Move center with gizmo"} onClick={() => setSelection(bodySelected ? null : { kind: "body", id: null })} />
                    <Action compact icon={<FaCube />} label="Fit to model" onClick={fitBodyToModel} disabled={!draft.model.asset} />
                </div>
                <VectorFields label="Size (m)" value={draft.boundingBox.size} onChange={(axis, value) => commitPlacement({ boundingBox: { size: { [axis]: value } } }, { coalesce: true, historyKey: `body-size-${axis}` })} scrub min={0.01} resetToken={fieldReset} />
                <VectorFields label="Center (m)" value={draft.boundingBox.center} onChange={(axis, value) => commitPlacement({ boundingBox: { center: { [axis]: value } } }, { coalesce: true, historyKey: `body-center-${axis}` })} scrub resetToken={fieldReset} />
            </Section>
            <Section title="Ego center">
                <p className="text-[11px] leading-relaxed text-[var(--slate-muted)]">The reference point cameras follow and tooling focuses on, marked by the green axes.</p>
                <div className="mt-2">
                    <Action compact icon={<FaArrowsAlt />} label={egoSelected ? "Gizmo active" : "Move with gizmo"} onClick={() => setSelection(egoSelected ? null : { kind: "ego", id: null })} />
                </div>
                <VectorFields label="Position (m)" value={draft.egoCenter} onChange={(axis, value) => update(["egoCenter", axis], value)} scrub resetToken={fieldReset} />
            </Section>
        </div>
    );
}

function nextId(entries, prefix, offset = 1) {
    const used = new Set(entries.map((entry) => entry.id));
    let index = entries.length + offset;
    while (used.has(`${prefix}-${index}`)) index += 1;
    return `${prefix}-${index}`;
}

function CenterState({ title, detail, action = null, error = false }) {
    return <div className="grid h-full place-items-center p-6"><div><AsyncState status={error ? "error" : action ? "empty" : "loading"} title={title} detail={detail} />{action && <div className="mt-4 flex justify-center">{action}</div>}</div></div>;
}

function Section({ title, children }) {
    return <section className="border-t border-[var(--slate-border)] pt-3 first:border-t-0 first:pt-0"><h3 className="mb-3 text-[13px] font-semibold text-[var(--slate-fg-2)]">{title}</h3>{children}</section>;
}

function Stat({ label, value }) {
    return <div className="border-l border-[var(--slate-border)] px-3 py-2 first:border-l-0"><p className="text-[11px] text-[var(--slate-muted)]">{label}</p><p className="mt-0.5 font-mono text-sm font-semibold text-[var(--slate-fg)]">{value.toLocaleString()}</p></div>;
}

function stepPrecision(step) {
    const text = String(step);
    const index = text.indexOf(".");
    const places = index < 0 ? 0 : text.length - index - 1;
    return Math.max(3, places);
}

function VectorFields({
    label,
    value,
    onChange,
    min,
    step = 0.01,
    resetToken = 0,
    degrees = false,
    commitOnBlur = false,
    disabled = false,
    onGestureStart,
    onGestureEnd,
    onGestureCancel,
}) {
    const shown = (axis) => {
        const raw = value?.[axis] ?? 0;
        return degrees ? radToDeg(raw) : raw;
    };
    const emit = (axis, next) => onChange(axis, degrees ? degToRad(next) : next);
    const displayStep = degrees ? 0.1 : step;
    return (
        <div className="mt-3">
            <p className="mb-1.5 text-[13px] font-medium text-[var(--slate-fg-2)]">{label}</p>
            <div className="grid grid-cols-3 gap-2">
                {["x", "y", "z"].map((axis) => (
                    <Field key={axis} label={axis.toUpperCase()}>
                        <DragNumber
                            key={resetToken}
                            value={shown(axis)}
                            onChange={(next) => emit(axis, next)}
                            onGestureStart={onGestureStart}
                            onGestureEnd={onGestureEnd}
                            onGestureCancel={onGestureCancel}
                            min={min}
                            step={displayStep}
                            precision={degrees ? 2 : stepPrecision(step)}
                            commitOnBlur={commitOnBlur}
                            disabled={disabled}
                            aria-label={`${label} ${axis.toUpperCase()}`}
                        />
                    </Field>
                ))}
            </div>
        </div>
    );
}

function Field({ label, children }) {
    const control = isValidElement(children)
        ? cloneElement(children, { className: [children.props.className, "sf-input"].filter(Boolean).join(" ") })
        : children;
    return <SharedField label={label}>{control}</SharedField>;
}

function Toggle({ label, value, onChange, disabled = false }) {
    return <SharedSwitch label={label} checked={value} disabled={disabled} onCheckedChange={onChange} />;
}

function LimitNumber({ label, value, min, step, precision = 3, onChange }) {
    return (
        <Field label={label}>
            <DragNumber aria-label={label} commitOnBlur min={min} step={step} precision={precision} value={value} onChange={onChange} />
        </Field>
    );
}

function selectionLabel(selection) {
    if (!selection?.kind) return "";
    if (selection.kind === "wheel") return `Wheel ${selection.id}`;
    if (selection.kind === "sensor") return `Sensor ${selection.id}`;
    if (selection.kind === "axle") {
        if (selection.id === "rear") return "Rear axle";
        if (selection.id === "front") return "Front axle";
        return "Wheels";
    }
    if (selection.kind === "body") return "Body";
    if (selection.kind === "ego") return "Ego center";
    if (selection.kind === "model") return "Model";
    return selection.kind;
}

function EditorNotices({ error, rawError, validation, urdfReport, dismissed, onDismiss, onDismissUrdf }) {
    const issueText = validation?.issues?.length
        ? validation.issues.map((issue) => `${issue.path || "manifest"}: ${issue.message}`).join("\n")
        : "";
    const errorText = error || rawError || (!validation?.ok ? issueText : "");
    return (
        <>
            {errorText && dismissed.error !== errorText && (
                <div className="m-3 flex items-start gap-2">
                    <StatusMessage className="min-w-0 flex-1" tone="danger" title="Vehicle needs attention">
                        <pre className="whitespace-pre-wrap font-sans">{errorText}</pre>
                    </StatusMessage>
                    <button type="button" className="text-[11px] text-[var(--slate-muted)]" onClick={() => onDismiss("error", errorText)}>Dismiss</button>
                </div>
            )}
            {validation?.ok && dismissed.validation !== validation && (
                <div className="m-3 flex items-start gap-2">
                    <StatusMessage className="min-w-0 flex-1" tone="success" title="Vehicle manifest is valid." />
                    <button type="button" className="text-[11px] text-[var(--slate-muted)]" onClick={() => onDismiss("validation", validation)}>Dismiss</button>
                </div>
            )}
            {urdfReport && (
                <div className="m-3 flex items-start gap-2">
                    <StatusMessage className="min-w-0 flex-1" title="URDF export">
                        <pre className="whitespace-pre-wrap font-sans">{(urdfReport.omissions ?? []).map((entry) => entry.message || entry.code).join("\n") || "No omissions."}</pre>
                    </StatusMessage>
                    <button type="button" className="text-[11px] text-[var(--slate-muted)]" onClick={onDismissUrdf}>Dismiss</button>
                </div>
            )}
        </>
    );
}

function Action({ icon, label, onClick, disabled = false, primary = false, compact = false }) {
    return <Button disabled={disabled} size={compact ? "compact" : "default"} variant={primary ? "primary" : "default"} onClick={() => Promise.resolve(onClick?.()).catch(() => {})}>{icon}{label}</Button>;
}
