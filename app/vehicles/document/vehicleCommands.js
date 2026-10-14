import { cloneJson } from "../../util/cloneJson.js";
import { canonicalFiniteNumber } from "../../simulation/kernel/SimulationHashes.js";
import { deriveCompleteWheelbase, proposeStandardPair, validateWheelBindings } from "../axle/standardAxle.js";
import { reviewBoundWheels, reviewModelWheelPair } from "../axle/reviewModelWheels.js";
import { measurePlacedVehicleModel } from "../model/measurePlacedVehicle.js";
import {
    VEHICLE_MANIFEST_VERSION_V3,
    normalizeVehicleManifest,
    validateVehicleManifest,
} from "../VehicleManifest.js";

function issue(code, path, message) {
    return { code, path, message };
}

function fail(issues) {
    return { ok: false, manifest: null, issues };
}

function axlePair(wheels, axle) {
    const members = wheels.filter((wheel) => wheel.axle === axle);
    const left = members.find((wheel) => wheel.side === "left") ?? null;
    const right = members.find((wheel) => wheel.side === "right") ?? null;
    return { members, left, right };
}

function withWheelbase(manifest) {
    const derived = deriveCompleteWheelbase(manifest.wheels);
    if (derived == null) return manifest;
    return {
        ...manifest,
        kinematics: { ...manifest.kinematics, wheelbase: derived },
    };
}

/**
 * Apply one cumulative axle patch to a manifest snapshot.
 * Geometry edits are refused while either wheel is model-bound.
 */
export function applyAxlePatch(manifest, { axle, patch = {}, normalizeOptions } = {}) {
    if (manifest?.version !== VEHICLE_MANIFEST_VERSION_V3) {
        return fail([issue("vehicle.manifest.version", "version", "Axle edits require a version 3 vehicle.")]);
    }
    if (axle !== "front" && axle !== "rear") {
        return fail([issue("vehicle.axle.incomplete-pair", "wheels", `Unsupported axle "${axle}".`)]);
    }
    const next = cloneJson(manifest);
    const pair = axlePair(next.wheels, axle);
    if (!pair.left || !pair.right || pair.members.length !== 2) {
        return fail([issue("vehicle.axle.incomplete-pair", "wheels", `Axle "${axle}" must contain one left and one right wheel.`)]);
    }
    if (pair.left.visual || pair.right.visual) {
        return fail([issue("vehicle.axle.geometry-locked", "wheels", "Detach the model-bound wheels before editing this axle.")]);
    }
    if (patch.x !== undefined) {
        pair.left.position.x = patch.x;
        pair.right.position.x = patch.x;
    }
    if (patch.y !== undefined) {
        pair.left.position.y = patch.y;
        pair.right.position.y = patch.y;
    }
    if (patch.z !== undefined) {
        const halfTrack = Math.abs(patch.z);
        pair.left.position.z = halfTrack;
        pair.right.position.z = -halfTrack;
    }
    if (patch.radius !== undefined) {
        pair.left.radius = patch.radius;
        pair.right.radius = patch.radius;
    }
    if (patch.width !== undefined) {
        pair.left.width = patch.width;
        pair.right.width = patch.width;
    }
    pair.left.steerable = axle === "front";
    pair.right.steerable = axle === "front";
    const normalized = normalizeVehicleManifest(withWheelbase(next), normalizeOptions);
    const edited = axlePair(normalized.wheels, axle);
    const proposal = proposeStandardPair(edited.left, edited.right, { axle });
    if (!proposal.withinTolerance) return fail(proposal.issues);
    const complete = normalized.wheels.every((wheel) => wheel.axle === "front" || wheel.axle === "rear")
        && normalized.wheels.some((wheel) => wheel.axle === "front")
        && normalized.wheels.some((wheel) => wheel.axle === "rear");
    if (complete && deriveCompleteWheelbase(normalized.wheels) == null) {
        return fail([issue("vehicle.axle.wheelbase-mismatch", "kinematics.wheelbase", "Standard axle positions do not produce a positive wheelbase.")]);
    }
    return { ok: true, manifest: normalized, issues: [] };
}

