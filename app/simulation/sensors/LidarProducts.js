import { gaussianSample } from "../../autonomy/LocalizationMeasurements.js";
import { buildPointCloud2, buildSemanticPointCloud2 } from "./SensorMessages.js";

function gaussian(rng) {
    return gaussianSample(rng);
}

/** Apply host-owned noise and point dropout exactly once to an explicit range image. */
export function buildMeasuredRangeImage({ buffer, config, rng, publisher = null } = {}) {
    const layout = config.calibration.scanLayout;
    if (!layout) throw new TypeError("Explicit range-image measurement requires calibration.scanLayout.");
    if (!(buffer instanceof Float32Array) || buffer.length !== layout.channels.length * layout.azimuthsDeg.length * 4) {
        throw new TypeError(`Range-image buffer has ${buffer?.length ?? 0} values; expected ${layout.channels.length * layout.azimuthsDeg.length * 4}.`);
    }
    const measured = new Float32Array(buffer.length);
    const noise = config.noise ?? {};
    const hasRangeNoise = Number(noise.bias) !== 0
        || (noise.model === "gaussian" && Number(noise.standardDeviation) > 0);
    const hasPointDropout = Number(noise.pointDropoutProbability) > 0;
    let pointDrops = 0;
    for (let offset = 0; offset < buffer.length; offset += 4) {
        const rawRange = Number(buffer[offset]);
        if (!(rawRange >= layout.minRangeM && rawRange <= layout.maxRangeM)) continue;
        if (hasPointDropout && rng.next() < noise.pointDropoutProbability) {
            pointDrops += 1;
            continue;
        }
        const noisyRange = rawRange + (Number(noise.bias) || 0)
            + (hasRangeNoise && noise.model === "gaussian" ? gaussian(rng) * Number(noise.standardDeviation) : 0);
        measured[offset] = Math.max(layout.minRangeM, Math.min(layout.maxRangeM, noisyRange));
        measured[offset + 1] = Math.max(0, Math.min(1, Number(buffer[offset + 1]) || 0));
        // ABI 1 exposes no oracle labels to plugin code.
        measured[offset + 2] = 0;
        measured[offset + 3] = 0;
    }
    publisher?.recordPointDrops?.(pointDrops);
    return measured;
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
