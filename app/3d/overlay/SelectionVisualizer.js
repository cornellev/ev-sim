import { useEffect, useRef } from "react";
import * as THREE from "three";

const HIGHLIGHT_COLOR = 0x38bdf8;
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

export function SelectionVisualizer({ data }) {
    const helperRef = useRef(null);
    const highlightedRef = useRef(null);

    useEffect(() => {
        const editor = data?.editor?.();
        const registry = data?.environment?.()?.objects?.();
        const scene = data?.three?.()?.scene;
        if (!editor || !registry || !scene) return undefined;

        function clear() {
            if (highlightedRef.current) {
                resetMaterialHighlight(highlightedRef.current);
                highlightedRef.current = null;
            }

            if (helperRef.current) {
                helperRef.current.parent?.remove?.(helperRef.current);
                helperRef.current.geometry?.dispose?.();
                helperRef.current.material?.dispose?.();
                helperRef.current = null;
            }
        }

        return editor.subscribe((snapshot) => {
            clear();
            const entity = snapshot.selection?.id
                ? registry.getEntity(snapshot.selection.id)
                : null;

            if (!entity?.object3D || entity.visible === false) {
                data?.simulation?.()?.render?.();
                return;
            }

            applyMaterialHighlight(entity.object3D);
            highlightedRef.current = entity.object3D;

            const helper = new THREE.BoxHelper(entity.object3D, HIGHLIGHT_COLOR);
            helper.name = `EnvironmentSelection:${entity.id}`;
            helper.renderOrder = 999;
            helper.userData.skipEnvironmentSelection = true;

            if (helper.material) {
                helper.material.depthTest = false;
                helper.material.transparent = true;
                helper.material.opacity = 0.95;
            }

            scene.add(helper);
            helperRef.current = helper;
            data?.simulation?.()?.render?.();
        });
    }, [data]);

    useEffect(() => {
        const registry = data?.environment?.()?.objects?.();
        if (!registry?.subscribe) return undefined;

        return registry.subscribe(() => {
            helperRef.current?.update?.();
            data?.simulation?.()?.render?.();
        });
    }, [data]);

    useEffect(() => () => {
        helperRef.current?.parent?.remove?.(helperRef.current);
        helperRef.current?.geometry?.dispose?.();
        helperRef.current?.material?.dispose?.();
        if (highlightedRef.current) {
            resetMaterialHighlight(highlightedRef.current);
        }
    }, []);

    return null;
}
