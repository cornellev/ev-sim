import {
    assertRangeImageLayout,
    rangeImageDimensions,
} from "../simulation/sensors/RangeImageLayout.js";
import { CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_VERSION } from "../simulation/sensors/CpuLidarBackend.js";
import { clonePluginJson } from "./PluginJson.js";

export const PLUGIN_SENSOR_RANGE_IMAGE_CAPABILITY = "sensors.sample.range-image";

export function pluginSensorRangeImageCapability() {
    return PLUGIN_SENSOR_RANGE_IMAGE_CAPABILITY;
}

export const PLUGIN_SENSOR_ABI = 1;
export const PLUGIN_SENSOR_FAMILY = "range-image";
export const PLUGIN_SENSOR_SETTING_TYPES = Object.freeze([
    "float64",
    "int32",
    "boolean",
    "string",
    "json",
    "enum",
]);
export const PLUGIN_SENSOR_PRODUCT_KINDS = Object.freeze(["pointCloud", "vendor-packets"]);

const SETTING_TYPES = new Set(PLUGIN_SENSOR_SETTING_TYPES);

function object(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${path} must be an object.`);
    }
    return value;
}

function exactKeys(value, allowed, path) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) throw new TypeError(`${path} contains unknown field "${unknown}".`);
}

function text(value, path) {
    if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
        throw new TypeError(`${path} must be a non-empty trimmed string.`);
    }
    return value;
}

function safeKey(value, path) {
    const key = text(value, path);
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new TypeError(`${path} is invalid.`);
    return key;
}

function positiveInteger(value, path) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${path} must be a positive safe integer.`);
    return value;
}

function validateSettingValue(setting, value, path) {
    if (setting.valueType === "float64" && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new TypeError(`${path} must be a finite number.`);
    }
    if (setting.valueType === "int32" && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
        throw new TypeError(`${path} must be an int32.`);
    }
    if (setting.valueType === "boolean" && typeof value !== "boolean") throw new TypeError(`${path} must be boolean.`);
    if (["string", "enum"].includes(setting.valueType) && typeof value !== "string") throw new TypeError(`${path} must be a string.`);
    if (setting.valueType === "enum" && !setting.options.includes(value)) {
        throw new TypeError(`${path} must be one of ${setting.options.join(", ")}.`);
    }
    if (setting.valueType === "json") clonePluginJson(value, path);
    if (typeof value === "number") {
        if (setting.min !== undefined && value < setting.min) throw new RangeError(`${path} must be at least ${setting.min}.`);
        if (setting.max !== undefined && value > setting.max) throw new RangeError(`${path} must be at most ${setting.max}.`);
    }
    return clonePluginJson(value, path);
}

function normalizeSetting(value, path) {
    const source = object(value, path);
    exactKeys(source, ["key", "valueType", "default", "options", "min", "max"], path);
    const key = safeKey(source.key, `${path}.key`);
    const valueType = text(source.valueType, `${path}.valueType`);
    if (!SETTING_TYPES.has(valueType)) throw new TypeError(`${path}.valueType is unsupported.`);
    if (!Object.hasOwn(source, "default")) throw new TypeError(`${path}.default is required.`);
    const result = { key, valueType };
    if (source.options !== undefined) {
        if (valueType !== "enum" || !Array.isArray(source.options) || source.options.length === 0) {
            throw new TypeError(`${path}.options requires a non-empty enum option array.`);
        }
        result.options = source.options.map((entry, index) => text(entry, `${path}.options.${index}`));
        if (new Set(result.options).size !== result.options.length) throw new TypeError(`${path}.options contains duplicates.`);
    } else if (valueType === "enum") {
        throw new TypeError(`${path}.options is required for enum settings.`);
    }
    for (const bound of ["min", "max"]) {
        if (source[bound] === undefined) continue;
        if (!["float64", "int32"].includes(valueType) || !Number.isFinite(source[bound])
            || (valueType === "int32" && !Number.isInteger(source[bound]))) {
            throw new TypeError(`${path}.${bound} is invalid for ${valueType}.`);
        }
        result[bound] = source[bound];
    }
    if (result.min !== undefined && result.max !== undefined && result.min > result.max) {
        throw new RangeError(`${path}.min cannot exceed max.`);
    }
    result.default = validateSettingValue(result, source.default, `${path}.default`);
    return Object.freeze(result);
}

