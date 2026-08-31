/**
 * Sole managed-run actuator sink. Tracks requested / selected / applied / achieved
 * state per vehicle, enforces watchdog/stale policy, delay, and rate limits, and
 * publishes visualization.controls.* plus transition events.
 */

import { DEFAULT_ACTUATOR_LIMITS } from "../vehicles/VehicleManifest.js";
import {
    emptyInternalCommand,
    internalCommandFromSi,
    normalizeStampedAckermannCommand,
    threeSteeringToRep103,
    toStampedAckermannEnvelope,
} from "./ControlCommandAdapter.js";
import {
    emptyControlsSnapshot,
    normalizeControlsSnapshot,
} from "./AutonomyVisualizationModel.js";

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function mergeLimits(vehicleLimits = {}, overrides = {}) {
    return {
        maxSpeed: Number(overrides.maxSpeed ?? vehicleLimits.maxSpeed ?? DEFAULT_ACTUATOR_LIMITS.maxSpeed),
        maxAcceleration: Number(overrides.maxAcceleration ?? vehicleLimits.maxAcceleration ?? DEFAULT_ACTUATOR_LIMITS.maxAcceleration),
        maxDeceleration: Number(overrides.maxDeceleration ?? vehicleLimits.maxDeceleration ?? DEFAULT_ACTUATOR_LIMITS.maxDeceleration),
        maxJerk: Number(overrides.maxJerk ?? vehicleLimits.maxJerk ?? DEFAULT_ACTUATOR_LIMITS.maxJerk),
        maxSteeringAngle: Number(overrides.maxSteeringAngle ?? vehicleLimits.maxSteeringAngle ?? DEFAULT_ACTUATOR_LIMITS.maxSteeringAngle),
        maxSteeringRate: Number(overrides.maxSteeringRate ?? vehicleLimits.maxSteeringRate ?? DEFAULT_ACTUATOR_LIMITS.maxSteeringRate),
        responseDelayNs: Math.max(0, Math.floor(Number(
            overrides.responseDelayNs ?? vehicleLimits.responseDelayNs ?? DEFAULT_ACTUATOR_LIMITS.responseDelayNs
        ))),
        wheelbase: Number(vehicleLimits.wheelbase ?? 1.5),
    };
}

function cloneCommand(command) {
    return command ? { ...command } : emptyInternalCommand();
}

function vehicleStateKey(vehicleId) {
    return String(vehicleId || "ego");
}

export class ControlRuntime {
    constructor(options = {}) {
        this.telemetry = options.telemetry ?? null;
        this.manifest = options.manifest ?? null;
        this.controls = options.controls ?? this.manifest?.controls ?? null;
        this.limitsByVehicle = new Map();
        this.states = new Map();
        this.pendingByVehicle = new Map();
        this.delayQueues = new Map();
        this._defineSignals();
    }

    configure({ manifest = null, controls = null, vehicleLimits = {} } = {}) {
        this.manifest = manifest ?? this.manifest;
        this.controls = controls ?? manifest?.controls ?? this.controls;
        this.limitsByVehicle.clear();
        for (const [vehicleId, limits] of Object.entries(vehicleLimits)) {
            this.limitsByVehicle.set(vehicleId, mergeLimits(limits, this.controls?.actuatorOverrides || {}));
        }
        const target = this.controls?.targetVehicleId || "ego";
        if (!this.limitsByVehicle.has(target)) {
            this.limitsByVehicle.set(target, mergeLimits({}, this.controls?.actuatorOverrides || {}));
        }
    }

    reset() {
        this.states.clear();
        this.pendingByVehicle.clear();
        this.delayQueues.clear();
        this._publishSnapshot(emptyControlsSnapshot(), 0, 0);
    }

    setVehicleLimits(vehicleId, limits) {
        this.limitsByVehicle.set(vehicleStateKey(vehicleId), mergeLimits(limits, this.controls?.actuatorOverrides || {}));
    }

    getLimits(vehicleId) {
        const id = vehicleStateKey(vehicleId);
        if (!this.limitsByVehicle.has(id)) {
            this.limitsByVehicle.set(id, mergeLimits({}, this.controls?.actuatorOverrides || {}));
        }
        return this.limitsByVehicle.get(id);
    }

