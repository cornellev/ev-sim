/**
 * URDF import plan. Nothing is written until a caller accepts the patch
 * and later saves through the vehicle publication service.
 */

import { canonicalFiniteNumber } from "../../simulation/kernel/SimulationHashes.js";
import { reviewModelWheelPair } from "../axle/reviewModelWheels.js";
import { withinPairTolerance } from "../axle/standardAxle.js";
import { CONTACT_BICYCLE_MODEL, createBlankVehicleManifest, normalizeVehicleManifest } from "../VehicleManifest.js";
import { bakeUrdfGeometry } from "./bakeUrdfGeometry.js";
import { urdfIssue } from "./issue.js";
import { parseUrdfRobot } from "./parseUrdfRobot.js";
import { readUrdfPackage } from "./urdfPackage.js";

const TREE_CODES = new Set([
    "vehicle.urdf.multiple-roots",
    "vehicle.urdf.cycle",
    "vehicle.urdf.dangling-link",
    "vehicle.urdf.multiple-parents",
    "vehicle.urdf.depth",
    "vehicle.urdf.xacro",
    "vehicle.urdf.entity",
    "vehicle.urdf.parse",
    "vehicle.urdf.xml-limit",
    "vehicle.urdf.missing-entry",
    "vehicle.urdf.package-escape",
    "vehicle.urdf.ambiguous-path",
]);

function treeBlocked(issues) {
    return issues.some((entry) => TREE_CODES.has(entry.code));
}

function sideOf(center) {
    if (!center || withinPairTolerance(center.z, 0)) return "center";
    return center.z > 0 ? "left" : "right";
}

function nodeForLink(closure, measurement, link) {
    const record = closure?.nodes?.find((node) => node.name === link);
    if (!record || !measurement) return null;
    return measurement.nodes.find((node) => node.nodeIndex === record.index) ?? null;
}

function measuredWheel(wheel, node) {
    return {
        ...wheel,
        node,
        nodeIndex: node?.nodeIndex ?? null,
        center: node?.center ?? null,
        side: node?.center ? sideOf(node.center) : "center",
    };
}

function clusterByX(wheels) {
    const sorted = [...wheels].sort((left, right) => left.center.x - right.center.x);
    const clusters = [];
    for (const wheel of sorted) {
        const last = clusters.at(-1);
        if (!last || !withinPairTolerance(last.anchor, wheel.center.x)) {
            clusters.push({ anchor: wheel.center.x, wheels: [wheel] });
        } else last.wheels.push(wheel);
    }
    return clusters;
}

function pairCluster(cluster, axle, issues) {
    const left = cluster.wheels.find((wheel) => wheel.side === "left");
    const right = cluster.wheels.find((wheel) => wheel.side === "right");
    const centerline = cluster.wheels.filter((wheel) => wheel.side === "center");
    for (const wheel of centerline) {
        issues.push(urdfIssue("vehicle.urdf.centerline-wheel", `robot/link[${wheel.link}]`, `Wheel "${wheel.link}" lies on the vehicle centerline.`));
    }
    if (!left || !right || cluster.wheels.length !== 2) return null;
    const review = reviewModelWheelPair({ left: left.node, right: right.node, axle });
    return { axle, left, right, review, x: review.proposed?.x ?? cluster.anchor };
}

