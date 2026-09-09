import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import { EXPERIMENT_ZERO_ROOM } from "./ExperimentZeroCase.js";

const PALETTE = Object.freeze({
    plaster: 0xc8c5bc,
    floor: 0x70675c,
    wood: 0x8c5c35,
    woodDark: 0x4f3424,
    chair: 0x52606b,
    cabinet: 0x9a9489,
    cabinetGap: 0x302e2a,
    fabric: 0x7d4338,
    metal: 0x8e969b,
    metalDark: 0x252a2d,
    paper: 0xc9b779,
    box: 0x8c795e,
    trim: 0xe0ddd5,
});

function material(color, options = {}) {
    return new THREE.MeshStandardMaterial({
        color,
        roughness: options.roughness ?? 0.72,
        metalness: options.metalness ?? 0,
        side: options.side ?? THREE.FrontSide,
    });
}

function geometry(kind, size, { detail = "detailed", radius = 0.035, segments = 3 } = {}) {
    if (kind === "cylinder") {
        return new THREE.CylinderGeometry(size[0], size[1], size[2], detail === "detailed" ? 24 : 8);
    }
    if (kind === "plane") return new THREE.PlaneGeometry(size[0], size[1]);
    if (kind === "rounded" && detail === "detailed") {
        return new RoundedBoxGeometry(size[0], size[1], size[2], segments, Math.min(radius, ...size.map((entry) => entry / 2)));
    }
    return new THREE.BoxGeometry(size[0], size[1], size[2]);
}

function addPart(group, {
    kind = "box",
    size,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    color,
    roughness,
    metalness,
    radius,
}, detail) {
    const mesh = new THREE.Mesh(
        geometry(kind, size, { detail, radius }),
        material(color, { roughness, metalness, side: kind === "plane" ? THREE.DoubleSide : THREE.FrontSide }),
    );
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
}

function roomShell(detail) {
    const group = new THREE.Group();
    const wall = (size, position) => addPart(group, { kind: detail === "detailed" ? "rounded" : "box", size, position, color: PALETTE.plaster, radius: 0.018 }, detail);
    addPart(group, { size: [6, 0.08, 5], position: [0, -0.04, 0], color: PALETTE.floor, roughness: 0.88 }, detail);
    wall([0.12, 2.8, 5], [-2.94, 1.4, 0]);
    wall([0.12, 2.8, 5], [2.94, 1.4, 0]);

    // Back wall with an actual recessed window opening.
    wall([3.4, 2.8, 0.12], [-1.3, 1.4, 2.44]);
    wall([1.0, 2.8, 0.12], [2.5, 1.4, 2.44]);
    wall([1.6, 0.95, 0.12], [1.2, 0.475, 2.44]);
    wall([1.6, 0.6, 0.12], [1.2, 2.5, 2.44]);
    for (const [size, position] of [
        [[1.76, 0.08, 0.24], [1.2, 0.98, 2.36]],
        [[1.76, 0.08, 0.18], [1.2, 2.22, 2.4]],
        [[0.08, 1.32, 0.18], [0.36, 1.6, 2.4]],
        [[0.08, 1.32, 0.18], [2.04, 1.6, 2.4]],
    ]) addPart(group, { size, position, color: PALETTE.trim }, detail);

    // Front wall with a door-sized opening and dimensional frame.
    wall([3.4, 2.8, 0.12], [1.3, 1.4, -2.44]);
    wall([1.0, 2.8, 0.12], [-2.5, 1.4, -2.44]);
    wall([1.0, 0.7, 0.12], [-1.5, 2.45, -2.44]);
    for (const [size, position] of [
        [[0.09, 2.2, 0.2], [-2.03, 1.1, -2.36]],
        [[0.09, 2.2, 0.2], [-0.97, 1.1, -2.36]],
        [[1.15, 0.09, 0.2], [-1.5, 2.16, -2.36]],
    ]) addPart(group, { size, position, color: PALETTE.trim }, detail);
    return group;
}

