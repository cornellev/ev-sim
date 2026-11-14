import { assertNativeValue, getNativeTopicContract, nativeShapeAt, validateNativeTopicValue } from "../simulation/NativeTopicContracts.js";
import { applyNativeOperation, bindNativeProductContext } from "./NativeProductTransforms.js";
import { normalizeMappingDefinition } from "./ProtobufMappingDefinition.js";
import { encodeMessage, PROTOBUF_LIMITS } from "./ProtobufSchema.js";

const numeric = new Set(["double", "float", "int32", "uint32", "int64", "uint64", "timeNs", "sint32", "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64", "enum"]);
const vectorShape = { fields: { x: { type: "double" }, y: { type: "double" }, z: { type: "double" } } };
const quaternionShape = { fields: { ...vectorShape.fields, w: { type: "double" } } };
const poseShape = { fields: { position: vectorShape, orientation: quaternionShape } };
const metadataShape = { fields: Object.fromEntries(["simTimeNs", "captureTimeNs", "deliveryTimeNs", "captureStep", "actualDeliveryStep", "sequenceId"].map((name) => [name, { type: "uint64" }])) };
Object.assign(metadataShape.fields, { frameId: { type: "string" }, runId: { type: "string" } });
const inboundMetadataShape = { fields: { runId: { type: "string" }, frameId: { type: "string" }, captureTimeNs: { type: "timeNs" }, sequenceId: { type: "uint64" } }, optional: ["runId", "frameId", "captureTimeNs", "sequenceId"] };

export function protobufMessageShape(type, stack = []) {
    if (!type.fields) return { type: type.values ? "enum" : type.name };
    if (stack.includes(type)) return { recursive: true };
    const fields = Object.fromEntries(type.fieldsArray.map((field) => {
        let shape = field.resolvedType ? protobufMessageShape(field.resolvedType, [...stack, type]) : { type: field.type };
        const hasPresence = !!field.partOf || !!field.resolvedType?.fields;
        if (field.repeated) shape = { item: shape, length: null, defaultValue: [] };
        else if (field.map) shape = { map: shape };
        else if (!hasPresence) shape = { ...shape, defaultValue: field.resolvedType?.values ? 0 : field.type === "bytes" ? new Uint8Array() : /(?:int|fixed)64$/.test(field.type) ? "0" : field.defaultValue };
        return [field.name, shape];
    }));
    return { fields, optional: Object.keys(fields) };
}

function shapeForValue(value) {
    if (typeof value === "number") return { type: "double" };
    if (typeof value === "string") return { type: "string" };
    if (typeof value === "boolean") return { type: "bool" };
    if (value instanceof Uint8Array) return { type: "bytes" };
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Frozen mapping value has an unsupported shape.");
    return { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shapeForValue(item)])) };
}

function read(object, parts, shape) {
    let currentShape = shape;
    for (const part of parts) {
        currentShape = currentShape?.fields?.[part];
        if (!object || !Object.hasOwn(object, part)) return currentShape && Object.hasOwn(currentShape, "defaultValue") ? structuredClone(currentShape.defaultValue) : undefined;
        object = object[part];
    }
    return object;
}

function compatible(source, target) {
    if (source.recursive || target.recursive || source.map || target.map) return false;
    if (source.item || target.item) return !!source.item && !!target.item && (target.length == null || source.length === target.length) && compatible(source.item, target.item);
    if (source.fields || target.fields) return !!source.fields && !!target.fields && Object.entries(source.fields).every(([name, shape]) => target.fields[name] && compatible(shape, target.fields[name]));
    return source.type === target.type || (numeric.has(source.type) && numeric.has(target.type));
}