function reviewWheels(bake, robot, issues) {
    const unclassified = [];
    const measured = (bake.wheelLinks ?? []).map((wheel) => measuredWheel(wheel, nodeForLink(bake.closure, bake.measurement, wheel.link)));
    for (const wheel of measured) {
        if (!wheel.center || !(wheel.node?.radius > 0) || !(wheel.node?.width > 0)) {
            issues.push(urdfIssue("vehicle.wheel.bounds-unavailable", `robot/link[${wheel.link}]`, `Wheel "${wheel.link}" has no measurable geometry.`));
        }
    }
    const usable = measured.filter((wheel) => wheel.center && wheel.node?.radius > 0 && wheel.node?.width > 0);
    const steered = usable.filter((wheel) => wheel.steeringJoint);
    const fixed = usable.filter((wheel) => !wheel.steeringJoint);
    let front = null;
    const steeredCluster = steered.length > 0 ? { anchor: steered.reduce((sum, wheel) => sum + wheel.center.x, 0) / steered.length, wheels: steered } : null;
    if (steeredCluster) {
        front = pairCluster(steeredCluster, "front", issues);
        if (!front) {
            issues.push(urdfIssue("vehicle.axle.incomplete-pair", "wheels", "The steered wheels are not one left/right pair."));
            unclassified.push(...steered);
        }
    }
    const fixedClusters = clusterByX(fixed).map((cluster) => ({ ...cluster, pair: pairCluster(cluster, "rear", issues) }));
    let rear = null;
    const rearCandidates = [];
    for (const cluster of fixedClusters) {
        if (!cluster.pair) {
            unclassified.push(...cluster.wheels);
            continue;
        }
        if (front && cluster.pair.x > front.x && !withinPairTolerance(cluster.pair.x, front.x)) {
            issues.push(urdfIssue("vehicle.urdf.rear-steering", "wheels", "A fixed axle sits ahead of the steered axle."));
            unclassified.push(...cluster.wheels);
            continue;
        }
        rearCandidates.push(cluster.pair);
    }
    if (!front) {
        rearCandidates.sort((left, right) => left.x - right.x);
        rear = rearCandidates.shift() ?? null;
        for (const extra of rearCandidates) unclassified.push(extra.left, extra.right);
    } else if (rearCandidates.length > 0) {
        rearCandidates.sort((left, right) => right.x - left.x);
        rear = rearCandidates.shift() ?? null;
        for (const extra of rearCandidates) unclassified.push(extra.left, extra.right);
    }
    for (const pair of [front, rear]) {
        if (pair && !pair.review.withinTolerance) issues.push(...pair.review.issues);
    }
    return { front, rear, unclassified };
}

export function deriveBicycleSteeringLimit(joints) {
    if (!joints || joints.length === 0) return { status: "absent", maxSteeringAngle: null, ranges: [] };
    const ranges = [];
    for (const joint of joints) {
        const lower = joint.limit?.lower;
        const upper = joint.limit?.upper;
        if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
            return { status: "required", maxSteeringAngle: null, ranges };
        }
        const sign = joint.axisInRoot.z >= 0 ? 1 : -1;
        const scale = 0 - sign;
        let commandLower = scale * lower;
        let commandUpper = scale * upper;
        if (commandLower > commandUpper) [commandLower, commandUpper] = [commandUpper, commandLower];
        ranges.push({ joint: joint.name, lower: commandLower, upper: commandUpper });
    }
    const magnitudes = [];
    for (const range of ranges) {
        if (range.lower > 0 || range.upper < 0) return { status: "required", maxSteeringAngle: null, ranges };
        magnitudes.push(Math.min(Math.abs(range.lower), Math.abs(range.upper)));
    }
    const smallest = Math.min(...magnitudes);
    const largest = Math.max(...magnitudes);
    if (!(smallest > 0) || !withinPairTolerance(smallest, largest)) {
        return { status: "required", maxSteeringAngle: null, ranges };
    }
    return { status: "derived", maxSteeringAngle: canonicalFiniteNumber(smallest), ranges };
}

function steeringFor(robot, review) {
    const names = review?.front
        ? [review.front.left.steeringJoint, review.front.right.steeringJoint].filter(Boolean)
        : [];
    const joints = names.map((name) => robot.joints[name]).filter(Boolean);
    return deriveBicycleSteeringLimit(joints);
}