function clearBakedLidarZone(manifest) {
    const params = manifest.lidarZone?.params ?? { voxelSize: 0.2 };
    manifest.lidarZone = {
        params: { ...params },
        vertices: [],
        triangles: [],
    };
}

function measurementError(error) {
    return issue(error?.code || "vehicle.wheel.bounds-unavailable", "model", error?.message || "Wheel measurement failed.");
}

function resolveMeasurement(manifest, { glbBytes = null, measurement = null } = {}) {
    if (glbBytes) {
        try {
            return {
                measurement: measurePlacedVehicleModel({
                    glbBytes,
                    model: manifest.model,
                    boundingBox: manifest.boundingBox,
                    hiddenNodeIndices: manifest.model?.hiddenNodeIndices ?? [],
                }),
            };
        } catch (error) {
            return { error };
        }
    }
    if (measurement) return { measurement };
    return { error: new Error("Wheel measurement requires the canonical model.") };
}

function mergePlacement(manifest, { model, boundingBox } = {}) {
    if (model) {
        manifest.model = {
            ...manifest.model,
            ...model,
            rotation: model.rotation ? { ...manifest.model.rotation, ...model.rotation } : manifest.model.rotation,
            offset: model.offset ? { ...manifest.model.offset, ...model.offset } : manifest.model.offset,
        };
    }
    if (boundingBox) {
        manifest.boundingBox = {
            ...manifest.boundingBox,
            ...boundingBox,
            size: boundingBox.size ? { ...manifest.boundingBox.size, ...boundingBox.size } : manifest.boundingBox.size,
            center: boundingBox.center ? { ...manifest.boundingBox.center, ...boundingBox.center } : manifest.boundingBox.center,
        };
    }
}

function placementUnchanged(before, after) {
    const same = (left, right) => canonicalFiniteNumber(left) === canonicalFiniteNumber(right);
    return same(before.model.scale, after.model.scale)
        && same(before.model.rotation.x, after.model.rotation.x)
        && same(before.model.rotation.y, after.model.rotation.y)
        && same(before.model.rotation.z, after.model.rotation.z)
        && before.model.rotation.order === after.model.rotation.order
        && same(before.model.offset.x, after.model.offset.x)
        && same(before.model.offset.y, after.model.offset.y)
        && same(before.model.offset.z, after.model.offset.z)
        && same(before.boundingBox.center.x, after.boundingBox.center.x)
        && same(before.boundingBox.center.y, after.boundingBox.center.y)
        && same(before.boundingBox.center.z, after.boundingBox.center.z)
        && same(before.boundingBox.size.x, after.boundingBox.size.x)
        && same(before.boundingBox.size.y, after.boundingBox.size.y)
        && same(before.boundingBox.size.z, after.boundingBox.size.z);
}

function ensureAxleWheel(manifest, axle, side) {
    const id = `${axle}-${side}`;
    let wheel = manifest.wheels.find((entry) => entry.axle === axle && entry.side === side)
        ?? manifest.wheels.find((entry) => entry.id === id);
    if (!wheel) {
        wheel = {
            id,
            position: { x: 0, y: 0, z: 0 },
            radius: 0.25,
            width: 0.25,
            steerable: axle === "front",
        };
        manifest.wheels.push(wheel);
    }
    return wheel;
}

function writeProposedGeometry(wheel, proposed, side) {
    const sign = side === "left" ? 1 : -1;
    wheel.position = {
        x: proposed.x,
        y: proposed.y,
        z: canonicalFiniteNumber(sign * proposed.z),
    };
    wheel.radius = proposed.radius;
    wheel.width = proposed.width;
    wheel.steerable = proposed.steerable === true;
}

function writeProposedWheel(wheel, proposed, axle, side, nodeIndex) {
    writeProposedGeometry(wheel, proposed, side);
    wheel.axle = axle;
    wheel.side = side;
    wheel.visual = { kind: "model-node", nodeIndex };
}

