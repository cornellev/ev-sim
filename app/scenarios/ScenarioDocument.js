import { validateRouteVerification } from "./route/Route.js";

export const SCENARIO_KIND = "cev-sim.scenario";
export const SCENARIO_VERSION = 1;
export const SCENARIO_CATALOG_KIND = "cev-sim.scenario-catalog";
export const SCENARIO_CATALOG_VERSION = 1;

export const CONTROLLER_KINDS = Object.freeze([
    "external-ros",
    "script",
    "script-with-route",
    "route-follower",
]);

export const TRIGGER_CONDITION_KINDS = Object.freeze([
    "zone-enter",
    "zone-exit",
    "time",
    "step",
    "signal",
    "flag",
    "actor-distance",
]);

export const TRIGGER_ACTION_KINDS = Object.freeze([
    "finish",
    "set-flag",
    "set-signal",
    "run-script",
    "actor-command",
    "sensor-state",
]);

export const COMPLETION_KINDS = Object.freeze([
    "max-duration",
    "ego-collision",
    "fatal-assertion",
    "script",
]);

export const EXPECTED_OUTCOME_KINDS = Object.freeze([
    "finish-zone",
    "no-collisions",
    "final-waypoint-distance",
    "flag-true",
    "script",
]);

export const PARAMETER_TYPES = Object.freeze(["float64", "int32", "boolean", "string"]);
export const PARAMETER_TARGET_KINDS = Object.freeze(["scalar-field", "script-input", "scenario-signal"]);

function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, fallback = "") {
    const normalized = String(value ?? "").trim();
    return normalized || fallback;
}

function finite(value, fallback = 0) {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : fallback;
}

function positive(value, fallback = 1) {
    return Math.max(Number.EPSILON, finite(value, fallback));
}

