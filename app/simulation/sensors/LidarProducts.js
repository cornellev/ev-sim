import { buildPointCloud2, buildSemanticPointCloud2 } from "../../3d/devices/SensorMessages.js";

function gaussian(rng) {
    const left = Math.max(Number.EPSILON, rng.next());
    return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * rng.next());
}

/** Build measured messages and the policy-safe range/incidence grid in one RNG pass. */
export function buildLidarCapture({
    buffer,
    config,
    captureTimeNs,
    rng,
    publisher = null,
    includeObservation = false,
}) {
    const messages = [];
    const noise = config.noise;
    const products = config.calibration.products || {};
    const frameId = config.measurementFrameId || config.frameId;
    let observation = null;
    if (products.pointCloud === true && (config.outputs.pointCloudTopicId || includeObservation)) {
        let pointDrops = 0;
        const azimuth = config.calibration.azimuth;
        const elevation = config.calibration.elevation;
        const width = Math.ceil((azimuth.endDeg - azimuth.startDeg) / azimuth.stepDeg);
        const height = Math.ceil((elevation.endDeg - elevation.startDeg) / elevation.stepDeg);
        const values = includeObservation ? new Float32Array(width * height * 2) : null;
        const hasRangeNoise = Number(noise.bias) !== 0
            || (noise.model === "gaussian" && Number(noise.standardDeviation) > 0);
        const hasPointDropout = Number(noise.pointDropoutProbability) > 0;
        const value = buildPointCloud2({
            buffer,
            bufferEncoding: "metric-v2",
            calibration: config.calibration,
            timeNs: captureTimeNs,
            frameId,
            ...(hasRangeNoise ? {
                sampleRange: (range) => range + noise.bias
                    + (noise.model === "gaussian" ? gaussian(rng) * noise.standardDeviation : 0),
            } : {}),
            ...(hasPointDropout ? {
                shouldDrop: () => rng.next() < noise.pointDropoutProbability,
                onPointDrop: () => { pointDrops += 1; },
            } : {}),
            ...(values ? {
                onMeasured: (index, range, incidence) => {
                    values[index * 2] = range;
                    values[index * 2 + 1] = incidence;
                },
            } : {}),
        });
        if (config.outputs.pointCloudTopicId) messages.push({
            topicId: config.outputs.pointCloudTopicId,
            signal: "pointCloud",
            frameId,
            value,
        });
        publisher?.recordPointDrops?.(pointDrops);
        if (values) observation = { dtype: "float32", shape: [height, width, 2], value: values };
    }
    if (products.semanticPointCloud === true && config.outputs.semanticPointCloudTopicId) {
        messages.push({
            topicId: config.outputs.semanticPointCloudTopicId,
            signal: "semanticPointCloud",
            frameId,
            value: buildSemanticPointCloud2({
                buffer,
                bufferEncoding: "metric-v2",
                calibration: config.calibration,
                timeNs: captureTimeNs,
                frameId,
            }),
        });
    }
    return { messages, observation };
}

/** Backward-compatible message-only helper used by browser sensors. */
export function buildLidarMessages(options) {
    return buildLidarCapture(options).messages;
}