function applyAssignedPair(manifest, { axle, leftNodeIndex, rightNodeIndex, measurement }) {
    const leftNode = measurement.nodes.find((node) => node.nodeIndex === leftNodeIndex);
    const rightNode = measurement.nodes.find((node) => node.nodeIndex === rightNodeIndex);
    const review = reviewModelWheelPair({ left: leftNode, right: rightNode, axle });
    if (leftNodeIndex === rightNodeIndex) {
        return {
            ok: false,
            review,
            issues: [issue("vehicle.wheel.duplicate-binding", "wheels", "A wheel pair needs two different nodes.")],
        };
    }
    if (!review.withinTolerance || !review.proposed) return { ok: false, review, issues: review.issues };
    const left = ensureAxleWheel(manifest, axle, "left");
    const right = ensureAxleWheel(manifest, axle, "right");
    writeProposedWheel(left, review.proposed, axle, "left", leftNodeIndex);
    writeProposedWheel(right, review.proposed, axle, "right", rightNodeIndex);
    const hidden = new Set(manifest.model.hiddenNodeIndices ?? []);
    hidden.delete(leftNodeIndex);
    hidden.delete(rightNodeIndex);
    manifest.model.hiddenNodeIndices = [...hidden];
    const bindingIssues = validateWheelBindings(manifest, measurement.nodeTable);
    if (bindingIssues.length > 0) return { ok: false, review, issues: bindingIssues };
    return { ok: true, review, issues: [] };
}

export function previewVehiclePlacement(manifest, patch = {}) {
    const next = cloneJson(manifest);
    mergePlacement(next, patch);
    return next;
}

function command(label, run) {
    return { label, run };
}

export function applyMigration(plan) {
    return command("Migrate vehicle", (context) => {
        if (!plan?.ok || !plan.proposedManifest) {
            const message = plan?.diagnostics?.[0]?.message ?? "Migration plan is blocked.";
            context.issue("vehicle.migration.blocked", "", message);
            return { ok: false };
        }
        context.setManifest(plan.proposedManifest);
        return { ok: true };
    });
}

export function editAxle({ axle, patch }) {
    return command(`Edit ${axle} axle`, (context) => {
        const applied = applyAxlePatch(context.manifest, { axle, patch });
        if (!applied.ok) {
            for (const entry of applied.issues) context.issue(entry.code, entry.path, entry.message);
            return { ok: false };
        }
        context.setManifest(applied.manifest);
        return { ok: true };
    });
}

export function editWheel({ wheelId, patch }) {
    return command("Edit wheel", (context) => {
        const next = cloneJson(context.manifest);
        const wheel = next.wheels.find((entry) => entry.id === wheelId);
        if (!wheel) {
            context.issue("vehicle.wheel.missing", "wheels", `Wheel "${wheelId}" does not exist.`);
            return { ok: false };
        }
        if (wheel.axle || patch.axle !== undefined || patch.side !== undefined) {
            context.issue("vehicle.axle.incomplete-pair", "wheels", "Use an axle edit to change a standard-axle wheel.");
            return { ok: false };
        }
        if (patch.position) wheel.position = { ...wheel.position, ...patch.position };
        if (patch.radius !== undefined) wheel.radius = patch.radius;
        if (patch.width !== undefined) wheel.width = patch.width;
        if (patch.steerable !== undefined) wheel.steerable = patch.steerable === true;
        context.setManifest(next);
        return { ok: true };
    });
}

function pairByRole(wheels, axle) {
    const left = wheels.find((wheel) => wheel.axle === axle && wheel.side === "left")
        ?? wheels.find((wheel) => wheel.id === `${axle}-left`);
    const right = wheels.find((wheel) => wheel.axle === axle && wheel.side === "right")
        ?? wheels.find((wheel) => wheel.id === `${axle}-right`);
    return { left, right };
}

