import { useEffect, useRef, useState } from "react";
import { boundsCenter } from "../../earth/EarthImportConfig.js";
import {
    computeOutlineVerticalRange,
    cornersToSamplePoints,
    createGeoBoundsOutlineGroup,
    geoBoundsToLocalCorners,
} from "../../earth/map/GeoBoundsOutlineGeometry.js";
import { sampleEarthTileElevation } from "../../earth/map/sampleEarthTileElevation.js";
import {
    editorStateToGeoBounds,
    summarizeBounds,
} from "../../earth/map/GeoBoundsSelection.js";
import {
    EARTH_IMPORT_STATUS,
    EDITOR_MODES,
} from "../../editor/EditorState";

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

function shouldShowBoundsOutline(editorSnapshot) {
    if (!editorSnapshot || editorSnapshot.editorMode !== EDITOR_MODES.EARTH_IMPORT) {
        return false;
    }

    const earthImport = editorSnapshot.earthImport;
    const bounds = editorStateToGeoBounds(earthImport);
    if (!summarizeBounds(bounds).valid) {
        return false;
    }

    return earthImport.previewActive
        || earthImport.status === EARTH_IMPORT_STATUS.PREVIEW
        || earthImport.status === EARTH_IMPORT_STATUS.LOADING_TILES
        || earthImport.status === EARTH_IMPORT_STATUS.LOADING_ROADS;
}

/**
 * Renders a vertical red boundary around the selected import bounds during tile preview.
 * Tiles often extend beyond the selected rectangle; this outline marks the exact import area.
 */
export function EarthImportBoundsOutline({ data }) {
    const groupRef = useRef(null);
    const [outlineState, setOutlineState] = useState(null);
    const [tileRevision, setTileRevision] = useState(0);

    useEffect(() => {
        const editor = data?.editor?.();
        return editor?.subscribe?.((snapshot) => {
            if (!shouldShowBoundsOutline(snapshot)) {
                setOutlineState(null);
                return;
            }

            const bounds = editorStateToGeoBounds(snapshot.earthImport);
            setOutlineState({
                bounds,
                anchor: boundsCenter(bounds),
            });
        });
    }, [data]);

    useEffect(() => {
        if (!outlineState) return undefined;

        let lastTopY = null;
        const interval = setInterval(() => {
            const manager = data?.earthTilesManager?.();
            if (!manager?.group) return;

            const corners = geoBoundsToLocalCorners(outlineState.bounds, outlineState.anchor);
            const tileElevation = sampleEarthTileElevation(
                manager.group,
                cornersToSamplePoints(corners),
            );
            const { topY } = computeOutlineVerticalRange(tileElevation);
            if (lastTopY === topY) return;
            lastTopY = topY;
            setTileRevision((value) => value + 1);
        }, 750);

        return () => clearInterval(interval);
    }, [outlineState, data]);

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

        const corners = geoBoundsToLocalCorners(outlineState.bounds, outlineState.anchor);
        const tileRoot = data?.earthTilesManager?.()?.group ?? null;
        const tileElevation = sampleEarthTileElevation(tileRoot, cornersToSamplePoints(corners));
        const verticalRange = computeOutlineVerticalRange(tileElevation);
        const group = createGeoBoundsOutlineGroup(
            outlineState.bounds,
            outlineState.anchor,
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
    }, [outlineState, tileRevision, data]);

    return null;
}