function normalizeProduct(value, path) {
    const source = object(value, path);
    const kind = text(source.kind, `${path}.kind`);
    if (!PLUGIN_SENSOR_PRODUCT_KINDS.includes(kind)) throw new TypeError(`${path}.kind is unsupported.`);
    if (kind === "pointCloud") {
        exactKeys(source, ["kind", "productId", "outputKey", "rosType", "contractId"], path);
        if (source.rosType !== "sensor_msgs/PointCloud2") {
            throw new TypeError(`${path}.rosType must be "sensor_msgs/PointCloud2".`);
        }
        return Object.freeze({
            kind,
            productId: safeKey(source.productId, `${path}.productId`),
            outputKey: safeKey(source.outputKey, `${path}.outputKey`),
            rosType: source.rosType,
            ...(source.contractId === undefined ? {} : { contractId: text(source.contractId, `${path}.contractId`) }),
        });
    }
    exactKeys(source, ["kind", "productId", "streams"], path);
    if (!Array.isArray(source.streams) || source.streams.length === 0) {
        throw new TypeError(`${path}.streams must be a non-empty array.`);
    }
    const streams = source.streams.map((entry, index) => {
        const streamPath = `${path}.streams.${index}`;
        const stream = object(entry, streamPath);
        exactKeys(stream, ["streamId", "maxPayloadBytes"], streamPath);
        return Object.freeze({
            streamId: safeKey(stream.streamId, `${streamPath}.streamId`),
            maxPayloadBytes: positiveInteger(stream.maxPayloadBytes, `${streamPath}.maxPayloadBytes`),
        });
    });
    if (new Set(streams.map((entry) => entry.streamId)).size !== streams.length) {
        throw new TypeError(`${path}.streams contains duplicate stream IDs.`);
    }
    return Object.freeze({
        kind,
        productId: safeKey(source.productId, `${path}.productId`),
        streams: Object.freeze(streams),
    });
}

function normalizeObservation(value, products, path) {
    if (value === undefined) return undefined;
    const source = object(value, path);
    exactKeys(source, ["productId", "dtype", "components"], path);
    const productId = safeKey(source.productId, `${path}.productId`);
    if (source.dtype !== "float32") throw new TypeError(`${path}.dtype must be "float32".`);
    if (!Array.isArray(source.components)
        || source.components.length !== 2
        || source.components[0] !== "rangeMeters"
        || source.components[1] !== "incidence") {
        throw new TypeError(`${path}.components must be ["rangeMeters", "incidence"].`);
    }
    const product = products.find((entry) => entry.productId === productId);
    if (!product || product.kind !== "pointCloud") {
        throw new TypeError(`${path}.productId must reference a declared pointCloud product.`);
    }
    return Object.freeze({ productId, dtype: "float32", components: Object.freeze(["rangeMeters", "incidence"]) });
}

export function normalizePluginSensorDescriptor(value, pluginId, path = "plugin.json.sensorTypes.0") {
    const source = object(value, path);
    exactKeys(source, ["type", "sensorAbi", "family", "stateVersion", "defaults", "settings", "products", "observation"], path);
    const type = text(source.type, `${path}.type`);
    if (!type.startsWith(`${pluginId}.`) || type.length === pluginId.length + 1) {
        throw new TypeError(`${path}.type must start with "${pluginId}.".`);
    }
    if (source.sensorAbi !== PLUGIN_SENSOR_ABI) throw new TypeError(`${path}.sensorAbi must be ${PLUGIN_SENSOR_ABI}.`);
    if (source.family !== PLUGIN_SENSOR_FAMILY) throw new TypeError(`${path}.family must be "${PLUGIN_SENSOR_FAMILY}".`);
    const defaultsSource = object(source.defaults, `${path}.defaults`);
    exactKeys(defaultsSource, ["rateHz", "scanLayout"], `${path}.defaults`);
    if (typeof defaultsSource.rateHz !== "number" || !Number.isFinite(defaultsSource.rateHz) || defaultsSource.rateHz <= 0) {
        throw new TypeError(`${path}.defaults.rateHz must be positive and finite.`);
    }
    if (!Array.isArray(source.settings ?? [])) throw new TypeError(`${path}.settings must be an array.`);
    if (!Array.isArray(source.products) || source.products.length === 0) throw new TypeError(`${path}.products must be a non-empty array.`);
    const settings = (source.settings ?? []).map((entry, index) => normalizeSetting(entry, `${path}.settings.${index}`));
    const products = source.products.map((entry, index) => normalizeProduct(entry, `${path}.products.${index}`));
    if (new Set(settings.map((entry) => entry.key)).size !== settings.length) throw new TypeError(`${path}.settings contains duplicate keys.`);
    if (new Set(products.map((entry) => entry.productId)).size !== products.length) throw new TypeError(`${path}.products contains duplicate product IDs.`);
    const outputKeys = products.filter((entry) => entry.kind === "pointCloud").map((entry) => entry.outputKey);
    if (new Set(outputKeys).size !== outputKeys.length) throw new TypeError(`${path}.products contains duplicate output keys.`);
    const observation = normalizeObservation(source.observation, products, `${path}.observation`);
    return Object.freeze({
        type,
        sensorAbi: PLUGIN_SENSOR_ABI,
        family: PLUGIN_SENSOR_FAMILY,
        stateVersion: positiveInteger(source.stateVersion, `${path}.stateVersion`),
        defaults: Object.freeze({
            rateHz: defaultsSource.rateHz,
            scanLayout: assertRangeImageLayout(defaultsSource.scanLayout, { path: `${path}.defaults.scanLayout` }),
        }),
        settings: Object.freeze(settings),
        products: Object.freeze(products),
        ...(observation ? { observation } : {}),
    });
}

