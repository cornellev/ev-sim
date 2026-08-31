function resolve(source) {
    return typeof source === "function" ? source() : source;
}

function manager(source) {
    return resolve(source) ?? null;
}

function vehicleList(source) {
    return manager(source)?.vehicles ?? [];
}

function vector(value = {}) {
    return {
        x: Number(value?.x) || 0,
        y: Number(value?.y) || 0,
        z: Number(value?.z) || 0,
    };
}

function rotation(value = {}) {
    return {
        ...vector(value),
        order: value?.order || "XYZ",
    };
}

function defaultVehicleState(vehicle, index) {
    return {
        id: String(vehicle?.telemetryId || vehicle?.id || `vehicle-${index + 1}`),
        position: vector(vehicle?.position),
        rotation: rotation(vehicle?.rotation),
        velocity: vector(vehicle?.velocity),
        acceleration: vector(vehicle?.acceleration),
        steeringAngle: Number(vehicle?.steeringAngle) || 0,
    };
}

/**
 * Creates the narrow service facade consumed by SimulationKernel. Sources may
 * be concrete managers or accessors so browser managers that are installed
 * after Data construction remain visible without exposing Data to the kernel.
 */
export function createSimulationRuntimeContext(options = {}) {
    const telemetry = options.telemetry
        ?? manager(options.scripts)?.signalStore
        ?? null;

    const context = {
        telemetry,
        environment: {
            prepare(environment, resolvedRun, worldResource) {
                return options.applyEnvironment?.(environment, resolvedRun, worldResource);
            },
            applyResolved(environment, resolvedRun, worldResource) {
                return this.prepare(environment, resolvedRun, worldResource);
            },
            reset(runtimeOptions) {
                return options.resetEnvironment?.(runtimeOptions);
            },
            finalize(runtimeOptions) {
                return options.finalizeEnvironment?.(runtimeOptions) ?? null;
            },
            dispose() {
                return options.disposeEnvironment?.();
            },
            getDeterministicState() {
                return options.environmentState?.() ?? null;
            },
        },
        inputs: {
            update(dt) {
                return manager(options.inputs)?.update?.(dt);
            },
            reset(runtimeOptions) {
                const target = manager(options.inputs);
                if (typeof target?.resetRun === "function") return target.resetRun(runtimeOptions);
                return target?.reset?.(runtimeOptions);
            },
            finalize(runtimeOptions) {
                return manager(options.inputs)?.finalizeRun?.(runtimeOptions) ?? null;
            },
            dispose() {
                return manager(options.inputs)?.disposeRun?.();
            },
            getDeterministicState() {
                return manager(options.inputs)?.getDeterministicState?.() ?? null;
            },
        },
        scripts: {
            setTopicScheduler(handler) {
                return manager(options.scripts)?.setTopicScheduler?.(handler);
            },
            setTopicRouter(router, topics) {
                return manager(options.scripts)?.setTopicRouter?.(router, topics);
            },
            setManifest(manifest, runtimeOptions) {
                return manager(options.scripts)?.setManifest?.(manifest, runtimeOptions);
            },
            prepareResolvedScripts(scripts, runtimeOptions) {
                return manager(options.scripts)?.prepareResolvedScripts?.(scripts, runtimeOptions);
            },
            applyTopicUpdate(info) {
                return manager(options.scripts)?.applyTopicUpdate?.(info);
            },
            update(dt, clock) {
                return manager(options.scripts)?.update?.(dt, clock);
            },
            reset(runtimeOptions) {
                return manager(options.scripts)?.resetRun?.(runtimeOptions);
            },
            finalize(runtimeOptions) {
                return manager(options.scripts)?.finalizeRun?.(runtimeOptions) ?? null;
            },
            dispose() {
                return manager(options.scripts)?.disposeRun?.();
            },
            getDeterministicState() {
                return manager(options.scripts)?.getDeterministicState?.() ?? null;
            },
        },
        vehicles: {
            list() {
                return vehicleList(options.vehicles);
            },
            configureFromManifest(entries, runtimeOptions) {
                return manager(options.vehicles)?.configureFromManifest?.(
                    entries,
                    resolve(options.vehicleScene) ?? null,
                    runtimeOptions,
                );
            },
            update(dt) {
                return manager(options.vehicles)?.update?.(dt);
            },
            reset(initialState = {}, runtimeOptions = {}) {
                const target = manager(options.vehicles);
                if (target?.resetRun) return target.resetRun(initialState, runtimeOptions);
                return this.applyInitialState(initialState);
            },
            finalize(runtimeOptions) {
                return manager(options.vehicles)?.finalizeRun?.(runtimeOptions) ?? null;
            },
            dispose() {
                return manager(options.vehicles)?.disposeRun?.();
            },
            getDeterministicState() {
                const target = manager(options.vehicles);
                if (target?.getDeterministicState) return target.getDeterministicState();
                return vehicleList(options.vehicles)
                    .map(defaultVehicleState)
                    .sort((left, right) => left.id.localeCompare(right.id));
            },
            applyInitialState(initialState = {}) {
                const byId = new Map((initialState.vehicles || []).map((vehicle) => [vehicle.id, vehicle]));
                for (const [index, vehicle] of vehicleList(options.vehicles).entries()) {
                    const configured = byId.get(vehicle.telemetryId) || initialState.vehicles?.[index];
                    if (!configured) continue;
                    if (typeof vehicle.resetRunState === "function") {
                        vehicle.resetRunState(configured);
                        continue;
                    }
                    vehicle.position?.set?.(
                        configured.pose.position.x,
                        configured.pose.position.y,
                        configured.pose.position.z,
                    );
                    vehicle.rotation?.set?.(
                        configured.pose.rotation.x,
                        configured.pose.rotation.y,
                        configured.pose.rotation.z,
                        configured.pose.rotation.order || "XYZ",
                    );
                    vehicle.velocity?.set?.(
                        configured.linearVelocity.x,
                        configured.linearVelocity.y,
                        configured.linearVelocity.z,
                    );
                    vehicle.acceleration?.set?.(
                        Number(configured.linearAcceleration?.x) || 0,
                        Number(configured.linearAcceleration?.y) || 0,
                        Number(configured.linearAcceleration?.z) || 0,
                    );
                    if (Number.isFinite(configured.steeringAngle)) {
                        vehicle.steeringAngle = configured.steeringAngle;
                    }
                    vehicle.updatePosition?.(vehicle.position);
                    vehicle.updateRotation?.(vehicle.rotation);
                }
            },
        },
        devices: {
            list() {
                return manager(options.devices)?.devices ?? [];
            },
            configureFromManifest(sensorRig, runtimeOptions) {
                return manager(options.devices)?.configureFromManifest?.(sensorRig, runtimeOptions);
            },
            resetSchedule() {
                return manager(options.devices)?.resetSchedule?.();
            },
            update(dt, clock) {
                return manager(options.devices)?.update?.(dt, clock);
            },
            updateAsync(dt, clock) {
                const target = manager(options.devices);
                return target?.updateAsync ? target.updateAsync(dt, clock) : target?.update?.(dt, clock);
            },
            deliver(clock) {
                return manager(options.devices)?.deliver?.(clock);
            },
            reset(runtimeOptions) {
                const target = manager(options.devices);
                if (typeof target?.resetRun === "function") return target.resetRun(runtimeOptions);
                return target?.resetSchedule?.(runtimeOptions);
            },
            finalize(runtimeOptions) {
                return manager(options.devices)?.finalizeRun?.(runtimeOptions) ?? null;
            },
            dispose() {
                return manager(options.devices)?.disposeRun?.();
            },
            getDeterministicState() {
                return manager(options.devices)?.getDeterministicState?.() ?? [];
            },
        },
        physics: {
            start() {
                return manager(options.physics)?.start?.();
            },
            stop() {
                return manager(options.physics)?.stop?.();
            },
            configureRun(configuration) {
                return manager(options.physics)?.configureRun?.(configuration);
            },
            resetRun() {
                return manager(options.physics)?.resetRun?.();
            },
            beginStep() {
                return manager(options.physics)?.beginStep?.();
            },
            step(dt) {
                return manager(options.physics)?.step?.(dt);
            },
            syncAndPublishContacts(clock) {
                return manager(options.physics)?.syncAndPublishContacts?.(clock) ?? null;
            },
            finalize(runtimeOptions) {
                return manager(options.physics)?.finalizeRun?.(runtimeOptions) ?? null;
            },
            dispose() {
                const target = manager(options.physics);
                if (typeof target?.disposeRun === "function") return target.disposeRun();
                return target?.dispose?.();
            },
            getDeterministicState() {
                return manager(options.physics)?.getDeterministicState?.() ?? null;
            },
        },
        scenarios: options.scenarios ?? null,
        controls: {
            applySetpoints(appliedMap) {
                if (!appliedMap) return;
                const vehicles = vehicleList(options.vehicles);
                for (const [vehicleId, setpoint] of appliedMap) {
                    if (!setpoint || setpoint.passthrough) continue;
                    const vehicle = vehicles.find((candidate) => candidate.telemetryId === vehicleId)
                        ?? (vehicleId === "ego" ? vehicles[0] : null);
                    if (!vehicle) continue;
                    if (vehicle.velocity) vehicle.velocity.x = setpoint.speedMps;
                    vehicle.steeringAngle = setpoint.steeringRadThree;
                }
            },
            sampleAchieved(controlRuntime, { targetVehicleId = "ego", step = 0, timeNs = 0 } = {}) {
                if (!controlRuntime) return;
                const vehicles = vehicleList(options.vehicles);
                const vehicle = vehicles.find((candidate) => candidate.telemetryId === targetVehicleId)
                    ?? vehicles[0];
                if (!vehicle) return;
                controlRuntime.sampleAchieved(targetVehicleId, {
                    speedMps: Number(vehicle.velocity?.x) || 0,
                    steeringRadThree: Number(vehicle.steeringAngle) || 0,
                    accelerationMps2: Number(vehicle.acceleration?.x) || 0,
                });
                controlRuntime._publishSnapshot(
                    controlRuntime.getSnapshot(targetVehicleId, { applyTimeNs: timeNs }),
                    step,
                    timeNs,
                );
            },
        },
        topics: {
            client() {
                return resolve(options.topicClient) ?? null;
            },
        },
    };

    return Object.freeze(context);
}
