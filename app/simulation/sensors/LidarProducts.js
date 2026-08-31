import { buildPointCloud2, buildSemanticPointCloud2 } from "../../3d/devices/SensorMessages.js";

function gaussian(rng) {
    const left = Math.max(Number.EPSILON, rng.next());
    return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * rng.next());
}

/** Build measured and semantic products from the shared metric-v2 ray grid. */
export function buildLidarMessages({ buffer, config, captureTimeNs, rng, publisher = null }) {
    const messages = [];
    const noise = config.noise;
    const products = config.calibration.products || {};
    const frameId = config.measurementFrameId || config.frameId;
    if (products.pointCloud === true && config.outputs.pointCloudTopicId) {
        let pointDrops = 0;
        const hasRangeNoise = Number(noise.bias) !== 0
            || (noise.model === "gaussian" && Number(noise.standardDeviation) > 0);
        const hasPointDropout = Number(noise.pointDropoutProbability) > 0;
        messages.push({
            topicId: config.outputs.pointCloudTopicId,
            signal: "pointCloud",
            frameId,
            value: buildPointCloud2({
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
            }),
        });
        publisher?.recordPointDrops?.(pointDrops);
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
    return messages;
}
