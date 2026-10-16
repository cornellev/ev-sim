/**
 * Compare measured model nodes with the standard axle proposal.
 * Measurement never rewrites a manifest.
 */

import { canonicalFiniteNumber } from "../../simulation/kernel/SimulationHashes.js";
import {
    pairTolerance,
    proposeStandardPair,
    validateWheelBindings,
    withinPairTolerance,
} from "./standardAxle.js";

function issue(code, path, message) {
    return { code, path, message };
}

function asWheel(node, axle) {
    if (!node?.center) return null;
    return {
        position: node.center,
        radius: node.radius,
        width: node.width,
        steerable: axle === "front",
    };
}

function radialIssue(node, side) {
    if (!node?.size) return null;
    const tolerance = pairTolerance(node.size.x, node.size.y);
    if (node.radialDelta <= tolerance) return null;
    return issue(
        "vehicle.wheel.radial-asymmetry",
        `wheels.${side}`,
        `Radial extents differ by ${node.radialDelta}, outside pair tolerance ${tolerance}.`,
    );
}

export function reviewModelWheelPair({ left, right, axle } = {}) {
    const radial = [radialIssue(left, "left"), radialIssue(right, "right")].filter(Boolean);
    const proposal = proposeStandardPair(asWheel(left, axle), asWheel(right, axle), { axle });
    if (radial.length === 0) return proposal;
    return {
        ...proposal,
        withinTolerance: false,
        proposed: null,
        maxAdjustment: null,
        issues: [...radial, ...proposal.issues],
    };
}

function sameNumber(left, right) {
    return canonicalFiniteNumber(left) === canonicalFiniteNumber(right);
}

function matchesProposal(wheel, proposed, side) {
    const sign = side === "left" ? 1 : -1;
    return sameNumber(wheel.position.x, proposed.x)
        && sameNumber(wheel.position.y, proposed.y)
        && sameNumber(wheel.position.z, sign * proposed.z)
        && sameNumber(wheel.radius, proposed.radius)
        && sameNumber(wheel.width, proposed.width)
        && wheel.steerable === (proposed.steerable === true);
}

function matchesMeasurement(wheel, node) {
    return withinPairTolerance(wheel.position.x, node.center.x)
        && withinPairTolerance(wheel.position.y, node.center.y)
        && withinPairTolerance(wheel.position.z, node.center.z)
        && withinPairTolerance(wheel.radius, node.radius)
        && withinPairTolerance(wheel.width, node.width);
}

function equalsMeasurement(wheel, node) {
    return sameNumber(wheel.position.x, node.center.x)
        && sameNumber(wheel.position.y, node.center.y)
        && sameNumber(wheel.position.z, node.center.z)
        && sameNumber(wheel.radius, node.radius)
        && sameNumber(wheel.width, node.width);
}

function proposalMovement(wheel, proposed, side) {
    const sign = side === "left" ? 1 : -1;
    return Math.max(
        Math.abs(wheel.position.x - proposed.x),
        Math.abs(wheel.position.y - proposed.y),
        Math.abs(wheel.position.z - sign * proposed.z),
        Math.abs(wheel.radius - proposed.radius),
        Math.abs(wheel.width - proposed.width),
    );
}

function nodeByIndex(measurement, nodeIndex) {
    return measurement?.nodes?.find((node) => node.nodeIndex === nodeIndex) ?? null;
}

function axleMembers(wheels, axle) {
    const members = wheels.filter((wheel) => wheel.axle === axle);
    return {
        left: members.find((wheel) => wheel.side === "left") ?? null,
        right: members.find((wheel) => wheel.side === "right") ?? null,
    };
}

/**
 * Check stored bindings against a fresh measurement.
 * A fully bound axle must reproduce the measured proposal.
 * One remaining bound wheel must stay within tolerance of its own measurement.
 */
