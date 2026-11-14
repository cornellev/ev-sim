import { assertRangeImageLayout } from "../../../app/simulation/sensors/RangeImageLayout.js";
import { clonePluginJson } from "../../../app/plugin/PluginJson.js";
import { normalizePluginSensorParameters } from "../../../app/plugin/PluginSensorContract.js";

const pluginRangeImageRunFields = Object.freeze([
    Object.freeze({
        label: "Point dropout probability",
        path: Object.freeze(["noise", "pointDropoutProbability"]),
        control: "number",
        min: 0,
        max: 1,
        step: 0.001,
        advanced: true,
    }),
]);

export function createPluginSensorTypeDefinition(descriptor, ownership) {
    const pointCloudProducts = descriptor.products.filter((product) => product.kind === "pointCloud");
    return Object.freeze({
        id: descriptor.type,
        label: descriptor.type,
        idPrefix: descriptor.type.split(".").at(-1) || "sensor",
        pluginSensor: Object.freeze({ descriptor, ownership: Object.freeze({ ...ownership }) }),
        run: Object.freeze({
            defaultRateHz: descriptor.defaults.rateHz,
            fields: pluginRangeImageRunFields,
            outputs: Object.freeze(pointCloudProducts.map((product) => Object.freeze({
                key: product.outputKey,
                signal: product.productId,
                ...(product.valueContract ? { valueContract: product.valueContract } : { rosType: product.rosType }),
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
                    ...(descriptor.sensorAbi === 1 ? { schema: {
                        ...Object.fromEntries(pointCloudProducts.map((product) => [product.outputKey, product.rosType])),
                        ...(source.schema && typeof source.schema === "object" && !Array.isArray(source.schema)
                            ? clonePluginJson(source.schema, "sensor.schema") : {}),
                    } } : {}),
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

