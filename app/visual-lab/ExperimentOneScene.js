import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import sourceFixture from "./experiment-one-fixture.json" with { type: "json" };

export const EXPERIMENT_ONE_FIXTURE_SOURCE = Object.freeze(sourceFixture);

function sourceObject(record) {
    return record.copyOf
        ? { ...sourceFixture.objects.find((entry) => entry.id === record.copyOf), ...record }
        : record;
}

function simpleParts(record) {
    const parts = sourceObject(record).parts;
    if (record.id === "room-shell" || record.id === "metal-lamp") return parts;
    const keep = {
        table: ["top", "leg-nw", "leg-ne"],
        "chair-a": ["seat", "back", "leg-nw", "leg-ne"],
        "chair-b": ["seat", "back", "leg-nw", "leg-ne"],
        cabinet: ["body", "top"],
        fabric: ["fold-1"],
        "clutter-books": ["book-1"],
        "clutter-box": ["body"],
    }[record.id];
    return keep ? parts.filter((entry) => keep.includes(entry.id)) : parts;
}

export function experimentOneParts(record, detail = "detailed") {
    return detail === "simple" ? simpleParts(record) : sourceObject(record).parts;
}

function geometry(part, detail) {
    if (part.shape === "cylinder") {
        return new THREE.CylinderGeometry(part.size[0] / 2, part.size[2] / 2, part.size[1], detail === "detailed" ? 32 : 12);
    }
    if (part.shape === "cone") {
        return new THREE.ConeGeometry(part.size[0], part.size[1], detail === "detailed" ? 32 : 12, 1, true);
    }
    if (detail === "detailed" && part.bevel > 0) {
        return new RoundedBoxGeometry(...part.size, 4, Math.min(part.bevel, ...part.size.map((value) => value / 2)));
    }
    return new THREE.BoxGeometry(...part.size);
}

function colorBytes(hex) {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function patternValue(pattern, x, y) {
    const hash = ((x * 73856093) ^ (y * 19349663)) >>> 0;
    const noise = ((hash & 255) / 255) - 0.5;
    if (pattern === "wood") return Math.sin((x + noise * 1.5) * 0.48) * 0.15 + noise * 0.05;
    if (pattern === "weave") return ((x % 4 < 2) === (y % 4 < 2) ? 0.07 : -0.07) + noise * 0.025;
    if (pattern === "brushed") return Math.sin(y * 2.7) * 0.035 + noise * 0.025;
    if (pattern === "plaster") return noise * 0.075;
    if (pattern === "paper") return noise * 0.035;
    return noise * 0.018;
}

function textureSet(definition) {
    const size = 64;
    const base = colorBytes(definition.baseColor);
    const colorData = new Uint8Array(size * size * 4);
    const roughnessData = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const offset = (y * size + x) * 4;
            const variation = patternValue(definition.pattern, x, y);
            for (let channel = 0; channel < 3; channel += 1) {
                colorData[offset + channel] = Math.max(0, Math.min(255, Math.round(base[channel] * (1 + variation))));
                roughnessData[offset + channel] = Math.round(255 * Math.max(0.04, Math.min(1, definition.roughness - variation * 0.35)));
            }
            colorData[offset + 3] = 255;
            roughnessData[offset + 3] = 255;
        }
    }
    const map = new THREE.DataTexture(colorData, size, size, THREE.RGBAFormat);
    map.colorSpace = THREE.SRGBColorSpace;
    const roughnessMap = new THREE.DataTexture(roughnessData, size, size, THREE.RGBAFormat);
    for (const texture of [map, roughnessMap]) {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.needsUpdate = true;
    }
    return { map, roughnessMap };
}

function fixtureMaterial(name, profile, resources) {
    const definition = sourceFixture.materials[name];
    const physical = profile === "physical";
    const textures = physical ? textureSet(definition) : {};
    resources.push(...Object.values(textures));
    const material = new THREE.MeshStandardMaterial({
        color: physical ? 0xffffff : definition.baseColor,
        roughness: physical ? definition.roughness : Math.min(1, definition.roughness + 0.12),
        metalness: physical ? definition.metalness : Math.min(definition.metalness, 0.45),
        ...textures,
    });
    material.userData = {
        visualLabMaterialId: name,
        textureScaleMeters: definition.textureScaleMeters,
        appearanceProfile: profile,
    };
    resources.push(material);
    return material;
}

function applyTransform(group, record, override = null) {
    group.position.set(...(override?.position ?? record.position));
    group.rotation.set(...(override?.rotationRadians ?? [0, 0, 0]));
    group.scale.setScalar(override?.uniformScale ?? 1);
}