function emptyPlan(source, diagnostics, omissions = []) {
    return {
        kind: "cev-sim.urdf-import-plan",
        version: 1,
        source,
        diagnostics,
        omissions,
        closure: null,
        measurement: null,
        wheelReview: null,
        steering: { status: "absent", maxSteeringAngle: null, ranges: [] },
        body: { boundingBox: null, model: null },
        patch: null,
    };
}

/** Plan a local URDF import. The patch stays null until `acceptUrdfImport`. */
export function planUrdfImport(packageInput) {
    const pkg = packageInput?.fileMap ? packageInput : readUrdfPackage(packageInput);
    const diagnostics = [...(pkg.diagnostics ?? [])];
    const omissions = [];
    if (treeBlocked(diagnostics) || !pkg.fileMap?.has(pkg.entryPath)) return emptyPlan(pkg.source, diagnostics, omissions);
    const parsed = parseUrdfRobot(pkg.fileMap.get(pkg.entryPath), { entryPath: pkg.entryPath });
    diagnostics.push(...parsed.issues);
    omissions.push(...parsed.omissions);
    if (!parsed.robot || treeBlocked(diagnostics)) return emptyPlan(pkg.source, diagnostics, omissions);
    const bake = bakeUrdfGeometry(parsed.robot, pkg);
    diagnostics.push(...bake.issues);
    const geometryIssues = diagnostics.filter((entry) => entry.severity !== "info");
    const wheelReview = geometryIssues.length > 0 ? null : reviewWheels(bake, parsed.robot, diagnostics);
    const steering = wheelReview
        ? steeringFor(parsed.robot, wheelReview)
        : { status: "absent", maxSteeringAngle: null, ranges: [] };
    if (steering.status === "required") {
        diagnostics.push(urdfIssue(
            "vehicle.urdf.steering-limit-required",
            "kinematics.maxSteeringAngle",
            "The steering joints do not map to one symmetric bicycle limit.",
        ));
    }
    const closureBlocked = geometryIssues.length > 0;
    return {
        kind: "cev-sim.urdf-import-plan",
        version: 1,
        source: pkg.source,
        diagnostics,
        omissions,
        closure: closureBlocked ? null : bake.closure,
        measurement: closureBlocked ? null : bake.measurement,
        wheelReview,
        steering,
        body: {
            boundingBox: bake.boundingBox,
            model: bake.model,
        },
        patch: null,
        robotName: parsed.robot.name,
    };
}

function wheelRecord(axle, side, proposed, nodeIndex) {
    const sign = side === "left" ? 1 : -1;
    return {
        id: `${axle}-${side}`,
        position: { x: proposed.x, y: proposed.y, z: canonicalFiniteNumber(sign * proposed.z) },
        radius: proposed.radius,
        width: proposed.width,
        steerable: axle === "front",
        axle,
        side,
        visual: { kind: "model-node", nodeIndex },
    };
}

function generatedWheel(wheel) {
    return {
        id: `generated-${wheel.nodeIndex}`,
        position: {
            x: canonicalFiniteNumber(wheel.center.x),
            y: canonicalFiniteNumber(wheel.center.y),
            z: canonicalFiniteNumber(wheel.center.z),
        },
        radius: canonicalFiniteNumber(wheel.node.radius),
        width: canonicalFiniteNumber(wheel.node.width),
        steerable: false,
    };
}

