import { proposeSensorWiring } from "../simulation/sensors/SensorWiring.js";
import {
    isControlsCommandTopic,
    scenarioUsesExternalRosForTopic,
} from "../autonomy/AutonomyContractCatalog.js";
import {
    CONTROL_AUTHORITY_MODES,
    RUN_LOGGING_POLICIES,
    RUN_PACING_MODES,
    createDefaultRunManifest,
    normalizeControlsConfig,
    normalizeRunManifest,
    stripRunMetadata,
} from "../simulation/RunManifest.js";
import { stampManifestPluginSelectionForVehicleLock } from "../plugin/PluginSensorAuthoring.js";
import {
    enableSensorInheritance,
    resolveInheritedVehicleSelection,
} from "../simulation/sensors/SensorInheritance.js";
import { finiteOr, plainObject } from "../util/plainGeometry.js";

export const EXECUTION_PROFILE_IDS = Object.freeze(["standard", "external"]);

export const EXECUTION_PROFILE_LABELS = Object.freeze({
    standard: "Standard Simulation",
    external: "External Controller",
    custom: "Custom",
});

const LOCAL_CONTROLLER_KINDS = new Set(["route-follower", "script", "script-with-route"]);
const IGNORED_OVERRIDE_KEYS = new Set([
    "kind",
    "version",
    "id",
    "name",
    "description",
    "scenario",
    "environment",
    "autonomyCatalog",
]);

function requiredProfile(profileId) {
    if (profileId !== "standard" && profileId !== "external") {
        throw new TypeError(`Unknown execution profile "${profileId}".`);
    }
    return profileId;
}

function pacingOf(manifest) {
    const pacing = manifest?.clock?.pacing;
    return RUN_PACING_MODES.includes(pacing) ? pacing : "realtime";
}

function speedOf(manifest) {
    return Math.max(0, finiteOr(manifest?.clock?.speed, 1));
}

function publishClockOf(manifest) {
    return manifest?.clock?.publishClock !== false;
}

function authorityOf(manifest) {
    const authority = manifest?.controls?.authority;
    if (CONTROL_AUTHORITY_MODES.includes(authority)) return authority;
    return manifest?.scenario?.id ? "reference" : "candidate";
}

function loggingPolicyOf(manifest) {
    const policy = manifest?.logging?.policy;
    return RUN_LOGGING_POLICIES.includes(policy) ? policy : "optional";
}

function egoControlSource(manifest, scenario) {
    if (!manifest?.scenario?.id) {
        return {
            kind: "direct-command",
            scriptId: null,
            topicId: null,
            routePath: null,
            withhold: false,
        };
    }
    if (!scenario) {
        return {
            kind: "unknown",
            scriptId: null,
            topicId: null,
            routePath: "scenario",
            withhold: true,
        };
    }
    const routes = Array.isArray(scenario.routes) ? scenario.routes : [];
    const index = routes.findIndex((route) => route?.actorId === "ego");
    if (index < 0) {
        return {
            kind: "unknown",
            scriptId: null,
            topicId: null,
            routePath: "routes",
            withhold: false,
        };
    }
    const controller = plainObject(routes[index]?.controller);
    return {
        kind: controller.kind || "unknown",
        scriptId: controller.scriptId || null,
        topicId: controller.topicId || null,
        routePath: `routes.${index}.controller`,
        withhold: false,
    };
}

function publicControlSource(source) {
    return {
        kind: source.kind,
        scriptId: source.scriptId,
        topicId: source.topicId,
        routePath: source.routePath,
    };
}

function issue(code, path, surface, message) {
    return { code, path, surface, message };
}

function missingExternalTopic(manifest, scenario, source) {
    if (!source.topicId) {
        return issue(
            "missing-external-topic",
            source.routePath ? `${source.routePath}.topicId` : "routes",
            "scenario",
            "The ego external-ros controller has no topic id. This preset does not set one.",
        );
    }
    const topics = Array.isArray(manifest?.topics) ? manifest.topics : [];
    if (!topics.some((topic) => scenarioUsesExternalRosForTopic(scenario, topic))) {
        return issue(
            "missing-external-topic",
            "topics",
            "topics",
            `No manifest topic matches "${source.topicId}". This preset does not add one.`,
        );
    }
    return null;
}

