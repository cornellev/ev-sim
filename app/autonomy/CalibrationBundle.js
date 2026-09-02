import { createHash } from "node:crypto";

import { PERCEPTION_LABEL_CATALOG_VERSION } from "./AutonomyContractCatalog.js";
import {
    buildTransformStamped,
    cameraLinkToOpticalRotation,
    composeRep103Poses,
    eulerToQuaternion,
    rep103PoseToThree,
} from "./CoordinateFrames.js";
import { canonicalNumericTree } from "../simulation/kernel/SimulationHashes.js";

function text(value, fallback = "") {
    const normalized = String(value ?? "").trim();
    return normalized || fallback;
}

function canonicalStringify(value) {
    const normalize = (entry) => {
        if (Array.isArray(entry)) return entry.map(normalize);
        if (!entry || typeof entry !== "object") return entry;
        return Object.fromEntries(
            Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]),
        );
    };
    return JSON.stringify(normalize(value));
}

function defaultSensorFrames(sensor) {
    const id = sensor.id;
    const isCamera = sensor.type === "camera";
    const mountFrameId = text(sensor.mountFrameId, isCamera ? `${id.replace(/-camera$/, "")}_camera_link`.replace(/^([^-]+)$/, "$1_camera_link") : sensor.frameId || `${id}_frame`);
    const measurementFrameId = text(sensor.measurementFrameId, sensor.frameId || mountFrameId);
    if (isCamera && !sensor.mountFrameId && sensor.frameId?.includes("optical")) {
        const base = sensor.frameId.replace(/_optical_frame$/, "_link").replace(/_optical$/, "_link");
        return { mountFrameId: base, measurementFrameId: sensor.frameId };
    }
    return { mountFrameId, measurementFrameId };
}

function staticTransformsForSensor(sensor, rootFrameId) {
    const { mountFrameId, measurementFrameId } = defaultSensorFrames(sensor);
    const transforms = [];
    const mountPose = {
        position: sensor.pose?.position || { x: 0, y: 0, z: 0 },
        rotation: sensor.pose?.rotation || { x: 0, y: 0, z: 0, order: "XYZ" },
    };
    transforms.push({
        parentFrameId: rootFrameId,
        childFrameId: mountFrameId,
        translation: mountPose.position,
        rotation: eulerToQuaternion(mountPose.rotation),
    });
    if (measurementFrameId !== mountFrameId) {
        if (sensor.type === "camera") {
            const opticalQ = cameraLinkToOpticalRotation();
            transforms.push({
                parentFrameId: mountFrameId,
                childFrameId: measurementFrameId,
                translation: { x: 0, y: 0, z: 0 },
                rotation: opticalQ,
            });
        } else {
            transforms.push({
                parentFrameId: mountFrameId,
                childFrameId: measurementFrameId,
                translation: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0, w: 1 },
            });
        }
    }
    return transforms;
}

function sensorSchedule(sensor, stepNs) {
    const periodSteps = Math.max(1, Math.round(1e9 / (Number(sensor.rateHz || 10) * stepNs)));
    const phaseSteps = Math.max(0, Math.round(Number(sensor.phaseNs || 0) / stepNs));
    return { periodSteps, phaseSteps, stepNs };
}