function adoptPair(manifest, axle) {
    const wheels = manifest.wheels ?? [];
    const { left, right } = pairByRole(wheels, axle);
    const proposal = proposeStandardPair(left, right, { axle });
    if (!proposal.withinTolerance || !proposal.proposed) {
        return { ok: false, issues: proposal.issues };
    }
    const next = cloneJson(manifest);
    next.version = VEHICLE_MANIFEST_VERSION_V3;
    for (const wheel of next.wheels) {
        if (wheel.id !== left.id && wheel.id !== right.id) continue;
        const side = wheel.id === left.id ? "left" : "right";
        const sign = side === "left" ? 1 : -1;
        wheel.position = {
            x: proposal.proposed.x,
            y: proposal.proposed.y,
            z: canonicalFiniteNumber(sign * proposal.proposed.z),
        };
        wheel.radius = proposal.proposed.radius;
        wheel.width = proposal.proposed.width;
        wheel.steerable = proposal.proposed.steerable === true;
        wheel.axle = axle;
        wheel.side = side;
    }
    return { ok: true, manifest: withWheelbase(next), issues: [] };
}

export function adoptStandardPair({ axle, acceptAdjustments = false }) {
    return command(`Adopt ${axle} axle`, (context) => {
        if (!acceptAdjustments) {
            context.issue("vehicle.axle.asymmetric", "wheels", "Accept the proposed axle adjustments before applying them.");
            return { ok: false };
        }
        const applied = adoptPair(context.manifest, axle);
        if (!applied.ok) {
            for (const entry of applied.issues) context.issue(entry.code, entry.path, entry.message);
            return { ok: false };
        }
        context.setManifest(applied.manifest);
        return { ok: true };
    });
}

/** Adopt every named front/rear pair in one undo step. */
export function adoptStandardAxles({ axles = ["front", "rear"] } = {}) {
    return command("Group standard axles", (context) => {
        let current = context.manifest;
        let changed = false;
        for (const axle of axles) {
            const wheels = current.wheels ?? [];
            const left = wheels.find((wheel) => wheel.id === `${axle}-left`);
            const right = wheels.find((wheel) => wheel.id === `${axle}-right`);
            if (!left || !right) continue;
            if (left.axle === axle && right.axle === axle && left.side === "left" && right.side === "right") continue;
            const applied = adoptPair(current, axle);
            if (!applied.ok) {
                for (const entry of applied.issues) context.issue(entry.code, entry.path, entry.message);
                return { ok: false };
            }
            current = applied.manifest;
            changed = true;
        }
        if (!changed) return { ok: true, history: false };
        context.setManifest(current);
        return { ok: true };
    });
}

export function classifyWheel({ wheelId, axle = null, side = null }) {
    return command("Classify wheel", (context) => {
        const next = cloneJson(context.manifest);
        const wheel = next.wheels.find((entry) => entry.id === wheelId);
        if (!wheel) {
            context.issue("vehicle.wheel.missing", "wheels", `Wheel "${wheelId}" does not exist.`);
            return { ok: false };
        }
        if (wheel.visual?.kind === "model-node") {
            context.issue("vehicle.axle.geometry-locked", "wheels", "Detach the model-bound wheel before changing its axle.");
            return { ok: false };
        }
        if (!axle && !side) {
            const previous = wheel.axle;
            delete wheel.axle;
            delete wheel.side;
            if (previous) {
                const remaining = next.wheels.filter((entry) => entry.axle === previous);
                const complete = remaining.length === 2
                    && remaining.some((entry) => entry.side === "left")
                    && remaining.some((entry) => entry.side === "right");
                if (!complete) {
                    for (const entry of remaining) {
                        delete entry.axle;
                        delete entry.side;
                    }
                }
            }
            context.setManifest(withWheelbase(next));
            return { ok: true };
        }
        if ((axle !== "front" && axle !== "rear") || (side !== "left" && side !== "right")) {
            context.issue("vehicle.axle.incomplete-pair", "wheels", "Choose a front or rear side.");
            return { ok: false };
        }
        const occupied = next.wheels.find((entry) => entry.id !== wheel.id && entry.axle === axle && entry.side === side);
        if (occupied) {
            context.issue("vehicle.axle.incomplete-pair", "wheels", `${axle} ${side} is already assigned to ${occupied.id}.`);
            return { ok: false };
        }
        wheel.axle = axle;
        wheel.side = side;
        wheel.steerable = axle === "front";
        next.version = VEHICLE_MANIFEST_VERSION_V3;
        context.setManifest(withWheelbase(next));
        return { ok: true };
    });
}

