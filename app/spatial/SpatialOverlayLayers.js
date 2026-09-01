'use client';

import { worldPointFromPose } from "./trajectorySimplify.js";

const CURSOR_SIZE = 1.4;

function headingWedge(origin, heading, length = CURSOR_SIZE) {
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const tip = { x: origin.x + cos * length, z: origin.z + sin * length };
    const left = {
        x: origin.x + Math.cos(heading + 2.4) * length * 0.55,
        z: origin.z + Math.sin(heading + 2.4) * length * 0.55,
    };
    const right = {
        x: origin.x + Math.cos(heading - 2.4) * length * 0.55,
        z: origin.z + Math.sin(heading - 2.4) * length * 0.55,
    };
    return `${tip.x},${tip.z} ${left.x},${left.z} ${right.x},${right.z}`;
}

function boxFootprint(detection, scale = 1) {
    const center = detection?.center || detection?.position || {};
    const size = detection?.size || detection?.dimensions || {};
    const yaw = Number(detection?.yaw ?? detection?.rotation?.y ?? 0);
    const halfX = Math.max(0.2, Number(size.x || size.length || 1) * scale / 2);
    const halfZ = Math.max(0.2, Number(size.z || size.width || 1) * scale / 2);
    const cx = Number(center.x) || 0;
    const cz = Number(center.z) || 0;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const corners = [
        [-halfX, -halfZ], [halfX, -halfZ], [halfX, halfZ], [-halfX, halfZ],
    ].map(([dx, dz]) => ({
        x: cx + dx * cos - dz * sin,
        z: cz + dx * sin + dz * cos,
    }));
    return corners.map((point) => `${point.x},${point.z}`).join(" ");
}

export default function SpatialOverlayLayers({
    model,
    autonomy = null,
    layers,
    toScreen,
    onSeek,
    hoveredEventId = null,
}) {
    if (!model || !toScreen) return null;

    const routeScreen = model.routePoints.map(toScreen).filter(Boolean);
    const routePath = routeScreen.map((point) => `${point.x},${point.y}`).join(" ");

    return (
        <g data-map-interactive aria-hidden="true">
            {layers.route && routePath && (
                <polyline
                    points={routePath}
                    fill="none"
                    stroke="#64748b"
                    strokeWidth="2"
                    strokeDasharray="6 5"
                    strokeLinecap="round"
                    opacity="0.85"
                />
            )}

            {layers.trails && model.trails.map((trail) => {
                const points = trail.segment.map((sample) => toScreen(worldPointFromPose(sample))).filter(Boolean);
                if (points.length < 2) return null;
                const path = points.map((point) => `${point.x},${point.y}`).join(" ");
                return (
                    <g key={trail.path}>
                        <polyline
                            points={path}
                            fill="none"
                            stroke={trail.color}
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity="0.92"
                        />
                        {onSeek && points.map((point, index) => (
                            <circle
                                key={`${trail.path}-${index}`}
                                cx={point.x}
                                cy={point.y}
                                r="6"
                                fill="transparent"
                                stroke="transparent"
                                data-map-interactive
                                onClick={() => onSeek(trail.segment[index]?.timeUs)}
                            />
                        ))}
                    </g>
                );
            })}

            {layers.events && model.events.map((event, index) => {
                const trail = model.trails.find((entry) => entry.entityId === model.primaryEntityId) || model.trails[0];
                const sample = trail?.samples?.find((entry) => Math.abs(entry.timeUs - event.timeUs) < 50_000)
                    || trail?.samples?.reduce((best, entry) => (
                        !best || Math.abs(entry.timeUs - event.timeUs) < Math.abs(best.timeUs - event.timeUs) ? entry : best
                    ), null);
                if (!sample) return null;
                const point = toScreen(worldPointFromPose(sample));
                if (!point) return null;
                const active = hoveredEventId === `${event.timeUs}-${index}`;
                return (
                    <g key={`${event.timeUs}-${index}`} data-map-interactive onClick={() => onSeek?.(event.timeUs)}>
                        <circle cx={point.x} cy={point.y} r={active ? 7 : 5} fill="#f59e0b" opacity={active ? 1 : 0.85} />
                        <circle cx={point.x} cy={point.y} r="12" fill="transparent" />
                    </g>
                );
            })}

            {layers.localization && autonomy?.localization?.estimate?.position && (() => {
                const estimate = autonomy.localization.estimate.position;
                const point = toScreen({ x: estimate.x, z: estimate.z });
                if (!point) return null;
                return (
                    <g>
                        <circle cx={point.x} cy={point.y} r="5" fill="none" stroke="#34d399" strokeWidth="2" />
                        {autonomy.localization.error && model.cursor && (() => {
                            const truth = toScreen(worldPointFromPose(model.cursor));
                            if (!truth) return null;
                            return <line x1={truth.x} y1={truth.y} x2={point.x} y2={point.y} stroke="#fbbf24" strokeWidth="1.5" strokeDasharray="4 3" />;
                        })()}
                    </g>
                );
            })()}

            {layers.perception && autonomy?.perception?.detections3d?.map((detection, index) => {
                const footprint = boxFootprint(detection);
                const screenPoints = footprint.split(" ").map((pair) => {
                    const [x, z] = pair.split(",").map(Number);
                    return toScreen({ x, z });
                }).filter(Boolean);
                if (screenPoints.length < 3) return null;
                return (
                    <polygon
                        key={`candidate-${index}`}
                        points={screenPoints.map((point) => `${point.x},${point.y}`).join(" ")}
                        fill="rgb(56 189 248 / 0.12)"
                        stroke="#38bdf8"
                        strokeWidth="1.5"
                    />
                );
            })}

            {layers.cursor && model.cursor && (() => {
                const origin = worldPointFromPose(model.cursor);
                const screen = toScreen(origin);
                if (!screen) return null;
                const wedge = headingWedge(origin, model.cursorHeading)
                    .split(" ")
                    .map((pair) => {
                        const [x, z] = pair.split(",").map(Number);
                        const projected = toScreen({ x, z });
                        return projected ? `${projected.x},${projected.y}` : null;
                    })
                    .filter(Boolean)
                    .join(" ");
                return (
                    <g>
                        <polygon points={wedge} fill="#f8fafc" opacity="0.95" />
                        <circle cx={screen.x} cy={screen.y} r="4.5" fill="#f8fafc" stroke="#181a1b" strokeWidth="1.5" />
                    </g>
                );
            })()}
        </g>
    );
}
