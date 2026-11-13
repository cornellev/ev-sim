import { normalizeRunManifest, validateRunManifest, computeResolvedRunHash } from "../simulation/RunManifest.js";
import { getNativeTopicContract, nativeShapeAt, NATIVE_SENSOR_OUTPUT_CONTRACTS } from "../simulation/NativeTopicContracts.js";
import { canonicalStringify } from "../simulation/canonicalJson.js";
import { protobufFingerprint } from "./ProtobufSchema.js";
import { createProtobufInterfaceResource, planProtobufRouteAdmission } from "./ProtobufRunBinding.js";

const hash = (value) => protobufFingerprint(new TextEncoder().encode(canonicalStringify(value)));
const contracts = Object.freeze({ "sensor_msgs/Imu": "cev.imu", "sensor_msgs/NavSatFix": "cev.gnss", "nav_msgs/Odometry": "cev.odometry", "sensor_msgs/PointCloud2": "cev.points",
    "sensor_fusion_msgs/SemanticPointCloud2": "cev.semantic-points", "sensor_msgs/Image": "cev.image", "sensor_msgs/CameraInfo": "cev.camera-info",
    "vision_msgs/Detection2DArray": "cev.detections-2d", "vision_msgs/Detection3DArray": "cev.detections-3d", "sensor_fusion_msgs/StampedLanes": "cev.lanes",
    "sensor_fusion_msgs/TrafficControlStates": "cev.traffic-controls", "tf2_msgs/TFMessage": "cev.transforms", "rosgraph_msgs/Clock": "cev.clock",
    "geometry_msgs/PoseStamped": "cev.goal", "geometry_msgs/Pose": "cev.goal", "diagnostic_msgs/DiagnosticArray": "cev.diagnostics", "sensor_fusion_msgs/StampedAckermannDrive": "cev.control-command",
    "std_msgs/Float64": "cev.scalar-f64", "std_msgs/Float32": "cev.scalar-f64", "std_msgs/Int32": "cev.scalar-i32", "std_msgs/UInt32": "cev.scalar-u32", "std_msgs/Bool": "cev.boolean", "std_msgs/String": "cev.text", "geometry_msgs/Vector3": "cev.vector3", "std_msgs/Byte": "cev.bytes" });
const paths = Object.freeze({ angular_velocity: "angularVelocity", linear_acceleration: "linearAcceleration", orientation_covariance: "orientationCovariance",
    angular_velocity_covariance: "angularVelocityCovariance", linear_acceleration_covariance: "linearAccelerationCovariance", "pose.pose": "pose", "pose.covariance": "poseCovariance",
    "twist.twist.linear": "linearVelocity", "twist.twist.angular": "angularVelocity", "twist.covariance": "twistCovariance", child_frame_id: "childFrameId",
    position_covariance: "covariance", position_covariance_type: "covarianceType", "status.status": "status", "status.service": "service",
    steering_angle_velocity: "steeringRateRadps", steering_angle: "steeringRad", speed: "speedMps", acceleration: "accelerationMps2", jerk: "jerkMps3", deadline_ns: "deadlineNs" });
// shortcut: only reviewed scalar/topic/field graph nodes migrate; extend at ZPB-08.
const graphTypes = new Set(["OutputNodeBlock", "ProgramInputBlock", "NumberUnitClass", "TopicSnapshotBlock", "TopicFieldBlock", "JsonGetBlock"]);

function migratePath(path, contractId) {
    let migrated = path;
    for (const [from, to] of Object.entries(paths).sort(([a], [b]) => b.length - a.length)) if (path === from || path.startsWith(`${from}.`)) { migrated = to + path.slice(from.length); break; }
    nativeShapeAt(getNativeTopicContract(contractId).shape, migrated);
    return migrated;
}