function profileIssues(profileId, manifest, scenario, source) {
    if (source.withhold) {
        return [issue(
            "scenario-not-loaded",
            "scenario",
            "scenario",
            "The scenario document is not loaded, so the execution profile was not applied.",
        )];
    }
    const issues = [];
    if (profileId === "standard" && !LOCAL_CONTROLLER_KINDS.has(source.kind)) {
        issues.push(issue(
            "missing-local-controller",
            source.routePath || "scenario",
            "scenario",
            "Standard Simulation needs the scenario ego to use a route follower, script, or script-with-route controller.",
        ));
    }
    if (profileId === "external" && LOCAL_CONTROLLER_KINDS.has(source.kind)) {
        issues.push(issue(
            "local-controller-ignores-candidate",
            source.routePath,
            "scenario",
            `The ego ${source.kind} controller runs in the simulator and does not consume candidate command input. This preset does not change that controller.`,
        ));
    }
    if (profileId === "external" && source.kind === "external-ros") {
        const topicIssue = missingExternalTopic(manifest, scenario, source);
        if (topicIssue) issues.push(topicIssue);
    }
    if (profileId === "external" && source.kind === "direct-command") {
        const topics = Array.isArray(manifest?.topics) ? manifest.topics : [];
        if (!topics.some((topic) => isControlsCommandTopic(topic))) {
            issues.push(issue(
                "missing-controls-topic",
                "topics",
                "topics",
                "Candidate authority reads /controls/command. This preset does not add that topic.",
            ));
        }
    }
    return issues;
}

function authorityFor(profileId, source) {
    if (source.withhold) return null;
    if (profileId === "standard") return "reference";
    return source.kind === "external-ros" ? "reference" : "candidate";
}

// Full manifest normalization rewrites sensors and topics; the preset only touches these leaves.
function applyProfilePatch(manifest, profileId, source) {
    const next = structuredClone(manifest);
    const authority = authorityFor(profileId, source);
    if (authority) {
        const controls = plainObject(next.controls);
        next.controls = normalizeControlsConfig({
            ...controls,
            authority,
        }, {
            targetVehicleId: controls.targetVehicleId || next.initialState?.vehicles?.[0]?.id || "ego",
        });
    }
    next.clock = {
        ...plainObject(next.clock),
        pacing: "realtime",
        speed: Math.max(0, finiteOr(1, 1)),
        ...(profileId === "external" ? { publishClock: true } : {}),
    };
    if (profileId === "standard") {
        next.logging = { ...plainObject(next.logging), policy: "optional" };
    }
    return next;
}

function previewChanges(before, after, profileId) {
    const changes = [];
    diffValues(before?.controls, after?.controls, "controls", changes);
    const clockKeys = profileId === "external" ? ["pacing", "speed", "publishClock"] : ["pacing", "speed"];
    for (const key of clockKeys) {
        diffValues(before?.clock?.[key], after?.clock?.[key], `clock.${key}`, changes);
    }
    if (profileId === "standard") {
        diffValues(before?.logging?.policy, after?.logging?.policy, "logging.policy", changes);
    }
    return changes
        .map(({ path, before: previous, after: value }) => ({ path, before: previous, after: value }))
        .sort((left, right) => left.path.localeCompare(right.path));
}

export function previewProfile(manifest, profileId, context = {}) {
    const profile = requiredProfile(profileId);
    const source = egoControlSource(manifest, context.scenario);
    const controlSource = publicControlSource(source);
    const issues = profileIssues(profile, manifest, context.scenario, source);
    if (source.withhold) {
        return {
            profileId: profile,
            nextManifest: manifest,
            changes: [],
            issues,
            controlSource,
            ready: false,
        };
    }
    const patched = applyProfilePatch(manifest, profile, source);
    const changes = previewChanges(manifest, patched, profile);
    return {
        profileId: profile,
        nextManifest: changes.length === 0 ? manifest : patched,
        changes,
        issues,
        controlSource,
        ready: true,
    };
}

