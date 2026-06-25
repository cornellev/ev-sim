import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { FaCube, FaEyeSlash, FaTimes, FaUndo } from "react-icons/fa";
import { MenuButton } from "./ui/MenuButton";
import { cn } from "./ui/cn";

const HIGHLIGHT_COLOR = 0x38bdf8;
const HIGHLIGHT_EMISSIVE = new THREE.Color(HIGHLIGHT_COLOR);
const MATERIAL_SNAPSHOTS = new WeakMap();
const POPOUT_WIDTH = 304;
const POPOUT_HEIGHT = 214;
const POPOUT_GAP = 14;
const POPOUT_MARGIN = 12;
const BUILDING_CONTROL_LOCK = "building-inspector";

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function getPointerPanelPosition(event) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const panelWidth = Math.min(POPOUT_WIDTH, Math.max(220, viewportWidth - POPOUT_MARGIN * 2));
    const panelHeight = Math.min(POPOUT_HEIGHT, Math.max(180, viewportHeight - POPOUT_MARGIN * 2));
    const maxX = Math.max(POPOUT_MARGIN, viewportWidth - panelWidth - POPOUT_MARGIN);
    const maxY = Math.max(POPOUT_MARGIN, viewportHeight - panelHeight - POPOUT_MARGIN);
    const opensLeft = event.clientX + POPOUT_GAP + panelWidth > viewportWidth - POPOUT_MARGIN;
    const x = opensLeft
        ? clamp(event.clientX - panelWidth - POPOUT_GAP, POPOUT_MARGIN, maxX)
        : clamp(event.clientX + POPOUT_GAP, POPOUT_MARGIN, maxX);
    const y = clamp(
        event.clientY - panelHeight * 0.5,
        POPOUT_MARGIN,
        maxY,
    );

    return {
        x,
        y,
        origin: opensLeft ? "center right" : "center left",
    };
}

function isOverlayClick(event) {
    return event.target instanceof Element && Boolean(event.target.closest("#overlay"));
}

function isVisibleInScene(object) {
    let current = object;

    while (current) {
        if (current.visible === false) return false;
        current = current.parent;
    }

    return true;
}

function getBuildingTarget(object, hiddenBuildingIds) {
    let current = object;

    while (current) {
        if (current.userData?.skipBuildingSelection) return null;

        const buildingId = current.userData?.buildingId;
        if (buildingId && !hiddenBuildingIds.has(buildingId) && isVisibleInScene(current)) {
            return {
                id: buildingId,
                object: current,
            };
        }

        current = current.parent;
    }

    return null;
}

function collectBuildingMeshes(scene, buildingId) {
    const meshes = [];

    scene?.traverse?.((object) => {
        if (object.isMesh && object.userData?.buildingId === buildingId) {
            meshes.push(object);
        }
    });

    return meshes;
}

function forEachMaterial(object, callback) {
    object?.traverse?.((child) => {
        if (!child.isMesh || !child.material) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => {
            if (material) callback(material);
        });
    });
}

function applyMaterialHighlight(object) {
    forEachMaterial(object, (material) => {
        if (!material.emissive || typeof material.emissiveIntensity !== "number") return;

        if (!MATERIAL_SNAPSHOTS.has(material)) {
            MATERIAL_SNAPSHOTS.set(material, {
                emissive: material.emissive.clone(),
                emissiveIntensity: material.emissiveIntensity,
            });
        }

        material.emissive.copy(HIGHLIGHT_EMISSIVE);
        material.emissiveIntensity = Math.max(material.emissiveIntensity, 0.38);
        material.needsUpdate = true;
    });
}

function resetMaterialHighlight(object) {
    forEachMaterial(object, (material) => {
        const snapshot = MATERIAL_SNAPSHOTS.get(material);
        if (!snapshot || !material.emissive) return;

        material.emissive.copy(snapshot.emissive);
        material.emissiveIntensity = snapshot.emissiveIntensity;
        material.needsUpdate = true;
    });
}

function formatNumber(value) {
    if (!Number.isFinite(value)) return "0.0";
    return value.toFixed(1);
}

function getBuildingMetrics(object) {
    const box = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    box.getSize(size);

    return {
        height: formatNumber(size.y),
        width: formatNumber(size.x),
        depth: formatNumber(size.z),
    };
}