export function planNativeRunMigration({ manifest, interfaceResource = null, scripts = [], mappingOverrides = {}, scriptPaths = {}, resolvedRun = null } = {}) {
    if (manifest?.version !== 12) throw new Error("Native migration requires a reviewed v12 authoring manifest.");
    const original = structuredClone({ manifest, interfaceResource, scripts });
    const blocked = [], changes = [];
    const candidate = structuredClone(manifest);
    candidate.version = 13;
    delete candidate.autonomyCatalog;
    if (candidate.controls?.fallbackCommand) {
        const command = candidate.controls.fallbackCommand;
        candidate.controls.fallbackCommand = { mode: command.mode, speedMps: command.speed, steeringRad: command.steering_angle,
            steeringRateRadps: command.steering_angle_velocity, accelerationMps2: command.acceleration, jerkMps3: command.jerk };
    }
    for (const topic of candidate.topics ?? []) {
        const rosType = topic.schema?.type || topic.type;
        const productKeys = (candidate.sensorRig?.sensors ?? []).flatMap((sensor) => Object.entries(sensor.outputs ?? {}).filter(([, id]) => id === topic.id).map(([key]) => key));
        const contractId = contracts[rosType] && (productKeys.length ? NATIVE_SENSOR_OUTPUT_CONTRACTS[productKeys[0]] : contracts[rosType]);
        if (!contractId) { blocked.push({ path: `topics.${topic.id}`, message: `No reviewed migration for ${rosType}.` }); continue; }
        topic.valueContract = { id: contractId, version: 1 };
        delete topic.type; delete topic.schema;
        changes.push({ path: `topics.${topic.id}.valueContract`, from: rosType, to: topic.valueContract });
    }
    for (const sensor of candidate.sensorRig?.sensors ?? []) delete sensor.schema;
    if (candidate.plugins?.enabled || candidate.sensorTransports?.bindings?.length) blocked.push({ path: "plugins", message: "Plugin/native transport declarations require their consumer migration gate." });
    if (candidate.scenario) blocked.push({ path: "scenario", message: "Scenario topic consumers require a separate reviewed migration." });
    if (resolvedRun?.bindings?.entries?.length && !candidate.scripts?.embeddedBindings?.length) blocked.push({ path: "scripts", message: "Embed and review resolved library bindings before native adoption." });
    for (const binding of candidate.scripts?.embeddedBindings ?? []) {
        if (!["fixed-update", "simulation-timer", "episode-reset"].includes(binding.trigger?.kind)
            || (binding.inputs ?? []).some((input) => !["constant", "sim"].includes(input.source))
            || (binding.outputs ?? []).some((output) => output.sink !== "signal")) blocked.push({ path: `scripts.embeddedBindings.${binding.id}`, message: "Topic and signal consumers require their ZPB-08 binding migration." });
        if (!candidate.scripts.artifacts.some((reference) => reference.scriptId === binding.scriptId)) blocked.push({ path: `scripts.embeddedBindings.${binding.id}.scriptId`, message: "An explicit editable artifact reference is required." });
    }
    const scriptPlans = [];
    for (const reference of candidate.scripts?.artifacts ?? []) {
        const document = scripts.find((item) => item.id === reference.scriptId);
        if (!document?.graph || document.sourceType === "artifact") { blocked.push({ path: `scripts.${reference.scriptId}`, message: "An editable graph source is required; immutable artifacts are never rewritten." }); continue; }
        const graph = structuredClone(document.graph);
        for (const node of graph.nodes ?? []) {
            if (!graphTypes.has(node.type)) { blocked.push({ path: `scripts.${document.id}.${node.uuid}`, message: `Graph node ${node.type} has no reviewed migration.` }); continue; }
            const selector = node.type === "TopicFieldBlock" ? "fieldPath" : node.type === "JsonGetBlock" ? "path" : null;
            if (selector) {
                const topicId = scriptPaths[document.id]?.[node.uuid];
                const topic = candidate.topics.find((item) => item.id === topicId);
                try {
                    const path = migratePath(node.storedData?.[selector] ?? node.state?.[selector], topic?.valueContract?.id);
                    node.state = { ...node.state, [selector]: path };
                    if (node.storedData && typeof node.storedData === "object") node.storedData[selector] = path;
                }
                catch (error) { blocked.push({ path: `scripts.${document.id}.${node.uuid}.${selector}`, message: `Explicit topic binding and a known field path are required: ${error.message}` }); }
            }
        }
        const id = `${document.id}-native-${hash(graph).slice(0, 12)}`;
        scriptPlans.push({ sourceId: document.id, sourceHash: hash(document), id, name: document.name, graph });
        reference.scriptId = id; reference.expectedHash = null;
        for (const binding of candidate.scripts.embeddedBindings ?? []) if (binding.scriptId === document.id) binding.scriptId = id;
        for (const parameter of candidate.parameters ?? []) if (parameter.target?.kind === "script-input" && parameter.target.scriptId === document.id) parameter.target.scriptId = id;
    }
    if (candidate.scripts?.bindingIds?.length) blocked.push({ path: "scripts.bindingIds", message: "Embed and review selected bindings before native adoption." });
    if (candidate.scripts) {
        candidate.scripts.bindingSource = "embedded";
        candidate.scripts.embeddedBindings ??= [];
        candidate.scripts.embeddedBindings.sort((left, right) => String(left.id).localeCompare(String(right.id)));
        candidate.scripts.expectedBindingsHash = computeResolvedRunHash(candidate.scripts.embeddedBindings);
    }
    let resource = null;
    if (interfaceResource) {
        const document = structuredClone(interfaceResource.document);
        document.version = 2;
        for (const route of document.routes) {
            try {
                if (mappingOverrides[route.id]) { route.mapping = structuredClone(mappingOverrides[route.id]); continue; }
                if (route.mapping.adapter) throw new Error("Named adapters require an explicit native mapping replacement.");
                const topic = candidate.topics.find((item) => item.id === (route.source?.topicId ?? route.target?.topicId));
                for (const field of route.mapping.fields) {
                    if (route.direction === "publish" && field.from?.startsWith("value.") && topic) {
                        if (field.from === "value.header.frame_id") field.from = "metadata.frameId";
                        else field.from = `value.${migratePath(field.from.slice(6), topic.valueContract.id)}`;
                    } else if (route.direction === "subscribe" && topic) field.to = migratePath(field.to, topic.valueContract.id);
                }
            } catch (error) { blocked.push({ path: `routes.${route.id}.mapping`, message: error.message }); }
        }
        try { resource = createProtobufInterfaceResource(document); candidate.protobuf.interfaceHash = resource.hash; }
        catch (error) { blocked.push({ path: "protobuf", message: error.message }); }
    } else if (candidate.protobuf?.mode === "zenoh") blocked.push({ path: "protobuf", message: "The exact pinned interface is required." });
    let normalized = candidate;
    if (!blocked.length) {
        const validation = validateRunManifest(candidate);
        if (!validation.ok) blocked.push(...validation.issues);
        else normalized = validation.manifest;
        if (resource) try { planProtobufRouteAdmission({ manifest: normalized, interfaceResource: resource, resolvedRun: { ...resolvedRun, version: 13, manifest: normalized } }); }
        catch (error) { blocked.push({ path: "protobuf", message: error.message }); }
    }
    const plan = { kind: "cev-sim.native-run-migration", version: 1, baseRevision: manifest.revision ?? 0, originalHash: hash(original), original,
        candidate: normalized, interfaceResource: resource, scriptPlans, changes, blocked, request: { mappingOverrides: structuredClone(mappingOverrides), scriptPaths: structuredClone(scriptPaths), resolvedRun: structuredClone(resolvedRun) } };
    return { ...plan, hash: hash(plan), ok: blocked.length === 0 };
}

