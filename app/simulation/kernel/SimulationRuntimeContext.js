function resolve(source) {
    return typeof source === "function" ? source() : source;
}

function manager(source) {
    return resolve(source) ?? null;
}

function vehicleList(source) {
    return manager(source)?.vehicles ?? [];
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
            applyResolved(environment, resolvedRun) {
                return options.applyEnvironment?.(environment, resolvedRun);
            },
        },
        inputs: {
            update(dt) {
                return manager(options.inputs)?.update?.(dt);
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
            applyInitialState(initialState = {}) {
                const byId = new Map((initialState.vehicles || []).map((vehicle) => [vehicle.id, vehicle]));
                for (const [index, vehicle] of vehicleList(options.vehicles).entries()) {
                    const configured = byId.get(vehicle.telemetryId) || initialState.vehicles?.[index];
                    if (!configured) continue;
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
            deliver(clock) {
                return manager(options.devices)?.deliver?.(clock);
            },
        },
        physics: {
            start() {
                return manager(options.physics)?.start?.();
            },
            stop() {
                return manager(options.physics)?.stop?.();
            },
            configureRun(manifest, environmentManifest) {
                return manager(options.physics)?.configureRun?.(manifest, environmentManifest);
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
