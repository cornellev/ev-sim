import { createHash } from "node:crypto";

import { flipRows, warpBrownConrady } from "../../app/3d/perception/CameraRenderProducts.js";
import { SeededRNG } from "../../app/util/SeededRNG.js";

function rngAtState(state) {
    const rng = new SeededRNG(0);
    rng._state = Number(state) >>> 0;
    return rng;
}

function gaussian(rng) {
    const left = Math.max(Number.EPSILON, rng.next());
    return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * rng.next());
}

function digest(value) {
    return createHash("sha256")
        .update(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
        .digest("hex");
}

function cameraObservation(rendered, request) {
    const calibration = request.sensor.calibration;
    const upright = flipRows(rendered, request.width, request.height, 4);
    const values = warpBrownConrady({
        data: upright,
        width: request.width,
        height: request.height,
        intrinsics: calibration.intrinsics,
        distortion: calibration.distortion,
        channels: 4,
        interpolation: "linear",
    });
    const noise = request.sensor.noise;
    const rng = rngAtState(request.rngState);
    if (noise.model === "gaussian" || Number(noise.bias) !== 0) {
        for (let offset = 0; offset < values.length; offset += 4) {
            for (let channel = 0; channel < 3; channel += 1) {
                const perturbation = Number(noise.bias || 0)
                    + (noise.model === "gaussian" ? gaussian(rng) * Number(noise.standardDeviation || 0) : 0);
                values[offset + channel] = Math.max(0, Math.min(255, Math.round(values[offset + channel] + perturbation)));
            }
        }
    }
    return { dtype: "uint8", scalarType: 4, shape: [request.height, request.width, 4], values, digest: digest(values) };
}

function lidarObservation(rendered, request) {
    const values = new Float32Array(request.width * request.height * 2);
    const noise = request.sensor.noise;
    const calibration = request.sensor.calibration;
    const rng = rngAtState(request.rngState);
    for (let index = 0; index < request.width * request.height; index += 1) {
        const offset = index * 4;
        if (!(rendered[offset] > 0) || !(rendered[offset + 3] > 0)) continue;
        if (Number(noise.pointDropoutProbability) > 0
            && rng.next() < noise.pointDropoutProbability) continue;
        let range = rendered[offset] + Number(noise.bias || 0);
        if (noise.model === "gaussian" && Number(noise.standardDeviation) > 0) {
            range += gaussian(rng) * Number(noise.standardDeviation);
        }
        values[index * 2] = Math.max(0, Math.min(Number(calibration.range), range));
        values[index * 2 + 1] = rendered[offset + 1];
    }
    return { dtype: "float32", scalarType: 1, shape: [request.height, request.width, 2], values, digest: digest(values) };
}

export function postProcessGpuObservation(rendered, request) {
    return request.type === "camera"
        ? cameraObservation(rendered, request)
        : lidarObservation(rendered, request);
}
