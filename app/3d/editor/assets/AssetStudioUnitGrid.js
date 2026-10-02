import { gridPlanSignature, planAssetStudioUnitGrid } from "./assetStudioUnitGridPlan.js";

const MINOR_COLOR = 0x27272a;
const MAJOR_COLOR = 0x3f3f46;
const AXIS_COLORS = [0x9a5a5a, 0x5a8a62, 0x5a719a];

function createLine(THREE, color, opacity) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
    });
    const line = new THREE.LineSegments(geometry, material);
    line.renderOrder = -1;
    line.frustumCulled = false;
    line.visible = false;
    return line;
}

function setPositions(THREE, line, positions) {
    const array = positions.length >= 6 ? new Float32Array(positions) : new Float32Array(6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(array, 3));
    line.geometry.dispose();
    line.geometry = geometry;
    line.visible = positions.length >= 6;
}

function concatPlanes(planes, key) {
    let length = 0;
    for (const plane of planes) length += plane[key].length;
    const out = new Float32Array(length);
    let offset = 0;
    for (const plane of planes) {
        out.set(plane[key], offset);
        offset += plane[key].length;
    }
    return out;
}

/** Scene-space XY / XZ / YZ meter grid. Editor-only; not parented under the normalized asset root. */
export class AssetStudioUnitGrid {
    constructor(THREE) {
        this.THREE = THREE;
        this.group = new THREE.Group();
        this.group.name = "asset-studio-units";
        this.group.userData.skipEnvironmentSelection = true;
        this.minor = createLine(THREE, MINOR_COLOR, 0.55);
        this.major = createLine(THREE, MAJOR_COLOR, 0.55);
        this.axes = AXIS_COLORS.map((color) => createLine(THREE, color, 0.8));
        this.minor.name = "asset-studio-units-minor";
        this.major.name = "asset-studio-units-major";
        this.group.add(this.minor, this.major, ...this.axes);
        this.signature = null;
        this.last = { minorMeters: 1, label: "1 m" };
    }

    setVisible(visible) {
        this.group.visible = Boolean(visible);
    }

    sync({ camera, target, viewportWidth, viewportHeight } = {}) {
        if (!this.group.visible) return this.last;
        const plan = planAssetStudioUnitGrid({
            target: { x: target?.x ?? 0, y: target?.y ?? 0, z: target?.z ?? 0 },
            distance: camera.position.distanceTo(target),
            fovDegrees: camera.fov,
            viewportWidthPx: viewportWidth,
            viewportHeightPx: viewportHeight,
        });
        const signature = gridPlanSignature(plan);
        if (signature !== this.signature) {
            this.signature = signature;
            const THREE = this.THREE;
            setPositions(THREE, this.minor, concatPlanes(plan.planes, "minor"));
            setPositions(THREE, this.major, concatPlanes(plan.planes, "major"));
            const axes = [plan.axes.x, plan.axes.y, plan.axes.z];
            this.axes.forEach((line, index) => setPositions(THREE, line, axes[index]));
        }
        this.last = { minorMeters: plan.minorMeters, label: plan.label };
        return this.last;
    }

    dispose() {
        this.group.parent?.remove(this.group);
        for (const line of [this.minor, this.major, ...this.axes]) {
            line.geometry?.dispose?.();
            line.material?.dispose?.();
        }
        this.signature = null;
    }
}
