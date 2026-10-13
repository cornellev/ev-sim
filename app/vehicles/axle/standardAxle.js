/**
 * Standard front/rear axle checks for version 3 vehicle manifests.
 * Pair measurement never rewrites authored geometry.
 */

import { canonicalFiniteNumber } from "../../simulation/kernel/SimulationHashes.js";

const STANDARD_AXLES = Object.freeze(["front", "rear"]);

export function pairTolerance(a, b) {
    return Math.max(0.001, 0.001 * Math.max(Math.abs(a), Math.abs(b)));
}

export function withinPairTolerance(a, b) {
    return Math.abs(a - b) <= pairTolerance(a, b);
}

function issue(code, path, message) {
    return { code, path, message };
}

function wheelSnapshot(wheel) {
    return {
        position: { ...wheel.position },
        radius: wheel.radius,
        width: wheel.width,
        steerable: wheel.steerable === true,
    };
}

/**
 * Compare one left/right pair after the caller has normalized geometric scalars.
 * `proposed.z` is the positive half-track (+Z left).
 */
export function proposeStandardPair(left, right, { axle } = {}) {
    if (!left || !right) {
        return {
            withinTolerance: false,
            measured: null,
            proposed: null,
            maxAdjustment: null,
            issues: [issue("vehicle.axle.incomplete-pair", "wheels", "A standard axle needs one left and one right wheel.")],
        };
    }
    const measured = { left: wheelSnapshot(left), right: wheelSnapshot(right) };
    const comparisons = [
        ["x", left.position.x, right.position.x],
        ["y", left.position.y, right.position.y],
        ["radius", left.radius, right.radius],
        ["width", left.width, right.width],
        ["z", left.position.z, -right.position.z],
    ];
    const issues = [];
    let withinTolerance = true;
    for (const [name, first, second] of comparisons) {
        if (withinPairTolerance(first, second)) continue;
        withinTolerance = false;
        issues.push(issue(
            "vehicle.axle.asymmetric",
            `wheels.${name}`,
            `${name} differs by ${Math.abs(first - second)}, outside pair tolerance ${pairTolerance(first, second)}.`,
        ));
    }
    if (axle === "front" || axle === "rear") {
        const expected = axle === "front";
        if (left.steerable !== expected || right.steerable !== expected) {
            issues.push(issue(
                "vehicle.axle.steer-mismatch",
                "wheels",
                `${axle} wheels must be ${expected ? "steerable" : "fixed"}.`,
            ));
        }
    }
    if (!withinTolerance) {
        return { withinTolerance: false, measured, proposed: null, maxAdjustment: null, issues };
    }
    const proposed = {
        x: canonicalFiniteNumber((left.position.x + right.position.x) / 2),
        y: canonicalFiniteNumber((left.position.y + right.position.y) / 2),
        z: canonicalFiniteNumber((Math.abs(left.position.z) + Math.abs(right.position.z)) / 2),
        radius: canonicalFiniteNumber((left.radius + right.radius) / 2),
        width: canonicalFiniteNumber((left.width + right.width) / 2),
        steerable: axle === "rear" ? false : axle === "front" ? true : left.steerable === true,
    };
    const adjustments = [
        Math.abs(left.position.x - proposed.x),
        Math.abs(right.position.x - proposed.x),
        Math.abs(left.position.y - proposed.y),
        Math.abs(right.position.y - proposed.y),
        Math.abs(left.radius - proposed.radius),
        Math.abs(right.radius - proposed.radius),
        Math.abs(left.width - proposed.width),
        Math.abs(right.width - proposed.width),
        Math.abs(left.position.z - proposed.z),
        Math.abs(right.position.z - (-proposed.z)),
    ];
    return {
        withinTolerance: true,
        measured,
        proposed,
        maxAdjustment: Math.max(...adjustments),
        issues,
    };
}

function membersOf(wheels, axle) {
    return wheels.filter((wheel) => wheel.axle === axle);
}

function completePair(wheels, axle) {
    const members = membersOf(wheels, axle);
    if (members.length !== 2) return null;
    const left = members.find((wheel) => wheel.side === "left");
    const right = members.find((wheel) => wheel.side === "right");
    if (!left || !right) return null;
    return { left, right };
}

