'use client';

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";

import {
    AXIS_GIZMO_SIZE,
    ORBIT_ALIGN_AXES,
    axisGizmoPixel,
    pickAxisGizmo,
    projectAxisGizmo,
    quaternionFromLookAt,
} from "./alignOrbitAxis.js";

const CENTER = AXIS_GIZMO_SIZE / 2;
const DEFAULT_QUATERNION = quaternionFromLookAt(
    { x: 4.5, y: 3, z: 4.5 },
    { x: 0, y: 0.6, z: 0 },
    { x: 0, y: 1, z: 0 },
);

const AXIS_COLOR = {
    "+x": "#ff5a5f",
    "-x": "#ff5a5f",
    "+y": "#3ddc97",
    "-y": "#3ddc97",
    "+z": "#4da3ff",
    "-z": "#4da3ff",
};

function positiveAxis(id) {
    return id.startsWith("+");
}

function facingAmount(depth) {
    return (depth + 1) / 2;
}

function paintGizmo(quaternion, refs) {
    const projected = projectAxisGizmo(quaternion);
    refs.projectedRef.current = projected;
    const ordered = projected.slice().sort((left, right) => left.depth - right.depth);
    const svg = refs.svgRef.current;
    const handles = svg?.querySelector("[data-axis-handles]");
    const lines = svg?.querySelector("[data-axis-lines]");
    for (const endpoint of ordered) {
        const pixel = axisGizmoPixel(endpoint);
        const hot = refs.hoverRef.current === endpoint.id;
        const opacity = Math.min(1, 0.3 + 0.7 * facingAmount(endpoint.depth) + (hot ? 0.2 : 0));
        const line = refs.lineRefs.current[endpoint.id];
        const group = refs.groupRefs.current[endpoint.id];
        const dot = refs.dotRefs.current[endpoint.id];
        const label = refs.labelRefs.current[endpoint.id];
        if (line) {
            line.setAttribute("x2", pixel.x.toFixed(2));
            line.setAttribute("y2", pixel.y.toFixed(2));
            line.setAttribute("opacity", opacity.toFixed(3));
        }
        if (group) group.setAttribute("transform", `translate(${pixel.x.toFixed(2)} ${pixel.y.toFixed(2)})`);
            if (dot) {
                const radius = 4 + 4.5 * facingAmount(endpoint.depth);
                dot.setAttribute("r", radius.toFixed(2));
                dot.setAttribute("opacity", opacity.toFixed(3));
            }
        if (label) {
            const visible = positiveAxis(endpoint.id) && endpoint.depth > 0.15;
            label.setAttribute("opacity", visible ? "1" : "0");
        }
    }
    const orderKey = ordered.map((endpoint) => endpoint.id).join("");
    if (orderKey !== refs.orderRef.current) {
        refs.orderRef.current = orderKey;
        for (const endpoint of ordered) {
            const line = refs.lineRefs.current[endpoint.id];
            const group = refs.groupRefs.current[endpoint.id];
            if (line && lines) lines.appendChild(line);
            if (group && handles) handles.appendChild(group);
        }
    }
}

/**
 * Top-right orientation gizmo. The studio pushes a camera quaternion each frame;
 * this component writes SVG attributes directly and does not rerender on that tick.
 */