function partnerWheel(wheels, wheel, mode) {
    if (!wheel?.axle || !wheel?.side) return null;
    if (mode === "mirror") {
        const side = wheel.side === "left" ? "right" : "left";
        return wheels.find((entry) => entry.id !== wheel.id && entry.axle === wheel.axle && entry.side === side) ?? null;
    }
    const axle = wheel.axle === "front" ? "rear" : "front";
    return wheels.find((entry) => entry.id !== wheel.id && entry.axle === axle && entry.side === wheel.side) ?? null;
}

/**
 * Copy one partner onto the selected wheel.
 * `mirror` reads the other side of the same axle and flips lateral position.
 * `align` reads the same side of the other axle and copies only lateral position.
 */
export function copyWheelFromPartner({ wheelId, mode }) {
    const label = mode === "align" ? "Align wheel" : "Mirror complementary wheel";
    return command(label, (context) => {
        if (mode !== "mirror" && mode !== "align") {
            context.issue("vehicle.wheel.partner", "wheels", "Choose a complementary mirror or a same-side alignment.");
            return { ok: false };
        }
        const next = cloneJson(context.manifest);
        const wheel = next.wheels.find((entry) => entry.id === wheelId);
        if (!wheel) {
            context.issue("vehicle.wheel.missing", "wheels", `Wheel "${wheelId}" does not exist.`);
            return { ok: false };
        }
        if (wheel.visual?.kind === "model-node") {
            context.issue("vehicle.axle.geometry-locked", "wheels", "Detach the model-bound wheel before copying a partner.");
            return { ok: false };
        }
        if (!wheel.axle || !wheel.side) {
            context.issue("vehicle.wheel.partner", "wheels", "Classify this wheel before copying a partner.");
            return { ok: false };
        }
        const source = partnerWheel(next.wheels, wheel, mode);
        if (!source) {
            const message = mode === "mirror"
                ? "The other side of this axle is not classified."
                : "The same side of the other axle is not classified.";
            context.issue("vehicle.wheel.partner", "wheels", message);
            return { ok: false };
        }
        if (mode === "mirror") {
            wheel.position = {
                x: source.position.x,
                y: source.position.y,
                z: canonicalFiniteNumber(-source.position.z),
            };
            wheel.radius = source.radius;
            wheel.width = source.width;
        } else {
            wheel.position = { ...wheel.position, z: source.position.z };
        }
        context.setManifest(withWheelbase(next));
        return { ok: true };
    });
}

export function detachWheel({ wheelId }) {
    return command("Detach wheel", (context) => {
        if (context.manifest.version !== VEHICLE_MANIFEST_VERSION_V3) {
            context.issue("vehicle.manifest.version", "version", "Wheel detachment requires a version 3 vehicle.");
            return { ok: false };
        }
        const next = cloneJson(context.manifest);
        const wheel = next.wheels.find((entry) => entry.id === wheelId);
        if (!wheel?.visual || wheel.visual.kind !== "model-node") {
            context.issue("vehicle.wheel.unbound", "wheels", "Wheel has no model binding to detach.");
            return { ok: false };
        }
        const hidden = new Set(next.model.hiddenNodeIndices ?? []);
        hidden.add(wheel.visual.nodeIndex);
        next.model.hiddenNodeIndices = [...hidden];
        delete wheel.visual;
        clearBakedLidarZone(next);
        context.setManifest(next);
        return { ok: true };
    });
}

