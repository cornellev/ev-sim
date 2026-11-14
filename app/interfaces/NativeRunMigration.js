import { normalizeRunManifest, validateRunManifest, computeResolvedRunHash } from "../simulation/RunManifest.js";
import { getNativeTopicContract, nativeShapeAt, NATIVE_SENSOR_OUTPUT_CONTRACTS, normalizeNativeTopic } from "../simulation/NativeTopicContracts.js";
import { canonicalStringify } from "../simulation/canonicalJson.js";
import { protobufFingerprint } from "./ProtobufSchema.js";
import { createProtobufInterfaceResource, planProtobufRouteAdmission } from "./ProtobufRunBinding.js";
import { UNIT_CATALOG_META } from "../scripting/UnitCatalog.meta.js";
import { getGraphScriptReferences } from "../scripting/GraphDocument.js";
import { normalizeBinding } from "../scripting/bindings/BindingDocument.js";
import { collectScenarioScriptIds, normalizeScenario, stripScenarioMetadata } from "../scenarios/ScenarioDocument.js";
import { verifyPluginPackage } from "../plugin/PluginPackage.js";
import { createSensorDefinitionRegistry } from "../simulation/sensors/SensorTypeRegistry.js";
import { normalizeVehicleManifest } from "../vehicles/VehicleManifest.js";
import { getAutonomyContract } from "../autonomy/AutonomyContractCatalog.js";
import { listNativeTopicDefinitions } from "../simulation/NativeTopicCatalog.js";

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
const graphTypes = new Set([...UNIT_CATALOG_META.map((entry) => entry.type), "OutputNodeBlock", "ProgramInputBlock", "LocalScriptProgramBlock"]);
const metadataPaths = { "header.frame_id": "frameId" };

function migratePath(path, contractId) {
    if (path === "data" && getNativeTopicContract(contractId).shape.type) return "";
    let migrated = path;
    for (const [from, to] of Object.entries(paths).sort(([a], [b]) => b.length - a.length)) if (path === from || path.startsWith(`${from}.`)) { migrated = to + path.slice(from.length); break; }
    nativeShapeAt(getNativeTopicContract(contractId).shape, migrated);
    return migrated;
}

