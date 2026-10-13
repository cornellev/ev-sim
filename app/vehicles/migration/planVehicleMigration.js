/**
 * Pure v2/v3 migration planner. It does not write files, fetch URLs, or encode GLB.
 * VEH-02 supplies `encodeModel`; VEH-03 persists the returned snapshot.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalFiniteNumber } from "../../simulation/kernel/SimulationHashes.js";
import { cloneJson } from "../../util/cloneJson.js";
import { proposeStandardPair } from "../axle/standardAxle.js";
import {
    VEHICLE_MANIFEST_VERSION_V3,
    normalizeVehicleManifest,
} from "../VehicleManifest.js";

const LEFT_IDS = Object.freeze({ front: "front-left", rear: "rear-left" });
const RIGHT_IDS = Object.freeze({ front: "front-right", rear: "rear-right" });

function issue(severity, code, path, message) {
    return { severity, code, path, message };
}

function isPlain(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function diffValues(before, after, path, out) {
    if (Object.is(before, after)) return;
    if (isPlain(before) && isPlain(after)) {
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
        for (const key of keys) diffValues(before[key], after[key], path ? `${path}.${key}` : key, out);
        return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
        if (before.length === after.length && before.every((entry, index) => isPlain(entry) && isPlain(after[index]))) {
            before.forEach((entry, index) => diffValues(entry, after[index], `${path}.${index}`, out));
            return;
        }
        if (before.length === after.length && before.every((entry, index) => Object.is(entry, after[index]))) return;
    }
    out.push({ path, before, after });
}

function sha256Hex(bytes) {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
    return bytesToHex(sha256(data));
}

function isExternalUrl(asset) {
    return /^[a-z][a-z0-9+.-]*:/i.test(String(asset ?? ""));
}

function isPublicPath(asset) {
    return typeof asset === "string" && asset.startsWith("/") && !asset.startsWith("/api/");
}

function gltfDocument(bytes) {
    let text;
    try {
        text = new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).trim();
    } catch {
        return null;
    }
    if (!text.startsWith("{")) return null;
    try {
        const json = JSON.parse(text);
        if (!json || typeof json !== "object" || Array.isArray(json) || !json.asset) return null;
        return json;
    } catch {
        return null;
    }
}

function relativeUris(json) {
    const uris = [];
    for (const collection of [json.buffers, json.images]) {
        for (const entry of Array.isArray(collection) ? collection : []) {
            const uri = String(entry?.uri ?? "").trim().split(/[?#]/, 1)[0];
            if (!uri || /^(?:data:|blob:|https?:)/i.test(uri)) continue;
            uris.push(uri);
        }
    }
    return uris;
}

function resolveUri(entry, uri) {
    if (uri.startsWith("/")) return uri;
    if (entry.startsWith("/")) {
        const directory = entry.slice(0, entry.lastIndexOf("/"));
        return `${directory}/${uri}`.replaceAll("/./", "/");
    }
    return uri;
}

function stripRoles(wheel) {
    return {
        id: wheel.id,
        position: { ...wheel.position },
        radius: wheel.radius,
        width: wheel.width,
        steerable: wheel.steerable === true,
    };
}

function selectPair(wheels, axle, used) {
    const available = wheels.filter((wheel) => !used.has(wheel));
    const taggedLeft = available.find((wheel) => wheel.axle === axle && wheel.side === "left");
    const taggedRight = available.find((wheel) => wheel.axle === axle && wheel.side === "right");
    if (taggedLeft || taggedRight) return { left: taggedLeft ?? null, right: taggedRight ?? null };
    const left = available.find((wheel) => wheel.id === LEFT_IDS[axle] && wheel.axle === undefined);
    const right = available.find((wheel) => wheel.id === RIGHT_IDS[axle] && wheel.axle === undefined);
    if (left || right) return { left: left ?? null, right: right ?? null };
    return { left: null, right: null };
}

function wheelFromProposal(wheel, axle, side, proposed) {
    const sign = side === "left" ? 1 : -1;
    const next = {
        id: wheel.id,
        position: {
            x: proposed.x,
            y: proposed.y,
            z: canonicalFiniteNumber(sign * proposed.z),
        },
        radius: proposed.radius,
        width: proposed.width,
        steerable: proposed.steerable === true,
        axle,
        side,
    };
    if (wheel.visual) next.visual = cloneJson(wheel.visual);
    return next;
}

function planLayout(normalized, { standardizeLayout }) {
    if (!standardizeLayout) {
        const wheels = normalized.version === VEHICLE_MANIFEST_VERSION_V3
            ? normalized.wheels.map((wheel) => cloneJson(wheel))
            : normalized.wheels.map(stripRoles);
        return { ok: true, wheels, wheelbase: normalized.kinematics.wheelbase, acknowledgements: [], diagnostics: [] };
    }
    const used = new Set();
    const assignments = new Map();
    const diagnostics = [];
    for (const axle of ["front", "rear"]) {
        const pair = selectPair(normalized.wheels, axle, used);
        if (!pair.left || !pair.right) continue;
        const proposal = proposeStandardPair(pair.left, pair.right, { axle });
        if (!proposal.withinTolerance) {
            diagnostics.push(...proposal.issues.map((entry) => issue("error", entry.code, entry.path, entry.message)));
            continue;
        }
        used.add(pair.left);
        used.add(pair.right);
        assignments.set(pair.left, { axle, side: "left", proposed: proposal.proposed });
        assignments.set(pair.right, { axle, side: "right", proposed: proposal.proposed });
    }
    if (diagnostics.length > 0) {
        return { ok: false, wheels: null, wheelbase: null, acknowledgements: [], diagnostics };
    }
    const wheels = normalized.wheels.map((wheel) => {
        const assignment = assignments.get(wheel);
        if (!assignment) return stripRoles(wheel);
        return wheelFromProposal(wheel, assignment.axle, assignment.side, assignment.proposed);
    });
    const acknowledgements = [];
    let wheelbase = normalized.kinematics.wheelbase;
    const front = wheels.find((wheel) => wheel.axle === "front");
    const rear = wheels.find((wheel) => wheel.axle === "rear");
    const complete = front && rear && wheels.every((wheel) => wheel.axle === "front" || wheel.axle === "rear");
    if (complete) {
        const derived = canonicalFiniteNumber(Math.abs(front.position.x - rear.position.x));
        const before = normalized.kinematics.wheelbase;
        if (derived > 0 && derived !== canonicalFiniteNumber(before)) {
            acknowledgements.push({
                code: "wheelbase-change",
                before,
                after: derived,
                required: true,
                motion: {
                    yawRateScale: before / derived,
                    turnRadiusScale: derived / before,
                },
            });
        }
        wheelbase = derived > 0 ? derived : wheelbase;
    }
    return { ok: true, wheels, wheelbase, acknowledgements, diagnostics };
}

function planAssets(normalized, { files, publicFiles, localPackage, encodeModel }) {
    const asset = normalized.model?.asset ?? null;
    const hiddenNodeIndices = normalized.version === VEHICLE_MANIFEST_VERSION_V3
        ? [...(normalized.model.hiddenNodeIndices ?? [])]
        : [];
    if (!asset) {
        return {
            ok: true,
            operations: [{ op: "model-free", entry: null, inputs: [], outputs: null }],
            diagnostics: [],
            model: { asset: null, dependencies: [], hiddenNodeIndices },
            hashes: {},
        };
    }
    if (normalized.version === VEHICLE_MANIFEST_VERSION_V3 && !isExternalUrl(asset)) {
        return {
            ok: true,
            operations: [],
            diagnostics: [],
            model: {
                asset,
                dependencies: [...(normalized.model.dependencies ?? [])],
                hiddenNodeIndices,
                scale: normalized.model.scale,
                rotation: cloneJson(normalized.model.rotation),
                offset: cloneJson(normalized.model.offset),
            },
            hashes: hashProvided(files),
        };
    }
    if (isExternalUrl(asset) && !localPackage) {
        return {
            ok: false,
            operations: [{ op: "require-local-package", entry: asset, inputs: [], outputs: null }],
            diagnostics: [issue("error", "vehicle.model.external-url", "model.asset", "An external model URL requires a selected local package before migration.")],
            model: null,
            hashes: {},
        };
    }
    const entry = isExternalUrl(asset) ? localPackage.entryPath : asset;
    const table = isExternalUrl(asset) ? localPackage.files : isPublicPath(asset) ? publicFiles : files;
    return encodeClosure(entry, table ?? {}, encodeModel, hiddenNodeIndices);
}

function hashProvided(files) {
    const hashes = {};
    for (const [name, bytes] of Object.entries(files ?? {})) hashes[name] = sha256Hex(bytes);
    return hashes;
}

function encodeClosure(entry, table, encodeModel, hiddenNodeIndices) {
    const bytes = table[entry];
    if (!bytes) {
        return {
            ok: false,
            operations: [{ op: "missing-dependency", entry, inputs: [entry], outputs: null }],
            diagnostics: [issue("error", "vehicle.model.missing-dependency", "model.asset", `Missing model file "${entry}".`)],
            model: null,
            hashes: hashProvided(table),
        };
    }
    const inputs = [entry];
    const gltf = gltfDocument(bytes);
    if (gltf) {
        for (const uri of relativeUris(gltf)) {
            const resolved = resolveUri(entry, uri);
            inputs.push(resolved);
            if (!table[resolved]) {
                return {
                    ok: false,
                    operations: [{ op: "missing-dependency", entry, inputs, outputs: null }],
                    diagnostics: [issue("error", "vehicle.model.missing-dependency", "model.dependencies", `Missing dependency "${resolved}".`)],
                    model: null,
                    hashes: hashProvided(table),
                };
            }
        }
    }
    const hashes = {};
    for (const name of inputs) hashes[name] = sha256Hex(table[name]);
    if (typeof encodeModel !== "function") {
        return {
            ok: false,
            operations: [{ op: "encode-canonical-glb", entry, inputs, outputs: null }],
            diagnostics: [issue("error", "vehicle.migration.encoder-unavailable", "model.asset", "Canonical GLB encoding is not available.")],
            model: null,
            hashes,
        };
    }
    let encoded;
    try {
        encoded = encodeModel({
            entry,
            inputs: inputs.map((name) => ({ name, bytes: table[name] })),
        });
    } catch (error) {
        return {
            ok: false,
            operations: [{ op: "encode-canonical-glb", entry, inputs, outputs: null }],
            diagnostics: [issue("error", "vehicle.migration.encoder-unavailable", "model.asset", error.message)],
            model: null,
            hashes,
        };
    }
    if (!encoded?.asset) {
        return {
            ok: false,
            operations: [{ op: "encode-canonical-glb", entry, inputs, outputs: null }],
            diagnostics: [issue("error", "vehicle.migration.encoder-unavailable", "model.asset", "Canonical GLB encoding is not available.")],
            model: null,
            hashes,
        };
    }
    const outputs = {
        asset: encoded.asset,
        dependencies: [...(encoded.dependencies ?? [])],
    };
    return {
        ok: true,
        operations: [{ op: "encode-canonical-glb", entry, inputs, outputs }],
        diagnostics: [],
        model: { asset: encoded.asset, dependencies: outputs.dependencies, hiddenNodeIndices },
        hashes,
    };
}

function emptyPlan(diagnostics, { snapshot = null, acknowledgements = [], operations = [], changes = [] } = {}) {
    return {
        ok: false,
        blocked: true,
        proposedManifest: null,
        assetPlan: { operations },
        diagnostics,
        changes,
        acknowledgements,
        snapshot,
    };
}

export function planVehicleMigration(source, {
    files = {},
    publicFiles = {},
    localPackage = null,
    standardizeLayout = false,
    acknowledgeWheelbase = false,
    encodeModel = null,
} = {}) {
    let normalized;
    try {
        normalized = normalizeVehicleManifest(source);
    } catch (error) {
        return emptyPlan([issue("error", "vehicle.manifest.invalid", "", error.message)]);
    }
    const snapshot = {
        kind: "cev-sim.vehicle-pre-migration",
        version: 1,
        manifest: cloneJson(normalized),
        assets: {},
    };
    const layout = planLayout(normalized, { standardizeLayout });
    if (!layout.ok) {
        return emptyPlan(layout.diagnostics, { snapshot, acknowledgements: layout.acknowledgements });
    }
    const assets = planAssets(normalized, { files, publicFiles, localPackage, encodeModel });
    snapshot.assets = assets.hashes ?? {};
    if (!assets.ok) {
        return emptyPlan(assets.diagnostics, {
            snapshot,
            acknowledgements: layout.acknowledgements,
            operations: assets.operations,
        });
    }
    const acknowledgement = layout.acknowledgements[0] ?? null;
    const candidate = normalizeVehicleManifest({
        ...normalized,
        version: VEHICLE_MANIFEST_VERSION_V3,
        model: {
            ...normalized.model,
            ...assets.model,
        },
        wheels: layout.wheels,
        kinematics: {
            ...normalized.kinematics,
            wheelbase: layout.wheelbase,
        },
    });
    const changes = [];
    diffValues(normalized, candidate, "", changes);
    if (acknowledgement && !acknowledgeWheelbase) {
        return emptyPlan([
            issue(
                "error",
                "vehicle.migration.wheelbase-acknowledgement",
                "kinematics.wheelbase",
                `Standardizing this layout changes wheelbase from ${acknowledgement.before} m to ${acknowledgement.after} m.`,
            ),
        ], {
            snapshot,
            acknowledgements: layout.acknowledgements,
            operations: assets.operations,
            changes,
        });
    }
    const diagnostics = [...layout.diagnostics, ...assets.diagnostics];
    if (acknowledgement) {
        diagnostics.push(issue(
            "info",
            "vehicle.migration.wheelbase-acknowledgement",
            "kinematics.wheelbase",
            `Wheelbase changes from ${acknowledgement.before} m to ${acknowledgement.after} m.`,
        ));
    }
    return {
        ok: true,
        blocked: false,
        proposedManifest: candidate,
        assetPlan: { operations: assets.operations },
        diagnostics,
        changes,
        acknowledgements: layout.acknowledgements,
        snapshot,
    };
}