export function normalizePluginSensorParameters(descriptor, value = {}, path = "calibration.parameters") {
    const source = object(value, path);
    const settings = new Map(descriptor.settings.map((entry) => [entry.key, entry]));
    const unknown = Object.keys(source).find((key) => !settings.has(key));
    if (unknown) throw new TypeError(`${path} contains unknown parameter "${unknown}".`);
    return Object.freeze(Object.fromEntries(descriptor.settings.map((setting) => [
        setting.key,
        validateSettingValue(
            setting,
            Object.hasOwn(source, setting.key) ? source[setting.key] : setting.default,
            `${path}.${setting.key}`,
        ),
    ])));
}

export function createPluginSensorTypeDefinition(descriptor, ownership) {
    const pointCloudProducts = descriptor.products.filter((product) => product.kind === "pointCloud");
    return Object.freeze({
        id: descriptor.type,
        label: descriptor.type,
        idPrefix: descriptor.type.split(".").at(-1) || "sensor",
        pluginSensor: Object.freeze({ descriptor, ownership: Object.freeze({ ...ownership }) }),
        run: Object.freeze({
            defaultRateHz: descriptor.defaults.rateHz,
            fields: Object.freeze([]),
            outputs: Object.freeze(pointCloudProducts.map((product) => Object.freeze({
                key: product.outputKey,
                signal: product.productId,
                rosType: product.rosType,
                measured: true,
            }))),
            normalize(source = {}) {
                const calibration = source.calibration && typeof source.calibration === "object"
                    && !Array.isArray(source.calibration) ? source.calibration : {};
                const authoredProducts = calibration.products && typeof calibration.products === "object"
                    && !Array.isArray(calibration.products) ? calibration.products : {};
                const products = Object.fromEntries(descriptor.products.map((product) => [
                    product.productId,
                    authoredProducts[product.productId] === true,
                ]));
                return {
                    calibration: {
                        scanLayout: calibration.scanLayout === undefined
                            ? descriptor.defaults.scanLayout
                            : assertRangeImageLayout(calibration.scanLayout, { path: "calibration.scanLayout" }),
                        parameters: normalizePluginSensorParameters(
                            descriptor,
                            calibration.parameters ?? {},
                            "calibration.parameters",
                        ),
                        products,
                    },
                    schema: {
                        ...Object.fromEntries(pointCloudProducts.map((product) => [product.outputKey, product.rosType])),
                        ...(source.schema && typeof source.schema === "object" && !Array.isArray(source.schema)
                            ? clonePluginJson(source.schema, "sensor.schema") : {}),
                    },
                    health: {
                        deadlineNs: Number.isSafeInteger(source.health?.deadlineNs) && source.health.deadlineNs >= 0
                            ? source.health.deadlineNs : Math.round(1e9 / descriptor.defaults.rateHz),
                        observationalOracle: source.health?.observationalOracle !== false,
                    },
                    determinism: { comparison: "numeric-tolerance", crossDeviceByteEquality: true },
                };
            },
            validate(sensor) {
                const issues = [];
                try {
                    assertRangeImageLayout(sensor.calibration?.scanLayout, { path: "calibration.scanLayout" });
                    normalizePluginSensorParameters(descriptor, sensor.calibration?.parameters ?? {});
                } catch (error) {
                    issues.push({ path: "calibration", message: error.message });
                }
                const declaredProducts = new Set(descriptor.products.map((product) => product.productId));
                const unknown = Object.keys(sensor.calibration?.products ?? {}).find((key) => !declaredProducts.has(key));
                if (unknown) issues.push({ path: `calibration.products.${unknown}`, message: `Unknown product "${unknown}".` });
                if (descriptor.observation && sensor.calibration?.products?.[descriptor.observation.productId] !== true) {
                    const requested = Object.values(sensor.outputs ?? {}).some(Boolean);
                    if (requested) {
                        issues.push({
                            path: `calibration.products.${descriptor.observation.productId}`,
                            message: "The observation-mapped point-cloud product must be enabled when its output is configured.",
                        });
                    }
                }
                return issues;
            },
        }),
        vehicle: Object.freeze({
            fields: Object.freeze([]),
            normalize(source = {}) {
                const config = source.config && typeof source.config === "object"
                    && !Array.isArray(source.config) ? source.config : {};
                const authoredProducts = config.products && typeof config.products === "object"
                    && !Array.isArray(config.products) ? config.products : {};
                const products = Object.fromEntries(descriptor.products.map((product) => [
                    product.productId,
                    authoredProducts[product.productId] === true,
                ]));
                const rateHz = typeof config.rateHz === "number" && Number.isFinite(config.rateHz) && config.rateHz > 0
                    ? config.rateHz
                    : descriptor.defaults.rateHz;
                return {
                    rateHz,
                    scanLayout: config.scanLayout === undefined
                        ? descriptor.defaults.scanLayout
                        : assertRangeImageLayout(config.scanLayout, { path: "config.scanLayout" }),
                    parameters: normalizePluginSensorParameters(
                        descriptor,
                        config.parameters ?? {},
                        "config.parameters",
                    ),
                    products,
                };
            },
            validate(sensor) {
                const issues = [];
                try {
                    assertRangeImageLayout(sensor.config?.scanLayout, { path: "config.scanLayout" });
                    normalizePluginSensorParameters(descriptor, sensor.config?.parameters ?? {}, "config.parameters");
                } catch (error) {
                    issues.push({ path: "config", message: error.message });
                }
                const declaredProducts = new Set(descriptor.products.map((product) => product.productId));
                const unknown = Object.keys(sensor.config?.products ?? {}).find((key) => !declaredProducts.has(key));
                if (unknown) issues.push({ path: `config.products.${unknown}`, message: `Unknown product "${unknown}".` });
                if (typeof sensor.config?.rateHz !== "number" || !Number.isFinite(sensor.config.rateHz)
                    || sensor.config.rateHz <= 0) {
                    issues.push({ path: "config.rateHz", message: "rateHz must be positive and finite." });
                }
                return issues;
            },
        }),
    });
}

