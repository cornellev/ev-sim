import { createHash } from "node:crypto";

import { SignalStore } from "../../app/scripting/runtime/SignalStore.js";
import { SimulationEngine } from "../../app/simulation/SimulationEngine.js";
import {
    canonicalStringify,
    createDefaultRunManifest,
} from "../../app/simulation/RunManifest.js";

function sha256(value) {
    return createHash("sha256").update(
        typeof value === "string" ? value : canonicalStringify(value)
    ).digest("hex");
}

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Number(number.toFixed(12)) : 0;
}

function createHarness() {
    const calls = [];
    const store = new SignalStore({}, { sourceId: "headless-characterization" });
    const vehicle = {
        telemetryId: "ego",
        position: {
            x: 0,
            y: 0,
            z: 0,
            set(x, y, z) { Object.assign(this, { x, y, z }); },
        },
        rotation: {
            x: 0,
            y: 0,
            z: 0,
            order: "XYZ",
            set(x, y, z, order) { Object.assign(this, { x, y, z, order }); },
        },
        velocity: {
            x: 0,
            y: 0,
            z: 0,
            set(x, y, z) { Object.assign(this, { x, y, z }); },
        },
        acceleration: { x: 0, y: 0, z: 0 },
        steeringAngle: 0,
        updatePosition() {},
        updateRotation() {},
        update(dt) {
            calls.push("vehicle");
            this.position.x += this.velocity.x * dt;
        },
    };
    const runtime = {
        signalStore: store,
        manifest: { enabled: false, bindings: [] },
        setTopicScheduler(handler) { this.scheduler = handler; },
        setTopicRouter() {},
        async setManifest(manifest) { this.manifest = manifest; },
        async prepareResolvedScripts() {},
        applyTopicUpdate(info) {
            calls.push(`input:${info.name}`);
            store.publishSignal(`topics.${info.name}`, info.value);
        },
        update() { calls.push("script"); },
    };
    const devices = {
        configureFromManifest() {},
        resetSchedule() {},
        update() { calls.push("sensor"); },
        deliver() { calls.push("delivery"); },
    };
    const physics = {
        async configureRun() {},
        resetRun() {},
        beginStep() {},
        step() { calls.push("physics"); },
        syncAndPublishContacts() {
            calls.push("contacts");
            return { started: [], active: [], ended: [] };
        },
    };
    const vehicleDatabase = {
        vehicles: [vehicle],
        update: (dt) => vehicle.update(dt),
        async configureFromManifest() {},
    };
    const data = {
        bindings: () => runtime,
        vehicles: () => vehicleDatabase,
        devices: () => devices,
        physics: () => physics,
        keys: () => ({ update: () => calls.push("keys") }),
        client: () => ({ get: () => null }),
        baking: () => null,
        earthTilesManager: () => null,
        skyManager: () => null,
    };
    return {
        calls,
        data,
        engine: new SimulationEngine(data),
        runtime,
        store,
        vehicle,
    };
}

function resolvedRun(manifest) {
    const definitionHash = sha256(manifest);
    const resolved = {
        manifest,
        definitionHash,
        environment: {
            hash: sha256({ environmentId: manifest.environment.id }),
            manifest: { environmentId: manifest.environment.id },
        },
        bindings: { entries: [] },
        scripts: [],
        vehicles: [],
    };
    return {
        ...resolved,
        resolvedHash: sha256(resolved),
    };
}

function queueActions(runtime, actions) {
    for (const action of actions) {
        runtime.scheduler({
            name: action.topic,
            typeStr: action.type,
            producer: action.producer,
            value: structuredClone(action.value),
        });
    }
}

function controlSnapshot(engine) {
    const snapshot = engine.controlRuntime?.getSnapshot?.("ego", {
        applyTimeNs: engine.timeNs,
    }) ?? {};
    return {
        status: snapshot.status ?? null,
        statusCode: snapshot.statusCode ?? null,
        sequence: snapshot.sequence ?? null,
        mode: snapshot.mode ?? null,
        applied: snapshot.applied ? {
            speedMps: finite(snapshot.applied.speedMps),
            steeringRad: finite(snapshot.applied.steeringRad),
            accelerationMps2: finite(snapshot.applied.accelerationMps2),
        } : null,
        achieved: snapshot.achieved ? {
            speedMps: finite(snapshot.achieved.speedMps),
            steeringRad: finite(snapshot.achieved.steeringRad),
            accelerationMps2: finite(snapshot.achieved.accelerationMps2),
        } : null,
    };
}