function nonNegativeInt(value, fallback = 0) {
    return Math.max(0, Math.floor(finite(value, fallback)));
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function vec3(value = {}, fallback = {}) {
    const source = object(value);
    return {
        x: finite(source.x, fallback.x ?? 0),
        y: finite(source.y, fallback.y ?? 0),
        z: finite(source.z, fallback.z ?? 0),
    };
}

function makeId(prefix, index) {
    return `${prefix}-${index + 1}`;
}

function normalizeActor(value = {}, index = 0) {
    const source = object(value);
    const id = text(source.id, index === 0 ? "ego" : makeId("actor", index));
    const ego = id === "ego" || source.role === "ego";
    return {
        id,
        name: ego ? text(source.name, "Ego") : text(source.name, `Actor ${index}`),
        role: ego ? "ego" : text(source.role, "actor"),
        vehicleId: ego ? null : (text(source.vehicleId) || null),
        enabled: source.enabled !== false,
    };
}

function normalizeWaypoint(value = {}, index = 0, count = 1) {
    const source = object(value);
    const kind = index === 0 ? "start" : index === count - 1 ? "finish" : "intermediate";
    const anchor = object(source.anchor ?? source.roadRef);
    return {
        id: text(source.id, makeId("waypoint", index)),
        order: index,
        kind,
        position: vec3(source.position),
        heading: finite(source.heading, 0),
        anchor: {
            kind: anchor.kind === "intersection" ? "intersection" : "road",
            id: text(anchor.id),
            fraction: Math.max(0, Math.min(1, finite(anchor.fraction, 0))),
        },
    };
}

function normalizeActivation(value = {}) {
    const source = object(value);
    const kind = source.kind === "flag" ? "flag" : "start";
    return {
        kind,
        flag: kind === "flag" ? text(source.flag) : null,
    };
}

function normalizeController(value = {}) {
    const source = object(value);
    const kind = CONTROLLER_KINDS.includes(source.kind) ? source.kind : "route-follower";
    return {
        kind,
        activation: normalizeActivation(source.activation),
        scriptId: ["script", "script-with-route"].includes(kind) ? (text(source.scriptId) || null) : null,
        topicId: kind === "external-ros" ? (text(source.topicId) || null) : null,
        inputs: Array.isArray(source.inputs) ? clone(source.inputs) : [],
        outputs: Array.isArray(source.outputs) ? clone(source.outputs) : [],
    };
}

function normalizeRoute(value = {}, index = 0) {
    const source = object(value);
    const rawWaypoints = Array.isArray(source.waypoints) ? source.waypoints : [];
    return {
        id: text(source.id, makeId("route", index)),
        name: text(source.name, index === 0 ? "Ego route" : `Route ${index + 1}`),
        actorId: text(source.actorId, index === 0 ? "ego" : makeId("actor", index)),
        initialSpeedMps: finite(source.initialSpeedMps, 0),
        controller: normalizeController(source.controller),
        waypoints: rawWaypoints.map((waypoint, waypointIndex) => normalizeWaypoint(
            waypoint,
            waypointIndex,
            rawWaypoints.length,
        )),
        verification: source.verification ? clone(source.verification) : null,
    };
}

function normalizeZone(value = {}, index = 0) {
    const source = object(value);
    return {
        id: text(source.id, makeId("zone", index)),
        name: text(source.name, `Zone ${index + 1}`),
        parentId: text(source.parentId) || null,
        center: vec3(source.center, { y: 1.5 }),
        size: {
            x: positive(source.size?.x, 5),
            y: positive(source.size?.y, 3),
            z: positive(source.size?.z, 5),
        },
    };
}

function normalizeCondition(value = {}) {
    const source = object(value);
    const kind = TRIGGER_CONDITION_KINDS.includes(source.kind) ? source.kind : "time";
    return {
        kind,
        zoneId: text(source.zoneId) || null,
        actorId: text(source.actorId, "ego"),
        otherActorId: text(source.otherActorId) || null,
        timeNs: Math.max(0, Math.floor(finite(source.timeNs, finite(source.time, 0) * 1e9))),
        step: nonNegativeInt(source.step, 0),
        path: text(source.path),
        flag: text(source.flag),
        operator: ["eq", "neq", "lt", "lte", "gt", "gte"].includes(source.operator) ? source.operator : "eq",
        expected: source.expected ?? true,
        thresholdM: Math.max(0, finite(source.thresholdM, 0)),
    };
}

function normalizeAction(value = {}) {
    const source = object(value);
    const kind = TRIGGER_ACTION_KINDS.includes(source.kind) ? source.kind : "finish";
    return {
        kind,
        flag: text(source.flag),
        path: text(source.path),
        value: clone(source.value),
        scriptId: text(source.scriptId) || null,
        actorId: text(source.actorId, "ego"),
        speedMps: finite(source.speedMps, 0),
        steeringRad: finite(source.steeringRad, 0),
        sensorAlias: text(source.sensorAlias),
        enabled: source.enabled !== false,
        dropoutProbability: Math.max(0, Math.min(1, finite(source.dropoutProbability, 0))),
        durationNs: Math.max(0, Math.floor(finite(source.durationNs, 0))),
        onError: source.onError === "continue" ? "continue" : "fail",
    };
}

function normalizeTrigger(value = {}, index = 0) {
    const source = object(value);
    return {
        id: text(source.id, makeId("trigger", index)),
        name: text(source.name, `Trigger ${index + 1}`),
        enabled: source.enabled !== false,
        once: source.once !== false,
        condition: normalizeCondition(source.condition),
        actions: (Array.isArray(source.actions) ? source.actions : []).map(normalizeAction),
    };
}

function normalizeCompletion(value = {}, index = 0) {
    const source = object(value);
    const kind = COMPLETION_KINDS.includes(source.kind) ? source.kind : "max-duration";
    const cadence = object(source.cadence);
    return {
        id: text(source.id, makeId("completion", index)),
        name: text(source.name, `Completion ${index + 1}`),
        kind,
        durationNs: Math.max(0, Math.floor(finite(source.durationNs, 30e9))),
        scriptId: kind === "script" ? (text(source.scriptId) || null) : null,
        cadence: {
            kind: ["every-step", "every-n-steps", "trigger"].includes(cadence.kind)
                ? cadence.kind
                : "every-step",
            everyN: Math.max(1, nonNegativeInt(cadence.everyN, 1)),
            triggerId: text(cadence.triggerId) || null,
        },
        onError: source.onError === "continue" ? "continue" : "fail",
    };
}

function normalizeOutcome(value = {}, index = 0) {
    const source = object(value);
    const kind = EXPECTED_OUTCOME_KINDS.includes(source.kind) ? source.kind : "no-collisions";
    return {
        id: text(source.id, makeId("outcome", index)),
        name: text(source.name, `Expected outcome ${index + 1}`),
        kind,
        actorId: text(source.actorId, "ego"),
        zoneId: text(source.zoneId) || null,
        routeId: text(source.routeId) || null,
        thresholdM: Math.max(0, finite(source.thresholdM, 1)),
        flag: text(source.flag),
        scriptId: kind === "script" ? (text(source.scriptId) || null) : null,
        // Scenario expectations are an AND contract: every declared outcome
        // participates in pass/fail. Diagnostic-only script errors are modeled
        // by `onError`, not by silently making an expectation optional.
        required: true,
        onError: source.onError === "continue" ? "continue" : "fail",
    };
}

function normalizeParameter(value = {}, index = 0) {
    const source = object(value);
    const type = PARAMETER_TYPES.includes(source.type) ? source.type : "float64";
    return {
        id: text(source.id, makeId("parameter", index)),
        name: text(source.name, `Parameter ${index + 1}`),
        description: text(source.description),
        type,
        default: source.default ?? (type === "boolean" ? false : type === "string" ? "" : 0),
        target: {
            ...clone(object(source.target)),
            kind: PARAMETER_TARGET_KINDS.includes(source.target?.kind) ? source.target.kind : null,
            path: text(source.target?.path),
            scriptId: text(source.target?.scriptId) || null,
            input: text(source.target?.input ?? source.target?.inputId),
        },
    };
}

export function createDefaultScenario(overrides = {}) {
    return normalizeScenario({
        kind: SCENARIO_KIND,
        version: SCENARIO_VERSION,
        id: "untitled-scenario",
        name: "Untitled Scenario",
        description: "",
        folderId: null,
        environment: { id: "igvc", expectedHash: null },
        actors: [{ id: "ego", name: "Ego", role: "ego", vehicleId: null }],
        routes: [{
            id: "ego-route",
            name: "Ego route",
            actorId: "ego",
            initialSpeedMps: 0,
            controller: { kind: "route-follower", activation: { kind: "start" } },
            waypoints: [],
            verification: null,
        }],
        zones: [],
        triggers: [],
        completion: { conditions: [] },
        expectedOutcomes: [],
        sensorAliases: [],
        parameters: [],
        ...overrides,
    }, { allowMissingKind: true });
}

export function normalizeScenario(value, { allowMissingKind = false } = {}) {
    const source = object(value);
    if (!allowMissingKind && source.kind !== undefined && source.kind !== SCENARIO_KIND) {
        throw new Error(`Unsupported scenario kind: ${JSON.stringify(source.kind)}.`);
    }
    if (source.version !== undefined && Number(source.version) !== SCENARIO_VERSION) {
        throw new Error(`Unsupported scenario version ${source.version}; expected ${SCENARIO_VERSION}.`);
    }
    const rawActors = Array.isArray(source.actors) && source.actors.length > 0
        ? source.actors
        : [{ id: "ego", name: "Ego" }];
    const actors = rawActors.map(normalizeActor);
    return {
        kind: SCENARIO_KIND,
        version: SCENARIO_VERSION,
        id: text(source.id, "untitled-scenario"),
        name: text(source.name, "Untitled Scenario"),
        description: text(source.description),
        folderId: text(source.folderId) || null,
        environment: {
            id: text(source.environment?.id, "igvc"),
            expectedHash: text(source.environment?.expectedHash) || null,
        },
        actors,
        routes: (Array.isArray(source.routes) ? source.routes : []).map(normalizeRoute),
        zones: (Array.isArray(source.zones) ? source.zones : []).map(normalizeZone),
        triggers: (Array.isArray(source.triggers) ? source.triggers : []).map(normalizeTrigger),
        completion: {
            conditions: (Array.isArray(source.completion?.conditions) ? source.completion.conditions : [])
                .map(normalizeCompletion),
        },
        expectedOutcomes: (Array.isArray(source.expectedOutcomes) ? source.expectedOutcomes : [])
            .map(normalizeOutcome),
        sensorAliases: (Array.isArray(source.sensorAliases) ? source.sensorAliases : []).map((entry, index) => ({
            id: text(entry?.id, makeId("sensor", index)),
            name: text(entry?.name, `Sensor ${index + 1}`),
            type: text(entry?.type) || null,
        })),
        parameters: (Array.isArray(source.parameters) ? source.parameters : []).map(normalizeParameter),
    };
}

function duplicates(entries, path, issues) {
    const seen = new Set();
    entries.forEach((entry, index) => {
        if (!entry.id) issues.push({ path: `${path}.${index}.id`, message: "A stable id is required." });
        if (seen.has(entry.id)) issues.push({ path: `${path}.${index}.id`, message: `Duplicate id "${entry.id}".` });
        seen.add(entry.id);
    });
}

function parameterValueMatches(type, value) {
    if (type === "boolean") return typeof value === "boolean";
    if (type === "string") return typeof value === "string";
    if (type === "int32") return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    return typeof value === "number" && Number.isFinite(value);
}

const SCENARIO_SCALAR_TARGET_PATTERNS = Object.freeze([
    /^actors\.\d+\.enabled$/,
    /^routes\.\d+\.initialSpeedMps$/,
    /^zones\.\d+\.(?:center|size)\.(?:x|y|z)$/,
    /^triggers\.\d+\.condition\.(?:timeNs|step|expected|thresholdM)$/,
    /^triggers\.\d+\.actions\.\d+\.(?:value|speedMps|steeringRad|enabled|dropoutProbability|durationNs)$/,
    /^completion\.conditions\.\d+\.durationNs$/,
    /^completion\.conditions\.\d+\.cadence\.everyN$/,
    /^expectedOutcomes\.\d+\.(?:thresholdM|required)$/,
]);

const RUN_SCALAR_TARGET_PATTERNS = Object.freeze([
    /^initialState\.vehicles\.\d+\.pose\.(?:position|rotation)\.(?:x|y|z)$/,
    /^initialState\.vehicles\.\d+\.linearVelocity\.(?:x|y|z)$/,
    /^initialState\.vehicles\.\d+\.steeringAngle$/,
    /^initialState\.signals(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/,
    /^clock\.(?:stepNs|speed|maxSteps|publishClock)$/,
    /^clock\.modules\.(?:inputs|scripting|vehicles|physics|sensors|assertions)$/,
    /^sensorRig\.sensors\.\d+\.(?:enabled|rateHz|phaseNs|maxQueueFrames)$/,
    /^sensorRig\.sensors\.\d+\.pose\.(?:position|rotation)\.(?:x|y|z)$/,
    /^sensorRig\.sensors\.\d+\.latency\.(?:fixedNs|jitterNs)$/,
    /^sensorRig\.sensors\.\d+\.noise\.(?:standardDeviation|bias|dropoutProbability)$/,
    /^sensorRig\.sensors\.\d+\.calibration(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\d+))+$/,
    /^assertions\.\d+\.(?:expected|tolerance)$/,
    /^assertions\.\d+\.window\.(?:startStep|endStep)$/,
]);

function scalarTargetPath(rawPath, owner) {
    let path = String(rawPath ?? "").trim();
    const prefixes = owner === "scenario"
        ? ["scenario."]
        : ["run.", "manifest.", "runManifest.", "run-manifest."];
    for (const prefix of prefixes) {
        if (path.startsWith(prefix)) {
            path = path.slice(prefix.length);
            break;
        }
    }
    return path;
}

function scalarTargetValue(document, pathParts) {
    let current = document;
    for (const part of pathParts) {
        if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) {
            return { found: false, value: undefined };
        }
        current = current[part];
    }
    return { found: true, value: current };
}

