import {
    buildTFMessage,
    buildTransformStamped,
    eulerToQuaternion,
    quaternionMultiply,
    rep103EulerToThree,
    threeEulerToRep103,
    threePoseToRep103,
    threeToRep103Vector,
} from "../autonomy/CoordinateFrames.js";
import { staticTransformMessages } from "../autonomy/CalibrationBundle.js";

function rep103PoseFromVehicle(vehicle) {
    const position = vehicle?.position || vehicle?.getPosition?.();
    const rotation = vehicle?.rotation || vehicle?.getRotation?.();
    return threePoseToRep103({
        position: {
            x: Number(position?.x || 0),
            y: Number(position?.y || 0),
            z: Number(position?.z || 0),
        },
        rotation: {
            x: Number(rotation?.x || 0),
            y: Number(rotation?.y || 0),
            z: Number(rotation?.z || 0),
            order: rotation?.order || "XYZ",
        },
    });
}

export class TransformRuntime {
    constructor(calibrationBundle, topicRouter, options = {}) {
        this.bundle = calibrationBundle;
        this.topicRouter = topicRouter;
        this.client = options.client ?? null;
        this.frames = calibrationBundle?.frames || {};
        this.staticPublished = false;
        this._tree = buildFrameTree(calibrationBundle);
    }

    publishStaticTransforms(timeNs = 0) {
        const transforms = staticTransformMessages(this.bundle, timeNs);
        const payload = buildTFMessage(transforms);
        this._routeOutbound("tf-static", payload, { captureTimeNs: timeNs, deliveryTimeNs: timeNs, cycle: 0 });
        this.staticPublished = true;
        return payload;
    }

    publishDynamicTransforms(timeNs, step, vehicles = []) {
        const vehicle = vehicles.find((entry) => (entry.telemetryId || entry.id) === this.frames.vehicleId)
            || vehicles[0]
            || null;
        const basePose = rep103PoseFromVehicle(vehicle);
        const transforms = [
            buildTransformStamped({
                timeNs,
                parentFrameId: this.frames.map,
                childFrameId: this.frames.odom,
                translation: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0, w: 1 },
            }),
            buildTransformStamped({
                timeNs,
                parentFrameId: this.frames.odom,
                childFrameId: this.frames.baseLink,
                translation: basePose.position,
                euler: basePose.rotation,
            }),
        ];
        const payload = buildTFMessage(transforms);
        this._routeOutbound("tf", payload, { captureTimeNs: timeNs, deliveryTimeNs: timeNs, cycle: step });
        return payload;
    }

    resolveCaptureFrames(sensorConfig, vehicles = [], captureTimeNs = 0) {
        const validation = validateMeasurementFrame(this._tree, sensorConfig, this.frames);
        if (!validation.ok) {
            return validation;
        }
        const vehicle = vehicles.find((entry) => (entry.telemetryId || entry.id) === sensorConfig.parentId) || null;
        const basePose = rep103PoseFromVehicle(vehicle);
        const mapPose = {
            position: { ...basePose.position },
            rotation: eulerToQuaternion(basePose.rotation),
        };
        return {
            ok: true,
            captureTimeNs,
            measurementFrameId: validation.measurementFrameId,
            mountFrameId: validation.mountFrameId,
            baseLinkFrameId: this.frames.baseLink,
            mapFrameId: this.frames.map,
            baseLinkPose: basePose,
            mapPose,
            syncGroupKey: sensorConfig.syncGroupId
                ? `${sensorConfig.syncGroupId}:${Math.floor(captureTimeNs / Math.max(1, this.bundle?.stepNs || 1))}`
                : null,
        };
    }

    _routeOutbound(contractId, payload, metadata) {
        const routed = this.topicRouter?.routeOutbound?.(contractId, {
            value: payload,
            typeStr: "tf2_msgs/TFMessage",
        }, metadata);
        const topic = this.topicRouter?.getTopic?.(contractId);
        if (topic && this.client?.isOpen?.()) {
            this.client.publish(topic.name, topic.schema?.type || topic.type, payload).catch?.(() => {});
        }
        return routed;
    }
}

function buildFrameTree(bundle) {
    const parents = new Map();
    for (const entry of bundle?.staticTransforms || []) {
        parents.set(entry.childFrameId, entry.parentFrameId);
    }
    parents.set(bundle?.frames?.baseLink, bundle?.frames?.odom);
    parents.set(bundle?.frames?.odom, bundle?.frames?.map);
    return parents;
}