export function planNativeRunMigration({ manifest, interfaceResource = null, targetInterfaceResource = null, additionalTopics = [], scripts = [], scenario = null, vehicles = [], mappingOverrides = {}, scriptPaths = {}, topicContracts = {}, bindingTopics = {}, pluginReplacements = {}, resolvedRun = null } = {}) {
    if (!Number.isInteger(manifest?.version) || manifest.version < 1 || manifest.version > 12) throw new Error("Native migration requires a historical authoring manifest through v12.");
    const original = structuredClone({ manifest, interfaceResource, scripts, scenario, vehicles });
    const blocked = [], changes = [];
    const candidate = structuredClone(normalizeRunManifest(manifest));
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
        const legacyRole = getAutonomyContract(topic.contractId);
        const nativeRole = legacyRole?.schema.type === rosType ? listNativeTopicDefinitions().find((entry) => entry.contractId === topic.contractId) : null;
        const contractId = topicContracts[topic.id]?.id ?? (contracts[rosType] && (productKeys.length ? NATIVE_SENSOR_OUTPUT_CONTRACTS[productKeys[0]] : nativeRole?.valueContract.id ?? contracts[rosType]));
        if (!contractId) { blocked.push({ path: `topics.${topic.id}`, message: `No reviewed migration for ${rosType}.` }); continue; }
        topic.valueContract = topicContracts[topic.id] ? structuredClone(topicContracts[topic.id]) : { id: contractId, version: 1 };
        try { getNativeTopicContract(topic.valueContract.id, topic.valueContract.version); }
        catch (error) { blocked.push({ path: `topics.${topic.id}`, message: error.message }); }
        delete topic.type; delete topic.schema;
        changes.push({ path: `topics.${topic.id}.valueContract`, from: rosType, to: topic.valueContract });
    }
    for (const sensor of candidate.sensorRig?.sensors ?? []) delete sensor.schema;
    if (!Array.isArray(additionalTopics) || additionalTopics.length > 64) throw new Error("Native migration accepts at most 64 explicitly reviewed additional topics.");
    for (const source of additionalTopics) {
        const topic = normalizeNativeTopic(source);
        if (candidate.topics.some((entry) => entry.id === topic.id || entry.name === topic.name)) throw new Error(`Additional topic ${topic.id} conflicts with the source run.`);
        candidate.topics.push(topic); changes.push({ path: `topics.${topic.id}`, from: null, to: topic });
    }
    const pluginPackages = [], pluginChanges = new Map();
    for (const lock of candidate.plugins?.artifacts ?? []) {
        try {
            const resource = pluginReplacements[lock.expectedHash] ?? resolvedRun?.pluginPackages?.find((entry) => entry.packageHash === lock.expectedHash);
            if (!resource) throw new Error(`Exact plugin package ${lock.expectedHash} is required.`);
            const verified = verifyPluginPackage(resource);
            if (verified.document.id !== lock.pluginId) throw new Error("Plugin replacement must keep its plugin ID.");
            if (lock.capabilities.some((capability) => capability.startsWith("topics.")) && verified.document.topicAbi !== 2) throw new Error("Native topic consumers require a reviewed topicAbi 2 package replacement.");
            if (verified.document.sensorTypes?.some((type) => candidate.sensorRig.sensors.some((sensor) => sensor.type === type.type) && type.sensorAbi !== 2)) throw new Error("Native plugin sensors require a reviewed sensorAbi 2 package replacement.");
            pluginChanges.set(lock.expectedHash, verified);
            lock.expectedHash = resource.packageHash;
            pluginPackages.push(resource);
        } catch (error) { blocked.push({ path: `plugins.${lock.pluginId}`, message: error.message }); }
    }
    if (!candidate.scripts.embeddedBindings?.length && resolvedRun?.bindings?.entries?.length) candidate.scripts.embeddedBindings = structuredClone(resolvedRun.bindings.entries);
    for (const binding of candidate.scripts?.embeddedBindings ?? []) {
        const topic = candidate.topics.find((topic) => topic.id === (bindingTopics[binding.id] ?? binding.trigger?.topic) || topic.name === (bindingTopics[binding.id] ?? binding.trigger?.topic));
        if (binding.trigger?.kind === "topic" && !topic) blocked.push({ path: `scripts.embeddedBindings.${binding.id}.trigger`, message: "Binding migration requires a declared trigger topic." });
        for (const input of binding.inputs ?? []) {
            try {
                if (input.source === "message" && input.field) {
                    if (metadataPaths[input.field]) { input.source = "message-metadata"; input.field = metadataPaths[input.field]; }
                    else input.field = migratePath(input.field, topic?.valueContract?.id);
                } else if (input.source === "signal" && /^(topics\.|(active|oracle|candidate|reference)\.topics\.)/.test(input.path) && input.field) {
                    const selected = candidate.topics.find((entry) => input.path === `topics.${entry.name}` || input.path.endsWith(`.topics.${entry.contractId || entry.id}`));
                    if (!selected) throw new Error("An explicit signal/topic association is required.");
                    input.field = migratePath(input.field, selected.valueContract.id);
                }
            } catch (error) { blocked.push({ path: `scripts.embeddedBindings.${binding.id}.inputs`, message: `Binding migration requires repair: ${error.message}` }); }
        }
        for (const output of binding.outputs ?? []) if (output.sink === "publish") {
            const selected = candidate.topics.find((entry) => entry.id === output.topic || entry.name === output.topic);
            if (!selected) blocked.push({ path: `scripts.embeddedBindings.${binding.id}.outputs`, message: "Binding publication topic is not declared." });
            else { output.valueContract = selected.valueContract; delete output.type; }
        }
    }
    let scenarioPlan = null;
    if (candidate.scenario) {
        if (!scenario) blocked.push({ path: "scenario", message: "The exact scenario source is required." });
        else {
            const document = structuredClone(scenario);
            document.version = 2;
            for (const route of document.routes ?? []) if (route.controller?.kind === "external-ros") {
                route.controller.kind = "external-topic";
                const topic = candidate.topics.find((topic) => topic.id === route.controller.topicId || topic.name === route.controller.topicId);
                if (topic?.valueContract?.id !== "cev.control-command") blocked.push({ path: `scenario.routes.${route.id}`, message: "External scenario commands require a declared native control-command topic." });
            }
            scenarioPlan = { sourceId: scenario.id, sourceHash: hash(scenario), document };
        }
    }
    const vehiclePlans = [];
    const sensorRegistry = createSensorDefinitionRegistry(pluginPackages.map((resource) => verifyPluginPackage(resource)));
    for (const source of vehicles) {
        if (!source.pluginLocks?.some((lock) => pluginChanges.has(lock.packageHash) && pluginChanges.get(lock.packageHash).resource.packageHash !== lock.packageHash)) continue;
        try {
            const document = structuredClone(source);
            for (const lock of document.pluginLocks) {
                const replacement = pluginChanges.get(lock.packageHash);
                if (replacement) Object.assign(lock, { packageHash: replacement.resource.packageHash, runtimeHash: replacement.resource.runtimeHash, version: replacement.document.version });
            }
            const normalized = normalizeVehicleManifest(document, { sensorRegistry });
            normalized.id = `${source.id}-native-${hash(normalized).slice(0, 12)}`;
            vehiclePlans.push({ sourceId: source.id, sourceHash: hash(source), document: normalized });
            for (const actor of candidate.initialState.vehicles) if (actor.type === source.id) actor.type = normalized.id;
            if (candidate.scenario?.egoVehicleId === source.id) candidate.scenario.egoVehicleId = normalized.id;
            for (const actor of scenarioPlan?.document.actors ?? []) if (actor.vehicleId === source.id) actor.vehicleId = normalized.id;
        } catch (error) { blocked.push({ path: `vehicles.${source.id}`, message: error.message }); }
    }
    const scriptPlans = [];
    const documents = new Map(scripts.map((document) => [document.id, document]));
    const roots = new Set([...(candidate.scripts.artifacts ?? []).map((reference) => reference.scriptId), ...(candidate.scripts.embeddedBindings ?? []).map((binding) => binding.scriptId), ...collectScenarioScriptIds(scenario), ...(candidate.parameters ?? []).filter((parameter) => parameter.target?.kind === "script-input").map((parameter) => parameter.target.scriptId)]);
    const order = [], visiting = new Set(), visited = new Set();
    const visit = (id, depth = 0) => {
        if (visited.has(id)) return;
        if (depth >= 64 || visiting.has(id) || visited.size + visiting.size >= 64) { blocked.push({ path: `scripts.${id}`, message: "Script closure contains a cycle or exceeds 64 scripts/depth." }); return; }
        const document = documents.get(id);
        if (!document?.graph || document.sourceType === "artifact" || document.editable === false) { blocked.push({ path: `scripts.${id}`, message: "Editable graph source is required for the captured library bindings and script closure; immutable artifacts are never rewritten." }); return; }
        visiting.add(id);
        for (const child of getGraphScriptReferences(document.graph).sort()) visit(child, depth + 1);
        visiting.delete(id); visited.add(id); order.push(document);
    };
    for (const id of [...roots].filter(Boolean).sort()) visit(id);
    const replacements = new Map();
    for (const document of order) {
        const graph = structuredClone(document.graph);
        for (const lock of graph.pluginLocks ?? []) {
            const replacement = pluginChanges.get(lock.packageHash);
            if (replacement) Object.assign(lock, { packageHash: replacement.resource.packageHash, runtimeHash: replacement.resource.runtimeHash, version: replacement.document.version });
        }
        for (const node of graph.nodes ?? []) {
            const pluginUnit = pluginPackages.some((resource) => verifyPluginPackage(resource).document.units?.some((unit) => unit.type === node.type));
            if (!graphTypes.has(node.type) && !pluginUnit) { blocked.push({ path: `scripts.${document.id}.${node.uuid}`, message: `Graph node ${node.type} has no reviewed native migration.` }); continue; }
            if (node.state?.sourceScriptId) {
                node.state.sourceScriptId = replacements.get(node.state.sourceScriptId) ?? node.state.sourceScriptId;
                node.state.sourceRevision = null;
                delete node.state.compiledProgram;
            } else if (node.type === "CompiledProgramUnitBlock") blocked.push({ path: `scripts.${document.id}.${node.uuid}`, message: "An embedded program requires its editable source and explicit script reference." });
            const selector = node.type === "TopicFieldBlock" ? "fieldPath" : node.type === "JsonGetBlock" ? "path" : null;
            if (selector) {
                if (scriptPaths[document.id]?.[node.uuid]?.source === "unchanged") continue;
                const topicId = scriptPaths[document.id]?.[node.uuid];
                const topic = candidate.topics.find((item) => item.id === topicId);
                try {
                    const oldPath = node.storedData?.[selector] ?? node.state?.[selector];
                    let path;
                    if (oldPath === "header.frame_id") {
                        const input = (graph.connections ?? []).find((edge) => edge.to === node.uuid);
                        const source = graph.nodes.find((entry) => entry.uuid === input?.from);
                        if (!topic || source?.type !== "TopicSnapshotBlock" || ![topic.id, topic.name].includes(source.state?.topic ?? source.storedData?.topic)) throw new Error("Frame metadata requires a reviewed direct TopicSnapshot connection.");
                        input.output = "metadata";
                        path = "frameId";
                    } else path = migratePath(oldPath, topic?.valueContract?.id);
                    node.state = { ...node.state, [selector]: path };
                    if (node.storedData && typeof node.storedData === "object") node.storedData[selector] = path;
                }
                catch (error) { blocked.push({ path: `scripts.${document.id}.${node.uuid}.${selector}`, message: `Explicit topic binding and a known field path are required: ${error.message}` }); }
            }
        }
        const id = `${document.id}-native-${hash(graph).slice(0, 12)}`;
        replacements.set(document.id, id);
        scriptPlans.push({ sourceId: document.id, sourceHash: hash(document), id, name: document.name, graph });
        const reference = candidate.scripts.artifacts.find((reference) => reference.scriptId === document.id);
        if (reference) { reference.scriptId = id; reference.expectedHash = null; }
        else candidate.scripts.artifacts.push({ scriptId: id, expectedHash: null });
        for (const binding of candidate.scripts.embeddedBindings ?? []) if (binding.scriptId === document.id) binding.scriptId = id;
        for (const parameter of candidate.parameters ?? []) if (parameter.target?.kind === "script-input" && parameter.target.scriptId === document.id) parameter.target.scriptId = id;
    }
    if (candidate.scripts?.bindingIds?.length && !resolvedRun?.bindings?.entries) blocked.push({ path: "scripts.bindingIds", message: "The exact effective library bindings are required." });
    candidate.scripts.bindingIds = [];
    if (scenarioPlan) {
        const replace = (value) => {
            if (!value || typeof value !== "object") return;
            for (const key of Object.keys(value)) if (key === "scriptId" && replacements.has(value[key])) value[key] = replacements.get(value[key]); else if (typeof value[key] === "object") replace(value[key]);
        };
        replace(scenarioPlan.document);
        scenarioPlan.document = normalizeScenario(scenarioPlan.document);
        scenarioPlan.document.id = `${scenario.id}-native-${hash(stripScenarioMetadata(scenarioPlan.document)).slice(0, 12)}`;
        candidate.scenario.id = scenarioPlan.document.id;
        candidate.scenario.expectedHash = hash(stripScenarioMetadata(scenarioPlan.document));
    }
    if (candidate.scripts) {
        candidate.scripts.bindingSource = "embedded";
        candidate.scripts.embeddedBindings ??= [];
        candidate.scripts.embeddedBindings = candidate.scripts.embeddedBindings.map((binding) => normalizeBinding(binding));
        candidate.scripts.embeddedBindings.sort((left, right) => String(left.id).localeCompare(String(right.id)));
        candidate.scripts.expectedBindingsHash = computeResolvedRunHash(candidate.scripts.embeddedBindings);
    }
    let resource = null;
    if (interfaceResource && !targetInterfaceResource) {
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
    } else if (candidate.protobuf?.mode === "zenoh" && !targetInterfaceResource) blocked.push({ path: "protobuf", message: "The exact pinned interface is required." });
    if (targetInterfaceResource) {
        try {
            resource = createProtobufInterfaceResource(targetInterfaceResource.document, targetInterfaceResource.hash);
            if (resource.document.version !== 2) throw new Error("A native migration target requires interface v2.");
            candidate.protobuf = { mode: "zenoh", interfaceHash: resource.hash, externalController: true };
        } catch (error) { blocked.push({ path: "protobuf", message: error.message }); }
    }
    let normalized = candidate;
    if (!blocked.length) {
        const validation = validateRunManifest(candidate, { sensorRegistry });
        if (!validation.ok) blocked.push(...validation.issues);
        else normalized = validation.manifest;
        if (resource) try { planProtobufRouteAdmission({ manifest: normalized, interfaceResource: resource, resolvedRun: { ...resolvedRun, version: 13, manifest: normalized } }); }
        catch (error) { blocked.push({ path: "protobuf", message: error.message }); }
    }
    const plan = { kind: "cev-sim.native-run-migration", version: 2, baseRevision: manifest.revision ?? 0, originalHash: hash(original), original,
        candidate: normalized, interfaceResource: resource, scriptPlans, scenarioPlan, vehiclePlans, pluginPackages, changes, blocked, request: { targetInterfaceResource: structuredClone(targetInterfaceResource), additionalTopics: structuredClone(additionalTopics), mappingOverrides: structuredClone(mappingOverrides), scriptPaths: structuredClone(scriptPaths), topicContracts: structuredClone(topicContracts), bindingTopics: structuredClone(bindingTopics), pluginReplacements: structuredClone(pluginReplacements), resolvedRun: structuredClone(resolvedRun) } };
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
    const compiled = new Map();
    for (const source of plan.scriptPlans) {
        if (typeof recompile !== "function") throw new Error("Native graph adoption requires explicit recompilation.");
        const graph = structuredClone(source.graph);
        for (const node of graph.nodes ?? []) if (node.state?.sourceScriptId) {
            const child = compiled.get(node.state.sourceScriptId);
            if (!child) throw new Error(`Native child ${node.state.sourceScriptId} must compile before its parent.`);
            node.state.compiledProgram = child;
        }
        const artifact = recompile(graph, source.name);
        if (artifact?.then) throw new Error("Graph recompilation must be synchronous.");
        compiled.set(source.id, artifact);
        scripts.push({ id: source.id, artifact, graph, name: source.name });
        manifest.scripts.artifacts.find((reference) => reference.scriptId === source.id).expectedHash = computeResolvedRunHash(artifact);
    }
    return { manifest: normalizeRunManifest(manifest, { sensorRegistry: createSensorDefinitionRegistry(plan.pluginPackages.map((resource) => verifyPluginPackage(resource))) }), interfaceResource: structuredClone(plan.interfaceResource), scripts, scenario: structuredClone(plan.scenarioPlan?.document ?? null), vehicles: structuredClone(plan.vehiclePlans), pluginPackages: plan.pluginPackages, original: structuredClone(plan.original), archiveHash: plan.originalHash };
}