function scalarTargetSchemaType(path, owner, value) {
    if (owner === "scenario") {
        if (/^(?:actors\.\d+\.enabled|triggers\.\d+\.actions\.\d+\.enabled|expectedOutcomes\.\d+\.required)$/.test(path)) return "boolean";
        if (/^(?:triggers\.\d+\.condition\.step|completion\.conditions\.\d+\.cadence\.everyN)$/.test(path)) return "int32";
        if (/^(?:routes\.\d+\.initialSpeedMps|zones\.\d+\.(?:center|size)\.(?:x|y|z)|triggers\.\d+\.condition\.(?:timeNs|thresholdM)|triggers\.\d+\.actions\.\d+\.(?:speedMps|steeringRad|dropoutProbability|durationNs)|completion\.conditions\.\d+\.durationNs|expectedOutcomes\.\d+\.thresholdM)$/.test(path)) return "float64";
    } else {
        if (/^(?:clock\.publishClock|clock\.modules\.[A-Za-z]+|sensorRig\.sensors\.\d+\.enabled)$/.test(path)) return "boolean";
        if (/^(?:clock\.(?:stepNs|maxSteps)|sensorRig\.sensors\.\d+\.(?:phaseNs|maxQueueFrames)|sensorRig\.sensors\.\d+\.latency\.(?:fixedNs|jitterNs)|assertions\.\d+\.window\.(?:startStep|endStep))$/.test(path)) return "int32";
        if (/^(?:initialState\.vehicles\.\d+\.(?:pose\.(?:position|rotation)\.(?:x|y|z)|linearVelocity\.(?:x|y|z)|steeringAngle)|clock\.speed|sensorRig\.sensors\.\d+\.(?:rateHz|noise\.(?:standardDeviation|bias|dropoutProbability))|assertions\.\d+\.tolerance)$/.test(path)) return "float64";
    }
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "string") return "string";
    return null;
}