function createObject(record, { detail, materialProfile, resources }) {
    const group = new THREE.Group();
    for (const part of experimentOneParts(record, detail)) {
        const partGeometry = geometry(part, detail);
        if (materialProfile === "physical") applyMetricUvs(
            partGeometry,
            sourceFixture.materials[part.material].textureScaleMeters,
        );
        const mesh = new THREE.Mesh(
            partGeometry,
            fixtureMaterial(part.material, materialProfile, resources),
        );
        mesh.name = `${record.id}:${part.id}`;
        mesh.position.set(...part.position);
        mesh.rotation.set(...(part.rotation ?? [0, 0, 0]));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.visualLabPartId = part.id;
        group.add(mesh);
    }
    return group;
}

function applyMetricUvs(bufferGeometry, scaleMeters) {
    const position = bufferGeometry.getAttribute("position");
    const normal = bufferGeometry.getAttribute("normal");
    if (!position || !normal) return;
    const values = new Float32Array(position.count * 2);
    for (let index = 0; index < position.count; index += 1) {
        const x = position.getX(index);
        const y = position.getY(index);
        const z = position.getZ(index);
        const nx = Math.abs(normal.getX(index));
        const ny = Math.abs(normal.getY(index));
        const nz = Math.abs(normal.getZ(index));
        const [u, v] = nx >= ny && nx >= nz
            ? [z, y]
            : ny >= nz ? [x, z] : [x, y];
        values[index * 2] = u / scaleMeters;
        values[index * 2 + 1] = v / scaleMeters;
    }
    bufferGeometry.setAttribute("uv", new THREE.BufferAttribute(values, 2));
}

export function createExperimentOneScene({
    detail = "detailed",
    materialProfile = "physical",
    transforms = [],
} = {}) {
    if (!["simple", "detailed"].includes(detail)) throw new Error(`Unsupported Experiment 1 detail "${detail}".`);
    if (!["incumbent", "physical"].includes(materialProfile)) throw new Error(`Unsupported Experiment 1 material profile "${materialProfile}".`);
    const root = new THREE.Group();
    root.name = `experiment-1-room:${detail}:${materialProfile}`;
    const objects = new Map();
    const resources = [];
    const overrides = new Map(transforms.map((entry) => [entry.instanceId ?? entry.objectId, entry]));
    for (const rawRecord of sourceFixture.objects) {
        const record = sourceObject(rawRecord);
        const override = overrides.get(record.id);
        if (override?.deleted) continue;
        const group = createObject(record, { detail, materialProfile, resources });
        group.name = record.label;
        group.userData.visualLabObjectId = record.id;
        group.userData.visualLabSourceObjectId = record.id;
        group.userData.visualLabEditable = record.editable;
        group.traverse((object) => Object.assign(object.userData, {
            visualLabObjectId: record.id,
            visualLabSourceObjectId: record.id,
            visualLabEditable: record.editable,
        }));
        applyTransform(group, record, override);
        root.add(group);
        objects.set(record.id, group);
    }
    for (const override of transforms.filter((entry) => entry.sourceObjectId
        && (entry.instanceId ?? entry.objectId) !== entry.sourceObjectId && !entry.deleted)) {
        const rawSource = sourceFixture.objects.find((entry) => entry.id === override.sourceObjectId);
        if (!rawSource || objects.has(override.instanceId ?? override.objectId)) continue;
        const source = sourceObject(rawSource);
        const instanceId = override.instanceId ?? override.objectId;
        const group = createObject(source, { detail, materialProfile, resources });
        group.name = `${source.label} copy`;
        group.traverse((object) => Object.assign(object.userData, {
            visualLabObjectId: instanceId,
            visualLabSourceObjectId: source.id,
            visualLabEditable: true,
        }));
        applyTransform(group, source, override);
        root.add(group);
        objects.set(instanceId, group);
    }
    return {
        root,
        objects,
        dispose() {
            root.removeFromParent();
            root.traverse((object) => object.geometry?.dispose?.());
            resources.forEach((resource) => resource.dispose?.());
            resources.length = 0;
            objects.clear();
        },
    };
}

export function createExperimentOneMetricFixtures({ detail = "detailed" } = {}) {
    return sourceFixture.objects.map((rawRecord) => {
        const record = sourceObject(rawRecord);
        return {
            id: record.id,
            tags: [record.category],
            primitives: experimentOneParts(record, detail).map((part) => ({
                id: `${record.id}:${part.id}`,
                shape: "box",
                center: {
                    x: record.position[0] + part.position[0],
                    y: record.position[1] + part.position[1],
                    z: record.position[2] + part.position[2],
                },
                size: { x: part.size[0], y: part.size[1], z: part.size[2] },
            })),
        };
    });
}
