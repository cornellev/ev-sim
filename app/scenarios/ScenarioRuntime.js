import { createLoadedScript } from "../scripting/ScriptRuntime.js";
import {
    distanceToRouteEnd,
    projectPoseToRoute,
    sampleRoute,
} from "./route/index.js";
import {
    SCENARIO_SCRIPT_CONTRACTS,
    invokeBooleanScript,
    scriptRuntimeContext,
} from "./ScriptContracts.js";

const EPSILON = 1e-9;

function clone(value) {
    if (value === undefined) return undefined;
    return typeof structuredClone === "function"
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function finite(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function sortedById(entries = []) {
    return [...entries].sort((left, right) => String(left?.id || "").localeCompare(String(right?.id || "")));
}

function point(value = {}) {
    const source = value?.position ?? value;
    return {
        x: finite(source?.x),
        y: finite(source?.y),
        z: finite(source?.z),
    };
}

function distance(left, right) {
    const a = point(left);
    const b = point(right);
    return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function inZone(position, zone) {
    const p = point(position);
    const center = point(zone?.center);
    const size = point(zone?.size);
    return Math.abs(p.x - center.x) <= size.x / 2 + EPSILON
        && Math.abs(p.y - center.y) <= size.y / 2 + EPSILON
        && Math.abs(p.z - center.z) <= size.z / 2 + EPSILON;
}

function compare(actual, operator, expected) {
    switch (operator) {
        case "neq": return actual !== expected;
        case "lt": return actual < expected;
        case "lte": return actual <= expected;
        case "gt": return actual > expected;
        case "gte": return actual >= expected;
        case "eq":
        default: return actual === expected;
    }
}

function flagPath(flag) {
    const name = String(flag || "").trim();
    if (!name) return "";
    return name.startsWith("scenario.") ? name : `scenario.flags.${name}`;
}

function normalizeAngle(value) {
    let result = finite(value);
    while (result > Math.PI) result -= Math.PI * 2;
    while (result < -Math.PI) result += Math.PI * 2;
    return result;
}

function outputLabel(mapping = {}) {
    return mapping.output ?? mapping.source ?? mapping.port ?? mapping.label ?? mapping.name;
}

function outputTarget(mapping = {}) {
    return mapping.target ?? mapping.command;
}

function isErrorAssertion(result) {
    return result?.status === "failed" && result?.severity === "error";
}

/**
 * Per-run deterministic scenario state machine. It deliberately owns no RAF or
 * timers: both phases are driven by SimulationEngine fixed-step boundaries.
 */
export class ScenarioRuntime {
    constructor(data = null, options = {}) {
        this.data = data;
        this.telemetry = options.telemetry ?? data?.bindings?.()?.signalStore ?? null;
        this.scriptFactory = options.scriptFactory ?? ((artifact, scriptOptions) => createLoadedScript(artifact, scriptOptions));
        this.listeners = new Set();
        this.resolvedRun = null;
        this.scenario = null;
        this.active = false;
        this._scriptEntries = [];
        this._defineSignals();
        this._clearState();
    }

    _defineSignals() {
        const define = (path, options) => this.telemetry?.defineSignal?.({
            path,
            source: "scenario",
            category: "scenario",
            replayRole: "state",
            logClass: "core",
            ...options,
        });
        define("scenario.status", { type: "string" });
        define("scenario.latestTrigger", { type: "json" });
        define("scenario.nextTimedEvent", { type: "json" });
        define("scenario.outcomes", { type: "json" });
        define("scenario.terminal", { type: "json" });
    }

    _clearState() {
        this.step = 0;
        this.timeNs = 0;
        this.triggered = new Set();
        this.triggerCounts = new Map();
        this.triggeredThisStep = new Set();
        this.zoneOccupancy = new Map();
        this.visitedZones = new Set();
        this.flags = new Map();
        this.latestTrigger = null;
        this.terminal = null;
        this.collisionCount = 0;
        this.egoCollisionCount = 0;
        this.effects = [];
        this.effectSequence = 0;
        this.controllerCommands = new Map();
        this.sensorBaselines = new Map();
        this.runners = new Map();
        this.scriptParameterInputs = new Map();
        this.scriptErrors = [];
        this.outcomes = [];
        this._finalized = null;
    }

    configure(resolvedRun) {
        this._restoreSensorBaselines();
        this._resetScenarioSignals(this.scenario);
        // Resolved artifacts are treated as immutable. Keep the reference so
        // tests and embedders may supply executable script adapters, which are
        // intentionally not structured-cloneable.
        this.resolvedRun = resolvedRun ?? null;
        this.scenario = this.resolvedRun?.scenario?.scenario
            ?? (this.resolvedRun?.scenario?.kind === "cev-sim.scenario" ? this.resolvedRun.scenario : null);
        this.active = Boolean(this.scenario);
        this._scriptEntries = this.resolvedRun?.scripts ?? this.resolvedRun?.scenario?.scripts ?? [];
        this.reset({ clearSignals: false });
        return this.getSnapshot();
    }

    reset({ clearSignals = true } = {}) {
        this._restoreSensorBaselines();
        if (clearSignals) this._resetScenarioSignals(this.scenario);
        this._clearState();
        if (!this.active) return;
        this.outcomes = (this.scenario.expectedOutcomes ?? []).map((outcome) => ({
            id: outcome.id,
            name: outcome.name,
            kind: outcome.kind,
            required: true,
            status: "pending",
            passed: null,
            detail: null,
        }));
        this._captureSensorBaselines();
        this._buildRunners();
        this._applyParameterSignals();
        this._publish();
        this._emit();
    }

    _resetScenarioSignals(scenario) {
        if (!scenario || !this.telemetry?.removeSignal) return;
        const paths = new Set();
        const addFlag = (value) => {
            const path = flagPath(value);
            if (path) paths.add(path);
        };
        for (const route of scenario.routes ?? []) addFlag(route.controller?.activation?.flag);
        for (const trigger of scenario.triggers ?? []) {
            addFlag(trigger.condition?.flag);
            for (const action of trigger.actions ?? []) {
                addFlag(action.flag);
                if (action.kind === "set-signal" && action.path) paths.add(action.path);
            }
        }
        for (const outcome of scenario.expectedOutcomes ?? []) addFlag(outcome.flag);
        for (const parameter of scenario.parameters ?? []) {
            if (["scenario-signal", "signal"].includes(parameter.target?.kind) && parameter.target.path) {
                paths.add(parameter.target.path);
            }
        }
        for (const path of paths) this.telemetry.removeSignal(path);
    }

    dispose() {
        this.listeners.clear();
        this.configure(null);
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    _emit() {
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) listener(snapshot);
    }

    getSnapshot() {
        return {
            active: this.active,
            scenarioId: this.scenario?.id ?? null,
            step: this.step,
            timeNs: this.timeNs,
            status: !this.active ? "inactive" : this.terminal ? this.terminal.status : "running",
            latestTrigger: clone(this.latestTrigger),
            nextTimedEvent: clone(this._nextTimedEvent()),
            terminal: clone(this.terminal),
            flags: Object.fromEntries([...this.flags.entries()].sort(([left], [right]) => left.localeCompare(right))),
            outcomes: clone(this.outcomes),
            collisionCount: this.collisionCount,
            egoCollisionCount: this.egoCollisionCount,
            activeEffects: this.effects.map((effect) => ({
                id: effect.id,
                kind: effect.kind,
                actorId: effect.actorId ?? null,
                sensorAlias: effect.sensorAlias ?? null,
                dropoutProbability: effect.kind === "sensor-state" ? effect.dropoutProbability : null,
                expiresAtNs: effect.expiresAtNs,
            })),
            scriptErrors: clone(this.scriptErrors),
        };
    }

    _timeOptions(source = "scenario") {
        return {
            timeUs: Math.round(this.timeNs / 1000),
            cycle: this.step,
            source,
            category: "scenario",
            replayRole: "state",
            logClass: "core",
        };
    }

    _publish() {
        if (!this.active || !this.telemetry) return;
        const options = this._timeOptions();
        this.telemetry.publishSignal?.("scenario.status", this.terminal?.status ?? "running", { ...options, type: "string" });
        this.telemetry.publishSignal?.("scenario.latestTrigger", this.latestTrigger, { ...options, type: "json" });
        this.telemetry.publishSignal?.("scenario.nextTimedEvent", this._nextTimedEvent(), { ...options, type: "json" });
        this.telemetry.publishSignal?.("scenario.outcomes", this.outcomes, { ...options, type: "json" });
        this.telemetry.publishSignal?.("scenario.terminal", this.terminal, { ...options, type: "json" });
    }

    _event(name, payload = {}, severity = "info") {
        return this.telemetry?.emitTelemetryEvent?.({
            timeUs: Math.round(this.timeNs / 1000),
            category: "scenario",
            name,
            severity,
            payload: { scenarioId: this.scenario?.id, step: this.step, ...payload },
        });
    }

    _buildRunners() {
        const entries = sortedById(this._scriptEntries.map((entry) => ({ ...entry, id: entry.scriptId ?? entry.id })));
        for (const entry of entries) {
            const scriptId = entry.scriptId ?? entry.id;
            try {
                const runner = entry.runtime ?? entry.script ?? this.scriptFactory(entry.artifact, {
                    signalStore: this.telemetry,
                    runtimeContext: scriptRuntimeContext(this.resolvedRun?.manifest?.seed, `scenario:${scriptId}`),
                });
                this.runners.set(scriptId, runner);
            } catch (error) {
                this._recordScriptError(scriptId, error, "configure");
            }
        }
    }

    _applyParameterSignals() {
        const bindings = [
            ...(this.resolvedRun?.parameters?.manifest?.bindings ?? []),
            ...(this.resolvedRun?.parameters?.scenario?.bindings ?? this.resolvedRun?.scenario?.parameters?.bindings ?? []),
        ];
        for (const binding of bindings) {
            const target = binding.target ?? {};
            if (["scenario-signal", "signal"].includes(target.kind) && target.path) {
                this.telemetry?.publishSignal?.(target.path, binding.value, {
                    ...this._timeOptions("scenario-parameter"),
                    type: binding.type,
                    replayRole: "input",
                });
                if (String(target.path).startsWith("scenario.")) this.flags.set(target.path, binding.value);
            } else if (target.kind === "script-input" && target.scriptId && target.input) {
                const inputs = this.scriptParameterInputs.get(target.scriptId) ?? {};
                inputs[target.input] = clone(binding.value);
                this.scriptParameterInputs.set(target.scriptId, inputs);
            }
        }
    }

    _captureSensorBaselines() {
        for (const device of this.data?.devices?.()?.devices ?? []) {
            if (!device.telemetryId) continue;
            this.sensorBaselines.set(device.telemetryId, {
                enabled: Boolean(device.enabled),
                dropoutProbability: finite(device.config?.noise?.dropoutProbability, 0),
            });
        }
    }

    _restoreSensorBaselines() {
        if (!this.sensorBaselines) return;
        for (const device of this.data?.devices?.()?.devices ?? []) {
            const baseline = this.sensorBaselines.get(device.telemetryId);
            if (!baseline) continue;
            if (typeof device.setEnabled === "function") device.setEnabled(baseline.enabled);
            else device.enabled = baseline.enabled;
            if (device.config?.noise) device.config.noise.dropoutProbability = baseline.dropoutProbability;
        }
    }

    _vehicles() {
        return this.data?.vehicles?.()?.vehicles ?? [];
    }

    _vehicle(actorId) {
        return this._vehicles().find((vehicle) => vehicle.telemetryId === actorId)
            ?? (actorId === "ego" ? this._vehicles()[0] : null);
    }

    _route(actorId) {
        return this.scenario?.routes?.find((route) => route.actorId === actorId) ?? null;
    }

    _flag(flag) {
        const path = flagPath(flag);
        if (!path) return false;
        const entry = this.telemetry?.read?.(path);
        if (entry?.exists) return Boolean(entry.value);
        return Boolean(this.flags.get(path));
    }

    setFlag(flag, value) {
        const path = flagPath(flag);
        if (!path) return false;
        const normalized = Boolean(value);
        this.flags.set(path, normalized);
        this.telemetry?.publishSignal?.(path, normalized, { ...this._timeOptions(), type: "boolean" });
        return normalized;
    }

    preMotion({ step, timeNs, dt } = {}) {
        if (!this.active || this.terminal) return this.getSnapshot();
        this.step = Math.max(0, Math.floor(finite(step, this.step + 1)));
        this.timeNs = Math.max(0, Math.floor(finite(timeNs, this.timeNs)));
        this.triggeredThisStep.clear();
        this._expireEffects();
        this._evaluateTriggers(new Set(["time", "step"]));
        this._runControllers(finite(dt, 0));
        this._applyActorEffects();
        this._applySensorEffects();
        this._publish();
        this._emit();
        return this.getSnapshot();
    }

    postTelemetry({ step, timeNs, dt, contacts = null } = {}) {
        if (!this.active) return this.getSnapshot();
        this.step = Math.max(0, Math.floor(finite(step, this.step)));
        this.timeNs = Math.max(0, Math.floor(finite(timeNs, this.timeNs)));
        this._observeContacts(contacts);
        if (!this.terminal) {
            const transitions = this._zoneTransitions();
            this._evaluateTriggers(new Set(["zone-enter", "zone-exit", "signal", "flag", "actor-distance"]), transitions);
            this._evaluateCompletion(finite(dt, 0));
        }
        this._publish();
        this._emit();
        return this.getSnapshot();
    }

    observeAssertions(results = []) {
        if (!this.active || this.terminal) return this.getSnapshot();
        const fatal = results.find(isErrorAssertion);
        if (fatal && this.scenario.completion?.conditions?.some((condition) => condition.kind === "fatal-assertion")) {
            this._terminate({
                reason: "fatal-assertion",
                sourceId: fatal.id ?? null,
                detail: fatal.message ?? fatal.id ?? "A fatal assertion failed.",
            });
        }
        return this.getSnapshot();
    }

    applyExternalTopic(info = {}) {
        if (!this.active) return false;
        const topic = this.resolvedRun?.manifest?.topics?.find((entry) => entry.name === info.name || entry.id === info.name);
        const route = this.scenario.routes.find((candidate) => (
            candidate.controller?.kind === "external-ros"
            && (candidate.controller.topicId === topic?.id || candidate.controller.topicId === info.name)
        ));
        if (!route) return false;
        if (!this._controllerActive(route.controller)) {
            // A matching scenario topic is still consumed while its controller
            // is inactive. Clear any prior external command so a rejected
            // packet cannot move the actor now or become live after re-enable.
            this._setControllerCommand(route.actorId, 0, 0);
            return true;
        }
        const value = info.value ?? {};
        const legacy = route.actorId === "ego" && info.name === "/ackdrive";
        const speed = value.speedMps ?? value.speed_mps ?? (legacy ? finite(value.speed) * 0.44704 : value.speed);
        const steering = value.steeringRad ?? value.steering_rad
            ?? (value.steering_angle !== undefined ? finite(value.steering_angle) * Math.PI / 180 : value.steering);
        this._setControllerCommand(route.actorId, finite(speed), -finite(steering));
        return true;
    }

    _controllerActive(controller = {}) {
        return controller.activation?.kind !== "flag" || this._flag(controller.activation.flag);
    }

    _runControllers(dt) {
        for (const route of this.scenario.routes ?? []) {
            const controller = route.controller ?? {};
            const active = this._controllerActive(controller);
            if (!active) {
                this._setControllerCommand(route.actorId, 0, 0);
                continue;
            }
            if (controller.kind === "route-follower") this._followRoute(route, dt);
            else if (["script", "script-with-route"].includes(controller.kind)) this._runControllerScript(route, dt);
            else if (controller.kind === "external-ros") this._reapplyControllerCommand(route.actorId);
        }
    }

    _followRoute(route) {
        const vehicle = this._vehicle(route.actorId);
        if (!vehicle) return;
        const projection = projectPoseToRoute(route, vehicle.position);
        const totalLength = finite(route.totalLength ?? route.verification?.totalLength, 0);
        const lookaheadMeters = Math.max(1.5, Math.abs(finite(route.initialSpeedMps)) * 0.6);
        const progress = Math.min(1, finite(projection?.progress) + (totalLength > EPSILON ? lookaheadMeters / totalLength : 1));
        const target = sampleRoute(route, progress) ?? route.waypoints?.at(-1)?.position;
        if (!target) return;
        const dx = finite(target.x) - finite(vehicle.position?.x);
        const dz = finite(target.z) - finite(vehicle.position?.z);
        const desiredYaw = -Math.atan2(dz, dx);
        const yaw = finite(vehicle.rotation?.y);
        const steering = Math.max(-0.65, Math.min(0.65, normalizeAngle(desiredYaw - yaw) * 0.9));
        const remaining = distanceToRouteEnd(route, vehicle.position);
        const speed = remaining <= 0.15 ? 0 : finite(route.initialSpeedMps);
        this._setControllerCommand(route.actorId, speed, steering);
    }

    _runControllerScript(route, dt) {
        const controller = route.controller ?? {};
        const runner = this.runners.get(controller.scriptId);
        if (!runner) {
            this._scriptFailure(controller.scriptId, new Error("The controller script is unavailable."), `controller:${route.id}`);
            return;
        }
        const vehicle = this._vehicle(route.actorId);
        const projection = projectPoseToRoute(route, vehicle?.position);
        const inputs = {
            time: this.timeNs / 1e9,
            dt,
            step: this.step,
            percent: finite(projection?.progress),
        };
        if (controller.kind === "script-with-route") inputs.route = clone(route);
        for (const mapping of controller.inputs ?? []) {
            const label = mapping.input ?? mapping.target ?? mapping.port ?? mapping.label;
            if (!label) continue;
            if (mapping.source === "signal" && mapping.path) inputs[label] = this.telemetry?.read?.(mapping.path)?.value;
            else if (mapping.source === "constant") inputs[label] = clone(mapping.value);
            else if (mapping.source === "route") inputs[label] = clone(route);
        }
        Object.assign(inputs, clone(this.scriptParameterInputs.get(controller.scriptId) ?? {}));
        try {
            const outputs = runner.run(inputs);
            let speed = 0;
            let steering = 0;
            for (const mapping of controller.outputs ?? []) {
                const value = outputs?.[outputLabel(mapping)];
                if (outputTarget(mapping) === "speed") speed = finite(value);
                if (outputTarget(mapping) === "steering") steering = finite(value);
            }
            this._setControllerCommand(route.actorId, speed, steering);
        } catch (error) {
            this._scriptFailure(controller.scriptId, error, `controller:${route.id}`);
        }
    }

    _applyVehicleCommand(actorId, speedMps, steeringRad) {
        const vehicle = this._vehicle(actorId);
        if (!vehicle) return false;
        if (vehicle.velocity) vehicle.velocity.x = finite(speedMps);
        vehicle.steeringAngle = finite(steeringRad);
        return true;
    }

    _latestActorEffect(actorId) {
        let latest = null;
        for (const effect of this.effects) {
            if (effect.kind === "actor-command" && effect.actorId === actorId) latest = effect;
        }
        return latest;
    }

    _setControllerCommand(actorId, speedMps, steeringRad) {
        const command = {
            speedMps: finite(speedMps),
            steeringRad: finite(steeringRad),
        };
        this.controllerCommands.set(actorId, command);
        if (this._latestActorEffect(actorId)) return true;
        return this._applyVehicleCommand(actorId, command.speedMps, command.steeringRad);
    }

    _reapplyControllerCommand(actorId) {
        if (this._latestActorEffect(actorId)) return true;
        const command = this.controllerCommands.get(actorId) ?? { speedMps: 0, steeringRad: 0 };
        return this._applyVehicleCommand(actorId, command.speedMps, command.steeringRad);
    }

    _expireEffects() {
        const previousLength = this.effects.length;
        this.effects = this.effects.filter((effect) => effect.expiresAtNs === null || effect.expiresAtNs > this.timeNs);
        if (this.effects.length !== previousLength) {
            this._applySensorEffects();
            this._event("disturbance-expired", { activeCount: this.effects.length });
        }
    }

    _addEffect(action, trigger) {
        const durationNs = Math.max(0, Math.floor(finite(action.durationNs)));
        const effect = {
            id: `effect-${++this.effectSequence}`,
            sequence: this.effectSequence,
            triggerId: trigger.id,
            kind: action.kind,
            actorId: action.actorId,
            sensorAlias: action.sensorAlias,
            speedMps: finite(action.speedMps),
            steeringRad: finite(action.steeringRad),
            enabled: action.enabled !== false,
            dropoutProbability: Math.max(0, Math.min(1, finite(action.dropoutProbability))),
            expiresAtNs: durationNs > 0 ? this.timeNs + durationNs : null,
        };
        this.effects.push(effect);
        this._event("disturbance-applied", { effect });
        return effect;
    }

    _applyActorEffects() {
        const latest = new Map();
        for (const effect of this.effects) {
            if (effect.kind === "actor-command") latest.set(effect.actorId, effect);
        }
        for (const effect of latest.values()) {
            this._applyVehicleCommand(effect.actorId, effect.speedMps, effect.steeringRad);
        }
    }

    _sensorId(alias) {
        return this.resolvedRun?.manifest?.scenario?.sensorBindings?.[alias] ?? alias;
    }

    _applySensorEffects() {
        const latest = new Map();
        for (const effect of this.effects) {
            if (effect.kind === "sensor-state") latest.set(this._sensorId(effect.sensorAlias), effect);
        }
        for (const device of this.data?.devices?.()?.devices ?? []) {
            const id = device.telemetryId;
            if (!id) continue;
            const effect = latest.get(id);
            const baseline = this.sensorBaselines.get(id) ?? {
                enabled: Boolean(device.enabled),
                dropoutProbability: finite(device.config?.noise?.dropoutProbability, 0),
            };
            const enabled = effect ? effect.enabled : baseline.enabled;
            if (typeof device.setEnabled === "function") device.setEnabled(enabled);
            else device.enabled = enabled;
            if (device.config?.noise) {
                device.config.noise.dropoutProbability = effect
                    ? effect.dropoutProbability
                    : baseline.dropoutProbability;
            }
        }
    }

    _evaluateTriggers(kinds, transitions = new Map()) {
        const triggers = this.scenario.triggers ?? [];
        for (const trigger of triggers) {
            if (this.terminal || trigger.enabled === false || !kinds.has(trigger.condition?.kind)) continue;
            if (trigger.once !== false && this.triggered.has(trigger.id)) continue;
            if (!this._condition(trigger.condition, transitions)) continue;
            this._fireTrigger(trigger);
        }
    }

    _condition(condition = {}, transitions) {
        if (condition.kind === "time") return this.timeNs >= Math.max(0, finite(condition.timeNs));
        if (condition.kind === "step") return this.step >= Math.max(0, Math.floor(finite(condition.step)));
        if (condition.kind === "zone-enter" || condition.kind === "zone-exit") {
            return transitions.get(`${condition.actorId}|${condition.zoneId}`)?.[condition.kind === "zone-enter" ? "entered" : "exited"] === true;
        }
        if (condition.kind === "flag") return compare(this._flag(condition.flag), condition.operator, condition.expected);
        if (condition.kind === "signal") {
            const entry = this.telemetry?.read?.(condition.path);
            return Boolean(entry?.exists) && compare(entry.value, condition.operator, condition.expected);
        }
        if (condition.kind === "actor-distance") {
            const first = this._vehicle(condition.actorId);
            const second = this._vehicle(condition.otherActorId);
            return Boolean(first && second) && distance(first.position, second.position) < finite(condition.thresholdM);
        }
        return false;
    }

    _fireTrigger(trigger) {
        this.triggered.add(trigger.id);
        this.triggeredThisStep.add(trigger.id);
        const count = (this.triggerCounts.get(trigger.id) ?? 0) + 1;
        this.triggerCounts.set(trigger.id, count);
        this.latestTrigger = {
            id: trigger.id,
            name: trigger.name,
            condition: trigger.condition?.kind ?? null,
            step: this.step,
            timeNs: this.timeNs,
            count,
        };
        this._event("trigger-fired", this.latestTrigger);
        for (const action of trigger.actions ?? []) {
            if (this.terminal && action.kind !== "finish") break;
            this._applyAction(action, trigger);
        }
    }

    _applyAction(action, trigger) {
        if (action.kind === "finish") {
            this._terminate({ reason: "trigger", sourceId: trigger.id, detail: trigger.name });
        } else if (action.kind === "set-flag") {
            this.setFlag(action.flag, action.value);
        } else if (action.kind === "set-signal") {
            this.telemetry?.publishSignal?.(action.path, action.value, this._timeOptions());
        } else if (action.kind === "run-script") {
            try {
                this._invokeScript(action.scriptId, { time: this.timeNs / 1e9, step: this.step });
            } catch (error) {
                this._scriptFailure(action.scriptId, error, `trigger:${trigger.id}`, action.onError);
            }
        } else if (["actor-command", "sensor-state"].includes(action.kind)) {
            this._addEffect(action, trigger);
            this._applyActorEffects();
            this._applySensorEffects();
        }
    }

    _zoneTransitions() {
        const transitions = new Map();
        for (const actor of this.scenario.actors ?? []) {
            const vehicle = this._vehicle(actor.id);
            if (!vehicle) continue;
            for (const zone of this.scenario.zones ?? []) {
                const key = `${actor.id}|${zone.id}`;
                const previous = this.zoneOccupancy.get(key) ?? false;
                const current = inZone(vehicle.position, zone);
                this.zoneOccupancy.set(key, current);
                const entered = current && !previous;
                const exited = !current && previous;
                if (entered && actor.id === "ego") this.visitedZones.add(zone.id);
                transitions.set(key, { previous, current, entered, exited });
            }
        }
        return transitions;
    }

    _observeContacts(contacts) {
        const started = [...(contacts?.started ?? [])].sort();
        this.collisionCount += started.length;
        for (const key of started) {
            if (String(key).split("|").includes("ego")) this.egoCollisionCount += 1;
        }
    }

    _evaluateCompletion() {
        for (const condition of this.scenario.completion?.conditions ?? []) {
            if (this.terminal) break;
            if (condition.kind === "max-duration" && this.timeNs >= finite(condition.durationNs)) {
                this._terminate({ reason: "max-duration", sourceId: condition.id, detail: condition.name });
            } else if (condition.kind === "ego-collision" && this.egoCollisionCount > 0) {
                this._terminate({ reason: "ego-collision", sourceId: condition.id, detail: condition.name });
            } else if (condition.kind === "script" && this._completionScriptDue(condition)) {
                try {
                    if (invokeBooleanScript(
                        this._requiredRunner(condition.scriptId),
                        SCENARIO_SCRIPT_CONTRACTS.FINISH,
                        this.timeNs / 1e9,
                        this.scriptParameterInputs.get(condition.scriptId),
                    )) {
                        this._terminate({ reason: "finish-predicate", sourceId: condition.id, detail: condition.name });
                    }
                } catch (error) {
                    this._scriptFailure(condition.scriptId, error, `completion:${condition.id}`, condition.onError);
                }
            }
        }
    }

    _completionScriptDue(condition) {
        const cadence = condition.cadence ?? { kind: "every-step", everyN: 1 };
        if (cadence.kind === "trigger") return this.triggeredThisStep.has(cadence.triggerId);
        if (cadence.kind === "every-n-steps") return this.step % Math.max(1, Math.floor(finite(cadence.everyN, 1))) === 0;
        return true;
    }

    _requiredRunner(scriptId) {
        const runner = this.runners.get(scriptId);
        if (!runner) throw new Error(`Visual script "${scriptId}" is unavailable.`);
        return runner;
    }

    _invokeScript(scriptId, inputs) {
        return this._requiredRunner(scriptId).run({
            ...inputs,
            ...clone(this.scriptParameterInputs.get(scriptId) ?? {}),
        });
    }

    _recordScriptError(scriptId, error, context) {
        const record = {
            scriptId: scriptId ?? null,
            context,
            message: error?.message ?? String(error),
            step: this.step,
            timeNs: this.timeNs,
        };
        this.scriptErrors.push(record);
        this._event("script-error", record, "error");
        return record;
    }

    _scriptFailure(scriptId, error, context, onError = "fail") {
        const record = this._recordScriptError(scriptId, error, context);
        if (onError !== "continue") {
            this._terminate({
                reason: "script-error",
                sourceId: scriptId ?? null,
                detail: record.message,
                status: "error",
            });
        }
    }

    _terminate({ reason, sourceId = null, detail = null, status = "completed" }) {
        if (this.terminal) return this.terminal;
        this.terminal = {
            status,
            completed: status === "completed",
            reason,
            sourceId,
            detail,
            step: this.step,
            timeNs: this.timeNs,
            latestTrigger: clone(this.latestTrigger),
        };
        this._event("scenario-terminal", this.terminal, status === "error" ? "error" : "info");
        this._publish();
        return this.terminal;
    }

    _nextTimedEvent() {
        if (!this.active) return null;
        const candidates = (this.scenario.triggers ?? [])
            .filter((trigger) => trigger.enabled !== false
                && trigger.condition?.kind === "time"
                && !(trigger.once !== false && this.triggered.has(trigger.id))
                && finite(trigger.condition.timeNs) >= this.timeNs)
            .sort((left, right) => finite(left.condition.timeNs) - finite(right.condition.timeNs)
                || String(left.id).localeCompare(String(right.id)));
        const trigger = candidates[0];
        return trigger ? { id: trigger.id, name: trigger.name, timeNs: finite(trigger.condition.timeNs) } : null;
    }

    finalize({ step = this.step, timeNs = this.timeNs, assertions = [] } = {}) {
        if (!this.active) return null;
        if (this._finalized) return clone(this._finalized);
        this.step = Math.max(0, Math.floor(finite(step, this.step)));
        this.timeNs = Math.max(0, Math.floor(finite(timeNs, this.timeNs)));
        const definitions = new Map((this.scenario.expectedOutcomes ?? []).map((outcome) => [outcome.id, outcome]));
        this.outcomes = this.outcomes.map((entry) => {
            const definition = definitions.get(entry.id);
            try {
                const result = this._evaluateOutcome(definition);
                return { ...entry, status: result.passed ? "passed" : "failed", passed: result.passed, detail: result.detail ?? null };
            } catch (error) {
                const diagnostic = definition?.onError === "continue";
                this._recordScriptError(definition?.scriptId, error, `outcome:${entry.id}`);
                return {
                    ...entry,
                    status: diagnostic ? "diagnostic-error" : "failed",
                    passed: diagnostic,
                    detail: error.message,
                };
            }
        });
        const assertionFailures = assertions.filter(isErrorAssertion);
        const requiredOutcomeFailures = this.outcomes.filter((outcome) => outcome.passed !== true);
        const completed = Boolean(this.terminal?.completed);
        const finalDistance = this._finalWaypointDistance("ego", null);
        const passed = completed && requiredOutcomeFailures.length === 0 && assertionFailures.length === 0;
        this._finalized = {
            completed,
            passed,
            status: this.terminal?.status ?? "interrupted",
            terminationReason: this.terminal?.reason ?? "run-stopped",
            terminalEvent: clone(this.terminal),
            latestTrigger: clone(this.latestTrigger),
            outcomes: clone(this.outcomes),
            metrics: {
                completed: completed ? 1 : 0,
                passed: passed ? 1 : 0,
                duration: this.timeNs / 1e9,
                "collision-count": this.collisionCount,
                "final-waypoint-distance": Number.isFinite(finalDistance) ? finalDistance : null,
                "assertion-failures": assertionFailures.length,
                "expected-outcome-failures": requiredOutcomeFailures.length,
            },
            step: this.step,
            timeNs: this.timeNs,
        };
        this._publish();
        this._emit();
        return clone(this._finalized);
    }

    _evaluateOutcome(outcome = {}) {
        if (outcome.kind === "finish-zone") {
            const finishZoneIds = outcome.zoneId
                ? [outcome.zoneId]
                : (this.scenario.triggers ?? [])
                    .filter((trigger) => trigger.condition?.kind === "zone-enter"
                        && trigger.condition.actorId === "ego"
                        && trigger.actions?.some((action) => action.kind === "finish"))
                    .map((trigger) => trigger.condition.zoneId);
            const passed = finishZoneIds.some((zoneId) => this.visitedZones.has(zoneId));
            return { passed, detail: passed ? null : "Ego did not reach a finish zone." };
        }
        if (outcome.kind === "no-collisions") {
            return { passed: this.collisionCount === 0, detail: `${this.collisionCount} collision transition(s).` };
        }
        if (outcome.kind === "final-waypoint-distance") {
            const value = this._finalWaypointDistance(outcome.actorId, outcome.routeId);
            return { passed: value <= finite(outcome.thresholdM), detail: `${value} m from the final waypoint.` };
        }
        if (outcome.kind === "flag-true") {
            const passed = this._flag(outcome.flag);
            return { passed, detail: passed ? null : `Flag "${outcome.flag}" is false.` };
        }
        if (outcome.kind === "script") {
            const passed = invokeBooleanScript(
                this._requiredRunner(outcome.scriptId),
                SCENARIO_SCRIPT_CONTRACTS.EXPECTED_OUTCOME,
                this.timeNs / 1e9,
                this.scriptParameterInputs.get(outcome.scriptId),
            );
            return { passed, detail: passed ? null : "The expected-outcome script returned false." };
        }
        return { passed: false, detail: `Unsupported expected outcome "${outcome.kind}".` };
    }

    _finalWaypointDistance(actorId = "ego", routeId = null) {
        const route = routeId
            ? this.scenario.routes.find((entry) => entry.id === routeId)
            : this._route(actorId || "ego");
        const vehicle = this._vehicle(actorId || route?.actorId || "ego");
        return route && vehicle ? distanceToRouteEnd(route, vehicle.position) : Number.POSITIVE_INFINITY;
    }
}

export function createScenarioRuntime(data, options) {
    return new ScenarioRuntime(data, options);
}

export { compare as compareScenarioValues, flagPath as scenarioFlagPath, inZone as isPositionInScenarioZone };