/** Derived wheelbase for a complete front/rear layout with no unclassified wheels. */
export function deriveCompleteWheelbase(wheels = []) {
    if (wheels.length === 0 || wheels.some((wheel) => wheel.axle === undefined)) return null;
    const front = completePair(wheels, "front");
    const rear = completePair(wheels, "rear");
    if (!front || !rear) return null;
    if (wheels.some((wheel) => wheel.axle !== "front" && wheel.axle !== "rear")) return null;
    const frontProposal = proposeStandardPair(front.left, front.right, { axle: "front" });
    const rearProposal = proposeStandardPair(rear.left, rear.right, { axle: "rear" });
    if (!frontProposal.withinTolerance || !rearProposal.withinTolerance) return null;
    const derived = canonicalFiniteNumber(Math.abs(frontProposal.proposed.x - rearProposal.proposed.x));
    return derived > 0 ? derived : null;
}

export function validateStandardAxles(manifest) {
    const wheels = Array.isArray(manifest?.wheels) ? manifest.wheels : [];
    const issues = [];
    wheels.forEach((wheel, index) => {
        const hasAxle = wheel.axle !== undefined;
        const hasSide = wheel.side !== undefined;
        if (hasAxle !== hasSide) {
            issues.push(issue("vehicle.axle.incomplete-pair", `wheels.${index}`, "axle and side must both be set or both be omitted."));
        }
        if (hasAxle && !STANDARD_AXLES.includes(wheel.axle)) {
            issues.push(issue("vehicle.axle.incomplete-pair", `wheels.${index}.axle`, `Unsupported axle "${wheel.axle}".`));
        }
        if (hasSide && wheel.side !== "left" && wheel.side !== "right") {
            issues.push(issue("vehicle.axle.incomplete-pair", `wheels.${index}.side`, `Unsupported side "${wheel.side}".`));
        }
        if (wheel.visual) {
            if (!hasAxle || !hasSide) {
                issues.push(issue("vehicle.wheel.visual", `wheels.${index}.visual`, "A model binding requires a standard axle and side."));
            }
            if (wheel.visual.kind !== "model-node" || !Number.isInteger(wheel.visual.nodeIndex) || wheel.visual.nodeIndex < 0) {
                issues.push(issue("vehicle.wheel.visual", `wheels.${index}.visual`, "Wheel visual must be { kind: \"model-node\", nodeIndex }."));
            }
        }
    });
    for (const axle of STANDARD_AXLES) {
        const members = membersOf(wheels, axle);
        if (members.length === 0) continue;
        const left = members.filter((wheel) => wheel.side === "left");
        const right = members.filter((wheel) => wheel.side === "right");
        if (left.length !== 1 || right.length !== 1 || members.length !== 2) {
            issues.push(issue("vehicle.axle.incomplete-pair", "wheels", `Axle "${axle}" must contain one left and one right wheel.`));
            continue;
        }
        issues.push(...proposeStandardPair(left[0], right[0], { axle }).issues);
    }
    const derived = deriveCompleteWheelbase(wheels);
    if (derived != null && manifest?.kinematics?.wheelbase !== derived) {
        issues.push(issue(
            "vehicle.axle.wheelbase-mismatch",
            "kinematics.wheelbase",
            `Wheelbase ${manifest.kinematics.wheelbase} does not match the axle-derived wheelbase ${derived}.`,
        ));
    }
    const front = completePair(wheels, "front");
    const rear = completePair(wheels, "rear");
    if (front && rear && !wheels.some((wheel) => wheel.axle === undefined)) {
        const frontProposal = proposeStandardPair(front.left, front.right, { axle: "front" });
        const rearProposal = proposeStandardPair(rear.left, rear.right, { axle: "rear" });
        if (frontProposal.withinTolerance && rearProposal.withinTolerance) {
            const distance = canonicalFiniteNumber(Math.abs(frontProposal.proposed.x - rearProposal.proposed.x));
            if (!(distance > 0)) {
                issues.push(issue("vehicle.axle.wheelbase-mismatch", "kinematics.wheelbase", "Standard axle positions do not produce a positive wheelbase."));
            }
        }
    }
    return issues;
}

