import * as THREE from "three";

import { getSensorType } from "./SensorTypeRegistry.js";
import { SensorRuntimeFactoryRegistry } from "./SensorRuntimeFactoryRegistry.js";
import { ManifestCamera } from "./ManifestCamera.js";
import { ManifestLidar3d } from "./ManifestLidar3d.js";
import { LiDAR3d } from "./LiDAR3d.js";
import { StereoCamera } from "./StereoCamera.js";

export { SensorRuntimeFactoryRegistry };

export const sensorRuntimeRegistry = new SensorRuntimeFactoryRegistry({ createUnknownPreview });

export function registerSensorRuntime(type, factories) {
    return sensorRuntimeRegistry.register(type, factories);
}

export function createRunSensorDevice(config, options = {}) {
    return sensorRuntimeRegistry.createRunDevice(config, options);
}

export function createVehicleSensorDevice(entry, context = {}) {
    return sensorRuntimeRegistry.createVehicleDevice(entry, context);
}

export function createSensorPreview(sensor) {
    return sensorRuntimeRegistry.createPreview(sensor);
}

export function getSensorPreviewSignature(sensor) {
    return sensorRuntimeRegistry.previewSignature(sensor);
}

registerSensorRuntime("camera", {
    createRunDevice: (config, options) => new ManifestCamera(config, options),
    createVehicleDevice(entry, { vehicleManifestId } = {}) {
        const position = toVector3(entry.pose.position);
        const rotation = toEuler(entry.pose.rotation);
        return new StereoCamera(entry.id, {
            position,
            rotation,
            range: entry.config.range,
            thetaStep: entry.config.thetaStep,
            phiStep: entry.config.phiStep,
            camera: {
                width: entry.config.width,
                height: entry.config.height,
                fov: entry.config.fov,
                near: entry.config.near,
                far: entry.config.far,
            },
            channels: {
                lidar: `${vehicleManifestId}/${entry.id}/lidar3d`,
                camera: `${vehicleManifestId}/${entry.id}/camera`,
            },
        });
    },
    createPreview(sensor) {
        const color = getSensorType(sensor.type)?.color ?? 0xf59e0b;
        const holder = new THREE.Group();
        holder.add(
            buildCameraFrustum(sensor.config, color),
            new THREE.Mesh(
                new THREE.BoxGeometry(0.08, 0.08, 0.12),
                new THREE.MeshStandardMaterial({ color, roughness: 0.4 }),
            ),
        );
        return holder;
    },
    previewSignature(sensor) {
        const { fov, width, height } = sensor.config;
        return `${sensor.type}:${fov}:${width}:${height}`;
    },
});

registerSensorRuntime("lidar3d", {
    createRunDevice: (config, options) => new ManifestLidar3d(config, options),
    createVehicleDevice(entry) {
        return new LiDAR3d(
            toVector3(entry.pose.position),
            toEuler(entry.pose.rotation),
            entry.config.range,
            entry.config.thetaStep,
            [...entry.config.thetaRange],
            entry.config.phiStep,
            [...entry.config.phiRange],
        );
    },
    createPreview(sensor) {
        const color = getSensorType(sensor.type)?.color ?? 0x38bdf8;
        const holder = new THREE.Group();
        holder.add(
            new THREE.Mesh(
                new THREE.CylinderGeometry(0.07, 0.07, 0.09, 20),
                new THREE.MeshStandardMaterial({ color, roughness: 0.35 }),
            ),
            new THREE.Mesh(
                new THREE.SphereGeometry(0.16, 12, 8),
                new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.35 }),
            ),
        );
        return holder;
    },
    previewSignature: (sensor) => sensor.type,
});

function toVector3(value = {}) {
    return new THREE.Vector3(value.x, value.y, value.z);
}

function toEuler(value = {}) {
    return new THREE.Euler(value.x, value.y, value.z, value.order || "XYZ");
}

function createUnknownPreview(sensor) {
    const holder = new THREE.Group();
    holder.add(new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.12, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x71717a, roughness: 0.8 }),
    ));
    holder.userData.unsupportedSensorType = sensor?.type || "unknown";
    return holder;
}

function buildCameraFrustum({ fov, width, height }, color) {
    const depth = 0.26;
    const halfHeight = depth * Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    const geometry = new THREE.ConeGeometry(halfHeight * Math.SQRT2, depth, 4, 1, true, Math.PI / 4);
    geometry.rotateZ(Math.PI / 2);
    geometry.translate(depth / 2, 0, 0);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, wireframe: true }));
    mesh.scale.z = width / height;
    return mesh;
}