function convert(value, shape) {
    if (shape.item) return Array.from(value, (item) => convert(item, shape.item));
    if (shape.fields) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, convert(child, shape.fields[key])]));
    if (shape.type === "bytes") {
        if (!(value instanceof Uint8Array) && (!Array.isArray(value) || Object.keys(value).length !== value.length || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))) throw new Error("Byte mapping requires bounded byte values.");
        return new Uint8Array(value);
    }
    if (numeric.has(shape.type)) {
        if (/(?:int|fixed)64$/.test(shape.type)) {
            if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Lossy 64-bit mapping conversion.");
            return BigInt(value).toString();
        }
        if (typeof value === "string" || typeof value === "bigint") {
            const n = BigInt(value);
            if (n < BigInt(Number.MIN_SAFE_INTEGER) || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Lossy integer narrowing.");
            value = Number(n);
        }
        return value;
    }
    return value;
}

function calculate(value, entry, destination) {
    if (entry.scale === undefined && entry.offset === undefined) return value;
    if ((typeof value === "string" || typeof value === "bigint") && Number.isSafeInteger(entry.scale ?? 1) && Number.isSafeInteger(entry.offset ?? 0)) {
        return convert((BigInt(value) * BigInt(entry.scale ?? 1) + BigInt(entry.offset ?? 0)).toString(), destination);
    }
    if (typeof value === "string" || typeof value === "bigint") value = convert(value, { type: "timeNs" });
    return value * (entry.scale ?? 1) + (entry.offset ?? 0);
}

