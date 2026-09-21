export const SENSOR_TRANSPORTS_KIND = "cev-sim.sensor-transports";
export const SENSOR_TRANSPORTS_VERSION = 1;
export const SENSOR_TRANSPORT_ADAPTERS = Object.freeze(["pcap", "udp"]);

function text(value, path) {
    if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
        throw new TypeError(`${path} must be a non-empty trimmed string.`);
    }
    return value;
}

function exactKeys(value, allowed, path) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) throw new TypeError(`${path} contains unknown field "${unknown}".`);
}

export function normalizeSensorTransports(value, { path = "sensorTransports" } = {}) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object.`);
    exactKeys(value, ["kind", "version", "bindings"], path);
    if (value.kind !== SENSOR_TRANSPORTS_KIND || value.version !== SENSOR_TRANSPORTS_VERSION) {
        throw new TypeError(`${path} must be ${SENSOR_TRANSPORTS_KIND} version ${SENSOR_TRANSPORTS_VERSION}.`);
    }
    if (!Array.isArray(value.bindings)) throw new TypeError(`${path}.bindings must be an array.`);
    const bindings = value.bindings.map((entry, index) => {
        const bindingPath = `${path}.bindings.${index}`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`${bindingPath} must be an object.`);
        exactKeys(entry, ["sensorId", "productId", "streamId", "adapter", "endpointId"], bindingPath);
        const adapter = text(entry.adapter, `${bindingPath}.adapter`);
        if (!SENSOR_TRANSPORT_ADAPTERS.includes(adapter)) throw new TypeError(`${bindingPath}.adapter is unsupported.`);
        return Object.freeze({
            sensorId: text(entry.sensorId, `${bindingPath}.sensorId`),
            productId: text(entry.productId, `${bindingPath}.productId`),
            streamId: text(entry.streamId, `${bindingPath}.streamId`),
            adapter,
            endpointId: text(entry.endpointId, `${bindingPath}.endpointId`),
        });
    });
    const keys = bindings.map((entry) => `${entry.sensorId}\0${entry.productId}\0${entry.streamId}\0${entry.adapter}`);
    if (new Set(keys).size !== keys.length) throw new TypeError(`${path}.bindings contains duplicates.`);
    return Object.freeze({
        kind: SENSOR_TRANSPORTS_KIND,
        version: SENSOR_TRANSPORTS_VERSION,
        bindings: Object.freeze(bindings),
    });
}

export function reconcileSensorTransportBindings(transports, sensors = [], { sensorRegistry = null } = {}) {
    if (!transports) return null;
    const enabled = new Map((sensors ?? [])
        .filter((sensor) => sensor?.enabled !== false)
        .map((sensor) => [sensor.id, sensor]));
    const bindings = (transports.bindings ?? []).filter((binding) => {
        const sensor = enabled.get(binding.sensorId);
        if (!sensor) return false;
        const definition = sensorRegistry?.get?.(sensor.type);
        if (!definition) return true;
        const plugin = definition.pluginSensor;
        if (!plugin) return false;
        if (sensor.calibration?.products?.[binding.productId] !== true) return false;
        const product = plugin.descriptor.products.find((entry) => entry.productId === binding.productId);
        if (!product || product.kind !== "vendor-packets") return false;
        return product.streams.some((stream) => stream.streamId === binding.streamId);
    });
    if (bindings.length === 0) return null;
    return Object.freeze({
        kind: SENSOR_TRANSPORTS_KIND,
        version: SENSOR_TRANSPORTS_VERSION,
        bindings: Object.freeze(bindings),
    });
}

