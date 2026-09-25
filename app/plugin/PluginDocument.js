import semver from "semver";

import { deepFreeze } from "../util/cloneJson.js";

import { validateCapabilityGrants } from "../plugin-api/capabilities.js";
import { PLUGIN_PORT_TYPES } from "../plugin-api/ports.js";
import { clonePluginJson } from "./PluginJson.js";
import { PLUGIN_ERROR_CODES, pluginError } from "./PluginErrors.js";
import { normalizePluginSensorDescriptor } from "./PluginSensorContract.js";
import { assertPluginSettingValue, normalizePluginUnitState } from "./PluginValues.js";

export const PLUGIN_DOCUMENT_KIND = "cev-sim.plugin";
export const PLUGIN_DOCUMENT_API = 1;

const PORT_TYPES = new Set(PLUGIN_PORT_TYPES);
const SETTING_TYPES = new Set(["float64", "int32", "boolean", "string", "json", "enum", "port_type"]);

function object(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
    return value;
}

function exactKeys(value, allowed, path) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) throw new Error(`${path} contains unknown field "${unknown}".`);
}

function text(value, path) {
    if (typeof value !== "string") throw new Error(`${path} must be a string.`);
    const normalized = value.trim();
    if (!normalized) throw new Error(`${path} is required.`);
    return normalized;
}

function packagePath(value, path, { module = false } = {}) {
    const normalized = text(value, path);
    if (normalized.includes("\\") || normalized.startsWith("/") || normalized.includes("%")
        || normalized.includes("?") || normalized.includes("#") || normalized.split("/").includes("..")) {
        throw new Error(`${path} must be a normalized package-relative path.`);
    }
    if (module && !/\.(?:js|mjs)$/.test(normalized)) throw new Error(`${path} must name an explicit .js or .mjs module.`);
    return normalized;
}

function normalizePorts(value, path) {
    const source = object(value ?? {}, path);
    exactKeys(source, ["inputs", "outputs"], path);
    const normalizeSide = (side) => {
        const entries = object(source[side] ?? {}, `${path}.${side}`);
        return Object.fromEntries(Object.entries(entries).map(([label, type]) => {
            if (!label.trim() || label !== label.trim() || ["__proto__", "prototype", "constructor"].includes(label)) {
                throw new Error(`${path}.${side} contains invalid label "${label}".`);
            }
            if (!PORT_TYPES.has(type)) throw new Error(`${path}.${side}.${label} uses unsupported port type "${type}".`);
            return [label, type];
        }));
    };
    return { inputs: normalizeSide("inputs"), outputs: normalizeSide("outputs") };
}

