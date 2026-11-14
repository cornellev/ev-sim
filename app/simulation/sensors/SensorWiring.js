import { topicFromContract } from "../../autonomy/AutonomyContractCatalog.js";
import { sensorTypeRegistry } from "./SensorTypeRegistry.js";
import { topicFromNativeContract } from "../NativeTopicCatalog.js";
import { NATIVE_SENSOR_OUTPUT_CONTRACTS } from "../NativeTopicContracts.js";

const CONTRACTS = Object.freeze({ imuTopicId: "imu", odometryTopicId: "wheel-odometry", pointCloudTopicId: "front-lidar-points" });

export function assertSensorWiringReviewCurrent(review, draft, { vehicle, catalogRevision }) {
    if (review.source !== JSON.stringify(draft) || review.vehicle !== vehicle || review.catalogRevision !== catalogRevision) {
        throw new Error("The draft or vehicle changed. Review sensor wiring again.");
    }
}

export function proposeSensorWiring(source, { registry = sensorTypeRegistry, selections = {}, sensorIds = null } = {}) {
    const manifest = structuredClone(source);
    const changes = [];
    const issues = [];
    const used = new Set(manifest.sensorRig.sensors.flatMap((sensor) => Object.values(sensor.outputs || {}).filter(Boolean)));
    for (const sensor of manifest.sensorRig.sensors) {
        if (manifest.version === 13) delete sensor.schema;
        if (sensor.enabled === false || (sensorIds && !sensorIds.includes(sensor.id))) continue;
        for (const output of registry.get(sensor.type)?.run?.outputs || []) {
            const contractId = CONTRACTS[output.key];
            if (!contractId || sensor.outputs?.[output.key]) continue;
            if (output.key === "pointCloudTopicId" && sensor.calibration?.products?.pointCloud !== true) continue;
            const key = `${sensor.id}:${output.key}`;
            const candidates = manifest.topics.filter((topic) => topic.contractId === contractId
                && topic.direction === "output" && topic.producer === "simulator"
                && (manifest.version === 13 ? topic.valueContract?.id === (output.valueContract?.id ?? NATIVE_SENSOR_OUTPUT_CONTRACTS[output.key]) : topic.type === output.rosType) && !used.has(topic.id));
            let topic = selections[key] ? candidates.find((entry) => entry.id === selections[key]) : candidates.length === 1 ? candidates[0] : null;
            if ((selections[key] && !topic) || (!selections[key] && candidates.length > 1)) {
                issues.push({ key, sensorId: sensor.id, output: output.key, candidates, message: `Choose an unused compatible topic for ${sensor.id} ${output.signal}.` });
                continue;
            }
            const created = !topic;
            if (!topic) {
                const stem = `${sensor.id}-${output.signal}`;
                let id = stem;
                let suffix = 2;
                while (manifest.topics.some((entry) => entry.id === id)) id = `${stem}-${suffix++}`;
                const nameStem = `/sensors/${sensor.id.replace(/[^a-zA-Z0-9_]/g, "_")}/${output.signal}`;
                let name = nameStem;
                suffix = 2;
                while (manifest.topics.some((entry) => entry.name === name)) name = `${nameStem}_${suffix++}`;
                topic = (manifest.version === 13 ? topicFromNativeContract : topicFromContract)(contractId, { id, name });
                manifest.topics.push(topic);
            }
            sensor.outputs = { ...sensor.outputs, [output.key]: topic.id };
            if (manifest.version !== 13) sensor.schema = { ...sensor.schema, [output.key]: topic.type };
            used.add(topic.id);
            changes.push({ sensorId: sensor.id, output: output.key, topicId: topic.id, name: topic.name, created });
        }
    }
    return { manifest, changes, issues };
}
