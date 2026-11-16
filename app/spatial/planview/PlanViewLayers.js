'use client';

import { occupancyScreenRect } from "./occupancy/paint.js";

function screenRadius(centerWorld, radiusM, toScreen) {
    const center = toScreen(centerWorld);
    const edge = toScreen({ x: centerWorld.x + radiusM, z: centerWorld.z });
    if (!center || !edge) return 0;
    return Math.hypot(edge.x - center.x, edge.y - center.y);
}

function pointsAttribute(points, toScreen) {
    return points
        .map((point) => toScreen(point))
        .filter(Boolean)
        .map((point) => `${point.x},${point.y}`)
        .join(" ");
}

function pickableProps(primitive, onSelectActor) {
    if (!primitive.actorId) return { style: { pointerEvents: "none" } };
    return {
        "data-actor-id": primitive.actorId,
        "data-map-interactive": true,
        style: { pointerEvents: "auto", cursor: "pointer" },
        onPointerDown: (event) => {
            event.stopPropagation();
            onSelectActor?.(primitive.actorId);
        },
    };
}

function OccupancyImage({ sample, viewport, size, canvasRef }) {
    const rect = occupancyScreenRect(sample, viewport, size);
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    const image = (
        <foreignObject x={rect.x} y={rect.y} width={rect.width} height={rect.height} style={{ pointerEvents: "none" }}>
            <div xmlns="http://www.w3.org/1999/xhtml" style={{ width: "100%", height: "100%", pointerEvents: "none" }}>
                <canvas
                    ref={canvasRef}
                    style={{ display: "block", width: "100%", height: "100%", imageRendering: "pixelated" }}
                />
            </div>
        </foreignObject>
    );
    if (!rect.rotationDeg) return image;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return <g transform={`rotate(${rect.rotationDeg} ${cx} ${cy})`}>{image}</g>;
}

export function PlanViewLayers({ primitives = [], toScreen, onSelectActor, occupancy = [], viewport, size }) {
    if (!toScreen) return null;
    return (
        <g data-plan-view>
            {occupancy.map((entry) => (
                <OccupancyImage
                    key={entry.key}
                    sample={entry.sample}
                    viewport={viewport}
                    size={size}
                    canvasRef={entry.canvasRef}
                />
            ))}
            {primitives.map((primitive, index) => {
                const key = `${primitive.layerId}-${index}`;
                if (primitive.kind === "polygon" || primitive.kind === "polyline") {
                    const points = pointsAttribute(primitive.points ?? [], toScreen);
                    if (!points) return null;
                    const shared = {
                        points,
                        fill: primitive.kind === "polygon" ? (primitive.fill || "none") : "none",
                        stroke: primitive.stroke || "none",
                        strokeWidth: primitive.strokeWidth ?? 1.5,
                        strokeDasharray: primitive.dash,
                        strokeLinejoin: "round",
                        strokeLinecap: "round",
                        opacity: primitive.opacity,
                    };
                    if (primitive.kind === "polygon") {
                        return <polygon key={key} {...shared} {...pickableProps(primitive, onSelectActor)} />;
                    }
                    return <polyline key={key} {...shared} style={{ pointerEvents: "none" }} />;
                }
                if (primitive.kind === "circle") {
                    const center = toScreen(primitive.center);
                    if (!center) return null;
                    const radius = primitive.radiusM
                        ? screenRadius(primitive.center, primitive.radiusM, toScreen)
                        : (primitive.radiusPx ?? 4);
                    if (!(radius > 0)) return null;
                    return (
                        <circle
                            key={key}
                            cx={center.x}
                            cy={center.y}
                            r={radius}
                            fill={primitive.fill || "none"}
                            stroke={primitive.stroke || "none"}
                            strokeWidth={primitive.strokeWidth ?? 1.5}
                            {...pickableProps(primitive, onSelectActor)}
                        />
                    );
                }
                if (primitive.kind === "label") {
                    const anchor = toScreen(primitive.anchor);
                    if (!anchor || !primitive.text) return null;
                    return (
                        <text
                            key={key}
                            x={anchor.x}
                            y={anchor.y - 10}
                            textAnchor="middle"
                            fill="#f8fafc"
                            fontSize="11"
                            fontFamily="ui-sans-serif, system-ui, sans-serif"
                            style={{ pointerEvents: "none" }}
                        >
                            {primitive.text}
                        </text>
                    );
                }
                return null;
            })}
        </g>
    );
}