function matchesExternal(manifest, source) {
    if (source.withhold) return false;
    const remote = source.kind === "external-ros";
    const direct = source.kind === "direct-command";
    if (!remote && !direct) return false;
    const authority = remote ? "reference" : "candidate";
    return pacingOf(manifest) === "realtime"
        && speedOf(manifest) === 1
        && publishClockOf(manifest)
        && authorityOf(manifest) === authority;
}

function matchesStandard(manifest, source) {
    return LOCAL_CONTROLLER_KINDS.has(source.kind)
        && pacingOf(manifest) === "realtime"
        && speedOf(manifest) === 1
        && authorityOf(manifest) === "reference"
        && loggingPolicyOf(manifest) === "optional";
}

export function inferExecutionProfile(manifest, context = {}) {
    const source = egoControlSource(manifest, context.scenario);
    const controlSource = publicControlSource(source);
    if (matchesExternal(manifest, source)) {
        return { profileId: "external", comparisonProfileId: "external", controlSource };
    }
    if (matchesStandard(manifest, source)) {
        return { profileId: "standard", comparisonProfileId: "standard", controlSource };
    }
    return { profileId: null, comparisonProfileId: "standard", controlSource };
}

function baselineOverrides(manifest) {
    const overrides = { cameraObjectMotion: manifest?.cameraObjectMotion };
    if (manifest?.id != null) overrides.id = manifest.id;
    if (manifest?.name != null) overrides.name = manifest.name;
    if (manifest?.description != null) overrides.description = manifest.description;
    if (manifest?.scenario) overrides.scenario = manifest.scenario;
    if (manifest?.environment) overrides.environment = manifest.environment;
    if (manifest?.autonomyCatalog) overrides.autonomyCatalog = manifest.autonomyCatalog;
    return overrides;
}

function withSelectedVehicle(baseline, selection) {
    const actorId = selection.actorId || "ego";
    const vehicles = (baseline.initialState?.vehicles ?? []).map((vehicle) => ({ ...vehicle }));
    let index = vehicles.findIndex((vehicle) => vehicle.id === actorId);
    if (index < 0 && vehicles.length > 0) {
        index = 0;
        vehicles[0] = { ...vehicles[0], id: actorId };
    }
    if (index >= 0 && selection.vehicleId) {
        vehicles[index] = { ...vehicles[index], type: selection.vehicleId };
    }
    return {
        ...baseline,
        initialState: { ...baseline.initialState, vehicles },
        sensorRig: {
            ...plainObject(baseline.sensorRig),
            vehicleId: actorId,
            sensors: [],
        },
    };
}

export function buildComparisonBaseline(manifest, profileId, context = {}) {
    const profile = profileId === "external" ? "external" : "standard";
    const source = egoControlSource(manifest, context.scenario);
    const issues = [];
    let baseline = withSelectedVehicle(
        createDefaultRunManifest(baselineOverrides(manifest)),
        resolveInheritedVehicleSelection(manifest),
    );
    if (context.vehicleManifest) {
        const inherited = enableSensorInheritance(baseline, context.vehicleManifest);
        baseline = inherited.manifest;
        const wiring = proposeSensorWiring(baseline, { registry: context.sensorRegistry });
        baseline = wiring.manifest;
        for (const entry of wiring.issues) issues.push(issue("sensor-wiring", "sensorRig", "sensors", entry.message));
        for (const entry of inherited.issues) {
            issues.push(issue("inheritance", entry.path, "sensors", entry.message));
        }
        for (const lock of context.vehicleManifest.pluginLocks ?? []) {
            try {
                const plugins = stampManifestPluginSelectionForVehicleLock(baseline.plugins, lock);
                if (plugins) baseline = { ...baseline, plugins };
            } catch (error) {
                issues.push(issue(
                    "plugin-grant",
                    "plugins",
                    "plugins",
                    error instanceof Error ? error.message : String(error),
                ));
            }
        }
    } else {
        const vehicleId = resolveInheritedVehicleSelection(manifest).vehicleId;
        issues.push(issue(
            "missing-vehicle",
            "sensorRig.inheritance",
            "sensors",
            vehicleId
                ? `Sensor inheritance requires vehicle "${vehicleId}".`
                : "Sensor inheritance requires a selected vehicle.",
        ));
    }
    if (source.withhold && profile === "external") {
        issues.push(issue(
            "scenario-not-loaded",
            "scenario",
            "scenario",
            "The scenario document is not loaded, so the baseline keeps default candidate authority.",
        ));
    }
    baseline = applyProfilePatch(baseline, profile, source);
    if (profile === "external" && RUN_LOGGING_POLICIES.includes(manifest?.logging?.policy)) {
        baseline = {
            ...baseline,
            logging: { ...plainObject(baseline.logging), policy: manifest.logging.policy },
        };
    }
    return {
        profileId: profile,
        manifest: normalizeRunManifest(baseline),
        issues,
    };
}

