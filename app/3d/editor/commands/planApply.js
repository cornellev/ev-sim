/**
 * Apply `PlanStep`s produced by transform bindings and option plans to a
 * document. Steps are plain data; this is the only place that turns them into
 * mutations. Node moves are grouped into a single `translateRoadNodes` call so
 * incident arms are rewritten once.
 */

import {
    setBuildingFootprint,
    setFeatureTransform,
    translateRoadNodes,
    updateBuildingRecord,
    updateFeatureRecord,
    updateRoadEdge,
} from "../document/documentMutations.js";
import { setObjectComponent } from "./objectMutations.js";

export const PLAN_STEP_OPS = Object.freeze([
    "move-node",
    "set-feature-transform",
    "set-building-footprint",
    "set-object-component",
    // ED-03 option writes
    "set-edge-options",
    "set-building-record",
    "set-feature-record",
    "set-earth-source",
    "set-sky",
]);

function applyEarthSource(document, patch) {
    if (!document.earth) return { ok: false, error: "The environment has no Earth source." };
    const merged = {
        ...document.earth,
        ...(patch ?? {}),
        anchor: { ...document.earth.anchor, ...(patch?.anchor ?? {}) },
        bounds: { ...document.earth.bounds, ...(patch?.bounds ?? {}) },
    };
    document.setScalar("earth", merged, { notify: false });
    return { ok: true };
}

/**
 * @returns {{ ok: boolean, error?: string, applied: number }}
 */
export function applyPlanSteps(document, steps, runtime = { notify: false }) {
    const nodePositions = new Map();
    const others = [];
    for (const step of steps ?? []) {
        if (!step || !PLAN_STEP_OPS.includes(step.op)) {
            return { ok: false, error: `Unknown plan step "${step?.op}".`, applied: 0 };
        }
        if (step.op === "move-node") {
            nodePositions.set(String(step.nodeId), step.position);
        } else {
            others.push(step);
        }
    }
    let applied = 0;
    const quiet = { ...runtime, notify: false };
    if (nodePositions.size > 0) {
        const result = translateRoadNodes(document, nodePositions, quiet);
        if (!result.ok) return { ok: false, error: result.error, applied };
        applied += nodePositions.size;
    }
    for (const step of others) {
        let result;
        if (step.op === "set-feature-transform") {
            result = setFeatureTransform(document, step.featureId, { x: step.x, z: step.z, rotationY: step.rotationY }, quiet);
        } else if (step.op === "set-building-footprint") {
            result = setBuildingFootprint(document, step.buildingId, { footprint: step.footprint, height: step.height }, quiet);
        } else if (step.op === "set-object-component") {
            result = setObjectComponent(document, step.objectId, step.key, step.value, quiet);
        } else if (step.op === "set-edge-options") {
            result = updateRoadEdge(document, step.edgeId, step.patch ?? {}, quiet);
        } else if (step.op === "set-building-record") {
            result = updateBuildingRecord(document, step.buildingId, step.patch ?? {}, quiet);
        } else if (step.op === "set-feature-record") {
            result = updateFeatureRecord(document, step.featureId, step.patch ?? {}, quiet);
        } else if (step.op === "set-earth-source") {
            result = applyEarthSource(document, step.patch ?? {});
        } else if (step.op === "set-sky") {
            document.setScalar("sky", step.value ?? null, { notify: false });
            result = { ok: true };
        }
        if (!result?.ok) return { ok: false, error: result?.error ?? `Plan step "${step.op}" failed.`, applied };
        applied += 1;
    }
    if (applied > 0 && runtime?.notify !== false) document.notify();
    return { ok: true, applied };
}