    _state(vehicleId) {
        const id = vehicleStateKey(vehicleId);
        if (!this.states.has(id)) {
            this.states.set(id, {
                vehicleId: id,
                requested: null,
                selected: null,
                applied: emptyInternalCommand({ mode: "hold" }),
                achieved: { speedMps: 0, steeringRadThree: 0, accelerationMps2: 0 },
                lastSequence: -1,
                lastHeartbeatNs: null,
                timedOut: false,
                saturated: false,
                rateLimited: false,
                fallbackActive: false,
                status: "ok",
                statusCode: null,
                flags: {
                    timedOut: false,
                    saturated: false,
                    rateLimited: false,
                    fallbackActive: false,
                    delayed: false,
                },
            });
        }
        return this.states.get(id);
    }

    /**
     * Queue a normalized internal command for a producer namespace.
     * Authority selection happens in step().
     */
    submitCommand(vehicleId, command, { producer = "candidate" } = {}) {
        const id = vehicleStateKey(vehicleId);
        if (!this.pendingByVehicle.has(id)) this.pendingByVehicle.set(id, new Map());
        this.pendingByVehicle.get(id).set(producer, cloneCommand({ ...command, producer }));
        const state = this._state(id);
        if (producer === (this.controls?.authority || "candidate")) {
            state.requested = cloneCommand({ ...command, producer });
        }
        return true;
    }

    /** Ingest a stamped SI topic payload (candidate/reference). */
    ingestStampedCommand(info, {
        vehicleId = null,
        producer = null,
        applyTimeNs = 0,
    } = {}) {
        const target = vehicleId || this.controls?.targetVehicleId || "ego";
        const resolvedProducer = producer || info?.producer || "candidate";
        const normalized = normalizeStampedAckermannCommand(info?.value, {
            applyTimeNs,
            producer: resolvedProducer,
            source: "topic",
        });
        if (!normalized.ok) {
            this._transitionEvent(target, "command-rejected", {
                code: normalized.code,
                message: normalized.message,
                topic: info?.name,
            });
            const state = this._state(target);
            state.status = "rejected";
            state.statusCode = normalized.code;
            return { ok: false, ...normalized };
        }
        const state = this._state(target);
        if (normalized.command.sequence <= state.lastSequence) {
            this._transitionEvent(target, "command-rejected", {
                code: "sequence-regression",
                message: "Command sequence must be strictly increasing.",
                sequence: normalized.command.sequence,
                lastSequence: state.lastSequence,
            });
            state.status = "rejected";
            state.statusCode = "sequence-regression";
            return { ok: false, code: "sequence-regression", command: null };
        }
        this.submitCommand(target, normalized.command, { producer: resolvedProducer });
        state.lastSequence = Math.max(state.lastSequence, normalized.command.sequence);
        return { ok: true, command: normalized.command };
    }

    /** Scenario / reference helper: SI speed with REP-103 steering. */
    submitSiSpeedSteer(vehicleId, {
        speedMps = 0,
        steeringRadRep103 = 0,
        mode = "velocity",
        sequence = null,
        captureTimeNs = null,
        producer = "reference",
        source = "scenario",
    } = {}) {
        const state = this._state(vehicleId);
        const command = internalCommandFromSi({
            speedMps,
            steeringRadRep103,
            mode,
            sequence: sequence ?? (state.lastSequence + 1),
            captureTimeNs,
            producer,
            source,
        });
        return this.submitCommand(vehicleId, command, { producer });
    }

    /**
     * Fixed-step controls phase: select authority, apply delay/limits, emit applied setpoints.
     * Returns Map(vehicleId -> { speedMps, steeringRadThree, accelerationMps2, command }).
     */
    step({ step = 0, timeNs = 0, dt = 0 } = {}) {
        const target = this.controls?.targetVehicleId || "ego";
        const ids = new Set([target, ...this.states.keys(), ...this.pendingByVehicle.keys()]);
        const applied = new Map();
        for (const vehicleId of ids) {
            applied.set(vehicleId, this._stepVehicle(vehicleId, { step, timeNs, dt }));
        }
        this.pendingByVehicle.clear();
        const snapshot = this.getSnapshot(target, { applyTimeNs: timeNs });
        this._publishSnapshot(snapshot, step, timeNs);
        return applied;
    }

