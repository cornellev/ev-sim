/**
 * Pure view model for the wheel assignment dialog.
 * Node indexes come from the glTF node table. Roles are editor state.
 */

import { reviewModelWheelPair } from "../axle/reviewModelWheels.js";

export const WHEEL_ASSIGNMENT_ROLES = Object.freeze([
    { id: "unassigned", label: "Unassigned" },
    { id: "front-left", label: "Front left" },
    { id: "front-right", label: "Front right" },
    { id: "rear-left", label: "Rear left" },
    { id: "rear-right", label: "Rear right" },
]);

const AXLES = Object.freeze(["front", "rear"]);

export function canonicalVehicleGlb(asset) {
    return typeof asset === "string" && /^[a-f0-9]{64}\.glb$/.test(asset);
}

export function rolesFromManifest(manifest) {
    const roles = {};
    for (const wheel of manifest?.wheels ?? []) {
        if (wheel.visual?.kind !== "model-node" || !wheel.axle || !wheel.side) continue;
        roles[wheel.visual.nodeIndex] = `${wheel.axle}-${wheel.side}`;
    }
    return roles;
}

function catalogNodes(catalog) {
    if (Array.isArray(catalog)) return catalog;
    return catalog?.nodes ?? [];
}

function formatIssue(entry) {
    return entry?.message || entry?.code || "Wheel assignment failed.";
}

export function buildWheelAssignmentState({ catalog, measurement, roles = {} } = {}) {
    const measured = new Map((measurement?.nodes ?? []).map((node) => [node.nodeIndex, node]));
    const entries = catalogNodes(catalog)
        .filter((node) => node?.inScene !== false && Number.isInteger(node.nodeIndex))
        .map((node) => {
            const shape = measured.get(node.nodeIndex);
            const role = roles[node.nodeIndex] ?? "unassigned";
            return {
                nodeIndex: node.nodeIndex,
                name: node.name || `Node ${node.nodeIndex}`,
                path: Array.isArray(node.path) ? node.path.filter(Boolean).join(" / ") : String(node.path ?? node.name ?? ""),
                role: WHEEL_ASSIGNMENT_ROLES.some((entry) => entry.id === role) ? role : "unassigned",
                center: shape?.center ?? null,
                radius: shape?.radius ?? null,
                width: shape?.width ?? null,
                radialDelta: shape?.radialDelta ?? null,
            };
        });
    const claimed = new Map();
    const duplicateRoles = [];
    for (const entry of entries) {
        if (entry.role === "unassigned") continue;
        if (claimed.has(entry.role)) duplicateRoles.push(entry.role);
        claimed.set(entry.role, entry);
    }
    const pairs = [];
    const messages = [];
    for (const role of duplicateRoles) messages.push(`${role} is assigned to more than one node.`);
    for (const axle of AXLES) {
        const left = entries.find((entry) => entry.role === `${axle}-left`) ?? null;
        const right = entries.find((entry) => entry.role === `${axle}-right`) ?? null;
        if (!left && !right) continue;
        if (!left || !right || duplicateRoles.length > 0) {
            pairs.push({
                axle,
                leftNodeIndex: left?.nodeIndex ?? null,
                rightNodeIndex: right?.nodeIndex ?? null,
                withinTolerance: false,
                unchanged: false,
                needsAcceptance: false,
                proposed: null,
                maxAdjustment: null,
                issues: [`Choose one left node and one right node for the ${axle} axle.`],
            });
            messages.push(`Choose both sides of the ${axle} axle.`);
            continue;
        }
        const review = reviewModelWheelPair({
            left: measured.get(left.nodeIndex),
            right: measured.get(right.nodeIndex),
            axle,
        });
        pairs.push({
            axle,
            leftNodeIndex: left.nodeIndex,
            rightNodeIndex: right.nodeIndex,
            withinTolerance: review.withinTolerance === true,
            unchanged: review.unchanged === true,
            needsAcceptance: review.needsAcceptance === true,
            proposed: review.proposed ?? null,
            maxAdjustment: review.maxAdjustment ?? null,
            issues: (review.issues ?? []).map(formatIssue),
        });
        for (const issue of review.issues ?? []) messages.push(formatIssue(issue));
    }
    const complete = pairs.filter((pair) => pair.leftNodeIndex != null && pair.rightNodeIndex != null);
    const ready = duplicateRoles.length === 0
        && complete.length > 0
        && pairs.length === complete.length
        && complete.every((pair) => pair.withinTolerance);
    return {
        entries,
        pairs,
        ready,
        messages: [...new Set(messages)],
        outOfTolerance: complete.filter((pair) => !pair.withinTolerance),
    };
}
