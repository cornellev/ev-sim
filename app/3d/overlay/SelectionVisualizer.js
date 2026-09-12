import { useEffect, useRef } from "react";
import * as THREE from "three";
import { descendantIds, indexObjectsById } from "../editor/commands/objectMutations.js";
import { GROUP_TYPE_ID } from "../editor/objects/types/group.js";
import { entityIdForObject, entityIdForSub } from "../editor/selection/selectionIds.js";

const HIGHLIGHT_COLOR = 0x38bdf8;
const SUB_HIGHLIGHT_COLOR = 0xfbbf24;
const GROUP_COLOR = 0xa78bfa;
const HIGHLIGHT_EMISSIVE = new THREE.Color(HIGHLIGHT_COLOR);
const MATERIAL_SNAPSHOTS = new WeakMap();

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

/**
 * Resolve the runtime objects a selection highlights: one entry per selected
 * leaf (groups expand to their descendants) plus the sub-object handle.
 * Exported for tests.
 */
export function resolveSelectionVisuals({ selectionSnapshot, document, registry }) {
    const leaves = [];
    const groups = [];
    if (!selectionSnapshot || !registry) return { leaves, groups, sub: null };
    const byId = indexObjectsById(document?.objects ?? []);
    const seen = new Set();
    const pushEntity = (record) => {
        const entityId = entityIdForObject(record, registry);
        const entity = entityId ? registry.getEntity(entityId) : null;
        if (entity?.object3D && entity.visible !== false && !seen.has(entity.id)) {
            seen.add(entity.id);
            leaves.push({ id: record.id, entity });
            return entity;
        }
        return null;
    };
    for (const id of selectionSnapshot.ids ?? []) {
        const record = byId.get(String(id));
        if (!record) continue;
        if (record.typeId === GROUP_TYPE_ID) {
            const members = [];
            for (const descendant of descendantIds(byId, record.id)) {
                const child = byId.get(descendant);
                if (!child || child.typeId === GROUP_TYPE_ID) continue;
                const entity = pushEntity(child);
                if (entity) members.push(entity);
            }
            groups.push({ id: record.id, members });
        } else {
            pushEntity(record);
        }
    }
    const subEntity = selectionSnapshot.sub ? registry.getEntity(entityIdForSub(selectionSnapshot.sub)) : null;
    return { leaves, groups, sub: subEntity?.object3D ? subEntity : null };
}

function createBoxHelper(object3D, color, name) {
    const helper = new THREE.BoxHelper(object3D, color);
    helper.name = name;
    helper.renderOrder = 999;
    helper.userData.skipEnvironmentSelection = true;
    if (helper.material) {
        helper.material.depthTest = false;
        helper.material.transparent = true;
        helper.material.opacity = 0.95;
    }
    return helper;
}

function createUnionHelper(object3Ds, color, name) {
    const box = new THREE.Box3();
    for (const object3D of object3Ds) {
        object3D.updateMatrixWorld(true);
        box.union(new THREE.Box3().setFromObject(object3D));
    }
    if (box.isEmpty()) return null;
    const helper = new THREE.Box3Helper(box, new THREE.Color(color));
    helper.name = name;
    helper.renderOrder = 998;
    helper.userData.skipEnvironmentSelection = true;
    if (helper.material) {
        helper.material.depthTest = false;
        helper.material.transparent = true;
        helper.material.opacity = 0.7;
    }
    return helper;
}

export function SelectionVisualizer({ data }) {
    const helpersRef = useRef([]);
    const highlightedRef = useRef([]);

    useEffect(() => {
        const selection = data?.selection?.();
        const registry = data?.environment?.()?.objects?.();
        const document = data?.environment?.()?.getDocument?.();
        const scene = data?.three?.()?.scene;
        if (!selection || !registry || !scene || !document) return undefined;

        function clear() {
            for (const object of highlightedRef.current) resetMaterialHighlight(object);
            highlightedRef.current = [];
            for (const helper of helpersRef.current) {
                helper.parent?.remove?.(helper);
                helper.geometry?.dispose?.();
                helper.material?.dispose?.();
            }
            helpersRef.current = [];
        }

        function rebuild() {
            clear();
            const visuals = resolveSelectionVisuals({ selectionSnapshot: selection.snapshot(), document, registry });
            for (const { id, entity } of visuals.leaves) {
                applyMaterialHighlight(entity.object3D);
                highlightedRef.current.push(entity.object3D);
                const helper = createBoxHelper(entity.object3D, HIGHLIGHT_COLOR, `EnvironmentSelection:${id}`);
                scene.add(helper);
                helpersRef.current.push(helper);
            }
            for (const group of visuals.groups) {
                const helper = createUnionHelper(group.members.map((entity) => entity.object3D), GROUP_COLOR, `EnvironmentSelectionGroup:${group.id}`);
                if (helper) {
                    scene.add(helper);
                    helpersRef.current.push(helper);
                }
            }
            if (visuals.sub) {
                const helper = createBoxHelper(visuals.sub.object3D, SUB_HIGHLIGHT_COLOR, `EnvironmentSelectionSub:${visuals.sub.id}`);
                scene.add(helper);
                helpersRef.current.push(helper);
            }
            data?.simulation?.()?.render?.();
        }

        const disposeSelection = selection.subscribe(rebuild);
        const disposeDocument = document.subscribe((snapshot, event) => {
            if (event?.source === "subscribe") return;
            if (event?.transient) {
                for (const helper of helpersRef.current) helper.update?.();
                data?.simulation?.()?.render?.();
                return;
            }
            rebuild();
        });
        return () => {
            disposeSelection?.();
            disposeDocument?.();
            clear();
        };
    }, [data]);

    useEffect(() => {
        const registry = data?.environment?.()?.objects?.();
        if (!registry?.subscribe) return undefined;

        return registry.subscribe(() => {
            for (const helper of helpersRef.current) helper.update?.();
            data?.simulation?.()?.render?.();
        });
    }, [data]);

    return null;
}