export function describePluginSensorObservation(descriptor, source = {}, { context = "run" } = {}) {
    const root = context === "vehicle" ? source.config ?? {} : source.calibration ?? {};
    const layout = root.scanLayout ?? descriptor.defaults.scanLayout;
    const products = root.products && typeof root.products === "object" && !Array.isArray(root.products)
        ? root.products : {};
    const mapping = descriptor.observation ?? null;
    let dimensions = { channelCount: 0, azimuthCount: 0, rayCount: 0 };
    try {
        dimensions = rangeImageDimensions(layout);
    } catch {
        dimensions = { channelCount: 0, azimuthCount: 0, rayCount: 0 };
    }
    const enabled = Boolean(mapping && products[mapping.productId] === true);
    const outputKey = mapping
        ? descriptor.products.find((product) => product.productId === mapping.productId)?.outputKey ?? null
        : null;
    return Object.freeze({
        dtype: mapping?.dtype ?? "float32",
        shape: Object.freeze([dimensions.channelCount, dimensions.azimuthCount, 2]),
        byteCount: dimensions.rayCount * 2 * Float32Array.BYTES_PER_ELEMENT,
        maxRangeM: layout?.maxRangeM ?? null,
        requiresCpuV2: true,
        cpuBackendVersion: CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_VERSION,
        outputMapping: mapping?.productId ?? null,
        outputKey,
        enabled,
    });
}