function shortBuildingId(buildingId) {
    if (!buildingId) return "Unknown";
    if (buildingId.length <= 14) return buildingId;
    return `${buildingId.slice(0, 9)}...${buildingId.slice(-4)}`;
}

function stopEvent(event) {
    event.stopPropagation();
}

export function BuildingInspector({ data }) {
    const [selectedBuilding, setSelectedBuilding] = useState(null);
    const [hiddenBuildingIds, setHiddenBuildingIds] = useState(() => new Set());
    const hiddenBuildingIdsRef = useRef(hiddenBuildingIds);
    const helperRef = useRef(null);

    const three = data?.three?.();
    const scene = three?.scene;
    const camera = three?.camera;
    const renderer = three?.renderer;

    const controls = useMemo(() => {
        const settings = data?.settings?.();

        return {
            disable: () => settings?.disableControls?.(BUILDING_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(BUILDING_CONTROL_LOCK),
        };
    }, [data]);

    useEffect(() => {
        hiddenBuildingIdsRef.current = hiddenBuildingIds;
    }, [hiddenBuildingIds]);

    useEffect(() => {
        if (!data?.mouse?.() || !scene || !camera || !renderer?.domElement) return undefined;

        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();

        return data.mouse().registerClick((event) => {
            if (isOverlayClick(event)) return;

            const rect = renderer.domElement.getBoundingClientRect();
            const inCanvas =
                event.clientX >= rect.left
                && event.clientX <= rect.right
                && event.clientY >= rect.top
                && event.clientY <= rect.bottom;

            if (!inCanvas) return;

            pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            raycaster.setFromCamera(pointer, camera);
            const intersects = raycaster.intersectObjects(scene.children, true);

            for (const hit of intersects) {
                const target = getBuildingTarget(hit.object, hiddenBuildingIdsRef.current);
                if (!target) continue;

                setSelectedBuilding({
                    id: target.id,
                    object: target.object,
                    panel: getPointerPanelPosition(event),
                    metrics: getBuildingMetrics(target.object),
                });
                data.simulation?.()?.render?.();
                return;
            }

            setSelectedBuilding(null);
            data.simulation?.()?.render?.();
        });
    }, [camera, data, renderer, scene]);

    useEffect(() => {
        if (!scene || !selectedBuilding?.object) return undefined;

        applyMaterialHighlight(selectedBuilding.object);

        const helper = new THREE.BoxHelper(selectedBuilding.object, HIGHLIGHT_COLOR);
        helper.name = `BuildingSelection:${selectedBuilding.id}`;
        helper.renderOrder = 999;
        helper.userData.skipBuildingSelection = true;

        if (helper.material) {
            helper.material.depthTest = false;
            helper.material.transparent = true;
            helper.material.opacity = 0.95;
        }

        scene.add(helper);
        helperRef.current = helper;
        data?.simulation?.()?.render?.();

        return () => {
            resetMaterialHighlight(selectedBuilding.object);

            if (helper.parent) {
                helper.parent.remove(helper);
            }

            helper.geometry?.dispose?.();
            helper.material?.dispose?.();

            if (helperRef.current === helper) {
                helperRef.current = null;
            }

            data?.simulation?.()?.render?.();
        };
    }, [data, scene, selectedBuilding]);

    const hiddenCount = hiddenBuildingIds.size;

    const hideSelectedBuilding = () => {
        if (!scene || !selectedBuilding) return;

        resetMaterialHighlight(selectedBuilding.object);
        helperRef.current?.parent?.remove?.(helperRef.current);

        const meshes = collectBuildingMeshes(scene, selectedBuilding.id);
        meshes.forEach((mesh) => {
            mesh.visible = false;
        });

        data?.splats?.()?.hiddenBuildings?.add?.(selectedBuilding.id);
        setHiddenBuildingIds((current) => new Set([...current, selectedBuilding.id]));
        setSelectedBuilding(null);
        data?.simulation?.()?.render?.();
    };

    const restoreHiddenBuildings = () => {
        if (!scene) return;

        hiddenBuildingIds.forEach((buildingId) => {
            collectBuildingMeshes(scene, buildingId).forEach((mesh) => {
                mesh.visible = true;
            });
            data?.splats?.()?.hiddenBuildings?.delete?.(buildingId);
        });

        setHiddenBuildingIds(new Set());
        data?.simulation?.()?.render?.();
    };

    const clearSelection = () => {
        setSelectedBuilding(null);
        data?.simulation?.()?.render?.();
    };

    return (
        <>
            {selectedBuilding && (
                <div
                    className="fixed z-30 pointer-events-auto"
                    style={{
                        left: `${selectedBuilding.panel.x}px`,
                        top: `${selectedBuilding.panel.y}px`,
                    }}
                    onMouseDown={controls.disable}
                    onMouseUp={controls.enable}
                    onMouseLeave={controls.enable}
                    onClick={stopEvent}
                >
                    <div
                        className="building-popout-panel rounded-2xl border border-sky-400/35 bg-zinc-950/88 p-3 text-zinc-100 shadow-[0_24px_80px_rgba(0,0,0,0.5)] backdrop-blur-2xl"
                        style={{
                            transformOrigin: selectedBuilding.panel.origin,
                            width: "min(304px, calc(100vw - 24px))",
                        }}
                    >
                        <div className="mb-2 flex items-start justify-between gap-3 border-b border-zinc-700/80 pb-2">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border border-sky-400/60 bg-sky-500/20 text-sky-100">
                                        <FaCube className="h-3 w-3" />
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-[11px] font-semibold tracking-wide text-zinc-100">Building</p>
                                        <p className="truncate font-mono text-[10px] text-zinc-400" title={selectedBuilding.id}>
                                            {shortBuildingId(selectedBuilding.id)}
                                        </p>
                                    </div>
                                </div>
                            </div>
                            <MenuButton
                                iconOnly
                                variant="ghost"
                                className="h-7 w-7 rounded-lg"
                                onClick={clearSelection}
                                title="Clear selection"
                                ariaLabel="Clear selection"
                            >
                                <FaTimes className="h-3 w-3" />
                            </MenuButton>
                        </div>

                        <div className="grid grid-cols-3 divide-x divide-zinc-700/80 border-y border-zinc-700/80 py-2">
                            <Metric label="Height" value={selectedBuilding.metrics.height} />
                            <Metric label="Width" value={selectedBuilding.metrics.width} />
                            <Metric label="Depth" value={selectedBuilding.metrics.depth} />
                        </div>

                        <div className="mt-3 flex items-center justify-between gap-2">
                            <p className="text-[10px] font-medium text-sky-200">Highlighted in scene</p>
                            <div className="flex items-center gap-1.5">
                                <MenuButton
                                    compact
                                    variant="danger"
                                    onClick={hideSelectedBuilding}
                                    title="Hide selected building"
                                    ariaLabel="Hide selected building"
                                >
                                    <FaEyeSlash className="h-3 w-3" />
                                    Hide
                                </MenuButton>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {hiddenCount > 0 && (
                <div
                    className={cn(
                        "fixed right-3 top-3 z-30 pointer-events-auto",
                        selectedBuilding && "opacity-70 hover:opacity-100",
                    )}
                    onMouseDown={controls.disable}
                    onMouseUp={controls.enable}
                    onMouseLeave={controls.enable}
                    onClick={stopEvent}
                >
                    <div className="building-popout-panel flex items-center gap-2 rounded-2xl border border-zinc-700/80 bg-zinc-950/88 p-2 text-zinc-100 shadow-[0_18px_60px_rgba(0,0,0,0.42)] backdrop-blur-2xl">
                        <div className="flex h-8 min-w-8 items-center justify-center rounded-xl border border-zinc-700/80 bg-zinc-900/80 px-2 font-mono text-[11px] text-sky-200">
                            {hiddenCount}
                        </div>
                        <span className="text-[11px] font-medium text-zinc-300">
                            {hiddenCount === 1 ? "Hidden building" : "Hidden buildings"}
                        </span>
                        <MenuButton
                            compact
                            variant="primary"
                            onClick={restoreHiddenBuildings}
                            title="Restore hidden buildings"
                            ariaLabel="Restore hidden buildings"
                        >
                            <FaUndo className="h-3 w-3" />
                            Restore
                        </MenuButton>
                    </div>
                </div>
            )}
        </>
    );
}

function Metric({ label, value }) {
    return (
        <div className="px-2 text-center">
            <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{label}</p>
            <p className="mt-0.5 font-mono text-[13px] text-zinc-100">{value}</p>
        </div>
    );
}