function targetTypeMatches(type, value, path, owner) {
    const expectedType = scalarTargetSchemaType(path, owner, value);
    if (expectedType && type !== expectedType) return false;
    if (value === null) {
        return owner === "run"
            && type === "int32"
            && (["clock.maxSteps"].includes(path) || /^assertions\.\d+\.window\.endStep$/.test(path));
    }
    if (type === "boolean") return typeof value === "boolean";
    if (type === "string") return typeof value === "string";
    if (["int32", "float64"].includes(type)) return typeof value === "number" && Number.isFinite(value);
    return false;
}

/** Resolve and validate a parameter's deliberately narrow scalar-field binding. */
export function validateScalarParameterTarget(document, declaration, { owner = "scenario" } = {}) {
    const normalizedOwner = owner === "scenario" ? "scenario" : "run";
    const path = scalarTargetPath(declaration?.target?.path, normalizedOwner);
    const patterns = normalizedOwner === "scenario" ? SCENARIO_SCALAR_TARGET_PATTERNS : RUN_SCALAR_TARGET_PATTERNS;
    if (!path || !patterns.some((pattern) => pattern.test(path))) {
        return {
            ok: false,
            path,
            pathParts: [],
            message: `Scalar target "${declaration?.target?.path ?? ""}" is not an approved ${normalizedOwner} parameter leaf.`,
        };
    }
    const pathParts = path.split(".");
    if (pathParts.some((part) => ["__proto__", "prototype", "constructor", "length"].includes(part))) {
        return { ok: false, path, pathParts, message: "Scalar parameter target contains an unsafe path segment." };
    }
    const resolved = scalarTargetValue(document, pathParts);
    if (!resolved.found || (resolved.value !== null && typeof resolved.value === "object")) {
        return { ok: false, path, pathParts, message: `Scalar target "${path}" must be an existing scalar leaf.` };
    }
    if (!targetTypeMatches(declaration?.type, resolved.value, path, normalizedOwner)) {
        return {
            ok: false,
            path,
            pathParts,
            value: resolved.value,
            message: `Scalar target "${path}" is not compatible with ${declaration?.type}.`,
        };
    }
    return { ok: true, path, pathParts, value: resolved.value, message: null };
}