function stepSnapshot(context, callStart, eventStart) {
    const { calls, engine, store, vehicle } = context;
    const appliedInputs = store.events().slice(eventStart)
        .filter((event) =>
            event.category === "topics"
            && event.name === "input-applied"
            && event.payload?.step === engine.steps
        )
        .map((event) => ({
            sequence: event.payload.sequence,
            topic: event.payload.topic,
        }));
    return {
        step: engine.steps,
        timeNs: engine.timeNs,
        timeSeconds: finite(engine.time),
        phases: [...engine.lastStepPhases],
        runtimeCalls: calls.slice(callStart),
        appliedInputs,
        vehicle: {
            position: {
                x: finite(vehicle.position.x),
                y: finite(vehicle.position.y),
                z: finite(vehicle.position.z),
            },
            velocity: {
                x: finite(vehicle.velocity.x),
                y: finite(vehicle.velocity.y),
                z: finite(vehicle.velocity.z),
            },
            steeringAngle: finite(vehicle.steeringAngle),
        },
        control: controlSnapshot(engine),
        assertions: engine.assertionEngine.snapshot(),
    };
}

function executeTape(context, tape) {
    const actionsByStep = new Map();
    for (const action of tape.actions) {
        const entries = actionsByStep.get(action.step) ?? [];
        entries.push(action);
        actionsByStep.set(action.step, entries);
    }

    const snapshots = [];
    const maxSteps = context.engine.maxSteps ?? tape.manifestOverrides.clock.maxSteps;
    for (let step = 1; step <= maxSteps; step += 1) {
        queueActions(context.runtime, actionsByStep.get(step) ?? []);
        const callStart = context.calls.length;
        const eventStart = context.store.events().length;
        context.engine.step(1);
        snapshots.push(stepSnapshot(context, callStart, eventStart));
    }
    return snapshots;
}

function trajectoryHash(resolvedHash, snapshots) {
    return sha256({ resolvedHash, snapshots });
}

function distanceTravelled(snapshots) {
    let previous = 0;
    let distance = 0;
    for (const snapshot of snapshots) {
        distance += Math.abs(snapshot.vehicle.position.x - previous);
        previous = snapshot.vehicle.position.x;
    }
    return finite(distance);
}

export async function generateHeadlessCharacterization(tape) {
    if (tape?.kind !== "cev-sim.headless.action-tape" || tape?.version !== 1) {
        throw new Error("Expected a cev-sim.headless.action-tape v1 fixture.");
    }
    const orderedSteps = tape.actions.map((action) => action.step);
    if (orderedSteps.some((step, index) =>
        !Number.isInteger(step)
        || step < 1
        || (index > 0 && step < orderedSteps[index - 1])
    )) {
        throw new Error("Action-tape steps must be positive integers in non-decreasing order.");
    }

    const manifest = createDefaultRunManifest(tape.manifestOverrides);
    const resolved = resolvedRun(manifest);
    const context = createHarness();
    await context.engine.applyRunManifest(resolved);
    const snapshots = executeTape(context, tape);

    context.engine.reset();
    const resetSnapshots = executeTape(context, tape);

    const freshContext = createHarness();
    await freshContext.engine.applyRunManifest(resolved);
    const freshSnapshots = executeTape(freshContext, tape);

    const trajectorySha256 = trajectoryHash(resolved.resolvedHash, snapshots);
    const resetTrajectorySha256 = trajectoryHash(resolved.resolvedHash, resetSnapshots);
    const freshTrajectorySha256 = trajectoryHash(resolved.resolvedHash, freshSnapshots);
    const finalSnapshot = snapshots.at(-1);

    return {
        kind: "cev-sim.headless.characterization",
        version: 1,
        id: tape.id,
        sourceRuntime: "app/simulation/SimulationEngine.js",
        run: {
            manifestId: manifest.id,
            definitionHash: resolved.definitionHash,
            resolvedHash: resolved.resolvedHash,
            stepNs: manifest.clock.stepNs,
            maxSteps: manifest.clock.maxSteps,
        },
        phaseOrder: finalSnapshot?.phases ?? [],
        snapshots,
        assertions: finalSnapshot?.assertions ?? [],
        metrics: {
            commandsApplied: snapshots.reduce(
                (total, snapshot) => total + snapshot.appliedInputs.length,
                0
            ),
            distanceTravelledM: distanceTravelled(snapshots),
            finalLongitudinalPositionM: finalSnapshot?.vehicle.position.x ?? 0,
            simulatedTimeNs: finalSnapshot?.timeNs ?? 0,
            totalSteps: finalSnapshot?.step ?? 0,
        },
        verification: {
            resetReplayMatches: resetTrajectorySha256 === trajectorySha256,
            freshRuntimeMatches: freshTrajectorySha256 === trajectorySha256,
        },
        hashes: {
            actionTapeSha256: sha256(tape),
            trajectorySha256,
            resetTrajectorySha256,
            freshTrajectorySha256,
        },
    };
}
