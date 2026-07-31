import { createDefaultScenario } from "../ScenarioDocument.js";

export const SCENARIO_TABS = [
    { id: "overview", label: "Overview" },
    { id: "routes", label: "Routes" },
    { id: "actors", label: "Actors" },
    { id: "zones", label: "Zones & triggers" },
    { id: "timeline", label: "Timeline" },
    { id: "completion", label: "Completion" },
    { id: "outcomes", label: "Expected outcomes" },
];

export const CONTROLLER_OPTIONS = [
    { value: "route-follower", label: "Built-in route follower" },
    { value: "external-ros", label: "External ROS" },
    { value: "script", label: "Script" },
    { value: "script-with-route", label: "Script with Route input" },
];

export const TRIGGER_CONDITIONS = [
    { value: "zone-enter", label: "Actor enters zone" },
    { value: "zone-exit", label: "Actor exits zone" },
    { value: "time", label: "Simulation time" },
    { value: "step", label: "Simulation step" },
    { value: "signal", label: "Signal comparison" },
    { value: "flag", label: "Scenario flag" },
    { value: "actor-distance", label: "Distance between actors" },
];

export const TRIGGER_ACTIONS = [
    { value: "finish", label: "Finish scenario" },
    { value: "set-flag", label: "Set scenario flag" },
    { value: "set-signal", label: "Set signal" },
    { value: "run-script", label: "Invoke script" },
    { value: "actor-command", label: "Override actor command" },
    { value: "sensor-state", label: "Enable / dropout sensor" },
];

export const COMPLETION_OPTIONS = [
    { value: "max-duration", label: "Maximum duration" },
    { value: "ego-collision", label: "Ego collision" },
    { value: "fatal-assertion", label: "Fatal assertion fails" },
    { value: "script", label: "Visual-script predicate" },
];

export const OUTCOME_OPTIONS = [
    { value: "finish-zone", label: "Ego reaches a finish zone" },
    { value: "no-collisions", label: "No collisions" },
    { value: "final-waypoint-distance", label: "Distance to final waypoint" },
    { value: "flag-true", label: "Scenario flag is true" },
    { value: "script", label: "End-only boolean script" },
];

export function slugify(value, fallback = "scenario") {
    const slug = String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || `${fallback}-${Date.now().toString(36)}`;
}

export function createScenarioDraft({ name, description = "", environmentId, folderId = null }) {
    const id = slugify(name);
    return createDefaultScenario({
        id,
        name: String(name || "Untitled scenario").trim() || "Untitled scenario",
        description: String(description || ""),
        folderId,
        environment: { id: environmentId || "igvc", expectedHash: null },
    });
}

export function scenarioDocument(value) {
    if (!value) return null;
    return value.scenario || value.document || value.manifest || value;
}

export function scenarioEntries(value) {
    const list = Array.isArray(value) ? value : value?.scenarios || value?.items || [];
    return list.map((entry) => ({
        ...entry,
        id: entry.id || entry.scenario?.id,
        name: entry.name || entry.scenario?.name || entry.id,
        description: entry.description || entry.scenario?.description || "",
        folderId: entry.folderId ?? entry.scenario?.folderId ?? null,
    })).filter((entry) => entry.id);
}

export function folderEntries(value) {
    const list = Array.isArray(value) ? value : value?.folders || [];
    return list.map((folder, index) => ({
        id: folder.id || slugify(folder.name, "folder"),
        name: folder.name || `Folder ${index + 1}`,
    }));
}

export function withUpdatedPath(source, path, value) {
    if (!path.length) return value;
    const [key, ...rest] = path;
    const copy = Array.isArray(source) ? [...source] : { ...(source || {}) };
    copy[key] = withUpdatedPath(source?.[key], rest, value);
    return copy;
}

export function buildRouteVerification(waypoints, environmentId) {
    const ordered = orderedWaypoints(waypoints);
    if (ordered.length < 2 || ordered[0]?.kind !== "start" || ordered.at(-1)?.kind !== "finish") {
        return null;
    }

    const sections = [];
    let totalLength = 0;
    for (let index = 0; index < ordered.length - 1; index += 1) {
        const from = ordered[index].position;
        const to = ordered[index + 1].position;
        const bend = { x: to.x, y: 0, z: from.z };
        const polyline = [from];
        if (Math.abs(from.x - to.x) > 0.001 && Math.abs(from.z - to.z) > 0.001) polyline.push(bend);
        polyline.push(to);
        const length = polyline.slice(1).reduce((sum, point, pointIndex) => {
            const previous = polyline[pointIndex];
            return sum + Math.hypot(point.x - previous.x, point.z - previous.z);
        }, 0);
        totalLength += length;
        sections.push({ index, fromWaypointId: ordered[index].id, toWaypointId: ordered[index + 1].id, polyline, length });
    }

    return {
        algorithm: "directed-a-star",
        environmentId,
        verifiedAt: new Date().toISOString(),
        sections,
        polyline: sections.flatMap((section, index) => index === 0 ? section.polyline : section.polyline.slice(1)),
        totalLength,
    };
}

export function orderedWaypoints(waypoints = []) {
    const start = waypoints.find((point) => point.kind === "start");
    const finish = waypoints.find((point) => point.kind === "finish");
    const middle = waypoints
        .filter((point) => point.kind === "intermediate")
        .sort((left, right) => (left.order || 0) - (right.order || 0));
    return [start, ...middle, finish].filter(Boolean);
}

export function renumberWaypoints(waypoints = []) {
    let next = 1;
    return orderedWaypoints(waypoints).map((point) => point.kind === "intermediate"
        ? { ...point, order: next++ }
        : point);
}

export function terminalTrigger(trigger) {
    const actions = trigger?.actions || (trigger?.action ? [trigger.action] : []);
    return actions.some((action) => (typeof action === "string" ? action : action?.kind) === "finish");
}

export function stableDocument(value) {
    if (!value) return "";
    const clone = structuredClone(value);
    delete clone.revision;
    delete clone.definitionHash;
    delete clone.createdAt;
    delete clone.updatedAt;
    return JSON.stringify(clone);
}
