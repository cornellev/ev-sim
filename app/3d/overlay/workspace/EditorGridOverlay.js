import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EDITOR_MODES } from "../../editor/EditorState";

const GRID_SIZE = 400;
const GRID_DIVISIONS = 400;
const GRID_COLOR_MAJOR = 0x3a3d42;
const GRID_COLOR_MINOR = 0x24272b;

/**
 * Editor working grid (1 m cells over 400 m). Editor-only: outside the
 * object registry, collision, LiDAR truth, and picking.
 */
export function EditorGridOverlay({ data }) {
    const gridRef = useRef(null);

    useEffect(() => {
        const scene = data?.three?.()?.scene;
        const editor = data?.editor?.();
        if (!scene || !editor) return undefined;
        const grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS, GRID_COLOR_MAJOR, GRID_COLOR_MINOR);
        grid.name = "EditorWorkingGrid";
        grid.position.y = 0.01;
        grid.renderOrder = -1;
        grid.userData.skipEnvironmentSelection = true;
        grid.material.transparent = true;
        grid.material.opacity = 0.55;
        grid.material.depthWrite = false;
        grid.visible = false;
        scene.add(grid);
        gridRef.current = grid;
        const dispose = editor.subscribe((snapshot) => {
            const visible = snapshot.sceneGridVisible !== false && snapshot.editorMode === EDITOR_MODES.SCENE;
            if (grid.visible !== visible) {
                grid.visible = visible;
                data.simulation?.()?.render?.();
            }
        });
        return () => {
            dispose?.();
            grid.parent?.remove?.(grid);
            grid.geometry?.dispose?.();
            grid.material?.dispose?.();
            gridRef.current = null;
            data.simulation?.()?.render?.();
        };
    }, [data]);

    return null;
}
