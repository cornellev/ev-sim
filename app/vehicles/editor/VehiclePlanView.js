"use client";

import { useMemo, useRef } from "react";

import { layoutVehiclePlan, projectVehiclePlan } from "../plan/projectVehiclePlan.js";

function pathFrom(points) {
    return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

function arrowChange(key, kind) {
    const horizontal = key === "ArrowLeft" ? 1 : key === "ArrowRight" ? -1 : 0;
    const vertical = key === "ArrowUp" ? 1 : key === "ArrowDown" ? -1 : 0;
    if (kind === "axle" && vertical) return { axis: "x", direction: vertical };
    if (kind === "track" && horizontal) return { axis: "z", direction: horizontal };
    if (kind === "axle" && horizontal) return { axis: "z", direction: horizontal };
    if (kind === "track" && vertical) return { axis: "x", direction: vertical };
    return null;
}

export function VehiclePlanView({
    draft,
    steeringPreview = 0,
    onSteeringPreview,
    readOnly = false,
    onBeginGesture,
    onPreviewGesture,
    onCommitGesture,
    onCancelGesture,
}) {
    const svgRef = useRef(null);
    const keyGesture = useRef(null);
    const pointerRef = useRef(null);
    const projection = useMemo(
        () => projectVehiclePlan(draft, { steeringAngle: steeringPreview }),
        [draft, steeringPreview],
    );
    const layout = useMemo(() => layoutVehiclePlan(projection), [projection]);
    const limit = projection.steeringLimit;
    const preview = Math.max(-limit, Math.min(limit, Number(steeringPreview) || 0));

    const localPoint = (event) => {
        const svg = svgRef.current;
        const rect = svg.getBoundingClientRect();
        const width = rect.width || layout.width;
        const height = rect.height || layout.height;
        return {
            x: ((event.clientX - rect.left) / width) * layout.width,
            y: ((event.clientY - rect.top) / height) * layout.height,
        };
    };

    const axleOf = (id) => projection.axles.find((axle) => axle.id === id);

    const onKeyDown = (event, record, kind) => {
        if (readOnly || record.locked) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            keyGesture.current = null;
            pointerRef.current = null;
            onCancelGesture?.();
            return;
        }
        const change = arrowChange(event.key, kind);
        if (!change) return;
        event.preventDefault();
        const axle = axleOf(record.axle);
        if (!axle) return;
        if (!keyGesture.current || keyGesture.current.axle !== record.axle) {
            onBeginGesture?.(record.axle);
            keyGesture.current = { axle: record.axle, x: axle.x, z: axle.halfTrack, dx: 0, dz: 0 };
        }
        const multiplier = event.shiftKey ? 0.1 : event.altKey ? 10 : 1;
        const step = 0.01 * multiplier * change.direction;
        if (change.axis === "x") keyGesture.current.dx += step;
        else keyGesture.current.dz += step;
        onPreviewGesture?.(record.axle, {
            x: keyGesture.current.x + keyGesture.current.dx,
            z: keyGesture.current.z + keyGesture.current.dz,
        });
    };

    const finishKeys = (event) => {
        if (!keyGesture.current) return;
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && event.type !== "blur") return;
        keyGesture.current = null;
        onCommitGesture?.();
    };

    const onPointerDown = (event, record, kind) => {
        if (readOnly || record.locked || event.button !== 0) return;
        event.currentTarget.focus();
        event.preventDefault();
        event.stopPropagation();
        const axle = axleOf(record.axle);
        if (!axle) return;
        const point = localPoint(event);
        onBeginGesture?.(record.axle);
        pointerRef.current = {
            id: event.pointerId,
            kind,
            axle: record.axle,
            map: layout.vehicleFromSvg,
            start: layout.vehicleFromSvg(point.x, point.y),
            x: axle.x,
            z: axle.halfTrack,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event) => {
        const pointer = pointerRef.current;
        if (!pointer || pointer.id !== event.pointerId) return;
        const point = localPoint(event);
        const vehicle = pointer.map(point.x, point.y);
        if (pointer.kind === "track") {
            onPreviewGesture?.(pointer.axle, { z: pointer.z + (vehicle.z - pointer.start.z) });
            return;
        }
        onPreviewGesture?.(pointer.axle, { x: pointer.x + (vehicle.x - pointer.start.x) });
    };

    const onPointerUp = (event) => {
        if (!pointerRef.current || pointerRef.current.id !== event.pointerId) return;
        pointerRef.current = null;
        onCommitGesture?.();
    };

    const onPointerCancel = (event) => {
        if (!pointerRef.current || pointerRef.current.id !== event.pointerId) return;
        pointerRef.current = null;
        onCancelGesture?.();
    };

    const simulatorLabel = projection.simulator.straight
        ? "Straight"
        : `Simulator turn, R = ${projection.simulator.radius.toFixed(2)} m`;
    const showAckermann = projection.ackermann.available;

    return (
        <div data-vehicle-plan className="space-y-2">
            <svg
                ref={svgRef}
                role="group"
                aria-label="Vehicle plan, forward is up, left is left"
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                preserveAspectRatio="none"
                className="vehicle-plan h-[280px] w-full rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-surface-1)]"
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
            >
                {layout.records.filter((record) => record.kind === "body").map((record) => (
                    <rect key={record.id} x={record.x} y={record.y} width={record.width} height={record.height} fill="none" stroke="currentColor" strokeOpacity="0.45" />
                ))}
                {layout.records.filter((record) => record.kind === "wheel").map((record) => (
                    <rect key={record.id} x={record.x} y={record.y} width={record.width} height={record.height} fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeOpacity="0.7" />
                ))}
                {layout.records.filter((record) => record.kind === "simulator-arc" && record.points.length > 1).map((record) => (
                    <g key={record.id} data-construction="simulator">
                        <path d={pathFrom(record.points)} fill="none" stroke="currentColor" strokeWidth="1.5" />
                        {record.marker && <circle cx={record.marker.svgX} cy={record.marker.svgY} r="3" fill="currentColor" />}
                    </g>
                ))}
                {layout.records.filter((record) => record.kind === "ackermann-arc" && record.points.length > 1).map((record) => (
                    <g key={record.id} data-construction="ackermann">
                        <path d={pathFrom(record.points)} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
                        {record.marker && <circle cx={record.marker.svgX} cy={record.marker.svgY} r="3" fill="none" stroke="currentColor" />}
                    </g>
                ))}
                <text x="12" y="18" className="vehicle-plan__label" data-construction="simulator">{simulatorLabel}</text>
                {showAckermann && (
                    <text x="12" y="36" className="vehicle-plan__label" data-construction="ackermann">
                        <tspan x="12" dy="0">Ideal Ackermann, rear axle.</tspan>
                        <tspan x="12" dy="14">Illustration, not the predicted path.</tspan>
                    </text>
                )}
                {layout.records.filter((record) => record.kind === "axle-handle" || record.kind === "track-handle").map((record) => {
                    const kind = record.kind === "axle-handle" ? "axle" : "track";
                    const disabled = readOnly || record.locked;
                    const axleName = record.axle === "front" ? "Front" : "Rear";
                    const label = kind === "axle" ? `${axleName} axle position` : `${axleName} track`;
                    const shown = kind === "axle" ? record.value : record.value * 2;
                    const valueText = kind === "axle"
                        ? `${shown.toFixed(3)} meters forward`
                        : `${shown.toFixed(3)} meters track`;
                    return (
                        <circle
                            key={record.id}
                            className="vehicle-plan__handle"
                            cx={record.svgX}
                            cy={record.svgY}
                            r="7"
                            fill="currentColor"
                            role="slider"
                            tabIndex={disabled ? -1 : 0}
                            aria-disabled={disabled || undefined}
                            aria-label={label}
                            aria-valuemin={kind === "axle" ? -20 : 0.05}
                            aria-valuemax={kind === "axle" ? 20 : 5}
                            aria-valuenow={Number(shown.toFixed(3))}
                            aria-valuetext={valueText}
                            data-plan-handle={record.id}
                            onKeyDown={(event) => onKeyDown(event, record, kind)}
                            onKeyUp={finishKeys}
                            onBlur={finishKeys}
                            onPointerDown={(event) => onPointerDown(event, record, kind)}
                        />
                    );
                })}
            </svg>
            <ul className="space-y-1 text-[11px] text-[var(--slate-muted)]">
                {layout.records.filter((record) => record.kind === "dimension").map((record) => (
                    <li key={record.id}>{record.text}</li>
                ))}
            </ul>
            <div aria-live="polite" className="text-[11px] leading-relaxed text-[var(--slate-fg-2)]">
                {projection.diagnostics.map((entry) => entry.message).join(" ")}
            </div>
            <label className="block text-[13px] font-medium text-[var(--slate-fg-2)]">
                Preview steering angle
                <input
                    className="mt-1 w-full"
                    type="range"
                    aria-label="Preview steering angle"
                    min={-limit}
                    max={limit}
                    step={0.01}
                    value={preview}
                    disabled={readOnly}
                    onChange={(event) => onSteeringPreview?.(Number(event.target.value))}
                />
            </label>
        </div>
    );
}