    _stepVehicle(vehicleId, { step, timeNs, dt }) {
        const state = this._state(vehicleId);
        const limits = this.getLimits(vehicleId);
        const authority = this.controls?.authority || "candidate";
        const pending = this.pendingByVehicle.get(vehicleId) || new Map();
        const candidate = pending.get("candidate") || null;
        const reference = pending.get("reference") || null;

        if (candidate) state.requested = cloneCommand(candidate);
        if (reference && (authority === "reference" || this.controls?.referenceShadow !== false)) {
            // Shadow reference is retained for telemetry even when candidate is authoritative.
            if (authority !== "reference") {
                state.referenceShadow = cloneCommand(reference);
            }
        }

        let selected = null;
        const bypass = pending.get("bypass");
        if (bypass) {
            selected = bypass;
        } else if (authority === "reference") {
            selected = reference || state.selected;
        } else {
            selected = candidate || state.selected;
            if (reference && this.controls?.referenceShadow !== false) {
                state.referenceShadow = cloneCommand(reference);
            }
        }

        const everCommanded = state.lastSequence >= 0 || Boolean(state.selected) || Boolean(selected);
        const watchdogNs = Number(this.controls?.watchdogNs ?? 100_000_000);
        const heartbeatNs = selected?.captureTimeNs ?? state.lastHeartbeatNs;
        const ageNs = Number.isFinite(heartbeatNs) ? timeNs - heartbeatNs : null;
        const timedOut = everCommanded && (!selected || (Number.isFinite(watchdogNs) && watchdogNs > 0 && (
            ageNs == null || ageNs > watchdogNs
            || (selected.deadlineNs != null && selected.deadlineNs > 0 && timeNs > selected.deadlineNs)
        )));

        if (!everCommanded) {
            // Preserve initial plant state until the first authoritative command arrives.
            state.status = "awaiting";
            state.statusCode = null;
            state.flags = {
                timedOut: false,
                saturated: false,
                rateLimited: false,
                fallbackActive: false,
                delayed: false,
                passthrough: true,
            };
            return {
                passthrough: true,
                speedMps: state.achieved?.speedMps ?? 0,
                steeringRadThree: state.achieved?.steeringRadThree ?? 0,
                accelerationMps2: 0,
                command: null,
                activeEnvelope: null,
            };
        }

        if (timedOut && !state.timedOut) {
            this._transitionEvent(vehicleId, "command-timeout", { ageNs, watchdogNs, step, timeNs });
        } else if (!timedOut && state.timedOut) {
            this._transitionEvent(vehicleId, "command-recovered", { ageNs, step, timeNs });
        }
        state.timedOut = timedOut;

        let desired = selected;
        state.fallbackActive = false;
        if (timedOut) {
            const policy = this.controls?.stalePolicy || "stop";
            if (policy === "hold") {
                desired = cloneCommand(state.applied);
                desired.mode = "hold";
                desired.source = "hold";
            } else if (policy === "fallback" && this.controls?.fallbackCommand) {
                const fb = this.controls.fallbackCommand;
                desired = internalCommandFromSi({
                    mode: fb.mode || "stop",
                    speedMps: fb.speed,
                    steeringRadRep103: fb.steering_angle,
                    accelerationMps2: fb.acceleration,
                    sequence: state.lastSequence + 1,
                    captureTimeNs: timeNs,
                    producer: "bypass",
                    source: "fallback",
                });
                state.fallbackActive = true;
                this._transitionEvent(vehicleId, "command-fallback", { step, timeNs });
            } else {
                desired = emptyInternalCommand({
                    mode: "stop",
                    sequence: state.lastSequence + 1,
                    captureTimeNs: timeNs,
                    producer: "bypass",
                    source: "safe-stop",
                });
            }
            state.status = "timeout";
            state.statusCode = "watchdog";
        } else {
            state.status = "ok";
            state.statusCode = null;
            state.lastSequence = Math.max(state.lastSequence, selected.sequence);
            state.lastHeartbeatNs = selected.captureTimeNs ?? timeNs;
            state.selected = cloneCommand(selected);
        }

        // Deterministic simulation-time delay queue.
        let delayed = desired;
        if (limits.responseDelayNs > 0 && desired) {
            if (!this.delayQueues.has(vehicleId)) this.delayQueues.set(vehicleId, []);
            const queue = this.delayQueues.get(vehicleId);
            queue.push({ readyNs: timeNs + limits.responseDelayNs, command: cloneCommand(desired) });
            let released = null;
            while (queue.length && queue[0].readyNs <= timeNs) {
                released = queue.shift().command;
            }
            delayed = released || cloneCommand(state.applied);
            state.flags.delayed = true;
        } else {
            state.flags.delayed = false;
        }

        const limited = this._applyLimits(state.applied, delayed || emptyInternalCommand({ mode: "stop" }), limits, dt);
        state.applied = limited.command;
        state.saturated = limited.saturated;
        state.rateLimited = limited.rateLimited;
        state.flags = {
            timedOut: state.timedOut,
            saturated: limited.saturated,
            rateLimited: limited.rateLimited,
            fallbackActive: state.fallbackActive,
            delayed: state.flags.delayed,
        };
        if (limited.saturated && !state._prevSaturated) {
            this._transitionEvent(vehicleId, "command-saturated", { step, timeNs });
        }
        if (limited.rateLimited && !state._prevRateLimited) {
            this._transitionEvent(vehicleId, "command-rate-limited", { step, timeNs });
        }
        state._prevSaturated = limited.saturated;
        state._prevRateLimited = limited.rateLimited;

        return {
            speedMps: state.applied.speedMps,
            steeringRadThree: state.applied.steeringRadThree,
            accelerationMps2: state.applied.accelerationMps2,
            command: cloneCommand(state.applied),
            activeEnvelope: toStampedAckermannEnvelope(state.applied, { applyTimeNs: timeNs }),
        };
    }