export function validateScenario(value, { requireVerifiedRoutes = true } = {}) {
    let scenario;
    try {
        scenario = normalizeScenario(value);
    } catch (error) {
        return { ok: false, scenario: null, issues: [{ path: "", message: error.message }] };
    }
    const issues = [];
    for (const [entries, path] of [
        [scenario.actors, "actors"],
        [scenario.routes, "routes"],
        [scenario.zones, "zones"],
        [scenario.triggers, "triggers"],
        [scenario.completion.conditions, "completion.conditions"],
        [scenario.expectedOutcomes, "expectedOutcomes"],
        [scenario.sensorAliases, "sensorAliases"],
        [scenario.parameters, "parameters"],
    ]) duplicates(entries, path, issues);

    if (scenario.actors[0]?.id !== "ego" || scenario.actors[0]?.role !== "ego") {
        issues.push({ path: "actors.0", message: "Ego must be the first actor." });
    }
    if (scenario.actors.filter((actor) => actor.id === "ego" || actor.role === "ego").length !== 1) {
        issues.push({ path: "actors", message: "A scenario must contain exactly one Ego actor." });
    }
    scenario.actors.forEach((actor, index) => {
        if (index > 0 && !actor.vehicleId) {
            issues.push({ path: `actors.${index}.vehicleId`, message: "Non-ego actors require a vehicle model." });
        }
    });

    const actorIds = new Set(scenario.actors.map((actor) => actor.id));
    const routeIds = new Set(scenario.routes.map((route) => route.id));
    const routeActors = new Set();
    scenario.routes.forEach((route, index) => {
        if (!actorIds.has(route.actorId)) {
            issues.push({ path: `routes.${index}.actorId`, message: `Unknown actor "${route.actorId}".` });
        }
        if (routeActors.has(route.actorId)) {
            issues.push({ path: `routes.${index}.actorId`, message: `Actor "${route.actorId}" has more than one route.` });
        }
        routeActors.add(route.actorId);
        if (route.waypoints.length < 2) {
            issues.push({ path: `routes.${index}.waypoints`, message: "A route requires start and finish waypoints." });
        }
        route.waypoints.forEach((waypoint, waypointIndex) => {
            if (!waypoint.anchor.id) {
                issues.push({ path: `routes.${index}.waypoints.${waypointIndex}.anchor`, message: "Waypoint must be anchored to a road or intersection." });
            }
        });
        if (requireVerifiedRoutes && !route.verification) {
            issues.push({ path: `routes.${index}.verification`, message: "Route must be verified." });
        } else if (requireVerifiedRoutes) {
            const routeVerification = validateRouteVerification(route);
            for (const issue of routeVerification.issues) {
                issues.push({
                    path: `routes.${index}.${issue.path ?? "verification"}`,
                    message: issue.message,
                });
            }
        }
        if (route.controller.activation.kind === "flag" && !route.controller.activation.flag) {
            issues.push({ path: `routes.${index}.controller.activation.flag`, message: "Flag activation requires a flag name." });
        }
        if (["script", "script-with-route"].includes(route.controller.kind) && !route.controller.scriptId) {
            issues.push({ path: `routes.${index}.controller.scriptId`, message: "Script controller requires a script." });
        }
        if (["script", "script-with-route"].includes(route.controller.kind)) {
            const commandTargets = new Set(route.controller.outputs.map((mapping) => mapping?.target ?? mapping?.command));
            for (const target of ["speed", "steering"]) {
                if (!commandTargets.has(target)) {
                    issues.push({ path: `routes.${index}.controller.outputs`, message: `Script controller requires an explicit ${target} output mapping.` });
                }
            }
        }
        if (route.controller.kind === "external-ros" && !route.controller.topicId) {
            issues.push({ path: `routes.${index}.controller.topicId`, message: "External ROS controller requires a topic id." });
        }
    });
    scenario.actors.forEach((actor, index) => {
        if (!routeActors.has(actor.id)) {
            issues.push({ path: `actors.${index}`, message: `Actor "${actor.id}" requires a route and start pose.` });
        }
    });

    const zones = new Map(scenario.zones.map((zone) => [zone.id, zone]));
    scenario.zones.forEach((zone, index) => {
        if (zone.parentId && !zones.has(zone.parentId)) {
            issues.push({ path: `zones.${index}.parentId`, message: `Unknown parent zone "${zone.parentId}".` });
        }
        const visited = new Set([zone.id]);
        let parentId = zone.parentId;
        while (parentId) {
            if (visited.has(parentId)) {
                issues.push({ path: `zones.${index}.parentId`, message: "Zone hierarchy contains a cycle." });
                break;
            }
            visited.add(parentId);
            parentId = zones.get(parentId)?.parentId || null;
        }
    });

    const triggerIds = new Set(scenario.triggers.map((trigger) => trigger.id));
    let finishActionCount = 0;
    scenario.triggers.forEach((trigger, index) => {
        const condition = trigger.condition;
        if (["zone-enter", "zone-exit"].includes(condition.kind) && !zones.has(condition.zoneId)) {
            issues.push({ path: `triggers.${index}.condition.zoneId`, message: `Unknown zone "${condition.zoneId}".` });
        }
        if (!actorIds.has(condition.actorId)) {
            issues.push({ path: `triggers.${index}.condition.actorId`, message: `Unknown actor "${condition.actorId}".` });
        }
        if (condition.kind === "actor-distance" && !actorIds.has(condition.otherActorId)) {
            issues.push({ path: `triggers.${index}.condition.otherActorId`, message: `Unknown actor "${condition.otherActorId}".` });
        }
        if (["signal", "flag"].includes(condition.kind) && !(condition.path || condition.flag)) {
            issues.push({ path: `triggers.${index}.condition`, message: `${condition.kind} condition requires a path or flag.` });
        }
        trigger.actions.forEach((action, actionIndex) => {
            if (action.kind === "finish") finishActionCount += 1;
            if (["actor-command"].includes(action.kind) && !actorIds.has(action.actorId)) {
                issues.push({ path: `triggers.${index}.actions.${actionIndex}.actorId`, message: `Unknown actor "${action.actorId}".` });
            }
            if (action.kind === "sensor-state" && !scenario.sensorAliases.some((entry) => entry.id === action.sensorAlias)) {
                issues.push({ path: `triggers.${index}.actions.${actionIndex}.sensorAlias`, message: `Unknown sensor alias "${action.sensorAlias}".` });
            }
            if (action.kind === "run-script" && !action.scriptId) {
                issues.push({ path: `triggers.${index}.actions.${actionIndex}.scriptId`, message: "Script action requires a script." });
            }
        });
    });

    scenario.completion.conditions.forEach((condition, index) => {
        if (condition.kind === "script" && !condition.scriptId) {
            issues.push({ path: `completion.conditions.${index}.scriptId`, message: "Script completion requires a script." });
        }
        if (condition.cadence.kind === "trigger" && !triggerIds.has(condition.cadence.triggerId)) {
            issues.push({ path: `completion.conditions.${index}.cadence.triggerId`, message: `Unknown trigger "${condition.cadence.triggerId}".` });
        }
    });
    if (finishActionCount === 0 && scenario.completion.conditions.length === 0) {
        issues.push({ path: "completion", message: "Scenario requires at least one termination condition." });
    }

    scenario.expectedOutcomes.forEach((outcome, index) => {
        if (outcome.zoneId && !zones.has(outcome.zoneId)) {
            issues.push({ path: `expectedOutcomes.${index}.zoneId`, message: `Unknown zone "${outcome.zoneId}".` });
        }
        if (outcome.routeId && !routeIds.has(outcome.routeId)) {
            issues.push({ path: `expectedOutcomes.${index}.routeId`, message: `Unknown route "${outcome.routeId}".` });
        }
        if (!actorIds.has(outcome.actorId)) {
            issues.push({ path: `expectedOutcomes.${index}.actorId`, message: `Unknown actor "${outcome.actorId}".` });
        }
        if (outcome.kind === "script" && !outcome.scriptId) {
            issues.push({ path: `expectedOutcomes.${index}.scriptId`, message: "Script outcome requires a script." });
        }
        if (outcome.kind === "finish-zone") {
            const hasFinishZone = scenario.triggers.some((trigger) => (
                ["zone-enter", "zone-exit"].includes(trigger.condition.kind)
                && trigger.condition.zoneId === outcome.zoneId
                && trigger.actions.some((action) => action.kind === "finish")
            ));
            if (!outcome.zoneId || !hasFinishZone) {
                issues.push({ path: `expectedOutcomes.${index}`, message: "Finish-zone outcome requires its selected zone to have a finish action." });
            }
        }
    });

    scenario.parameters.forEach((parameter, index) => {
        if (!parameterValueMatches(parameter.type, parameter.default)) {
            issues.push({ path: `parameters.${index}.default`, message: `Default value does not match ${parameter.type}.` });
        }
        if (!PARAMETER_TARGET_KINDS.includes(parameter.target?.kind)) {
            issues.push({ path: `parameters.${index}.target.kind`, message: "Target must be a scalar field, script input, or scenario signal." });
        } else if (["scalar-field", "scenario-signal"].includes(parameter.target.kind) && !parameter.target.path) {
            issues.push({ path: `parameters.${index}.target.path`, message: `${parameter.target.kind} target requires a path.` });
        } else if (parameter.target.kind === "scalar-field") {
            const target = validateScalarParameterTarget(scenario, parameter, { owner: "scenario" });
            if (!target.ok) issues.push({ path: `parameters.${index}.target.path`, message: target.message });
        } else if (parameter.target.kind === "script-input" && (!parameter.target.scriptId || !parameter.target.input)) {
            issues.push({ path: `parameters.${index}.target`, message: "Script-input target requires a script and input port." });
        }
    });
    return { ok: issues.length === 0, scenario, issues };
}