function isPlain(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectionId(path, entry) {
    if (path === "scripts.bindingIds") return String(entry);
    if (path === "sensorTransports.bindings") {
        if (!isPlain(entry)) return null;
        return [entry.sensorId, entry.productId, entry.streamId, entry.adapter].join("/");
    }
    if (path === "provenance.candidateModels") {
        if (!isPlain(entry)) return null;
        return entry.modelId || entry.digest || null;
    }
    if (path === "plugins.artifacts") return entry?.pluginId || null;
    if (path === "scripts.artifacts") return entry?.scriptId || null;
    if (isPlain(entry) && entry.id) return String(entry.id);
    return null;
}

function diffIdSet(path, before, after, out) {
    const beforeIds = new Set(before.map((entry) => String(entry)));
    const afterIds = new Set(after.map((entry) => String(entry)));
    for (const id of [...beforeIds].sort()) {
        if (afterIds.has(id)) continue;
        const groupPath = `${path}[${id}]`;
        out.push({ path: groupPath, before: id, after: undefined, groupId: groupPath });
    }
    for (const id of [...afterIds].sort()) {
        if (beforeIds.has(id)) continue;
        const groupPath = `${path}[${id}]`;
        out.push({ path: groupPath, before: undefined, after: id, groupId: groupPath });
    }
}

function diffByStableId(path, before, after, beforeIds, afterIds, out) {
    const afterById = new Map(afterIds.map((id, index) => [id, after[index]]));
    const seen = new Set();
    beforeIds.forEach((id, index) => {
        const groupPath = `${path}[${id}]`;
        if (!afterById.has(id)) {
            out.push({ path: groupPath, before: before[index], after: undefined, groupId: groupPath });
            return;
        }
        seen.add(id);
        const nested = [];
        diffValues(before[index], afterById.get(id), groupPath, nested);
        for (const change of nested) {
            out.push({ ...change, groupId: change.groupId ?? groupPath });
        }
    });
    afterIds.forEach((id, index) => {
        if (seen.has(id)) return;
        const groupPath = `${path}[${id}]`;
        out.push({ path: groupPath, before: undefined, after: after[index], groupId: groupPath });
    });
}

// shortcut: duplicate ids keep index pairing, upgrade if catalogs can emit them.
function diffByIndex(path, before, after, out) {
    const count = Math.max(before.length, after.length);
    for (let index = 0; index < count; index += 1) {
        diffValues(before[index], after[index], `${path}.${index}`, out);
    }
}

function diffCollection(path, left, right, out) {
    const before = Array.isArray(left) ? left : [];
    const after = Array.isArray(right) ? right : [];
    if (path === "scripts.bindingIds") {
        diffIdSet(path, before, after, out);
        return;
    }
    const beforeIds = before.map((entry) => collectionId(path, entry));
    const afterIds = after.map((entry) => collectionId(path, entry));
    const keyed = beforeIds.every(Boolean) && afterIds.every(Boolean);
    const duplicate = keyed && (
        new Set(beforeIds).size !== beforeIds.length || new Set(afterIds).size !== afterIds.length
    );
    if (!keyed || duplicate) {
        diffByIndex(path, before, after, out);
        return;
    }
    diffByStableId(path, before, after, beforeIds, afterIds, out);
}

function diffValues(left, right, path, out) {
    if (Object.is(left, right)) return;
    const leftPlain = isPlain(left);
    const rightPlain = isPlain(right);
    if (leftPlain || rightPlain) {
        if ((leftPlain && rightPlain) || left == null || right == null) {
            const leftObject = leftPlain ? left : {};
            const rightObject = rightPlain ? right : {};
            const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort();
            for (const key of keys) {
                diffValues(leftObject[key], rightObject[key], path ? `${path}.${key}` : key, out);
            }
            return;
        }
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if ((Array.isArray(left) && Array.isArray(right)) || left == null || right == null) {
            diffCollection(path, left, right, out);
            return;
        }
    }
    out.push({ path, before: left, after: right, groupId: null });
}

function overrideProjection(manifest, { scenarioOwnsInitialState = false, actorId = "ego" } = {}) {
    const copy = stripRunMetadata(manifest ?? {});
    for (const key of IGNORED_OVERRIDE_KEYS) delete copy[key];
    const vehicles = copy.initialState?.vehicles;
    if (!Array.isArray(vehicles)) return copy;
    copy.initialState = {
        ...copy.initialState,
        vehicles: vehicles.map((vehicle) => {
            if (!isPlain(vehicle) || vehicle.id !== actorId) return vehicle;
            const next = { ...vehicle };
            delete next.type;
            if (scenarioOwnsInitialState) {
                delete next.pose;
                delete next.linearVelocity;
                delete next.steeringAngle;
            }
            return next;
        }),
    };
    return copy;
}

export function compareOverrides(current, baseline, options = {}) {
    const changes = [];
    diffValues(
        overrideProjection(baseline, options),
        overrideProjection(current, options),
        "",
        changes,
    );
    return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function sameComparisonSession(previous, manifest, scenarioId) {
    return Boolean(previous)
        && previous.manifestId === (manifest?.id ?? null)
        && previous.scenarioId === scenarioId
        && (previous.profileId === "standard" || previous.profileId === "external");
}

export function retainComparisonProfile(previous, manifest, context = {}) {
    const scenarioId = manifest?.scenario?.id ?? null;
    const inference = inferExecutionProfile(manifest, context);
    const withheld = Boolean(scenarioId) && !context.scenario;
    const sameSession = sameComparisonSession(previous, manifest, scenarioId);
    if (withheld) {
        return {
            retained: sameSession ? previous : null,
            inference: {
                ...inference,
                comparisonProfileId: sameSession ? previous.profileId : inference.comparisonProfileId,
            },
        };
    }
    if (sameSession) {
        return {
            retained: previous,
            inference: { ...inference, comparisonProfileId: previous.profileId },
        };
    }
    const retained = {
        manifestId: manifest?.id ?? null,
        scenarioId,
        profileId: inference.comparisonProfileId,
    };
    return {
        retained,
        inference: { ...inference, comparisonProfileId: retained.profileId },
    };
}

export function classifyConfiguration(manifest, context = {}) {
    const inference = inferExecutionProfile(manifest, context);
    const comparisonProfileId = context.comparisonProfileId === "external" || context.comparisonProfileId === "standard"
        ? context.comparisonProfileId
        : inference.comparisonProfileId;
    const built = buildComparisonBaseline(manifest, comparisonProfileId, context);
    const actorId = resolveInheritedVehicleSelection(manifest).actorId || "ego";
    const overrides = compareOverrides(manifest, built.manifest, {
        scenarioOwnsInitialState: Boolean(manifest?.scenario?.id),
        actorId,
    });
    const matched = inference.profileId != null
        && inference.profileId === comparisonProfileId
        && overrides.length === 0;
    return {
        profileId: inference.profileId,
        comparisonProfileId,
        label: matched
            ? EXECUTION_PROFILE_LABELS[inference.profileId]
            : EXECUTION_PROFILE_LABELS.custom,
        baselineName: EXECUTION_PROFILE_LABELS[comparisonProfileId],
        controlSource: inference.controlSource,
        baseline: built.manifest,
        baselineIssues: built.issues,
        overrides,
    };
}

// shortcut: bracket ids that contain ] or . do not round-trip, upgrade if a catalog id needs encoding.
function pathTokens(path) {
    return String(path ?? "").split(".").filter(Boolean).map((part) => {
        const match = /^([^[]+)(?:\[(.*)\])?$/.exec(part);
        return match ? { key: match[1], id: match[2] ?? null } : { key: part, id: null };
    });
}

function childAt(cursor, token, walked) {
    if (cursor == null || typeof cursor !== "object") return { ok: false };
    const here = walked ? `${walked}.${token.key}` : token.key;
    if (token.id != null) {
        const list = cursor[token.key];
        if (!Array.isArray(list)) return { ok: false };
        const index = list.findIndex((entry) => collectionId(here, entry) === token.id);
        if (index < 0) return { ok: false };
        return { ok: true, value: list[index], here };
    }
    if (Array.isArray(cursor) && /^\d+$/.test(token.key)) {
        const index = Number(token.key);
        if (index < 0 || index >= cursor.length) return { ok: false };
        return { ok: true, value: cursor[index], here: token.key };
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, token.key)) return { ok: false };
    return { ok: true, value: cursor[token.key], here };
}

export function valueAtOverridePath(manifest, path) {
    const tokens = pathTokens(path);
    let cursor = manifest;
    let walked = "";
    for (const token of tokens) {
        const step = childAt(cursor, token, walked);
        if (!step.ok) return { ok: false, value: undefined };
        cursor = step.value;
        walked = token.id != null ? `${step.here}[${token.id}]` : step.here;
    }
    return { ok: tokens.length > 0, value: cursor };
}

function writeOverridePath(root, path, value) {
    const tokens = pathTokens(path);
    if (tokens.length === 0) return false;
    let cursor = root;
    let walked = "";
    for (let index = 0; index < tokens.length - 1; index += 1) {
        const token = tokens[index];
        const step = childAt(cursor, token, walked);
        if (!step.ok || step.value == null || typeof step.value !== "object") return false;
        cursor = step.value;
        walked = token.id != null ? `${step.here}[${token.id}]` : step.here;
    }
    const last = tokens.at(-1);
    const here = walked ? `${walked}.${last.key}` : last.key;
    if (last.id != null) {
        const list = cursor?.[last.key];
        if (!Array.isArray(list)) return false;
        const index = list.findIndex((entry) => collectionId(here, entry) === last.id);
        if (value === undefined) {
            if (index >= 0) list.splice(index, 1);
            return true;
        }
        if (index >= 0) list[index] = value;
        else list.push(value);
        return true;
    }
    if (Array.isArray(cursor) && /^\d+$/.test(last.key)) {
        const index = Number(last.key);
        if (value === undefined) {
            if (index >= 0 && index < cursor.length) cursor.splice(index, 1);
            return true;
        }
        cursor[index] = value;
        return true;
    }
    if (cursor == null || typeof cursor !== "object" || Array.isArray(cursor)) return false;
    if (value === undefined) delete cursor[last.key];
    else cursor[last.key] = value;
    return true;
}

export function previewOverrideReset(manifest, change, options = {}) {
    const next = structuredClone(manifest);
    if (!writeOverridePath(next, change?.path, change?.before)) {
        return { nextManifest: manifest, changes: [] };
    }
    const normalized = normalizeRunManifest(next, options);
    const changes = [];
    diffValues(manifest, normalized, "", changes);
    return {
        nextManifest: changes.length === 0 ? manifest : normalized,
        changes: changes
            .map(({ path, before, after }) => ({ path, before, after }))
            .sort((left, right) => left.path.localeCompare(right.path)),
    };
}
