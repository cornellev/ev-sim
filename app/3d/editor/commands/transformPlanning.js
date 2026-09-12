/**
 * Transform planning over the object graph.
 *
 * `collectTransformClosure` walks the selected roots through nested groups
 * and gathers the legacy dependency set (features, buildings, road nodes).
 * `planTransform` applies one world delta to every leaf through its type's
 * binding and composes it once into every group frame. Road nodes reached
 * through several leaves (a shared junction, an edge plus its intersection)
 * are planned exactly once. Any issue rejects the whole plan before anything
 * is applied.
 */

import { GROUP_TYPE_ID } from "../objects/types/group.js";
import { planObjectTransform } from "../objects/objectGraph.js";
import { objectTypeRegistry } from "../objects/ObjectTypeRegistry.js";
import { issue } from "../objects/ObjectOptions.js";
import { TRANSFORM_ISSUE_CODES, applyDeltaToPoint, decomposeDelta, normalizeDelta } from "../objects/transformDelta.js";
import { legacyRecordFor } from "../objects/objectGraph.js";
import { childrenOf, pruneToRoots } from "./objectMutations.js";

function definitionFor(registry, record) {
    return registry.get(record?.typeId, record?.typeVersion) ?? registry.get(record?.typeId) ?? null;
}

/**
 * @param {import("../document/EnvironmentDocument.js").EnvironmentDocument} document
 * @param {string[]} objectIds
 * @param {{ kind: "road-node", id: string } | null} [sub]
 */
export function collectTransformClosure(document, registry = objectTypeRegistry, objectIds = [], sub = null) {
    const index = document.index();
    const byId = index.objects;
    const roots = pruneToRoots(byId, objectIds);
    const groups = new Set();
    const leaves = new Set();
    const issues = [];
    const missing = [...objectIds].map(String).filter((id) => !byId.has(id));
    for (const id of missing) {
        issues.push(issue(["transform"], TRANSFORM_ISSUE_CODES.MISSING, `Object "${id}" does not exist.`, { objectId: id }));
    }

    const visit = (id) => {
        const record = byId.get(id);
        if (!record) return;
        if (record.components?.locked === true) {
            issues.push(issue(["transform"], TRANSFORM_ISSUE_CODES.LOCKED, `"${record.name ?? id}" is locked.`, { objectId: id }));
            return;
        }
        const definition = definitionFor(registry, record);
        if (!definition) {
            issues.push(issue(["transform"], TRANSFORM_ISSUE_CODES.NOT_TRANSFORMABLE, `Object type "${record.typeId}" is not registered.`, { objectId: id }));
            return;
        }
        if (!definition.getCapabilities(record)?.transformable) {
            issues.push(issue(["transform"], TRANSFORM_ISSUE_CODES.NOT_TRANSFORMABLE, `"${record.name ?? id}" cannot be transformed.`, { objectId: id }));
            return;
        }
        if (record.typeId === GROUP_TYPE_ID) {
            groups.add(id);
            for (const child of childrenOf(byId, id)) visit(String(child.id));
        } else {
            leaves.add(id);
        }
    };
    roots.forEach(visit);

    const nodeIds = new Set();
    const featureIds = new Set();
    const buildingIds = new Set();
    for (const id of leaves) {
        const record = byId.get(id);
        const definition = definitionFor(registry, record);
        const legacy = definition?.legacy ? legacyRecordFor(index, definition, id, {}) : null;
        for (const dependency of definition?.getDependencies(record, { legacy }) ?? []) {
            if (dependency.kind === "road-node") nodeIds.add(String(dependency.id));
            else if (dependency.kind === "feature") featureIds.add(String(dependency.id));
            else if (dependency.kind === "building") buildingIds.add(String(dependency.id));
        }
    }
    if (sub?.kind === "road-node" && sub.id !== undefined && sub.id !== null) {
        const nodeId = String(sub.id);
        if (index.nodes.has(nodeId)) nodeIds.add(nodeId);
        else issues.push(issue(["transform"], TRANSFORM_ISSUE_CODES.MISSING, `Road node "${nodeId}" does not exist.`, { objectId: nodeId }));
    }
    const edgeIds = new Set();
    for (const edge of index.edges.values()) {
        if (nodeIds.has(String(edge.startNodeId)) || nodeIds.has(String(edge.endNodeId))) edgeIds.add(String(edge.id));
    }
    return { roots, groups, leaves, nodeIds, edgeIds, featureIds, buildingIds, issues, sub: sub ?? null };
}

/**
 * @returns {{ ok: boolean, steps: object[], issues: object[], closure: object }}
 */
export function planTransform(document, registry = objectTypeRegistry, objectIds = [], delta, { sub = null, closure = null } = {}) {
    const resolvedClosure = closure ?? collectTransformClosure(document, registry, objectIds, sub);
    if (resolvedClosure.issues.length > 0) {
        return { ok: false, steps: [], issues: [...resolvedClosure.issues], closure: resolvedClosure };
    }
    const normalizedDelta = normalizeDelta(delta);
    const index = document.index();
    const byId = index.objects;
    const steps = [];
    const issues = [];
    const nodeSteps = new Map();

    const parts = decomposeDelta(normalizedDelta);
    const multi = resolvedClosure.groups.size > 0 || resolvedClosure.leaves.size > 1;
    if (multi && !parts.uniformScale) {
        issues.push(issue(["transform"], TRANSFORM_ISSUE_CODES.NON_UNIFORM_SCALE, "Groups and multi-selections scale uniformly only.", { objectId: resolvedClosure.roots[0] ?? null }));
    }

    for (const groupId of resolvedClosure.groups) {
        const record = byId.get(groupId);
        const plan = planObjectTransform(record, index, registry, normalizedDelta, {});
        issues.push(...plan.issues);
        steps.push(...plan.steps);
    }
    for (const leafId of resolvedClosure.leaves) {
        const record = byId.get(leafId);
        const plan = planObjectTransform(record, index, registry, normalizedDelta, {});
        issues.push(...plan.issues);
        for (const step of plan.steps) {
            if (step.op === "move-node") {
                // Shared nodes plan once: every leaf reads the same pristine node, so first wins.
                if (!nodeSteps.has(step.nodeId)) nodeSteps.set(step.nodeId, step);
            } else {
                steps.push(step);
            }
        }
    }
    const subNode = resolvedClosure.sub?.kind === "road-node" ? String(resolvedClosure.sub.id) : null;
    if (subNode && !nodeSteps.has(subNode) && index.nodes.has(subNode)) {
        nodeSteps.set(subNode, { op: "move-node", nodeId: subNode, position: applyDeltaToPoint(normalizedDelta, index.nodes.get(subNode)) });
    }
    if (issues.length > 0) {
        return { ok: false, steps: [], issues, closure: resolvedClosure };
    }
    return { ok: true, steps: [...steps, ...nodeSteps.values()], issues: [], closure: resolvedClosure };
}
