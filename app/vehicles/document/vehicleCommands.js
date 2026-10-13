import { cloneJson } from "../../util/cloneJson.js";
import { canonicalFiniteNumber } from "../../simulation/kernel/SimulationHashes.js";
import { deriveCompleteWheelbase, proposeStandardPair } from "../axle/standardAxle.js";
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
export function applyAxlePatch(manifest, { axle, patch = {} } = {}) {
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
    const normalized = normalizeVehicleManifest(withWheelbase(next));
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

export function adoptStandardPair({ axle, acceptAdjustments = false }) {
    return command(`Adopt ${axle} axle`, (context) => {
        if (!acceptAdjustments) {
            context.issue("vehicle.axle.asymmetric", "wheels", "Accept the proposed axle adjustments before applying them.");
            return { ok: false };
        }
        const wheels = context.manifest.wheels ?? [];
        const left = wheels.find((wheel) => wheel.axle === axle && wheel.side === "left")
            ?? wheels.find((wheel) => wheel.id === `${axle}-left`);
        const right = wheels.find((wheel) => wheel.axle === axle && wheel.side === "right")
            ?? wheels.find((wheel) => wheel.id === `${axle}-right`);
        const proposal = proposeStandardPair(left, right, { axle });
        if (!proposal.withinTolerance || !proposal.proposed) {
            for (const entry of proposal.issues) context.issue(entry.code, entry.path, entry.message);
            return { ok: false };
        }
        const next = cloneJson(context.manifest);
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

export function replaceManifest(manifest) {
    return command("Replace manifest", (context) => {
        const validation = validateVehicleManifest(manifest);
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
        context.setManifest(next);
        return { ok: true };
    });
}

export function applyReviewedUrdfPatch(patch = {}) {
    return command("Apply URDF", (context) => {
        const next = cloneJson(context.manifest);
        if (patch.model) {
            next.model = { ...next.model, ...patch.model };
            clearBindings(next);
        }
        if (patch.boundingBox) next.boundingBox = patch.boundingBox;
        if (patch.wheels) next.wheels = patch.wheels;
        if (patch.wheelbase !== undefined || patch.maxSteeringAngle !== undefined) {
            next.kinematics = { ...next.kinematics };
            if (patch.wheelbase !== undefined) next.kinematics.wheelbase = patch.wheelbase;
            if (patch.maxSteeringAngle !== undefined) next.kinematics.maxSteeringAngle = patch.maxSteeringAngle;
        }
        context.setManifest(next);
        return { ok: true };
    });
}
