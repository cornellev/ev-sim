import * as THREE from "three";
import { Visualizer } from "../Visualizer.js";
import { applyControlsPathRibbonPose } from "../../autonomy/ControlsPathArc.js";
import { disableRaycast, disposeObject } from "../../3d/overlay/overlayObjects.js";
import { SCENARIO_DIAGNOSTIC_LAYER } from "../../scenarios/ScenarioDiagnostics.js";
import { paintOccupancyRgba } from "../../spatial/planview/occupancy/paint.js";

export const OCCUPANCY_CHANNELS = Object.freeze(["oracle", "lidar", "stack"]);

function defaults(grid) {
    return { ...grid, resolutionM: grid.resolutionM ?? 0.05,
        originX: grid.originX ?? grid.origin?.x ?? 0, originY: grid.originY ?? grid.origin?.y ?? 0,
        originZ: grid.originZ ?? grid.origin?.z ?? 0, yawRad: grid.yawRad ?? 0,
        encoding: grid.encoding ?? grid.palette ?? "cost", vehicleRelative: grid.vehicleRelative ?? false };
}

function planeGeometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    geometry.setIndex([0, 2, 1, 2, 3, 1]);
    return geometry;
}

/** One owned grid per comparison channel; both views share its single color conversion. */
export class OccupancyVisualizer extends Visualizer {
    constructor(options = {}) {
        super({ ...options, optionalInputs: { oracle: null, lidar: null, stack: null, stackMessage: "" } });
        this.displayOnStatusChange = true;
        this.group = disableRaycast(new THREE.Group());
        this.group.name = "occupancy-visualizer";
        this.group.userData.nonColliding = true;
        this.channels = new Map(OCCUPANCY_CHANNELS.map((id) => [id, { grid: null, revision: 0, paintedRevision: -1, rgba: null, root: null, plane: null, texture: null, map: null }]));
        this.mapOutput = { grids: {}, stackMessage: "" };
    }

    validateInputs(inputs) {
        for (const id of OCCUPANCY_CHANNELS) {
            if (inputs[id] == null) continue;
            const grid = defaults(inputs[id]);
            if (!Number.isSafeInteger(grid.width) || grid.width <= 0 || !Number.isSafeInteger(grid.height) || grid.height <= 0
                || !Number.isSafeInteger(grid.width * grid.height)) return `${id} occupancy dimensions must be positive integers.`;
            if (!(Array.isArray(grid.cells) || (ArrayBuffer.isView(grid.cells) && !(grid.cells instanceof DataView)))
                || grid.cells.length !== grid.width * grid.height) return `${id} occupancy cells must match the exact dimensions.`;
            if (!Number.isFinite(grid.resolutionM) || grid.resolutionM <= 0) return `${id} occupancy resolution must be positive.`;
            if (![grid.originX, grid.originY, grid.originZ, grid.yawRad].every(Number.isFinite)) return `${id} occupancy origin and yaw must be finite.`;
            if (!["cost", "ternary"].includes(grid.encoding) || typeof grid.vehicleRelative !== "boolean") return `${id} occupancy encoding or frame placement is invalid.`;
        }
        return typeof inputs.stackMessage === "string" || "Occupancy diagnostics must be text.";
    }

    validatePose(pose) {
        if (!pose.position || ![pose.position.x, pose.position.y ?? 0, pose.position.z].every(Number.isFinite)) return "Occupancy pose must have a finite position.";
        if (![pose.yaw ?? 0, pose.rotation?.x ?? 0, pose.rotation?.y ?? 0, pose.rotation?.z ?? 0].every(Number.isFinite)
            || !["XYZ", "YZX", "ZXY", "XZY", "YXZ", "ZYX"].includes(pose.rotation?.order ?? "XYZ")) return "Occupancy pose rotation must be finite.";
        return true;
    }

    onDataUpdate(inputs, changedKeys) {
        for (const id of OCCUPANCY_CHANNELS) {
            if (!changedKeys.includes(id)) continue;
            const channel = this.channels.get(id);
            channel.grid = inputs[id] == null ? null : { ...defaults(inputs[id]), cells: inputs[id].cells.slice() };
            channel.revision += 1;
        }
    }