export function reattachWheel({ wheelId, nodeIndex }) {
    return command("Reattach wheel", (context) => {
        if (context.manifest.version !== VEHICLE_MANIFEST_VERSION_V3) {
            context.issue("vehicle.manifest.version", "version", "Wheel reattachment requires a version 3 vehicle.");
            return { ok: false };
        }
        const next = cloneJson(context.manifest);
        const wheel = next.wheels.find((entry) => entry.id === wheelId);
        if (!wheel) {
            context.issue("vehicle.wheel.missing", "wheels", `Wheel "${wheelId}" does not exist.`);
            return { ok: false };
        }
        if (!wheel.axle || !wheel.side) {
            context.issue("vehicle.wheel.visual", "wheels", "A model binding requires a standard axle and side.");
            return { ok: false };
        }
        wheel.visual = { kind: "model-node", nodeIndex };
        next.model.hiddenNodeIndices = (next.model.hiddenNodeIndices ?? []).filter((index) => index !== nodeIndex);
        clearBakedLidarZone(next);
        context.setManifest(next);
        return { ok: true };
    });
}

export function editBody({ boundingBox, egoCenter } = {}) {
    return command("Edit body", (context) => {
        const next = cloneJson(context.manifest);
        if (boundingBox) next.boundingBox = { ...next.boundingBox, ...boundingBox };
        if (egoCenter) next.egoCenter = egoCenter;
        context.setManifest(next);
        return { ok: true };
    });
}

export function editSensors({ sensors }) {
    return command("Edit sensors", (context) => {
        const next = cloneJson(context.manifest);
        next.sensors = sensors;
        context.setManifest(next);
        return { ok: true };
    });
}

export function editKinematics({ patch }) {
    return command("Edit kinematics", (context) => {
        const derived = deriveCompleteWheelbase(context.manifest.wheels);
        if (derived != null && patch?.wheelbase !== undefined && canonicalFiniteNumber(patch.wheelbase) !== derived) {
            context.issue("vehicle.axle.wheelbase-mismatch", "kinematics.wheelbase", "A complete standard layout derives its wheelbase from the axles.");
            return { ok: false };
        }
        const next = cloneJson(context.manifest);
        next.kinematics = { ...next.kinematics, ...patch };
        context.setManifest(next);
        return { ok: true };
    });
}

export function editManifestFields(manifest, label = "Edit") {
    return command(label, (context) => {
        context.setManifest(manifest);
        return { ok: true };
    });
}

export function replaceManifest(manifest, options) {
    return command("Replace manifest", (context) => {
        const validation = validateVehicleManifest(manifest, options ?? context.normalizeOptions);
        if (!validation.ok) {
            for (const entry of validation.issues) {
                context.issue(entry.code ?? "vehicle.manifest.invalid", entry.path ?? "", entry.message);
            }
            return { ok: false };
        }
        context.setManifest(validation.manifest);
        return { ok: true };
    });
}

export function setStagedResources(ref) {
    return command("Stage resources", (context) => {
        context.setStagedResources(ref ?? null);
        return { ok: true, history: false };
    });
}

function clearBindings(manifest) {
    manifest.model = { ...manifest.model, hiddenNodeIndices: [] };
    manifest.wheels = manifest.wheels.map((wheel) => {
        const next = { ...wheel, position: { ...wheel.position } };
        delete next.visual;
        return next;
    });
}

export function applyModelReplacement(patch = {}) {
    return command("Replace model", (context) => {
        const next = cloneJson(context.manifest);
        if (patch.model) next.model = { ...next.model, ...patch.model };
        clearBindings(next);
        if (patch.boundingBox) next.boundingBox = patch.boundingBox;
        if (patch.kinematics) next.kinematics = { ...next.kinematics, ...patch.kinematics };
        clearBakedLidarZone(next);
        context.setManifest(next);
        return { ok: true };
    });
}

/** One undo item for a reviewed URDF patch and the stage that holds its closure. */
export function applyReviewedUrdfImport({ patch = {}, stagedResources = undefined } = {}) {
    return command("Apply URDF", (context) => {
        const applied = applyReviewedUrdfPatch(patch).run(context);
        if (!applied || applied.ok === false) return applied ?? { ok: false };
        if (stagedResources !== undefined) context.setStagedResources(stagedResources);
        return { ok: true };
    });
}