/** Build the reviewed patch. Geometry is copied only when `acceptAdjustments` is set. */
export function acceptUrdfImport(plan, { acceptAdjustments = false, maxSteeringAngle = null, unclassified = "omit" } = {}) {
    const issues = (plan?.diagnostics ?? []).filter((entry) => entry.severity !== "info");
    if (!plan?.closure || !plan.body?.boundingBox) {
        return {
            ok: false,
            patch: null,
            issues: issues.length > 0
                ? issues
                : [urdfIssue("vehicle.urdf.unsupported-mesh", "model", "URDF geometry did not produce a canonical model.")],
        };
    }
    const blocking = issues.filter((entry) => entry.code !== "vehicle.urdf.steering-limit-required" && entry.code !== "vehicle.urdf.accept-required");
    const review = plan?.wheelReview;
    const pairs = [review?.front, review?.rear].filter(Boolean);
    if (pairs.some((pair) => !pair.review?.withinTolerance)) {
        return { ok: false, patch: null, issues: blocking.length > 0 ? blocking : issues };
    }
    if (blocking.length > 0) return { ok: false, patch: null, issues: blocking };
    if (!acceptAdjustments) {
        return {
            ok: false,
            patch: null,
            issues: [urdfIssue("vehicle.urdf.accept-required", "wheels", "Accept the measured wheel geometry before applying the URDF.")],
        };
    }
    let steeringAngle;
    if (plan.steering?.status === "required") {
        const explicit = Number(maxSteeringAngle);
        if (!Number.isFinite(explicit) || !(explicit > 0)) {
            return {
                ok: false,
                patch: null,
                issues: [urdfIssue("vehicle.urdf.steering-limit-required", "kinematics.maxSteeringAngle", "Enter a steering limit. The URDF joints do not determine one.")],
            };
        }
        steeringAngle = canonicalFiniteNumber(explicit);
    } else if (plan.steering?.status === "derived") {
        steeringAngle = Number.isFinite(maxSteeringAngle) ? canonicalFiniteNumber(maxSteeringAngle) : plan.steering.maxSteeringAngle;
    }
    const hidden = [];
    const wheels = [];
    for (const pair of pairs) {
        wheels.push(
            wheelRecord(pair.axle, "left", pair.review.proposed, pair.left.nodeIndex),
            wheelRecord(pair.axle, "right", pair.review.proposed, pair.right.nodeIndex),
        );
    }
    if (unclassified === "generated") {
        for (const wheel of review?.unclassified ?? []) {
            if (wheel.nodeIndex == null) continue;
            hidden.push(wheel.nodeIndex);
            wheels.push(generatedWheel(wheel));
        }
    }
    hidden.sort((left, right) => left - right);
    const patch = {
        model: {
            asset: plan.closure.asset.name,
            dependencies: plan.closure.dependencies.map((entry) => entry.name),
            hiddenNodeIndices: hidden,
            scale: 1,
            rotation: plan.body.model.rotation,
            offset: plan.body.model.offset,
        },
        boundingBox: plan.body.boundingBox,
    };
    if (pairs.length > 0 || hidden.length > 0) patch.wheels = wheels;
    if (review?.front && review?.rear) {
        patch.wheelbase = canonicalFiniteNumber(Math.abs(review.front.review.proposed.x - review.rear.review.proposed.x));
    }
    if (steeringAngle !== undefined) patch.maxSteeringAngle = steeringAngle;
    return { ok: true, patch, issues: [] };
}

/** New version 3 manifest. An existing vehicle should use `applyReviewedUrdfPatch` instead. */
export function manifestFromUrdfImport(plan, accepted, { id, name } = {}) {
    if (!accepted?.ok || !accepted.patch) throw new Error("URDF import has not been accepted.");
    const blank = createBlankVehicleManifest({ id, name });
    const patch = accepted.patch;
    return normalizeVehicleManifest({
        ...blank,
        id: id ?? blank.id,
        name: name ?? plan?.robotName ?? blank.name,
        description: blank.description,
        model: { ...blank.model, ...patch.model },
        boundingBox: patch.boundingBox,
        egoCenter: patch.boundingBox.center,
        wheels: patch.wheels ?? blank.wheels,
        kinematics: {
            ...blank.kinematics,
            ...(patch.wheelbase !== undefined ? { wheelbase: patch.wheelbase } : {}),
            ...(patch.maxSteeringAngle !== undefined ? { maxSteeringAngle: patch.maxSteeringAngle } : {}),
        },
        dynamics: { model: CONTACT_BICYCLE_MODEL },
    });
}
