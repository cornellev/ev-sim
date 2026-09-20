import { compareUtf8 } from "../world/WorldDescription.js";
import { assertLidarGeometryResource } from "../lidar/LidarGeometry.js";
import {
    CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_VERSION,
    assertCpuLidarBackendSelection,
} from "./CpuLidarBackend.js";
import { PluginSensorDevice } from "./PluginSensorAdapter.js";

export class PluginSensorManager {
    constructor(vehicleSource, options = {}) {
        this.vehicleSource = vehicleSource;
        this.options = options;
        this.telemetry = options.telemetry ?? null;
        this.devices = [];
        this.scene = null;
        this.clock = { step: 0, timeNs: 0 };
        this.seed = "0";
        this.runtimeData = options.runtimeData ?? {
            bindings: () => ({ signalStore: this.telemetry }),
            simulation: () => ({ timeNs: this.clock.timeNs, steps: this.clock.step }),
            client: () => null,
        };
    }

    vehicles() {
        const source = typeof this.vehicleSource === "function" ? this.vehicleSource() : this.vehicleSource;
        return source?.vehicles ?? source ?? [];
    }

    async configure(admission, options = {}) {
        this.disposeRun();
        const records = (admission?.sensors ?? [])
            .filter((entry) => entry.kind === "plugin-range-image")
            .sort((left, right) => compareUtf8(left.sensor.id, right.sensor.id));
        if (records.length === 0 || options.enabled === false) return this.devices;
        const selection = assertCpuLidarBackendSelection(options.backendSelection);
        if (String(selection.version) !== CPU_LIDAR_EXPLICIT_LAYOUT_BACKEND_VERSION) {
            throw new Error("Plugin range-image sensors require deterministic-cpu-bvh-lidar version 2.");
        }
        assertLidarGeometryResource(options.lidarGeometry);
        const messageCodec = options.messageCodec ?? this.options.messageCodec;
        if (typeof messageCodec?.encodeTopicValue !== "function"
            || typeof messageCodec?.registerMsgDefinition !== "function") {
            throw new Error("Plugin point-cloud sensors require a message-codec adapter.");
        }
        for (const [type, definition] of Object.entries(options.schemas ?? {})) {
            messageCodec.registerMsgDefinition(type, definition);
        }
        const pluginSession = options.pluginSession;
        if (!pluginSession) throw new Error("Plugin sensor execution requires its prepared plugin session.");
        const { CpuLidarScene } = await import("./CpuLidarScene.js");
        this.scene = new CpuLidarScene(options.lidarGeometry);
        this.seed = String(options.seed ?? "0");
        const vehicleIds = new Set(this.vehicles().map((entry) => entry.telemetryId || entry.id));
        const runtimeData = options.runtimeData ?? this.runtimeData;
        const created = [];
        try {
            for (const record of records) {
                if (!vehicleIds.has(record.sensor.parentId)) {
                    throw new Error(`Plugin sensor "${record.sensor.id}" references unknown parent vehicle "${record.sensor.parentId}".`);
                }
                const factory = pluginSession.sensorFactories.get(record.sensor.type);
                if (!factory || factory.pluginId !== record.plugin.ownership.pluginId
                    || factory.runtimeHash !== record.plugin.ownership.runtimeHash) {
                    throw new Error(`Plugin sensor factory "${record.sensor.type}" does not match its admitted declaration.`);
                }
                created.push(new PluginSensorDevice(record, {
                    factory,
                    scene: this.scene,
                    vehicles: () => this.vehicles(),
                    Publisher: options.Publisher,
                    transformRuntime: options.transformRuntime,
                    publisherOptions: {
                        seed: this.seed,
                        topics: options.topics,
                        topicRouter: options.topicRouter,
                        calibrationHash: options.calibrationHash,
                        stepNs: options.stepNs,
                        runtimeData,
                        encodeTopicValue: messageCodec.encodeTopicValue,
                        nativePacketSink: options.nativePacketSink,
                        nowNs: options.nowNs ?? (() => 0),
                    },
                }));
            }
            this.devices = created;
        } catch (error) {
            for (const device of created) device.dispose();
            this.devices = [];
            this.scene?.dispose();
            this.scene = null;
            throw error;
        }
        return this.devices;
    }

    update(_dt, clock) {
        this.clock = clock;
        for (const device of this.devices) if (device.enabled) device.contractPublisher.update(clock);
    }

    async updateAsync(_dt, clock) {
        this.clock = clock;
        for (const device of this.devices) if (device.enabled) await device.contractPublisher.updateAsync(clock);
    }

    deliver(clock) {
        this.clock = clock;
        for (const device of this.devices) device.contractPublisher.deliver(clock);
    }

    resetRun({ resetSeed = this.seed, episodeLidarPrimitives } = {}) {
        this.seed = String(resetSeed);
        if (this.scene && episodeLidarPrimitives !== undefined) this.scene.setEpisodePrimitives(episodeLidarPrimitives);
        for (const device of this.devices) {
            device.resetRunState({ resetSeed: this.seed });
            device.contractPublisher.reset({ resetSeed: this.seed });
        }
        return this.getDeterministicState();
    }

    getPerceptionObservationRecords(step) {
        return this.devices.map((device) => device.getObservationRecord(step)).filter(Boolean);
    }

    finalizeRun() {
        return this.devices.map((device) => ({ id: device.id, state: device.finalize() }));
    }

    getDeterministicState() {
        return this.devices.map((device) => ({
            id: device.id,
            type: device.type,
            enabled: device.enabled,
            pluginSensor: device.getDeterministicState(),
        })).sort((left, right) => compareUtf8(left.id, right.id));
    }

    disposeRun() {
        for (const device of this.devices) device.dispose();
        this.devices = [];
        this.scene?.dispose();
        this.scene = null;
    }
}