export function applyReviewedUrdfPatch(patch = {}) {
    return command("Apply URDF", (context) => {
        const next = cloneJson(context.manifest);
        if (patch.model) {
            next.model = { ...next.model, ...patch.model };
            clearBindings(next);
            if (Array.isArray(patch.model.hiddenNodeIndices)) {
                next.model.hiddenNodeIndices = [...patch.model.hiddenNodeIndices];
            }
        }
        if (patch.boundingBox) next.boundingBox = patch.boundingBox;
        if (patch.wheels) next.wheels = patch.wheels;
        if (patch.wheelbase !== undefined || patch.maxSteeringAngle !== undefined) {
            next.kinematics = { ...next.kinematics };
            if (patch.wheelbase !== undefined) next.kinematics.wheelbase = patch.wheelbase;
            if (patch.maxSteeringAngle !== undefined) next.kinematics.maxSteeringAngle = patch.maxSteeringAngle;
        }
        if (patch.model || patch.boundingBox || patch.wheels) clearBakedLidarZone(next);
        context.setManifest(next);
        return { ok: true };
    });
}

function reportIssues(context, issues = []) {
    for (const entry of issues) context.issue(entry.code, entry.path, entry.message);
}

function assignedPairs({ pairs, axle, leftNodeIndex, rightNodeIndex }) {
    if (Array.isArray(pairs) && pairs.length > 0) return pairs;
    return [{ axle, leftNodeIndex, rightNodeIndex }];
}

export function assignModelWheels({
    pairs = null,
    axle,
    leftNodeIndex,
    rightNodeIndex,
    acceptAdjustments = false,
    measurement = null,
    glbBytes = null,
} = {}) {
    return command("Assign wheels", (context) => {
        if (context.manifest.version !== VEHICLE_MANIFEST_VERSION_V3) {
            context.issue("vehicle.manifest.version", "version", "Wheel assignment requires a version 3 vehicle.");
            return { ok: false };
        }
        const resolved = resolveMeasurement(context.manifest, { glbBytes, measurement });
        if (resolved.error) {
            const entry = measurementError(resolved.error);
            context.issue(entry.code, entry.path, entry.message);
            return { ok: false };
        }
        const next = cloneJson(context.manifest);
        const reviews = [];
        for (const pair of assignedPairs({ pairs, axle, leftNodeIndex, rightNodeIndex })) {
            const applied = applyAssignedPair(next, { ...pair, measurement: resolved.measurement });
            reviews.push(applied.review);
            if (!applied.ok) {
                if (!acceptAdjustments && applied.review?.withinTolerance) return { ok: false, review: applied.review };
                reportIssues(context, applied.issues);
                return { ok: false, review: applied.review };
            }
        }
        if (!acceptAdjustments) return { ok: false, review: reviews[0] ?? null };
        clearBakedLidarZone(next);
        context.setManifest(withWheelbase(next));
        return { ok: true, review: reviews.length === 1 ? reviews[0] : reviews };
    });
}