    _applyLimits(previous, desired, limits, dt) {
        const prev = previous || emptyInternalCommand();
        const next = cloneCommand(desired);
        let saturated = false;
        let rateLimited = false;
        const dtSafe = Math.max(1e-6, Number(dt) || 1e-2);

        if (next.mode === "stop") {
            next.speedMps = 0;
            next.accelerationMps2 = 0;
            next.steeringRadRep103 = 0;
            next.steeringRadThree = 0;
        } else if (next.mode === "acceleration") {
            let accel = clamp(next.accelerationMps2, -limits.maxDeceleration, limits.maxAcceleration);
            if (accel !== next.accelerationMps2) saturated = true;
            const jerkLimit = limits.maxJerk * dtSafe;
            const prevAccel = prev.accelerationMps2 || 0;
            const jerked = clamp(accel, prevAccel - jerkLimit, prevAccel + jerkLimit);
            if (jerked !== accel) rateLimited = true;
            accel = jerked;
            next.accelerationMps2 = accel;
            next.speedMps = clamp(prev.speedMps + accel * dtSafe, -limits.maxSpeed, limits.maxSpeed);
            if (Math.abs(prev.speedMps + accel * dtSafe) > limits.maxSpeed) saturated = true;
        } else if (next.mode === "hold") {
            next.speedMps = prev.speedMps;
            next.steeringRadThree = prev.steeringRadThree;
            next.steeringRadRep103 = prev.steeringRadRep103;
            next.accelerationMps2 = 0;
        } else {
            // velocity mode
            let speed = clamp(next.speedMps, -limits.maxSpeed, limits.maxSpeed);
            if (speed !== next.speedMps) saturated = true;
            const maxDeltaV = limits.maxAcceleration * dtSafe;
            const maxBrake = limits.maxDeceleration * dtSafe;
            const upper = prev.speedMps + maxDeltaV;
            const lower = prev.speedMps - maxBrake;
            const rateLimitedSpeed = clamp(speed, Math.min(lower, upper), Math.max(lower, upper));
            if (rateLimitedSpeed !== speed) rateLimited = true;
            next.speedMps = rateLimitedSpeed;
            next.accelerationMps2 = (next.speedMps - prev.speedMps) / dtSafe;
        }

        let steer = clamp(next.steeringRadThree, -limits.maxSteeringAngle, limits.maxSteeringAngle);
        if (steer !== next.steeringRadThree) saturated = true;
        const maxDeltaSteer = limits.maxSteeringRate * dtSafe;
        const rateLimitedSteer = clamp(steer, prev.steeringRadThree - maxDeltaSteer, prev.steeringRadThree + maxDeltaSteer);
        if (rateLimitedSteer !== steer) rateLimited = true;
        next.steeringRadThree = rateLimitedSteer;
        next.steeringRadRep103 = threeSteeringToRep103(rateLimitedSteer);
        return { command: next, saturated, rateLimited };
    }