function normalizeSetting(value, path) {
    const source = object(value, path);
    exactKeys(source, ["target", "key", "valueType", "default", "options", "min", "max"], path);
    if (source.target !== "state") throw new Error(`${path}.target must be "state".`);
    const key = text(source.key, `${path}.key`);
    if (key !== source.key || ["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`${path}.key is invalid.`);
    const valueType = text(source.valueType, `${path}.valueType`);
    if (!SETTING_TYPES.has(valueType)) throw new Error(`${path}.valueType is unsupported.`);
    const result = { target: "state", key, valueType };
    if (Object.hasOwn(source, "default")) result.default = clonePluginJson(source.default, `${path}.default`);
    if (source.options !== undefined) {
        if (valueType !== "enum" || !Array.isArray(source.options) || source.options.length === 0) {
            throw new Error(`${path}.options requires a non-empty enum option array.`);
        }
        result.options = source.options.map((entry, index) => text(entry, `${path}.options.${index}`));
        if (new Set(result.options).size !== result.options.length) throw new Error(`${path}.options contains duplicates.`);
    }
    for (const keyName of ["min", "max"]) {
        if (source[keyName] !== undefined) {
            if (!["float64", "int32"].includes(valueType)) throw new Error(`${path}.${keyName} is valid only for numeric settings.`);
            if (!Number.isFinite(source[keyName])) throw new Error(`${path}.${keyName} must be finite.`);
            if (valueType === "int32" && !Number.isInteger(source[keyName])) throw new Error(`${path}.${keyName} must be an integer.`);
            result[keyName] = source[keyName];
        }
    }
    if (result.min !== undefined && result.max !== undefined && result.min > result.max) {
        throw new Error(`${path}.min cannot exceed ${path}.max.`);
    }
    if (Object.hasOwn(source, "default")) {
        assertPluginSettingValue(result, result.default, `${path}.default`);
    }
    return result;
}

function normalizeCatalog(value, path) {
    const source = object(value, path);
    exactKeys(source, ["name", "category", "keywords", "placeable", "deprecated", "requiresSignals"], path);
    if (!Array.isArray(source.keywords)) throw new Error(`${path}.keywords must be an array.`);
    for (const field of ["placeable", "deprecated", "requiresSignals"]) {
        if (source[field] !== undefined && typeof source[field] !== "boolean") throw new Error(`${path}.${field} must be a boolean.`);
    }
    const keywords = source.keywords.map((entry, index) => text(entry, `${path}.keywords.${index}`));
    if (new Set(keywords).size !== keywords.length) throw new Error(`${path}.keywords contains duplicates.`);
    return {
        name: text(source.name, `${path}.name`),
        category: text(source.category, `${path}.category`),
        keywords,
        placeable: source.placeable !== false,
        deprecated: source.deprecated === true,
        requiresSignals: source.requiresSignals === true,
    };
}

function normalizeUnit(value, pluginId, path) {
    const source = object(value, path);
    exactKeys(source, ["type", "ports", "settings", "defaults", "catalog"], path);
    const type = text(source.type, `${path}.type`);
    if (!type.startsWith(`${pluginId}.`) || type.length === pluginId.length + 1) throw new Error(`${path}.type must start with "${pluginId}.".`);
    const settings = (source.settings ?? []).map((entry, index) => normalizeSetting(entry, `${path}.settings.${index}`));
    const settingKeys = new Set();
    for (const setting of settings) {
        if (settingKeys.has(setting.key)) throw new Error(`${path}.settings contains duplicate key "${setting.key}".`);
        settingKeys.add(setting.key);
    }
    const declaredDefaults = clonePluginJson(source.defaults ?? {}, `${path}.defaults`);
    const defaults = Object.fromEntries(settings.filter((setting) => Object.hasOwn(setting, "default"))
        .map((setting) => [setting.key, clonePluginJson(setting.default, `${path}.settings.${setting.key}.default`)]));
    Object.assign(defaults, normalizePluginUnitState({ type, settings }, declaredDefaults, `${path}.defaults`));
    return { type, ports: normalizePorts(source.ports, `${path}.ports`), settings, defaults, catalog: normalizeCatalog(source.catalog, `${path}.catalog`) };
}

function normalizeSystem(value, pluginId, path) {
    const source = object(value, path);
    exactKeys(source, ["id", "phase", "priority", "stateVersion"], path);
    const id = text(source.id, `${path}.id`);
    if (!id.startsWith(`${pluginId}.`) || id.length === pluginId.length + 1) throw new Error(`${path}.id must start with "${pluginId}.".`);
    if (source.phase !== "scripts") throw new Error(`${path}.phase must be "scripts".`);
    if (!Number.isSafeInteger(source.priority)) throw new Error(`${path}.priority must be a safe integer.`);
    if (!Number.isSafeInteger(source.stateVersion) || source.stateVersion < 1) throw new Error(`${path}.stateVersion must be a positive safe integer.`);
    return { id, phase: "scripts", priority: source.priority, stateVersion: source.stateVersion };
}

export function assertPluginDocument(value) {
    try {
        const source = object(value, "plugin.json");
        exactKeys(source, ["kind", "api", "id", "version", "engines", "entry", "capabilities", "units", "systems", "sensorTypes", "editor"], "plugin.json");
        if (source.kind !== PLUGIN_DOCUMENT_KIND) throw new Error(`plugin.json.kind must be "${PLUGIN_DOCUMENT_KIND}".`);
        if (source.api !== PLUGIN_DOCUMENT_API) throw new Error(`plugin.json.api must be ${PLUGIN_DOCUMENT_API}.`);
        const id = text(source.id, "plugin.json.id");
        if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(id) || id === "cev" || id.startsWith("cev.")) {
            throw new Error("plugin.json.id must be a lowercase dotted ID outside the reserved cev namespace.");
        }
        const version = text(source.version, "plugin.json.version");
        if (!semver.valid(version)) throw new Error("plugin.json.version must be a valid SemVer version.");
        const engines = object(source.engines, "plugin.json.engines");
        exactKeys(engines, ["cevSim"], "plugin.json.engines");
        const cevSim = text(engines.cevSim, "plugin.json.engines.cevSim");
        if (!semver.validRange(cevSim)) throw new Error("plugin.json.engines.cevSim must be a valid SemVer range.");
        const entrySource = object(source.entry, "plugin.json.entry");
        exactKeys(entrySource, ["runtime", "ui"], "plugin.json.entry");
        const entry = { runtime: packagePath(entrySource.runtime, "plugin.json.entry.runtime", { module: true }) };
        if (entrySource.ui !== undefined) entry.ui = packagePath(entrySource.ui, "plugin.json.entry.ui", { module: true });
        const capabilities = [...validateCapabilityGrants(source.capabilities ?? [], source.capabilities ?? [], source.capabilities ?? [])];
        if (!Array.isArray(source.units)) throw new Error("plugin.json.units must be an array.");
        if (!Array.isArray(source.systems ?? [])) throw new Error("plugin.json.systems must be an array.");
        if (source.sensorTypes !== undefined && !Array.isArray(source.sensorTypes)) {
            throw new Error("plugin.json.sensorTypes must be an array when present.");
        }
        const units = source.units.map((unit, index) => normalizeUnit(unit, id, `plugin.json.units.${index}`));
        const systems = (source.systems ?? []).map((system, index) => normalizeSystem(system, id, `plugin.json.systems.${index}`));
        const sensorTypes = source.sensorTypes?.map((sensorType, index) => (
            normalizePluginSensorDescriptor(sensorType, id, `plugin.json.sensorTypes.${index}`)
        ));
        if ((sensorTypes?.length ?? 0) > 0 && !capabilities.includes("sensors.sample.range-image")) {
            throw new Error("plugin.json sensorTypes require capability \"sensors.sample.range-image\".");
        }
        for (const [label, entries] of [
            ["unit type", units.map((unit) => unit.type)],
            ["system id", systems.map((system) => system.id)],
            ["sensor type", sensorTypes?.map((sensorType) => sensorType.type) ?? []],
        ]) {
            if (new Set(entries).size !== entries.length) throw new Error(`plugin.json contains a duplicate ${label}.`);
        }
        const contributionIds = [
            ...units.map((unit) => unit.type),
            ...systems.map((system) => system.id),
            ...(sensorTypes?.map((sensorType) => sensorType.type) ?? []),
        ];
        if (new Set(contributionIds).size !== contributionIds.length) throw new Error("plugin.json contains duplicate contribution IDs.");
        let editor;
        if (source.editor !== undefined) {
            const editorSource = object(source.editor, "plugin.json.editor");
            exactKeys(editorSource, ["assets"], "plugin.json.editor");
            if (!Array.isArray(editorSource.assets)) throw new Error("plugin.json.editor.assets must be an array.");
            editor = { assets: editorSource.assets.map((asset, index) => packagePath(asset, `plugin.json.editor.assets.${index}`)) };
            if (new Set(editor.assets).size !== editor.assets.length) throw new Error("plugin.json.editor.assets contains duplicates.");
        }
        return deepFreeze({
            kind: PLUGIN_DOCUMENT_KIND,
            api: PLUGIN_DOCUMENT_API,
            id,
            version,
            engines: { cevSim },
            entry,
            capabilities,
            units,
            systems,
            ...(sensorTypes === undefined ? {} : { sensorTypes }),
            ...(editor ? { editor } : {}),
        });
    } catch (error) {
        if (error?.code === PLUGIN_ERROR_CODES.DOCUMENT_INVALID) throw error;
        throw pluginError(PLUGIN_ERROR_CODES.DOCUMENT_INVALID, error.message, { cause: error });
    }
}

export function validatePluginDocument(value) {
    try {
        return { ok: true, document: assertPluginDocument(value), issues: [] };
    } catch (error) {
        return { ok: false, document: null, issues: [{ path: error.path ?? "", message: error.message }] };
    }
}

export function assertPluginCompatibility(document, { pluginApi = PLUGIN_DOCUMENT_API, simulatorVersion } = {}) {
    if (document.api !== pluginApi) {
        throw pluginError(PLUGIN_ERROR_CODES.COMPATIBILITY, `Plugin API ${document.api} is unsupported; expected ${pluginApi}.`, { pluginId: document.id });
    }
    if (!simulatorVersion || !semver.valid(simulatorVersion) || !semver.satisfies(simulatorVersion, document.engines.cevSim)) {
        throw pluginError(PLUGIN_ERROR_CODES.COMPATIBILITY, `Plugin "${document.id}" does not support cev-sim ${simulatorVersion ?? "unknown"}.`, { pluginId: document.id });
    }
    return document;
}

export function runtimeManifestProjection(document) {
    const projection = clonePluginJson(document, "plugin document");
    delete projection.entry.ui;
    delete projection.editor;
    return deepFreeze(projection);
}