export function suppressSourceWheels({ nodeIndices = [], measurement = null, glbBytes = null } = {}) {
    return command("Replace source wheels", (context) => {
        if (context.manifest.version !== VEHICLE_MANIFEST_VERSION_V3) {
            context.issue("vehicle.manifest.version", "version", "Wheel suppression requires a version 3 vehicle.");
            return { ok: false };
        }
        const resolved = resolveMeasurement(context.manifest, { glbBytes, measurement });
        if (resolved.error) {
            const entry = measurementError(resolved.error);
            context.issue(entry.code, entry.path, entry.message);
            return { ok: false };
        }
        const selected = [...new Set(nodeIndices)].filter((index) => Number.isInteger(index) && index >= 0);
        if (selected.length === 0) {
            context.issue("vehicle.model.node-index", "model.hiddenNodeIndices", "Choose at least one source node to replace.");
            return { ok: false };
        }
        const next = cloneJson(context.manifest);
        for (const wheel of next.wheels) {
            if (wheel.visual?.kind === "model-node" && selected.includes(wheel.visual.nodeIndex)) delete wheel.visual;
        }
        const hidden = new Set(next.model.hiddenNodeIndices ?? []);
        for (const index of selected) hidden.add(index);
        next.model.hiddenNodeIndices = [...hidden];
        const bindingIssues = validateWheelBindings(next, resolved.measurement.nodeTable);
        if (bindingIssues.length > 0) {
            reportIssues(context, bindingIssues);
            return { ok: false };
        }
        for (const index of selected) {
            const node = resolved.measurement.nodes.find((entry) => entry.nodeIndex === index);
            if (!node?.center || !(node.radius > 0) || !(node.width > 0)) {
                context.issue("vehicle.wheel.bounds-unavailable", "wheels", `Node ${index} has no measurable wheel geometry.`);
                return { ok: false };
            }
            const id = `generated-${index}`;
            let wheel = next.wheels.find((entry) => entry.id === id);
            if (!wheel) {
                wheel = { id, position: { x: 0, y: 0, z: 0 }, radius: 0.25, width: 0.25, steerable: false };
                next.wheels.push(wheel);
            }
            delete wheel.axle;
            delete wheel.side;
            delete wheel.visual;
            wheel.position = { x: node.center.x, y: node.center.y, z: node.center.z };
            wheel.radius = node.radius;
            wheel.width = node.width;
            wheel.steerable = false;
        }
        clearBakedLidarZone(next);
        context.setManifest(next);
        return { ok: true };
    });
}

function applyMeasuredWheelUpdates(manifest, review) {
    for (const entry of review.axles) {
        if (entry.storedMatches) continue;
        if (entry.singleSide) {
            const wheel = manifest.wheels.find((candidate) => candidate.axle === entry.axle && candidate.side === entry.singleSide);
            const node = entry.review.measured[entry.singleSide];
            wheel.position = {
                x: canonicalFiniteNumber(node.center.x),
                y: canonicalFiniteNumber(node.center.y),
                z: canonicalFiniteNumber(node.center.z),
            };
            wheel.radius = canonicalFiniteNumber(node.radius);
            wheel.width = canonicalFiniteNumber(node.width);
            continue;
        }
        const left = manifest.wheels.find((candidate) => candidate.axle === entry.axle && candidate.side === "left");
        const right = manifest.wheels.find((candidate) => candidate.axle === entry.axle && candidate.side === "right");
        writeProposedGeometry(left, entry.review.proposed, "left");
        writeProposedGeometry(right, entry.review.proposed, "right");
    }
}

export function applyPlacementChange({
    model,
    boundingBox,
    measurement = null,
    glbBytes = null,
    acceptAdjustments = false,
} = {}) {
    return command("Change placement", (context) => {
        const next = cloneJson(context.manifest);
        mergePlacement(next, { model, boundingBox });
        const bound = (next.wheels ?? []).some((wheel) => wheel.visual?.kind === "model-node");
        if (!bound) {
            if (placementUnchanged(context.manifest, next)) return { ok: true };
            clearBakedLidarZone(next);
            context.setManifest(next);
            return { ok: true };
        }
        const resolved = resolveMeasurement(next, { glbBytes, measurement });
        if (resolved.error) {
            const entry = measurementError(resolved.error);
            context.issue(entry.code, entry.path, entry.message);
            return { ok: false };
        }
        const review = reviewBoundWheels(next, resolved.measurement);
        if (!review.withinTolerance) {
            reportIssues(context, review.issues);
            return { ok: false, review };
        }
        if (!review.unchanged && !acceptAdjustments) {
            context.issue("vehicle.axle.asymmetric", "wheels", "Accept the proposed wheel adjustments before changing placement.");
            return { ok: false, review };
        }
        if (review.unchanged && placementUnchanged(context.manifest, next)) return { ok: true, review };
        if (!review.unchanged) applyMeasuredWheelUpdates(next, review);
        clearBakedLidarZone(next);
        context.setManifest(withWheelbase(next));
        return { ok: true, review };
    });
}
