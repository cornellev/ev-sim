import { PhysicsEngine } from "../../physics/PhysicsEngine.js";
import { ScenarioRuntime } from "../../scenarios/ScenarioRuntime.js";
import { BindingRuntime } from "../../scripting/bindings/BindingRuntime.js";
import { SignalStore } from "../../scripting/runtime/SignalStore.js";
import { createSimulationRuntimeContext } from "../kernel/SimulationRuntimeContext.js";
import { HeadlessSensorManager } from "../sensors/HeadlessSensorManager.js";
import { HeadlessVehicleManager } from "./HeadlessVehicleManager.js";
import { HeadlessWorldRuntime } from "./HeadlessWorldRuntime.js";

function nullLifecycleService() {
    return {
        update() {},
        resetRun() {},
        finalizeRun() { return null; },
        disposeRun() {},
        getDeterministicState() { return null; },
    };
}

/**
 * Build the Node runtime without importing Three.js, GLTF loaders, DOM, canvas,
 * WebGL, or browser storage.
 */
export function createHeadlessRuntimeContext(options = {}) {
    const signalStore = options.signalStore ?? new SignalStore();
    const bindings = options.bindings ?? new BindingRuntime({
        autoLoad: false,
        allowWallTimers: false,
        signalStore,
        loadScript: options.loadScript,
    });
    const world = options.world ?? new HeadlessWorldRuntime();
    const vehicles = options.vehicles ?? new HeadlessVehicleManager();
    const inputs = options.inputs ?? nullLifecycleService();
    const devices = options.devices ?? new HeadlessSensorManager(() => vehicles, {
        telemetry: signalStore,
        rendererClient: options.rendererClient,
    });
    let renderRuntime = null;
    const data = {
        bindings: () => bindings,
        environment: () => world,
        vehicles: () => vehicles,
        devices: () => devices,
        objects: () => ({ boxes: () => [] }),
    };
    const physics = options.physics ?? new PhysicsEngine(data, { loadPhysics: options.loadPhysics });
    const scenarios = options.scenarios ?? new ScenarioRuntime(data, { telemetry: signalStore });
    const context = createSimulationRuntimeContext({
        telemetry: signalStore,
        applyEnvironment: (environment, resolvedRun, worldResource) => {
            return world.prepare(environment, resolvedRun, worldResource);
        },
        resetEnvironment: (runtimeOptions) => world.reset(runtimeOptions),
        finalizeEnvironment: () => world.finalizeRun(),
        disposeEnvironment: () => world.disposeRun(),
        environmentState: () => world.getDeterministicState(),
        inputs,
        scripts: bindings,
        vehicles,
        devices,
        physics,
        scenarios,
        prepareRendering: async (resolvedRun) => {
            const provider = resolvedRun.renderScene?.description?.provider;
            if (provider?.id !== "pbr-mesh" || provider.version !== 1) {
                renderRuntime = null;
                return null;
            }
            if (!options.rendererClient?.preparePbr) {
                throw new Error("Headless PBR requires a supervisor renderer preparation service.");
            }
            renderRuntime = await options.rendererClient.preparePbr({
                vehicles: vehicles.vehicles.map((vehicle) => ({
                    id: vehicle.id,
                    telemetryId: vehicle.telemetryId,
                    position: vehicle.position,
                    rotation: vehicle.rotation,
                })),
            });
            return renderRuntime;
        },
        currentRendering: () => renderRuntime,
        renderingStatus: () => renderRuntime?.status ?? null,
        disposeRendering: async () => {
            if (renderRuntime) await options.rendererClient?.releasePbr?.();
            renderRuntime = null;
        },
    });
    return Object.freeze({
        context,
        data,
        signalStore,
        bindings,
        world,
        vehicles,
        devices,
        physics,
        scenarios,
    });
}
