import { useEffect, useRef, useState } from "react";
import { boundsCenter } from "../../earth/EarthImportConfig.js";
import {
    computeOutlineVerticalRange,
    createGeoBoundsOutlineGroup,
} from "../../earth/map/GeoBoundsOutlineGeometry.js";
import {
    editorStateToGeoBounds,
} from "../../earth/map/GeoBoundsSelection.js";
import { shouldShowEarthImportBounds } from "../../earth/EarthImportBoundsPolicy.js";

function disposeGroup(group) {
    group?.traverse?.((object) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) {
            object.material.forEach((material) => material?.dispose?.());
        } else {
            object.material?.dispose?.();
        }
    });
}

/**
 * Renders a vertical red boundary around the selected import bounds during tile preview.
 * Tiles often extend beyond the selected rectangle; this outline marks the exact import area.
 */
export function EarthImportBoundsOutline({ data }) {
    const groupRef = useRef(null);
    const [outlineState, setOutlineState] = useState(null);

    useEffect(() => {
        const editor = data?.editor?.();
        return editor?.subscribe?.((snapshot) => {
            if (!shouldShowEarthImportBounds(snapshot)) {
                setOutlineState(null);
                return;
            }

            const bounds = editorStateToGeoBounds(snapshot.earthImport);
            setOutlineState({
                bounds,
                frame: data?.earthImportController?.()?.session?.geoFrame ?? boundsCenter(bounds),
            });
        });
    }, [data]);

    useEffect(() => {
        const scene = data?.three?.()?.scene;
        if (!scene) return undefined;

        if (groupRef.current) {
            groupRef.current.parent?.remove?.(groupRef.current);
            disposeGroup(groupRef.current);
            groupRef.current = null;
        }

        if (!outlineState) {
            data?.simulation?.()?.render?.();
            return undefined;
        }

        const verticalRange = computeOutlineVerticalRange();
        const group = createGeoBoundsOutlineGroup(
            outlineState.bounds,
            outlineState.frame,
            verticalRange,
        );

        scene.add(group);
        groupRef.current = group;
        data?.simulation?.()?.render?.();

        return () => {
            group.parent?.remove?.(group);
            disposeGroup(group);
            if (groupRef.current === group) {
                groupRef.current = null;
            }
        };
    }, [outlineState, data]);

    return null;
}