export function createScenarioCatalog(value = {}) {
    return normalizeScenarioCatalog({
        kind: SCENARIO_CATALOG_KIND,
        version: SCENARIO_CATALOG_VERSION,
        folders: [],
        ...value,
    });
}

export function normalizeScenarioCatalog(value = {}) {
    const source = object(value);
    if (source.kind !== undefined && source.kind !== SCENARIO_CATALOG_KIND) {
        throw new Error(`Unsupported scenario catalog kind: ${JSON.stringify(source.kind)}.`);
    }
    if (source.version !== undefined && Number(source.version) !== SCENARIO_CATALOG_VERSION) {
        throw new Error(`Unsupported scenario catalog version ${source.version}.`);
    }
    const seen = new Set();
    const catalog = {
        kind: SCENARIO_CATALOG_KIND,
        version: SCENARIO_CATALOG_VERSION,
        folders: (Array.isArray(source.folders) ? source.folders : []).map((folder, index) => ({
            id: text(folder?.id, makeId("folder", index)),
            name: text(folder?.name, `Folder ${index + 1}`),
        })).filter((folder) => {
            if (seen.has(folder.id)) return false;
            seen.add(folder.id);
            return true;
        }),
    };
    // Storage metadata is deliberately optional for authored/in-memory catalogs,
    // but must survive normalization once the singleton document is persisted so
    // callers can send its revision back for optimistic concurrency checks.
    if (source.revision !== undefined) {
        catalog.revision = Math.max(0, nonNegativeInt(source.revision, 0));
    }
    if (source.definitionHash !== undefined) catalog.definitionHash = text(source.definitionHash) || null;
    if (source.createdAt !== undefined) catalog.createdAt = text(source.createdAt) || null;
    if (source.updatedAt !== undefined) catalog.updatedAt = text(source.updatedAt) || null;
    return catalog;
}

export function stripScenarioMetadata(value) {
    const volatile = new Set(["revision", "definitionHash", "createdAt", "updatedAt"]);
    const visit = (entry) => {
        if (Array.isArray(entry)) return entry.map(visit);
        if (!entry || typeof entry !== "object") return entry;
        return Object.fromEntries(Object.entries(entry)
            .filter(([key]) => !volatile.has(key))
            .map(([key, nested]) => [key, visit(nested)]));
    };
    return visit(value);
}
