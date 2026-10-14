/**
 * Editor-session wheel links. The link is not written into a vehicle manifest.
 * Together copies a translation. Mirror copies it with lateral motion flipped
 * across the vehicle center plane (+Z left, −Z right).
 */

import { cloneJson } from "../../util/cloneJson.js";
import { deriveCompleteWheelbase, validateStandardAxles } from "../axle/standardAxle.js";
import { normalizeVehicleManifest } from "../VehicleManifest.js";

const STANDARD_AXLES = new Set(["front", "rear"]);

function issue(code, path, message) {
    return { code, path, message };
}

function fail(issues) {
    return { ok: false, manifest: null, link: null, issues };
}

function wheelById(wheels, id) {
    return (wheels ?? []).find((wheel) => wheel.id === id) ?? null;
}

export function isBoundWheel(wheel) {
    return wheel?.visual?.kind === "model-node";
}

function hasAxleRole(wheel) {
    return wheel?.axle !== undefined || wheel?.side !== undefined;
}

/** The other wheel of a complete front or rear pair, or null. */
export function standardPartner(wheels, wheelId) {
    const wheel = wheelById(wheels, wheelId);
    if (!wheel || !STANDARD_AXLES.has(wheel.axle) || (wheel.side !== "left" && wheel.side !== "right")) return null;
    const members = (wheels ?? []).filter((entry) => entry.axle === wheel.axle);
    if (members.length !== 2) return null;
    const opposite = wheel.side === "left" ? "right" : "left";
    const partner = members.find((entry) => entry.side === opposite && entry.id !== wheel.id);
    return partner ?? null;
}

function isStandardPair(wheels, firstId, secondId) {
    return standardPartner(wheels, firstId)?.id === secondId;
}

function parseLink(link) {
    if (!link || !Array.isArray(link.ids) || link.ids.length !== 2) return null;
    const [first, second] = link.ids;
    if (typeof first !== "string" || typeof second !== "string" || !first || !second || first === second) return null;
    if (link.mode !== "together" && link.mode !== "mirror") return null;
    return { ids: [first, second], mode: link.mode };
}

function finitePosition(position) {
    const x = Number(position?.x);
    const y = Number(position?.y);
    const z = Number(position?.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x, y, z };
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
 * A stored link between two unbound wheels that are not part of a standard pair.
 * A standard pair is mirrored by the editor without storing a link.
 */
export function validateWheelLink(wheels, link) {
    if (link == null) return { ok: true, link: null, issues: [] };
    const parsed = parseLink(link);
    if (!parsed) {
        return fail([issue("vehicle.wheel.link", "wheels", "A wheel link needs two different wheels and a together or mirror mode.")]);
    }
    const [firstId, secondId] = parsed.ids;
    const first = wheelById(wheels, firstId);
    const second = wheelById(wheels, secondId);
    if (!first || !second) {
        return fail([issue("vehicle.wheel.link", "wheels", "Both linked wheels have to be on this vehicle.")]);
    }
    if (isBoundWheel(first) || isBoundWheel(second)) {
        return fail([issue("vehicle.wheel.link-bound", "wheels", "Detach the model-bound wheels before linking them.")]);
    }
    if (hasAxleRole(first) || hasAxleRole(second) || isStandardPair(wheels, firstId, secondId)) {
        return fail([issue("vehicle.wheel.link-standard", "wheels", "A standard-axle wheel only moves with its axle partner.")]);
    }
    return { ok: true, link: parsed, issues: [] };
}

/**
 * The link that should follow a translation of `drivenId`.
 * A complete standard pair is always mirrored. An explicit link is used otherwise.
 */
export function resolveMotionLink(wheels, drivenId, explicitLink = null) {
    const driven = wheelById(wheels, drivenId);
    if (!driven || isBoundWheel(driven)) return null;
    const partner = standardPartner(wheels, drivenId);
    if (partner) {
        if (isBoundWheel(partner)) return null;
        return { ids: [drivenId, partner.id], mode: "mirror" };
    }
    const stored = validateWheelLink(wheels, explicitLink);
    if (!stored.ok || !stored.link?.ids.includes(drivenId)) return null;
    return stored.link;
}

export function linkedPartnerId(wheels, drivenId, explicitLink = null) {
    const link = resolveMotionLink(wheels, drivenId, explicitLink);
    if (!link) return null;
    return link.ids.find((id) => id !== drivenId) ?? null;
}

/** Partner highlight for the hierarchy. Selection wins over a stored link on other wheels. */
export function highlightedLinkIds(wheels, selection, explicitLink = null) {
    if (selection?.kind === "wheel" && selection.id) {
        const partnerId = linkedPartnerId(wheels, selection.id, explicitLink);
        if (partnerId) return [selection.id, partnerId];
    }
    const stored = validateWheelLink(wheels, explicitLink);
    if (stored.ok && stored.link) return [...stored.link.ids];
    return [];
}

/**
 * Apply one cumulative translation from a gesture capture.
 * The partner receives the same delta, or that delta with Z flipped.
 * Radius, width, steer, and axle role stay on each wheel.
 */
export function applyLinkedWheelMotion(manifest, { drivenId, position, link, normalizeOptions } = {}) {
    const parsed = parseLink(link);
    if (!parsed) {
        return fail([issue("vehicle.wheel.link", "wheels", "A wheel link needs two different wheels and a together or mirror mode.")]);
    }
    const wheels = manifest?.wheels ?? [];
    const [firstId, secondId] = parsed.ids;
    const driven = wheelById(wheels, drivenId);
    const partnerId = parsed.ids.find((id) => id !== drivenId);
    const partner = wheelById(wheels, partnerId);
    if (!driven || !partner || !parsed.ids.includes(drivenId)) {
        return fail([issue("vehicle.wheel.link", "wheels", "The moved wheel has to be one of the linked wheels.")]);
    }
    if (isBoundWheel(driven) || isBoundWheel(partner)) {
        return fail([issue("vehicle.wheel.link-bound", "wheels", "Detach the model-bound wheels before moving them.")]);
    }
    const paired = isStandardPair(wheels, firstId, secondId);
    if (paired && parsed.mode !== "mirror") {
        return fail([issue("vehicle.wheel.link-mode", "wheels", "A standard axle stays mirrored.")]);
    }
    if (!paired && (hasAxleRole(driven) || hasAxleRole(partner))) {
        return fail([issue("vehicle.wheel.link-standard", "wheels", "A standard-axle wheel only moves with its axle partner.")]);
    }
    const nextPosition = finitePosition(position);
    const drivenPosition = finitePosition(driven.position);
    const partnerPosition = finitePosition(partner.position);
    if (!nextPosition || !drivenPosition || !partnerPosition) {
        return fail([issue("vehicle.wheel.link", "wheels", "Wheel position must be finite.")]);
    }
    const delta = {
        x: nextPosition.x - drivenPosition.x,
        y: nextPosition.y - drivenPosition.y,
        z: nextPosition.z - drivenPosition.z,
    };
    const next = cloneJson(manifest);
    const nextDriven = wheelById(next.wheels, drivenId);
    const nextPartner = wheelById(next.wheels, partnerId);
    nextDriven.position = nextPosition;
    nextPartner.position = {
        x: partnerPosition.x + delta.x,
        y: partnerPosition.y + delta.y,
        z: partnerPosition.z + (parsed.mode === "mirror" ? -delta.z : delta.z),
    };
    const normalized = normalizeVehicleManifest(withWheelbase(next), normalizeOptions);
    const issues = validateStandardAxles(normalized);
    if (issues.length > 0) return fail(issues);
    return { ok: true, manifest: normalized, issues: [] };
}