export function validateNativeRunMigration(plan) {
    try {
        const rebuilt = planNativeRunMigration({ ...plan.original, ...plan.request });
        if (canonicalStringify(rebuilt) !== canonicalStringify(plan)) throw new Error("Migration preview has changed; create and review a new preview.");
        return { ok: rebuilt.ok, issues: rebuilt.blocked };
    } catch (error) { return { ok: false, issues: [{ path: "plan", message: error.message }] }; }
}

export function applyNativeRunMigration(plan, { expectedRevision, recompile } = {}) {
    const validation = validateNativeRunMigration(plan);
    if (!validation.ok) throw new Error(validation.issues.map((issue) => issue.message).join(" "));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== plan.baseRevision) throw new Error("Native migration revision conflict.");
    const manifest = structuredClone(plan.candidate), scripts = [];
    for (const source of plan.scriptPlans) {
        if (typeof recompile !== "function") throw new Error("Native graph adoption requires explicit recompilation.");
        const artifact = recompile(source.graph, source.name);
        if (artifact?.then) throw new Error("Graph recompilation must be synchronous.");
        scripts.push({ id: source.id, artifact, graph: source.graph, name: source.name });
        manifest.scripts.artifacts.find((reference) => reference.scriptId === source.id).expectedHash = computeResolvedRunHash(artifact);
    }
    return { manifest: normalizeRunManifest(manifest), interfaceResource: structuredClone(plan.interfaceResource), scripts, original: structuredClone(plan.original), archiveHash: plan.originalHash };
}
