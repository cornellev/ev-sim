import { Euler, Vector3 } from "three";

import { cameraScanAngles } from "../../../3d/devices/cameraScanAngles.js";
import { CPU_LIDAR_NEAR_METERS } from "../../../simulation/sensors/CpuLidarScene.js";
import { assertRangeImageLayout } from "../../../simulation/sensors/RangeImageLayout.js";

const NOT_RANGING = new Set(["imu", "gnss", "wheel-odometry"]);

/**
 * Rays a vehicle-document sensor would cast, in the editor frame.
 * Plugin sensors contribute their declared scan layout. Plugin code is not run.
 *
 * @param {object} manifest
 * @param {{ get: (type: string) => object|null }} [definitions]
 * @returns {{ rays: object[], skipped: { id: string, type: string, reason: string }[] }}
 */
export function enumerateCoverageRays(manifest, definitions) {
    const rays = [];
    const skipped = [];
    for (const sensor of manifest?.sensors ?? []) {
        const type = String(sensor?.type ?? "");
        const id = String(sensor?.id ?? "");
        if (NOT_RANGING.has(type)) {
            skipped.push({ id, type, reason: "not-ranging" });
            continue;
        }
        const definition = lookupDefinition(definitions, type);
        if (definition?.pluginSensor) {
            const layout = pluginLayout(sensor, definition);
            if (!layout) {
                skipped.push({ id, type, reason: "invalid-layout" });
                continue;
            }
            appendRangeImage(rays, sensor, layout);
            continue;
        }
        if (type === "lidar3d" || type === "camera") {
            const grid = uniformGrid(sensor);
            if (!grid) {
                skipped.push({ id, type, reason: "invalid-layout" });
                continue;
            }
            appendUniformGrid(rays, sensor, grid);
            continue;
        }
        skipped.push({ id, type, reason: "unknown-type" });
    }
    return { rays, skipped };
}

/**
 * Sensor-local direction before the vehicle pose is applied.
 * Matches CpuLidarScene and LiDAR3d: +X forward, +Y up.
 */
export function sphericalDirection(thetaRad, phiRad) {
    const cosPhi = Math.cos(phiRad);
    return {
        x: cosPhi * Math.cos(thetaRad),
        y: Math.sin(phiRad),
        z: cosPhi * Math.sin(thetaRad),
    };
}

function lookupDefinition(definitions, type) {
    if (!definitions || typeof definitions.get !== "function") return null;
    return definitions.get(type) ?? null;
}

function pluginLayout(sensor, definition) {
    const source = sensor?.config?.scanLayout
        ?? definition?.pluginSensor?.descriptor?.defaults?.scanLayout
        ?? null;
    if (!source) return null;
    try {
        return assertRangeImageLayout(source);
    } catch {
        return null;
    }
}

function uniformGrid(sensor) {
    const config = sensor?.config ?? {};
    const range = Number(config.range);
    const thetaStep = Number(config.thetaStep);
    const phiStep = Number(config.phiStep);
    if (!(range > 0) || !(thetaStep > 0) || !(phiStep > 0)) return null;
    const angles = sensor?.type === "camera"
        ? cameraScanAngles(config)
        : {
            thetaRange: pair(config.thetaRange, [-180, 180]),
            phiRange: pair(config.phiRange, [-20, 20]),
        };
    if (!angles.thetaRange || !angles.phiRange) return null;
    return {
        range,
        thetaStep,
        phiStep,
        thetaRange: angles.thetaRange,
        phiRange: angles.phiRange,
        minRangeM: CPU_LIDAR_NEAR_METERS,
    };
}

function pair(value, fallback) {
    if (!Array.isArray(value) || value.length !== 2) return [...fallback];
    const low = Number(value[0]);
    const high = Number(value[1]);
    if (!Number.isFinite(low) || !Number.isFinite(high) || !(high > low)) return null;
    return [low, high];
}

function appendUniformGrid(rays, sensor, grid) {
    const [thetaStart, thetaEnd] = grid.thetaRange;
    const [phiStart, phiEnd] = grid.phiRange;
    const thetaCount = Math.ceil((thetaEnd - thetaStart) / grid.thetaStep);
    const phiCount = Math.ceil((phiEnd - phiStart) / grid.phiStep);
    const pose = sensorPose(sensor);
    for (let phiIndex = 0; phiIndex < phiCount; phiIndex += 1) {
        const phiDeg = phiStart + phiIndex * grid.phiStep;
        if (phiDeg > phiEnd) continue;
        for (let thetaIndex = 0; thetaIndex < thetaCount; thetaIndex += 1) {
            const thetaDeg = thetaStart + thetaIndex * grid.thetaStep;
            if (thetaDeg > thetaEnd) continue;
            pushRay(rays, sensor, {
                family: "uniform-grid",
                index: phiIndex * thetaCount + thetaIndex,
                pose,
                thetaRad: thetaDeg * Math.PI / 180,
                phiRad: phiDeg * Math.PI / 180,
                minRangeM: grid.minRangeM,
                maxRangeM: grid.range,
            });
        }
    }
}

function appendRangeImage(rays, sensor, layout) {
    const pose = sensorPose(sensor);
    const width = layout.azimuthsDeg.length;
    layout.channels.forEach((channel, channelIndex) => {
        const phiRad = channel.elevationDeg * Math.PI / 180;
        layout.azimuthsDeg.forEach((azimuthDeg, azimuthIndex) => {
            pushRay(rays, sensor, {
                family: "range-image",
                index: channelIndex * width + azimuthIndex,
                pose,
                thetaRad: (azimuthDeg + channel.azimuthOffsetDeg) * Math.PI / 180,
                phiRad,
                minRangeM: layout.minRangeM,
                maxRangeM: layout.maxRangeM,
            });
        });
    });
}

function sensorPose(sensor) {
    const position = sensor?.pose?.position ?? {};
    const rotation = sensor?.pose?.rotation ?? {};
    return {
        origin: {
            x: finite(position.x),
            y: finite(position.y),
            z: finite(position.z),
        },
        euler: new Euler(
            finite(rotation.x),
            finite(rotation.y),
            finite(rotation.z),
            rotation.order || "XYZ",
        ),
    };
}

function pushRay(rays, sensor, spec) {
    const local = sphericalDirection(spec.thetaRad, spec.phiRad);
    const direction = new Vector3(local.x, local.y, local.z)
        .applyEuler(spec.pose.euler)
        .normalize();
    if (!Number.isFinite(direction.x)) return;
    rays.push({
        sensorId: String(sensor?.id ?? ""),
        sensorType: String(sensor?.type ?? ""),
        family: spec.family,
        index: spec.index,
        origin: spec.pose.origin,
        direction: { x: direction.x, y: direction.y, z: direction.z },
        minRangeM: spec.minRangeM,
        maxRangeM: spec.maxRangeM,
    });
}

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}
