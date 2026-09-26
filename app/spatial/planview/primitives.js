/**
 * World-space draw operations. Points are `{ x, z }` meters.
 * `actorId` makes a shape pickable. `radiusM` is a world radius;
 * `radiusPx` is a screen-space marker.
 */

export const PLAN_COLORS = Object.freeze({
    ego: "#f8fafc",
    vehicle: "#38bdf8",
    pedestrian: "#fb923c",
    cyclist: "#34d399",
    offRoad: "#f59e0b",
    collision: "#fb7185",
    routeDriven: "#e2e8f0",
    routeRemaining: "#64748b",
    trail: "#38bdf8",
    speed: "#f8fafc",
    goal: "#f59e0b",
    lane: "#a3e635",
    oracle: "#34d399",
    candidate: "#38bdf8",
    estimate: "#34d399",
    error: "#fbbf24",
    commanded: "#a78bfa",
    achieved: "#22d3ee",
    camera: "#38bdf8",
    lidar: "#a78bfa",
    signalRed: "#fb7185",
    signalYellow: "#facc15",
    signalGreen: "#34d399",
    signalUnknown: "#94a3b8",
});

export const SIGNAL_COLORS = Object.freeze({
    red: PLAN_COLORS.signalRed,
    yellow: PLAN_COLORS.signalYellow,
    green: PLAN_COLORS.signalGreen,
    unknown: PLAN_COLORS.signalUnknown,
});