export function compileMapping(admittedRoute, { resolvedRun = {}, runId = "run" } = {}) {
    const { route, messageType, topicContract } = admittedRoute;
    const definition = normalizeMappingDefinition(route.mapping);
    const publish = route.direction === "publish";
    const wire = protobufMessageShape(messageType);
    const native = topicContract ? getNativeTopicContract(topicContract.valueContract.id, topicContract.valueContract.version).shape : wire;
    const source = publish ? native : wire;
    const bindings = bindNativeProductContext(definition.bindings, resolvedRun);
    const run = structuredClone(resolvedRun);
    delete run.resolvedHash; delete run.simulationSemanticHash;
    run.runId = runId;
    const roots = { value: source, metadata: metadataShape, bindings: shapeForValue(bindings), derived: { fields: {} } };
    const pointShape = { item: { fields: { ...vectorShape.fields, intensity: { type: "float" } } }, length: null };
    if (publish && ["cev.points", "cev.semantic-points"].includes(topicContract?.valueContract.id)) roots.value = { ...source, fields: { ...source.fields, points: pointShape } };
    const compileSource = (path, localRoots = roots) => {
        const [root, ...parts] = path.split(".");
        let shape;
        if (root === "run") {
            const value = read(run, parts);
            if (value === undefined || ["resolvedHash", "simulationSemanticHash"].includes(parts[0])) throw new Error(`${path}: frozen run field is unavailable.`);
            shape = shapeForValue(value);
        } else shape = nativeShapeAt(localRoots[root], parts.join("."), path);
        return { root, parts, shape, rootShape: localRoots[root] };
    };
    const operation = (entry, localRoots) => {
        const from = compileSource(entry.from, localRoots);
        const args = Object.fromEntries(["offsetFrom", "fromFrame", "toFrame"].filter((key) => entry[key]).map((key) => [key, compileSource(entry[key], localRoots)]));
        let result = from.shape;
        if (entry.operation) {
            if (entry.operation === "quaternionYaw") {
                if (!compatible(from.shape, quaternionShape)) throw new Error("Yaw requires a quaternion source.");
                result = { type: "double" };
            } else if (entry.operation === "poseAtOffset") {
                if (!compatible(from.shape, poseShape) || !args.offsetFrom || !compatible(args.offsetFrom.shape, vectorShape)) throw new Error("Pose offset requires a pose and offset vector.");
                result = poseShape;
            } else if (!args.fromFrame || !args.toFrame || !compatible(args.fromFrame.shape, poseShape) || !compatible(args.toFrame.shape, poseShape)
                || (!compatible(from.shape, poseShape) && !compatible(from.shape, vectorShape))) throw new Error("Frame transform requires a point/pose and two bound poses.");
        }
        return { ...entry, from, args, resultShape: result };
    };
    const derived = (definition.derived ?? []).map((entry) => {
        const compiled = operation(entry, roots);
        roots.derived.fields[entry.id] = compiled.resultShape;
        return compiled;
    });
    const compileFields = (fields, destination, localRoots) => fields.map((entry) => {
        const shape = nativeShapeAt(destination, entry.to);
        const to = entry.to ? entry.to.split(".") : [];
        if (Object.hasOwn(entry, "value")) return { to, shape, value: convert(entry.value, shape) };
        if (entry.each) {
            const from = compileSource(entry.each.from, localRoots);
            if (!from.shape.item || !shape.item) throw new Error("Each requires source and destination collections.");
            return { to, shape, each: { from, fields: compileFields(entry.each.fields, shape.item, { ...localRoots, item: from.shape.item }) } };
        }
        const compiled = operation(entry, localRoots);
        if (!compatible(compiled.resultShape, shape) || ((entry.scale !== undefined || entry.offset !== undefined) && (!numeric.has(compiled.resultShape.type) || !numeric.has(shape.type)))) throw new Error(`${route.id}.${entry.to}: incompatible mapping shapes.`);
        return { ...compiled, to, shape };
    });
    const fields = compileFields(definition.fields, publish ? wire : native, roots);
    if (publish && definition.metadata !== undefined) throw new Error("Metadata mappings are subscription-only.");
    const metadataFields = compileFields(definition.metadata ?? [], inboundMetadataShape, roots);
    const checks = (definition.checks ?? []).map((entry) => {
        const from = compileSource(entry.from);
        if (!from.shape.type || from.shape.type === "bytes") throw new Error("Mapping checks require scalar sources.");
        const equalsFrom = entry.equalsFrom ? compileSource(entry.equalsFrom) : null;
        if (equalsFrom && (!equalsFrom.shape.type || !compatible(equalsFrom.shape, from.shape))) throw new Error("Mapping check sources have incompatible types.");
        const shape = numeric.has(from.shape.type) ? { type: /(?:int|fixed)64$/.test(from.shape.type) ? (/^(?:u|fixed)/.test(from.shape.type) ? "uint64" : "int64") : "double" } : { type: from.shape.type };
        const result = { from, equalsFrom, shape };
        if (Object.hasOwn(entry, "value")) { result.value = convert(entry.value, shape); assertNativeValue(shape, result.value); }
        return result;
    });
    if (!publish) {
        if (!native.fields && !(fields.length === 1 && fields[0].to.length === 0)) throw new Error("Native scalar inputs require a root assignment.");
        const covered = (shape, entries, prefix = "") => {
            if (entries.some((entry) => entry.to.length === 0)) return;
            for (const [name, child] of Object.entries(shape.fields ?? {})) {
                if (shape.optional?.includes(name)) continue;
                const path = prefix ? `${prefix}.${name}` : name;
                if (entries.some((entry) => entry.to.join(".") === path)) continue;
                if (child.fields) covered(child, entries, path);
                else throw new Error(`${route.id}: required native field ${path} has no mapping.`);
            }
        };
        covered(native, fields);
    }
    // Constants are validated at compile time as well as on each produced sample.
    const constants = (fields) => fields.filter((field) => Object.hasOwn(field, "value")).reduce((output, field) => {
        return write(output, field.to, field.value);
    }, {});
    if (publish) encodeMessage(messageType, constants(fields));
    else if (fields.some((field) => Object.hasOwn(field, "value"))) assertNativeValue(native, constants(fields), { partial: true });
    assertNativeValue(inboundMetadataShape, constants(metadataFields), { partial: true });
    return { routeId: route.id, publish, messageType, topicContract, nativeShape: native, sourceShape: roots.value, fields, metadataFields, checks, derived, bindings, run };
}