export const AxisAlignGizmo = forwardRef(function AxisAlignGizmo({ studioRef }, ref) {
    const svgRef = useRef(null);
    const lineRefs = useRef({});
    const groupRefs = useRef({});
    const dotRefs = useRef({});
    const labelRefs = useRef({});
    const quaternionRef = useRef(DEFAULT_QUATERNION);
    const projectedRef = useRef(projectAxisGizmo(DEFAULT_QUATERNION));
    const hoverRef = useRef(null);
    const orderRef = useRef("");
    const paintRefs = useRef({
        svgRef,
        lineRefs,
        groupRefs,
        dotRefs,
        labelRefs,
        projectedRef,
        hoverRef,
        orderRef,
    });

    useLayoutEffect(() => {
        paintGizmo(quaternionRef.current, paintRefs.current);
    });

    useImperativeHandle(ref, () => ({
        sync(quaternion) {
            quaternionRef.current = quaternion;
            paintGizmo(quaternion, paintRefs.current);
        },
    }), []);

    const align = (id) => {
        studioRef.current?.alignToAxis(id);
    };

    const hoverAt = (event) => {
        const svg = svgRef.current;
        if (!svg) return null;
        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const x = ((event.clientX - rect.left) / rect.width) * AXIS_GIZMO_SIZE;
        const y = ((event.clientY - rect.top) / rect.height) * AXIS_GIZMO_SIZE;
        return pickAxisGizmo(projectedRef.current, x, y);
    };

    return (
        <div className="pointer-events-auto shrink-0 rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] p-1">
            <svg
                ref={svgRef}
                width={AXIS_GIZMO_SIZE}
                height={AXIS_GIZMO_SIZE}
                viewBox={`0 0 ${AXIS_GIZMO_SIZE} ${AXIS_GIZMO_SIZE}`}
                role="group"
                aria-label="Align camera"
                className="block cursor-pointer touch-none"
                onPointerDown={(event) => {
                    const hit = hoverAt(event);
                    if (!hit) return;
                    event.preventDefault();
                    event.stopPropagation();
                    align(hit.id);
                }}
                onPointerMove={(event) => {
                    const hit = hoverAt(event);
                    const next = hit?.id ?? null;
                    if (next === hoverRef.current) return;
                    hoverRef.current = next;
                    paintGizmo(quaternionRef.current, paintRefs.current);
                }}
                onPointerLeave={() => {
                    if (!hoverRef.current) return;
                    hoverRef.current = null;
                    paintGizmo(quaternionRef.current, paintRefs.current);
                }}
            >
                <circle cx={CENTER} cy={CENTER} r="2" fill="var(--slate-muted)" opacity="0.7" />
                <g data-axis-lines>
                    {ORBIT_ALIGN_AXES.map((axis) => (
                        <line
                            key={`line-${axis.id}`}
                            ref={(node) => { lineRefs.current[axis.id] = node; }}
                            x1={CENTER}
                            y1={CENTER}
                            x2={CENTER}
                            y2={CENTER}
                            stroke={AXIS_COLOR[axis.id]}
                            strokeWidth={positiveAxis(axis.id) ? 1.75 : 1}
                            strokeLinecap="round"
                            pointerEvents="none"
                        />
                    ))}
                </g>
                <g data-axis-handles>
                    {ORBIT_ALIGN_AXES.map((axis) => (
                        <g
                            key={axis.id}
                            ref={(node) => { groupRefs.current[axis.id] = node; }}
                            role="button"
                            tabIndex={0}
                            aria-label={axis.label}
                            className="outline-none"
                            onFocus={(event) => {
                                event.currentTarget.querySelector("[data-hit]")?.setAttribute("stroke", "var(--slate-fg)");
                            }}
                            onBlur={(event) => {
                                event.currentTarget.querySelector("[data-hit]")?.setAttribute("stroke", "transparent");
                            }}
                            onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                align(axis.id);
                            }}
                        >
                            <title>{axis.label}</title>
                            <circle data-hit r="12" fill="transparent" stroke="transparent" strokeWidth="1.5" pointerEvents="none" />
                            <circle
                                ref={(node) => { dotRefs.current[axis.id] = node; }}
                                r={positiveAxis(axis.id) ? 7 : 5}
                                fill={AXIS_COLOR[axis.id]}
                                pointerEvents="none"
                            />
                            {positiveAxis(axis.id) && (
                                <text
                                    ref={(node) => { labelRefs.current[axis.id] = node; }}
                                    textAnchor="middle"
                                    dominantBaseline="central"
                                    fill="#09090b"
                                    fontSize="9"
                                    fontWeight="700"
                                    pointerEvents="none"
                                >
                                    {axis.id.slice(1).toUpperCase()}
                                </text>
                            )}
                        </g>
                    ))}
                </g>
            </svg>
        </div>
    );
});