export function validateMeasurementFrame(tree, sensorConfig, frames = {}) {
    const mountFrameId = sensorConfig.mountFrameId || sensorConfig.frameId;
    const measurementFrameId = sensorConfig.measurementFrameId || sensorConfig.frameId || mountFrameId;
    if (!mountFrameId || !measurementFrameId) {
        return { ok: false, code: "missing-frame", message: `Sensor "${sensorConfig.id}" is missing frame ids.` };
    }
    const chain = [measurementFrameId];
    let current = measurementFrameId;
    const visited = new Set();
    while (tree.has(current)) {
        if (visited.has(current)) {
            return { ok: false, code: "frame-cycle", message: `Frame tree cycle at "${current}".` };
        }
        visited.add(current);
        current = tree.get(current);
        chain.push(current);
        if (current === frames.baseLink) break;
    }
    if (current !== frames.baseLink) {
        return {
            ok: false,
            code: "invalid-tree",
            message: `Measurement frame "${measurementFrameId}" does not resolve to "${frames.baseLink}".`,
        };
    }
    return { ok: true, mountFrameId, measurementFrameId, chain };
}

export function validateSensorRigFrames(manifest) {
    const issues = [];
    const sensorRig = manifest?.sensorRig || {};
    const bundle = { frames: {
        map: sensorRig.mapFrameId || "map",
        odom: sensorRig.odomFrameId || "odom",
        baseLink: sensorRig.rootFrameId || "base_link",
        vehicleId: sensorRig.vehicleId || "ego",
    }, staticTransforms: [], stepNs: manifest?.clock?.stepNs || 16_666_667 };
    const frameIds = new Set([bundle.frames.map, bundle.frames.odom, bundle.frames.baseLink]);
    for (const sensor of sensorRig.sensors || []) {
        const mount = sensor.mountFrameId || sensor.frameId;
        const measurement = sensor.measurementFrameId || sensor.frameId || mount;
        if (mount) frameIds.add(mount);
        if (measurement) frameIds.add(measurement);
        bundle.staticTransforms.push({
            parentFrameId: bundle.frames.baseLink,
            childFrameId: mount,
            translation: sensor.pose?.position || { x: 0, y: 0, z: 0 },
            rotation: eulerToQuaternion(sensor.pose?.rotation || {}),
        });
        if (measurement !== mount && sensor.type === "camera") {
            bundle.staticTransforms.push({
                parentFrameId: mount,
                childFrameId: measurement,
                translation: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0, w: 1 },
            });
        }
    }
    const parents = buildFrameTree(bundle);
    const childParents = new Map();
    for (const [child, parent] of parents) {
        if (childParents.has(child) && childParents.get(child) !== parent) {
            issues.push({ path: "sensorRig", message: `Frame "${child}" has multiple parents.` });
        }
        childParents.set(child, parent);
    }
    for (const frameId of frameIds) {
        if (!/^[\w/-]+$/.test(frameId)) {
            issues.push({ path: "sensorRig", message: `Illegal frame id "${frameId}".` });
        }
    }
    for (const [index, sensor] of (sensorRig.sensors || []).entries()) {
        const result = validateMeasurementFrame(parents, sensor, bundle.frames);
        if (!result.ok) {
            issues.push({ path: `sensorRig.sensors.${index}.measurementFrameId`, message: result.message });
        }
    }
    return issues;
}

export function validateSyncGroups(manifest) {
    const issues = [];
    const topics = new Map((manifest.topics || []).map((topic) => [topic.id, topic]));
    const groups = manifest?.sensorRig?.syncGroups || [];
    const seen = new Set();
    for (const [index, group] of groups.entries()) {
        const id = String(group?.id || "").trim();
        if (!id) {
            issues.push({ path: `sensorRig.syncGroups.${index}.id`, message: "Sync group id is required." });
            continue;
        }
        if (seen.has(id)) {
            issues.push({ path: `sensorRig.syncGroups.${index}.id`, message: `Duplicate sync group "${id}".` });
        }
        seen.add(id);
        for (const [topicIndex, topicId] of (group.topicIds || []).entries()) {
            if (!topics.has(topicId)) {
                issues.push({
                    path: `sensorRig.syncGroups.${index}.topicIds.${topicIndex}`,
                    message: `Unknown topic id "${topicId}".`,
                });
            }
        }
    }
    for (const [index, sensor] of (manifest?.sensorRig?.sensors || []).entries()) {
        if (!sensor.syncGroupId) continue;
        if (!seen.has(sensor.syncGroupId)) {
            issues.push({
                path: `sensorRig.sensors.${index}.syncGroupId`,
                message: `Unknown sync group "${sensor.syncGroupId}".`,
            });
        }
    }
    return issues;
}

export { rep103EulerToThree, threeToRep103Vector };