function table(detail) {
    const group = new THREE.Group();
    addPart(group, { kind: "rounded", size: [1.8, 0.1, 0.9], position: [0, 0.77, 0], color: PALETTE.wood, roughness: 0.58, radius: 0.045 }, detail);
    const legs = detail === "detailed"
        ? [[-0.72, 0.375, -0.32], [0.72, 0.375, -0.32], [-0.72, 0.375, 0.32], [0.72, 0.375, 0.32]]
        : [[-0.62, 0.36, 0], [0.62, 0.36, 0]];
    legs.forEach((position) => addPart(group, {
        kind: detail === "detailed" ? "rounded" : "box",
        size: detail === "detailed" ? [0.1, 0.72, 0.1] : [0.18, 0.72, 0.62],
        position,
        color: PALETTE.woodDark,
        radius: 0.025,
    }, detail));
    if (detail === "detailed") {
        addPart(group, { size: [1.52, 0.08, 0.08], position: [0, 0.62, -0.34], color: PALETTE.woodDark }, detail);
    }
    return group;
}

function chair(detail, mirrored = false) {
    const group = new THREE.Group();
    addPart(group, { kind: "rounded", size: [0.55, 0.09, 0.52], position: [0, 0.48, 0], color: PALETTE.chair, radius: 0.04 }, detail);
    addPart(group, { kind: "rounded", size: [0.55, 0.5, 0.075], position: [0, 0.72, 0.23], rotation: [mirrored ? -0.08 : 0.08, 0, 0], color: PALETTE.chair, radius: 0.035 }, detail);
    const legs = detail === "detailed"
        ? [[-0.21, 0.235, -0.18], [0.21, 0.235, -0.18], [-0.21, 0.235, 0.18], [0.21, 0.235, 0.18]]
        : [[-0.18, 0.235, 0], [0.18, 0.235, 0]];
    legs.forEach((position) => addPart(group, {
        size: detail === "detailed" ? [0.065, 0.47, 0.065] : [0.1, 0.47, 0.35],
        position,
        color: PALETTE.metalDark,
        metalness: detail === "detailed" ? 0.45 : 0,
        roughness: 0.35,
    }, detail));
    if (detail === "detailed") {
        addPart(group, { size: [0.38, 0.045, 0.045], position: [0, 0.2, -0.18], color: PALETTE.metalDark, metalness: 0.45, roughness: 0.35 }, detail);
    }
    return group;
}

function cabinet(detail) {
    const group = new THREE.Group();
    addPart(group, { kind: "rounded", size: [1.65, 0.82, 0.45], position: [0, 0.47, 0], color: PALETTE.cabinet, radius: 0.035 }, detail);
    addPart(group, { kind: "rounded", size: [1.68, 0.08, 0.48], position: [0, 0.92, 0], color: PALETTE.woodDark, radius: 0.025 }, detail);
    if (detail === "detailed") {
        [-0.54, 0, 0.54].forEach((x) => {
            addPart(group, { size: [0.008, 0.66, 0.012], position: [x, 0.47, -0.231], color: PALETTE.cabinetGap }, detail);
        });
        [0.7, 0.45].forEach((y) => addPart(group, { size: [1.47, 0.008, 0.012], position: [0, y, -0.231], color: PALETTE.cabinetGap }, detail));
        [-0.54, 0, 0.54].forEach((x) => addPart(group, { kind: "cylinder", size: [0.018, 0.018, 0.07], position: [x, 0.57, -0.27], rotation: [Math.PI / 2, 0, 0], color: PALETTE.metalDark, metalness: 0.7, roughness: 0.22 }, detail));
    }
    return group;
}

function fabric(detail) {
    const group = new THREE.Group();
    if (detail === "detailed") {
        for (let index = 0; index < 3; index += 1) addPart(group, {
            kind: "rounded",
            size: [0.72 - (index * 0.035), 0.052, 0.52 - (index * 0.025)],
            position: [(index - 1) * 0.018, index * 0.045, 0],
            rotation: [0, (index - 1) * 0.035, 0],
            color: PALETTE.fabric,
            roughness: 0.96,
            radius: 0.022,
        }, detail);
    } else {
        addPart(group, { size: [0.72, 0.12, 0.52], position: [0, 0.06, 0], color: PALETTE.fabric, roughness: 0.96 }, detail);
    }
    return group;
}

function lamp(detail) {
    const group = new THREE.Group();
    addPart(group, { kind: "cylinder", size: [0.21, 0.24, 0.08], position: [0, 0.04, 0], color: PALETTE.metalDark, metalness: 0.82, roughness: 0.24 }, detail);
    addPart(group, { kind: "cylinder", size: [0.025, 0.025, 1.08], position: [0, 0.58, 0], color: PALETTE.metal, metalness: 0.9, roughness: 0.2 }, detail);
    addPart(group, { kind: "cylinder", size: [0.24, 0.1, 0.34], position: [0, 1.15, -0.08], rotation: [Math.PI / 2.8, 0, 0], color: PALETTE.metal, metalness: 0.86, roughness: 0.23 }, detail);
    return group;
}