function write(output, parts, value) {
    if (parts.length === 0) return value;
    const root = output;
    for (const part of parts.slice(0, -1)) output = output[part] ??= {};
    output[parts.at(-1)] = value;
    return root;
}

function applyFields(compiled, { value, metadata = {} }, assignments) {
    if (compiled.publish) {
        if (compiled.topicContract) {
            const validation = validateNativeTopicValue(compiled.topicContract.valueContract, value);
            if (!validation.ok) throw new Error(validation.message);
        } else encodeMessage(compiled.messageType, value);
    }
    const scope = { value, metadata, run: compiled.run, bindings: compiled.bindings, derived: {} };
    let nodes = PROTOBUF_LIMITS.valueNodes;
    const resolve = (source) => {
        if (source.root === "value" && source.parts.length === 1 && source.parts[0] === "points" && value?.positions) {
            return { length: value.count, *[Symbol.iterator]() {
                for (let index = 0; index < value.count; index++) yield { x: value.positions[index * 3], y: value.positions[index * 3 + 1], z: value.positions[index * 3 + 2], intensity: value.intensities[index] };
            } };
        }
        const result = read(scope[source.root], source.parts, source.rootShape);
        if (result === undefined && ["metadata", "run", "bindings"].includes(source.root)) throw new Error(`${source.root}.${source.parts.join(".")}: required mapping input is absent.`);
        return result;
    };
    const execute = (entry) => {
        let result = resolve(entry.from);
        if (result !== undefined && entry.operation) result = applyNativeOperation(entry.operation, result, Object.fromEntries(Object.entries(entry.args).map(([key, source]) => [key, resolve(source)])));
        return result;
    };
    for (const entry of compiled.derived) scope.derived[entry.id] = execute(entry);
    for (const check of compiled.checks ?? []) {
        const actual = convert(resolve(check.from), check.shape);
        const expected = check.equalsFrom ? convert(resolve(check.equalsFrom), check.shape) : check.value;
        assertNativeValue(check.shape, actual);
        assertNativeValue(check.shape, expected);
        if (actual !== expected) throw new Error(`${compiled.routeId}: mapping check failed at ${check.from.root}.${check.from.parts.join(".")}.`);
    }
    const fields = (entries) => {
        let output = {};
        for (const entry of entries) {
            if (--nodes < 0) throw new Error("Mapped value is too complex.");
            let result;
            if (Object.hasOwn(entry, "value")) result = structuredClone(entry.value);
            else if (entry.each) {
                const source = resolve(entry.each.from);
                if (source === undefined) continue;
                if (source.length > nodes) throw new Error("Mapped collection is too large.");
                const previous = scope.item;
                result = Array.from(source, (item) => { scope.item = item; return fields(entry.each.fields); });
                scope.item = previous;
            } else {
                result = execute(entry);
                if (result === undefined) continue;
                result = convert(calculate(result, entry, entry.shape), entry.shape);
            }
            output = write(output, entry.to, result);
        }
        return output;
    };
    return fields(assignments);
}

export function applyMapping(compiled, input) {
    if (compiled.publish && !compiled.topicContract && !compiled.fields.length && !compiled.derived.length && !compiled.checks?.length) {
        encodeMessage(compiled.messageType, input.value);
        return structuredClone(input.value);
    }
    const output = applyFields(compiled, input, compiled.fields);
    if (compiled.publish) encodeMessage(compiled.messageType, output);
    else assertNativeValue(compiled.nativeShape, output);
    return output;
}

export function applyInboundMetadata(compiled, input) {
    if (compiled.publish) throw new Error("Inbound metadata requires a subscription.");
    if (!compiled.metadataFields?.length) return {};
    const output = applyFields(compiled, input, compiled.metadataFields ?? []);
    assertNativeValue(inboundMetadataShape, output);
    return output;
}