    acceptVehicleMove(pose, metadata) {
        const prior = { scene: this.dirty.scene.placement, map: this.dirty.map.placement };
        const accepted = super.acceptVehicleMove(pose, metadata);
        if (![...this.channels.values()].some(({ grid }) => grid?.vehicleRelative)) {
            for (const target of ["scene", "map"]) this.dirty[target].placement = prior[target];
        }
        return accepted;
    }

    _paint(channel) {
        if (channel.paintedRevision === channel.revision) return;
        const grid = channel.grid;
        channel.rgba = paintOccupancyRgba(grid.cells, grid.width, grid.height, grid.encoding, channel.rgba);
        channel.paintedRevision = channel.revision;
        if (channel.texture) {
            channel.texture.image = { data: channel.rgba, width: grid.width, height: grid.height };
            channel.texture.needsUpdate = true;
        }
    }

    _place(channel) {
        const grid = channel.grid;
        channel.root ??= disableRaycast(new THREE.Group());
        applyControlsPathRibbonPose(channel.root, grid.vehicleRelative ? this.pose : null);
        channel.root.updateMatrix();
        const matrix = channel.root.matrix.clone().multiply(new THREE.Matrix4().compose(
            new THREE.Vector3(grid.originX, grid.originY, grid.originZ),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), grid.yawRad),
            new THREE.Vector3(grid.width * grid.resolutionM, 1, grid.height * grid.resolutionM),
        ));
        if (channel.plane) { channel.plane.matrix.copy(matrix); channel.plane.matrixWorldNeedsUpdate = true; }
        return [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, z]) => {
            const point = new THREE.Vector3(x, 0, z).applyMatrix4(matrix);
            return { x: point.x, y: point.y, z: point.z };
        });
    }

    display({ scene, camera } = {}) {
        camera?.layers?.enable?.(SCENARIO_DIAGNOSTIC_LAYER);
        if (scene && !this.group.parent) scene.add(this.group);
        for (const [id, channel] of this.channels) {
            if (!channel.grid || this.layerVisibility.scene[id] === false) { if (channel.plane) channel.plane.visible = false; continue; }
            this._paint(channel);
            if (!channel.plane) {
                channel.texture = new THREE.DataTexture(channel.rgba, channel.grid.width, channel.grid.height, THREE.RGBAFormat);
                channel.texture.minFilter = channel.texture.magFilter = THREE.NearestFilter;
                channel.texture.generateMipmaps = false;
                channel.texture.needsUpdate = true;
                channel.plane = disableRaycast(new THREE.Mesh(planeGeometry(), new THREE.MeshBasicMaterial({ map: channel.texture, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide })));
                channel.plane.name = `occupancy-${id}`;
                channel.plane.matrixAutoUpdate = false;
                channel.plane.renderOrder = 1090 + OCCUPANCY_CHANNELS.indexOf(id);
                this.group.add(channel.plane);
            }
            this._place(channel);
            channel.plane.visible = true;
        }
        this.group.visible = this.visible.scene;
        return this.group;
    }

    displayMap() {
        const grids = {};
        for (const [id, channel] of this.channels) {
            if (!channel.grid || this.layerVisibility.map[id] === false) continue;
            this._paint(channel);
            const corners = this._place(channel);
            if (channel.map?.revision !== channel.revision || corners.some((point, index) => ["x", "y", "z"].some((key) => point[key] !== channel.map.corners[index][key]))) {
                channel.map = { ...channel.grid, originX: corners[0].x, originY: corners[0].y, originZ: corners[0].z,
                    rgba: channel.rgba, revision: channel.revision, corners };
            }
            grids[id] = channel.map;
        }
        this.mapOutput = { grids, stackMessage: this.inputs.stackMessage };
        return this.mapOutput;
    }

    onVisibilityChange(target, visible) { if (target === "scene") this.group.visible = visible && this.ready; }
    onLayerVisibilityChange(id, target, visible) { if (target === "scene" && this.channels.get(id)?.plane) this.channels.get(id).plane.visible = visible && Boolean(this.channels.get(id).grid); }
    reset() {
        super.reset();
        for (const channel of this.channels.values()) { channel.grid = null; channel.map = null; channel.revision += 1; if (channel.plane) channel.plane.visible = false; }
        this.mapOutput = { grids: {}, stackMessage: "" };
    }
    dispose() {
        this.group.traverse(disposeObject);
        this.group.removeFromParent();
        this.group.clear();
        this.channels.clear();
        this.mapOutput = { grids: {}, stackMessage: "" };
        super.dispose();
    }
}
