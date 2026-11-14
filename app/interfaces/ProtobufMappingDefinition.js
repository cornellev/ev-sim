import { assertProtobufName } from "./ProtobufSchema.js";

export const MAPPING_OPERATIONS = Object.freeze(["quaternionYaw", "poseAtOffset", "frameTransform"]);

export function normalizeMappingDefinition(value) {
    const record = (value, keys) => {
        if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
            || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid mapping record or unknown field.");
    };
    const path = (value, source = false, item = false) => {
        if (!source && value === "") return value;
        if (typeof value !== "string" || !value.length || value.length > 1024) throw new Error("Mapping paths must be bounded strings.");
        value.split(".").forEach(assertProtobufName);
        if (source && !["value", "metadata", "run", "bindings", "derived", ...(item ? ["item"] : [])].includes(value.split(".")[0])) throw new Error("Invalid mapping source root.");
        return value;
    };
    const operation = (value) => {
        if (!MAPPING_OPERATIONS.includes(value)) throw new Error("Unavailable mapping operation.");
        return value;
    };
    const fields = (entries, item = false, depth = 0) => {
        if (!Array.isArray(entries) || entries.length > 1024 || Object.keys(entries).length !== entries.length || depth > 8) throw new Error("Mapping requires bounded dense fields.");
        const assigned = [];
        return entries.map((entry) => {
            record(entry, ["to", "from", "value", "scale", "offset", "each", "operation", "offsetFrom", "fromFrame", "toFrame"]);
            const to = path(entry.to);
            if (assigned.some((p) => !p || !to || p === to || p.startsWith(`${to}.`) || to.startsWith(`${p}.`))) throw new Error("Overlapping mapping destinations.");
            assigned.push(to);
            if (["from", "value", "each"].filter((key) => Object.hasOwn(entry, key)).length !== 1) throw new Error("Select one mapping source.");
            if (Object.hasOwn(entry, "value")) {
                if (Object.keys(entry).some((key) => !["to", "value"].includes(key))) throw new Error("Constants cannot have conversions.");
                return { to, value: structuredClone(entry.value) };
            }
            if (entry.each) {
                record(entry, ["to", "each"]);
                record(entry.each, ["from", "fields"]);
                return { to, each: { from: path(entry.each.from, true, item), fields: fields(entry.each.fields, true, depth + 1) } };
            }
            const result = { to, from: path(entry.from, true, item) };
            for (const key of ["scale", "offset"]) if (entry[key] !== undefined) {
                if (typeof entry[key] !== "number" || !Number.isFinite(entry[key])) throw new Error("Conversions require finite numeric coefficients.");
                result[key] = entry[key];
            }
            if (entry.operation !== undefined) {
                if (entry.scale !== undefined || entry.offset !== undefined) throw new Error("Select an operation or numeric conversion.");
                result.operation = operation(entry.operation);
            }
            for (const key of ["offsetFrom", "fromFrame", "toFrame"]) if (entry[key] !== undefined) {
                if (!entry.operation) throw new Error("Operation arguments require an operation.");
                const allowed = entry.operation === "poseAtOffset" ? ["offsetFrom"] : entry.operation === "frameTransform" ? ["fromFrame", "toFrame"] : [];
                if (!allowed.includes(key)) throw new Error("Argument is unavailable for this operation.");
                result[key] = path(entry[key], true, item);
            }
            return result;
        });
    };
    record(value, ["fields", "bindings", "derived", "metadata", "checks"]);
    const result = { fields: fields(value.fields) };
    if (value.metadata !== undefined) {
        result.metadata = fields(value.metadata);
        if (result.metadata.some((entry) => !["runId", "frameId", "captureTimeNs", "sequenceId"].includes(entry.to) || entry.each || entry.operation)) throw new Error("Inbound metadata selects runId, frameId, captureTimeNs or sequenceId scalars.");
    }
    if (value.checks !== undefined) {
        if (!Array.isArray(value.checks) || value.checks.length > 64 || Object.keys(value.checks).length !== value.checks.length) throw new Error("Mapping checks must be bounded dense records.");
        result.checks = value.checks.map((entry) => {
            record(entry, ["from", "value", "equalsFrom"]);
            if (Object.hasOwn(entry, "value") === Object.hasOwn(entry, "equalsFrom")) throw new Error("A mapping check selects a literal or equalsFrom.");
            return { from: path(entry.from, true), ...(Object.hasOwn(entry, "value") ? { value: structuredClone(entry.value) } : { equalsFrom: path(entry.equalsFrom, true) }) };
        });
    }
    if (value.bindings !== undefined) {
        record(value.bindings, ["vehicleId", "sensorId", "rearWheelIds"]);
        result.bindings = structuredClone(value.bindings);
        for (const key of ["vehicleId", "sensorId"]) if (result.bindings[key] !== undefined && (typeof result.bindings[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(result.bindings[key]))) throw new Error("Invalid native binding ID.");
        if (result.bindings.rearWheelIds !== undefined && (!Array.isArray(result.bindings.rearWheelIds) || result.bindings.rearWheelIds.length !== 2 || new Set(result.bindings.rearWheelIds).size !== 2 || result.bindings.rearWheelIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)))) throw new Error("Select two distinct rear wheel IDs.");
    }
    if (value.derived !== undefined) {
        if (!Array.isArray(value.derived) || value.derived.length > 64 || Object.keys(value.derived).length !== value.derived.length) throw new Error("Derived mappings must be bounded.");
        const ids = new Set();
        result.derived = value.derived.map((entry) => {
            record(entry, ["id", "operation", "from", "offsetFrom", "fromFrame", "toFrame"]);
            assertProtobufName(entry.id);
            if (ids.has(entry.id)) throw new Error("Duplicate derived ID.");
            ids.add(entry.id);
            return { id: entry.id, ...fields([{ to: entry.id, ...Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "id")) }])[0] };
        });
        result.derived.forEach((entry) => { delete entry.to; });
    }
    return result;
}