function ancestorOf(parents, ancestor, node) {
    let current = node;
    const seen = new Set();
    while (Number.isInteger(current) && current >= 0 && current < parents.length && !seen.has(current)) {
        seen.add(current);
        current = parents[current];
        if (current === ancestor) return true;
    }
    return false;
}

function overlaps(parents, left, right) {
    return left === right || ancestorOf(parents, left, right) || ancestorOf(parents, right, left);
}

export function validateWheelBindings(manifest, nodeTable) {
    const hidden = manifest?.model?.hiddenNodeIndices ?? [];
    const bindings = (manifest?.wheels ?? [])
        .map((wheel, index) => ({ wheel, index }))
        .filter((entry) => entry.wheel.visual?.kind === "model-node");
    if (hidden.length === 0 && bindings.length === 0) return [];
    if (!nodeTable || !Array.isArray(nodeTable.parents) || !Number.isInteger(nodeTable.count)) {
        return [issue("vehicle.model.nodes-unverified", "model", "Model node hierarchy is required to check wheel bindings.")];
    }
    const issues = [];
    const { count, parents } = nodeTable;
    const inRange = (index) => Number.isInteger(index) && index >= 0 && index < count;
    hidden.forEach((nodeIndex) => {
        if (!inRange(nodeIndex)) {
            issues.push(issue("vehicle.model.node-index", "model.hiddenNodeIndices", `Hidden node ${nodeIndex} is outside the model.`));
        }
    });
    const seen = new Map();
    for (const { wheel, index } of bindings) {
        const nodeIndex = wheel.visual.nodeIndex;
        if (!inRange(nodeIndex)) {
            issues.push(issue("vehicle.model.node-index", `wheels.${index}.visual.nodeIndex`, `Wheel "${wheel.id}" binds a node outside the model.`));
            continue;
        }
        if (seen.has(nodeIndex)) {
            issues.push(issue("vehicle.wheel.duplicate-binding", `wheels.${index}.visual.nodeIndex`, `Node ${nodeIndex} is bound to more than one wheel.`));
        } else {
            seen.set(nodeIndex, wheel.id);
        }
    }
    const boundIndices = [...seen.keys()];
    for (let left = 0; left < boundIndices.length; left += 1) {
        for (let right = left + 1; right < boundIndices.length; right += 1) {
            if (overlaps(parents, boundIndices[left], boundIndices[right])) {
                issues.push(issue("vehicle.wheel.ancestor-overlap", "wheels", `Bound nodes ${boundIndices[left]} and ${boundIndices[right]} overlap.`));
            }
        }
    }
    for (const nodeIndex of boundIndices) {
        for (const root of hidden) {
            if (!inRange(root)) continue;
            if (overlaps(parents, nodeIndex, root)) {
                issues.push(issue("vehicle.wheel.ancestor-overlap", "model.hiddenNodeIndices", `Bound node ${nodeIndex} overlaps hidden node ${root}.`));
            }
        }
    }
    for (let left = 0; left < hidden.length; left += 1) {
        for (let right = left + 1; right < hidden.length; right += 1) {
            if (inRange(hidden[left]) && inRange(hidden[right]) && overlaps(parents, hidden[left], hidden[right])) {
                issues.push(issue("vehicle.wheel.ancestor-overlap", "model.hiddenNodeIndices", `Hidden nodes ${hidden[left]} and ${hidden[right]} overlap.`));
            }
        }
    }
    return issues;
}

export function validateVehicleAssetClosure(manifest, { files = {}, nodeTable } = {}) {
    const issues = [];
    const names = new Set(Object.keys(files ?? {}));
    for (const dependency of manifest?.model?.dependencies ?? []) {
        if (!names.has(dependency)) {
            issues.push(issue("vehicle.model.missing-dependency", "model.dependencies", `Missing dependency "${dependency}".`));
        }
    }
    issues.push(...validateWheelBindings(manifest, nodeTable));
    return issues;
}