export function buildCalibrationBundle(manifest, options = {}) {
    const sensorRig = manifest?.sensorRig || {};
    const clock = manifest?.clock || {};
    const stepNs = Math.max(1, Number(clock.stepNs || 16_666_667));
    const mapFrameId = text(sensorRig.mapFrameId, "map");
    const odomFrameId = text(sensorRig.odomFrameId, "odom");
    const rootFrameId = text(sensorRig.rootFrameId, "base_link");
    const vehicleId = text(sensorRig.vehicleId, "ego");

    const syncGroups = (Array.isArray(sensorRig.syncGroups) ? sensorRig.syncGroups : []).map((group, index) => ({
        id: text(group.id, `sync-${index + 1}`),
        topicIds: [...new Set((group.topicIds || []).map((entry) => text(entry)).filter(Boolean))].sort(),
        description: text(group.description),
    }));

    const sensors = [...(sensorRig.sensors || [])]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((sensor) => {
            const frames = defaultSensorFrames(sensor);
            const schedule = sensorSchedule(sensor, stepNs);
            return {
                id: sensor.id,
                type: sensor.type,
                enabled: sensor.enabled !== false,
                parentId: sensor.parentId,
                syncGroupId: text(sensor.syncGroupId) || null,
                mountFrameId: frames.mountFrameId,
                measurementFrameId: frames.measurementFrameId,
                legacyFrameId: text(sensor.frameId) || frames.measurementFrameId,
                pose: {
                    position: { ...(sensor.pose?.position || { x: 0, y: 0, z: 0 }) },
                    rotation: { ...(sensor.pose?.rotation || { x: 0, y: 0, z: 0, order: "XYZ" }) },
                },
                threePose: rep103PoseToThree(sensor.pose),
                calibration: structuredClone(sensor.calibration || {}),
                outputs: structuredClone(sensor.outputs || {}),
                schema: structuredClone(sensor.schema || {}),
                health: structuredClone(sensor.health || {}),
                noise: structuredClone(sensor.noise || {}),
                schedule,
            };
        });

    const staticTransforms = [];
    for (const sensor of sensors) {
        if (sensor.enabled === false) continue;
        staticTransforms.push(...staticTransformsForSensor(
            { ...sensor, pose: sensors.find((entry) => entry.id === sensor.id)?.pose },
            rootFrameId,
        ));
    }
    staticTransforms.sort((left, right) => {
        const keyA = `${left.parentFrameId}:${left.childFrameId}`;
        const keyB = `${right.parentFrameId}:${right.childFrameId}`;
        return keyA.localeCompare(keyB);
    });

    const frameIds = new Set([mapFrameId, odomFrameId, rootFrameId]);
    for (const sensor of sensors) {
        frameIds.add(sensor.mountFrameId);
        frameIds.add(sensor.measurementFrameId);
    }

    const bundle = canonicalNumericTree({
        kind: "cev-sim.calibration-bundle",
        version: 2,
        manifestId: manifest.id,
        manifestVersion: manifest.version,
        seed: manifest.seed,
        stepNs,
        labelCatalogVersion: PERCEPTION_LABEL_CATALOG_VERSION,
        frames: {
            map: mapFrameId,
            odom: odomFrameId,
            baseLink: rootFrameId,
            vehicleId,
        },
        syncGroups,
        sensors,
        staticTransforms,
        frameIds: [...frameIds].sort(),
    });
    bundle.hash = calibrationBundleHash(bundle);
    return bundle;
}

export function calibrationBundleHash(bundle) {
    const { hash, ...rest } = bundle || {};
    return createHash("sha256").update(canonicalStringify(rest)).digest("hex");
}

export function staticTransformMessages(bundle, timeNs = 0) {
    return (bundle?.staticTransforms || []).map((entry) => buildTransformStamped({
        timeNs,
        parentFrameId: entry.parentFrameId,
        childFrameId: entry.childFrameId,
        translation: entry.translation,
        rotation: entry.rotation,
    }));
}

export function resolveMeasurementToRoot(bundle, sensorId) {
    const sensor = bundle?.sensors?.find((entry) => entry.id === sensorId);
    if (!sensor) return null;
    const mountPose = {
        position: sensor.pose.position,
        rotation: sensor.pose.rotation,
    };
    if (sensor.measurementFrameId === sensor.mountFrameId) {
        return mountPose;
    }
    if (sensor.type === "camera") {
        const composed = composeRep103Poses(mountPose, {
            position: { x: 0, y: 0, z: 0 },
            rotation: cameraLinkToOpticalRotation(),
        });
        return {
            position: composed.position,
            rotation: composed.rotation,
        };
    }
    return mountPose;
}
