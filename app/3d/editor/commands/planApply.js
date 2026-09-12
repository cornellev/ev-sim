/**
 * Apply `PlanStep`s produced by transform bindings to a document. Steps are
 * plain data; this is the only place that turns them into mutations. Node
 * moves are grouped into a single `translateRoadNodes` call so incident arms
 * are rewritten once.
 */

import { setBuildingFootprint, setFeatureTransform, translateRoadNodes } from "../document/documentMutations.js";
import { setObjectComponent } from "./objectMutations.js";

export const PLAN_STEP_OPS = Object.freeze([
    "move-node",
    "set-feature-transform",
    "set-building-footprint",
    "set-object-component",
]);

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
        }
        if (!result?.ok) return { ok: false, error: result?.error ?? `Plan step "${step.op}" failed.`, applied };
        applied += 1;
    }
    if (applied > 0 && runtime?.notify !== false) document.notify();
    return { ok: true, applied };
}