function books(detail) {
    const group = new THREE.Group();
    const count = detail === "detailed" ? 3 : 1;
    for (let index = 0; index < count; index += 1) addPart(group, {
        kind: detail === "detailed" ? "rounded" : "box",
        size: [0.48 - (index * 0.04), 0.045, 0.3 - (index * 0.015)],
        position: [0.015 * index, 0.025 + (index * 0.05), 0],
        rotation: [0, (index - 1) * 0.04, 0],
        color: index === 1 ? PALETTE.fabric : PALETTE.paper,
        roughness: 0.9,
        radius: 0.015,
    }, detail);
    return group;
}

function storageBox(detail) {
    const group = new THREE.Group();
    addPart(group, { kind: "rounded", size: [0.62, 0.38, 0.5], position: [0, 0.19, 0], color: PALETTE.box, roughness: 0.92, radius: 0.025 }, detail);
    if (detail === "detailed") {
        addPart(group, { size: [0.64, 0.045, 0.52], position: [0, 0.405, 0], color: PALETTE.box, roughness: 0.92 }, detail);
        addPart(group, { size: [0.18, 0.09, 0.012], position: [0, 0.22, -0.256], color: PALETTE.paper, roughness: 1 }, detail);
    }
    return group;
}

function applyTransform(group, base, override = {}) {
    const position = override.position ?? base.position;
    const rotation = override.rotationRadians ?? base.rotationRadians;
    const scale = Number(override.uniformScale ?? 1);
    group.position.set(...position);
    group.rotation.set(...rotation);
    group.scale.setScalar(scale);
}

export function createExperimentZeroScene({ detail = "detailed", transforms = [] } = {}) {
    const root = new THREE.Group();
    root.name = "ExperimentZeroRoom";
    const overrides = new Map(transforms.map((entry) => [entry.instanceId ?? entry.objectId, entry]));
    const objects = new Map();
    const factories = {
        "room-shell": roomShell,
        table,
        "chair-a": (selectedDetail) => chair(selectedDetail, false),
        "chair-b": (selectedDetail) => chair(selectedDetail, true),
        cabinet,
        fabric,
        "metal-lamp": lamp,
        "clutter-books": books,
        "clutter-box": storageBox,
    };
    for (const record of EXPERIMENT_ZERO_ROOM.objects) {
        const override = overrides.get(record.id);
        if (override?.deleted) continue;
        const group = factories[record.id](detail);
        group.name = record.label;
        group.userData.visualLabObjectId = record.id;
        group.userData.visualLabSourceObjectId = record.id;
        group.userData.visualLabEditable = record.editable;
        group.traverse((object) => {
            object.userData.visualLabObjectId = record.id;
            object.userData.visualLabSourceObjectId = record.id;
            object.userData.visualLabEditable = record.editable;
        });
        applyTransform(group, record, override);
        root.add(group);
        objects.set(record.id, group);
    }
    for (const override of transforms.filter((entry) => entry.sourceObjectId && (entry.instanceId ?? entry.objectId) !== entry.sourceObjectId && !entry.deleted)) {
        const source = EXPERIMENT_ZERO_ROOM.objects.find((entry) => entry.id === override.sourceObjectId);
        const instanceId = override.instanceId ?? override.objectId;
        if (!source || !source.editable || objects.has(instanceId)) continue;
        const group = factories[source.id](detail);
        group.name = `${source.label} copy`;
        group.userData.visualLabObjectId = instanceId;
        group.userData.visualLabSourceObjectId = source.id;
        group.userData.visualLabEditable = true;
        group.traverse((object) => {
            object.userData.visualLabObjectId = instanceId;
            object.userData.visualLabSourceObjectId = source.id;
            object.userData.visualLabEditable = true;
        });
        applyTransform(group, source, override);
        root.add(group);
        objects.set(instanceId, group);
    }
    return {
        root,
        objects,
        dispose() {
            root.traverse((object) => {
                object.geometry?.dispose?.();
                for (const entry of [].concat(object.material ?? [])) entry?.dispose?.();
            });
            root.removeFromParent();
            objects.clear();
        },
    };
}
