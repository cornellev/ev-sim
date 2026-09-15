'use client';

import { useEffect, useState } from "react";
import { Button, Switch } from "../../../ui";
import { NumberField } from "../fields/NumberField";
import { executeDrapeRoadsToGlb } from "../../editor/tools/drapeRoadsToGlb.js";

const OFFSET = Object.freeze({ path: ["offset"], label: "Offset", control: "number", units: "m", step: 0.01 });

/**
 * Snap selected road/intersection control points to a GLB surface, with a
 * session offset and optional connected-network expansion.
 */
export function RoadDrapeSection({ data, onResult }) {
    const [snapshot, setSnapshot] = useState(() => data?.editor?.()?.snapshot?.() ?? null);
    useEffect(() => data?.editor?.()?.subscribe?.(setSnapshot), [data]);
    const editor = data?.editor?.();
    const offset = Number.isFinite(Number(snapshot?.roadGlbSnapOffset)) ? Number(snapshot.roadGlbSnapOffset) : 0;
    const includeConnected = snapshot?.roadGlbSnapIncludeConnected === true;
    const commitOffset = (value) => {
        editor?.setRoadGlbSnapOffset?.(value);
    };
    const snap = () => {
        const result = executeDrapeRoadsToGlb(data);
        onResult?.(result);
        return result;
    };
    return (
        <div className="space-y-2 py-1">
            <NumberField id="road-drape-offset" descriptor={OFFSET} value={offset} onCommit={commitOffset} />
            <Switch
                checked={includeConnected}
                onCheckedChange={(checked) => editor?.setRoadGlbSnapIncludeConnected?.(checked === true)}
                label="Include connected"
                description="Walk every road that shares a node with the selection"
            />
            <Button size="compact" variant="ghost" onClick={snap}>
                Snap to GLB
            </Button>
        </div>
    );
}
