import { useEffect } from "react";
import {
    disposeRoadHandleStems,
    syncRoadAuthoringHandleOverlay,
} from "../../editor/projection/roadRuntimeEntities.js";

/**
 * Editor-only tangent visibility and knot→handle stems. Endpoints and knots
 * stay visible with the authoring group; tangent handles follow the selected
 * knot or the session "Road handles" overlay.
 */
export function RoadAuthoringHandleOverlay({ data }) {
    useEffect(() => {
        const scene = data?.three?.()?.scene;
        const editor = data?.editor?.();
        const selection = data?.selection?.();
        const registry = data?.environment?.()?.objects?.();
        const document = data?.environment?.()?.getDocument?.();
        if (!scene || !editor || !registry) return undefined;

        const sync = () => {
            const editorSnapshot = editor.snapshot();
            syncRoadAuthoringHandleOverlay({
                scene,
                registry,
                sub: selection?.snapshot?.()?.sub ?? null,
                showAll: editorSnapshot.roadHandlesVisible === true,
                layers: editorSnapshot.layers,
            });
            data.simulation?.()?.render?.();
        };

        const unsubscribes = [
            editor.subscribe(sync),
            selection?.subscribe?.(sync),
            registry.subscribe?.(sync),
            document?.subscribe?.(sync),
        ].filter(Boolean);

        return () => {
            for (const unsubscribe of unsubscribes) unsubscribe();
            disposeRoadHandleStems(scene);
            data.simulation?.()?.render?.();
        };
    }, [data]);

    return null;
}