export function reviewBoundWheels(manifest, measurement) {
    const issues = [];
    const axles = [];
    if (!measurement?.nodeTable) {
        return {
            withinTolerance: false,
            unchanged: false,
            needsAcceptance: false,
            axles,
            issues: [issue("vehicle.wheel.bounds-unavailable", "model", "Wheel measurement is required.")],
        };
    }
    issues.push(...validateWheelBindings(manifest, measurement.nodeTable));
    let withinTolerance = issues.length === 0;
    let unchanged = true;
    for (const axle of ["front", "rear"]) {
        const pair = axleMembers(manifest?.wheels ?? [], axle);
        const leftBound = pair.left?.visual?.kind === "model-node";
        const rightBound = pair.right?.visual?.kind === "model-node";
        if (!leftBound && !rightBound) continue;
        if (leftBound && rightBound) {
            const left = nodeByIndex(measurement, pair.left.visual.nodeIndex);
            const right = nodeByIndex(measurement, pair.right.visual.nodeIndex);
            const review = reviewModelWheelPair({ left, right, axle });
            const storedMatches = Boolean(review.proposed)
                && matchesProposal(pair.left, review.proposed, "left")
                && matchesProposal(pair.right, review.proposed, "right");
            if (!review.withinTolerance || !review.proposed) {
                withinTolerance = false;
                unchanged = false;
                issues.push(...review.issues);
            } else if (!storedMatches) {
                unchanged = false;
            }
            axles.push({
                axle,
                review,
                storedMatches,
                movement: review.proposed
                    ? Math.max(
                        proposalMovement(pair.left, review.proposed, "left"),
                        proposalMovement(pair.right, review.proposed, "right"),
                    )
                    : null,
            });
            continue;
        }
        const wheel = leftBound ? pair.left : pair.right;
        const side = leftBound ? "left" : "right";
        const node = nodeByIndex(measurement, wheel.visual.nodeIndex);
        const radial = radialIssue(node, side);
        if (!node?.center || radial || !matchesMeasurement(wheel, node)) {
            withinTolerance = false;
            unchanged = false;
            issues.push(radial ?? issue(
                "vehicle.wheel.measurement-mismatch",
                `wheels.${side}`,
                `${axle} ${side} wheel is outside measurement tolerance.`,
            ));
            axles.push({ axle, review: null, storedMatches: false, movement: null });
            continue;
        }
        const storedMatches = equalsMeasurement(wheel, node);
        if (!storedMatches) unchanged = false;
        axles.push({
            axle,
            review: {
                withinTolerance: true,
                measured: { [side]: node },
                proposed: {
                    x: canonicalFiniteNumber(node.center.x),
                    y: canonicalFiniteNumber(node.center.y),
                    z: canonicalFiniteNumber(Math.abs(node.center.z)),
                    radius: canonicalFiniteNumber(node.radius),
                    width: canonicalFiniteNumber(node.width),
                    steerable: wheel.steerable === true,
                },
                maxAdjustment: Math.max(
                    Math.abs(wheel.position.x - node.center.x),
                    Math.abs(wheel.position.y - node.center.y),
                    Math.abs(wheel.position.z - node.center.z),
                    Math.abs(wheel.radius - node.radius),
                    Math.abs(wheel.width - node.width),
                ),
                issues: [],
            },
            storedMatches,
            singleSide: side,
            movement: storedMatches ? 0 : Math.max(
                Math.abs(wheel.position.x - node.center.x),
                Math.abs(wheel.position.y - node.center.y),
                Math.abs(wheel.position.z - node.center.z),
                Math.abs(wheel.radius - node.radius),
                Math.abs(wheel.width - node.width),
            ),
        });
    }
    return {
        withinTolerance,
        unchanged,
        needsAcceptance: withinTolerance && !unchanged,
        axles,
        issues,
    };
}

export function manifestHasBoundWheels(manifest) {
    return (manifest?.wheels ?? []).some((wheel) => wheel.visual?.kind === "model-node");
}