    /** Sample achieved plant state after vehicle motion. */
    sampleAchieved(vehicleId, { speedMps = 0, steeringRadThree = 0, accelerationMps2 = 0 } = {}) {
        const state = this._state(vehicleId);
        state.achieved = {
            speedMps: Number(speedMps) || 0,
            steeringRadThree: Number(steeringRadThree) || 0,
            steeringRadRep103: threeSteeringToRep103(steeringRadThree),
            accelerationMps2: Number(accelerationMps2) || 0,
        };
        return state.achieved;
    }

    getApplied(vehicleId) {
        return cloneCommand(this._state(vehicleId).applied);
    }

    getSnapshot(vehicleId = null, { applyTimeNs = 0 } = {}) {
        const id = vehicleStateKey(vehicleId || this.controls?.targetVehicleId || "ego");
        const state = this._state(id);
        const requested = state.requested;
        const applied = state.applied;
        const achieved = state.achieved;
        const heartbeatNs = state.lastHeartbeatNs;
        return normalizeControlsSnapshot({
            vehicleId: id,
            captureTimeNs: requested?.captureTimeNs ?? applied?.captureTimeNs ?? null,
            arrivalTimeNs: null,
            applyTimeNs,
            status: state.status,
            statusCode: state.statusCode,
            ageNs: Number.isFinite(heartbeatNs) ? applyTimeNs - heartbeatNs : null,
            sequence: applied?.sequence ?? requested?.sequence ?? 0,
            mode: applied?.mode || "stop",
            authority: this.controls?.authority || "candidate",
            heartbeatAgeNs: Number.isFinite(heartbeatNs) ? applyTimeNs - heartbeatNs : null,
            delayNs: this.getLimits(id).responseDelayNs,
            flags: { ...state.flags },
            requested: requested ? {
                speedMps: requested.speedMps,
                steeringRad: requested.steeringRadRep103,
                accelerationMps2: requested.accelerationMps2,
            } : null,
            applied: applied ? {
                speedMps: applied.speedMps,
                steeringRad: applied.steeringRadRep103,
                accelerationMps2: applied.accelerationMps2,
            } : null,
            achieved: achieved ? {
                speedMps: achieved.speedMps,
                steeringRad: threeSteeringToRep103(achieved.steeringRadThree),
                accelerationMps2: achieved.accelerationMps2,
            } : null,
            deltas: {
                requestedVsAppliedSpeed: (requested?.speedMps ?? 0) - (applied?.speedMps ?? 0),
                appliedVsAchievedSpeed: (applied?.speedMps ?? 0) - (achieved?.speedMps ?? 0),
                requestedVsAppliedSteer: (requested?.steeringRadRep103 ?? 0) - (applied?.steeringRadRep103 ?? 0),
                appliedVsAchievedSteer: (applied?.steeringRadRep103 ?? 0) - threeSteeringToRep103(achieved?.steeringRadThree ?? 0),
            },
            referenceShadow: state.referenceShadow ? {
                speedMps: state.referenceShadow.speedMps,
                steeringRad: state.referenceShadow.steeringRadRep103,
            } : null,
            wheelbase: this.getLimits(id).wheelbase,
        });
    }

    _defineSignals() {
        if (!this.telemetry?.defineSignal) return;
        this.telemetry.defineSignal({
            path: "visualization.controls.snapshot",
            source: "controls",
            type: "json",
            logClass: "standard",
        });
        this.telemetry.defineSignal({
            path: "visualization.controls.status",
            source: "controls",
            type: "json",
            logClass: "standard",
        });
    }

    _publishSnapshot(snapshot, step, timeNs) {
        if (!this.telemetry?.publishSignal) return;
        this.telemetry.publishSignal("visualization.controls.snapshot", snapshot, {
            timeUs: Math.round(timeNs / 1000),
            cycle: step,
            source: "controls",
            type: "json",
        });
        this.telemetry.publishSignal("visualization.controls.status", {
            status: snapshot.status,
            statusCode: snapshot.statusCode,
            flags: snapshot.flags,
            sequence: snapshot.sequence,
            ageNs: snapshot.ageNs,
        }, {
            timeUs: Math.round(timeNs / 1000),
            cycle: step,
            source: "controls",
            type: "json",
        });
    }

    _transitionEvent(vehicleId, name, payload = {}) {
        this.telemetry?.emitTelemetryEvent?.({
            timeUs: Math.round((payload.timeNs ?? 0) / 1000),
            category: "controls",
            name,
            payload: { vehicleId, ...payload },
        });
    }
}
