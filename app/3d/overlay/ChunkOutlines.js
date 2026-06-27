import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

const CHUNK_OUTLINE_COLOR = 0x22d3ee;
const CHUNK_GRID_STEP = 5;

function pushLine(points, a, b) {
    points.push(new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z));
}

function createChunkGrid(chunk, height) {
    const { minX, minZ, maxX, maxZ } = chunk.bounds;
    const points = [];
    const width = maxX - minX;
    const depth = maxZ - minZ;
    const xDivisions = Math.max(1, Math.round(width / CHUNK_GRID_STEP));
    const zDivisions = Math.max(1, Math.round(depth / CHUNK_GRID_STEP));
    const yDivisions = Math.max(1, Math.round(height / CHUNK_GRID_STEP));

    for (let xi = 0; xi <= xDivisions; xi += 1) {
        const x = minX + (width * xi) / xDivisions;
        pushLine(points, { x, y: 0, z: minZ }, { x, y: height, z: minZ });
        pushLine(points, { x, y: 0, z: maxZ }, { x, y: height, z: maxZ });
    }

    for (let zi = 0; zi <= zDivisions; zi += 1) {
        const z = minZ + (depth * zi) / zDivisions;
        pushLine(points, { x: minX, y: 0, z }, { x: minX, y: height, z });
        pushLine(points, { x: maxX, y: 0, z }, { x: maxX, y: height, z });
    }

    for (let yi = 0; yi <= yDivisions; yi += 1) {
        const y = (height * yi) / yDivisions;
        pushLine(points, { x: minX, y, z: minZ }, { x: maxX, y, z: minZ });
        pushLine(points, { x: maxX, y, z: minZ }, { x: maxX, y, z: maxZ });
        pushLine(points, { x: maxX, y, z: maxZ }, { x: minX, y, z: maxZ });
        pushLine(points, { x: minX, y, z: maxZ }, { x: minX, y, z: minZ });
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
        color: CHUNK_OUTLINE_COLOR,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = `ChunkGrid:${chunk.key}`;
    lines.renderOrder = 998;
    lines.userData.skipEnvironmentSelection = true;
    return lines;
}

function disposeGroup(group) {
    group?.traverse?.((object) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) {
            object.material.forEach((material) => material?.dispose?.());
        } else {
            object.material?.dispose?.();
        }
    });
}

export function ChunkOutlines({ data }) {
    const groupRef = useRef(null);
    const [chunks, setChunks] = useState([]);
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        const registry = data?.environment?.()?.objects?.();
        return registry?.subscribe?.((snapshot) => {
            setChunks(snapshot.chunks ?? []);
        });
    }, [data]);

    useEffect(() => {
        const editor = data?.editor?.();
        return editor?.subscribe?.((snapshot) => {
            setVisible(snapshot.chunkOutlinesVisible !== false);
        });
    }, [data]);

    useEffect(() => {
        const scene = data?.three?.()?.scene;
        const chunkSize = data?.environment?.()?.chunks?.()?.chunkSize ?? 20;
        if (!scene) return undefined;

        if (groupRef.current) {
            groupRef.current.parent?.remove?.(groupRef.current);
            disposeGroup(groupRef.current);
        }

        const group = new THREE.Group();
        group.name = "EnvironmentChunkOutlines";
        group.visible = visible;
        group.userData.skipEnvironmentSelection = true;

        chunks.forEach((chunk) => {
            group.add(createChunkGrid(chunk, chunkSize));
        });

        scene.add(group);
        groupRef.current = group;
        data?.simulation?.()?.render?.();

        return () => {
            group.parent?.remove?.(group);
            disposeGroup(group);
            if (groupRef.current === group) {
                groupRef.current = null;
            }
        };
    }, [chunks, data, visible]);

    return null;
}
