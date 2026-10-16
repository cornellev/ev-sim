"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { degToRad, radToDeg } from "three/src/math/MathUtils.js";

import { Button } from "../../ui/Button.js";
import { SegmentedControl } from "../../ui/FormControls.js";
import { layoutVehiclePlan, planYawDegrees, projectVehiclePlan, turnDirection } from "../plan/projectVehiclePlan.js";

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

function segmentsOf(record) {
    if (Array.isArray(record.segments) && record.segments.length > 0) return record.segments;
    return record.points?.length > 1 ? [record.points] : [];
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
    const frameRef = useRef(null);
    const svgRef = useRef(null);
    const keyGesture = useRef(null);
    const pointerRef = useRef(null);
    const [fit, setFit] = useState("vehicle");
    const [activeHandle, setActiveHandle] = useState(null);
    const [size, setSize] = useState({ width: 320, height: 240 });
    const projection = useMemo(
        () => projectVehiclePlan(draft, { steeringAngle: steeringPreview }),
        [draft, steeringPreview],
    );
    const layout = useMemo(
        () => layoutVehiclePlan(projection, { width: size.width, height: size.height, fit }),
        [projection, size.width, size.height, fit],
    );
    const limit = projection.steeringLimit;
    const preview = Math.max(-limit, Math.min(limit, Number(steeringPreview) || 0));
    const previewDegrees = radToDeg(preview);
    const limitDegrees = radToDeg(limit);

    useEffect(() => {
        const node = frameRef.current;
        if (!node || typeof ResizeObserver === "undefined") return undefined;
        const apply = () => {
            const rect = node.getBoundingClientRect();
            const width = Math.max(180, Math.round(rect.width));
            const height = Math.max(180, Math.round(rect.height));
            setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
        };
        apply();
        const observer = new ResizeObserver(apply);
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

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
        setActiveHandle(record.id);
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
        setActiveHandle(null);
        onCommitGesture?.();
    };

    const onPointerCancel = (event) => {
        if (!pointerRef.current || pointerRef.current.id !== event.pointerId) return;
        pointerRef.current = null;
        setActiveHandle(null);
        onCancelGesture?.();
    };

    const simulatorLabel = projection.simulator.straight || projection.simulator.radius == null
        ? "Straight"
        : `Simulator turn, R = ${Math.abs(projection.simulator.radius).toFixed(2)} m ${turnDirection(projection.simulator.radius)}`;
    const showAckermann = projection.ackermann.available;

    return (
        <div data-vehicle-plan className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <SegmentedControl
                    label="Plan fit"
                    value={fit}
                    onValueChange={setFit}
                    items={[
                        { value: "vehicle", label: "Vehicle" },
                        { value: "turn", label: "Turn" },
                    ]}
                />
            </div>
            <div ref={frameRef} className="h-[240px] w-full">
                <svg
                    ref={svgRef}
                    role="group"
                    aria-label="Vehicle plan, forward is up, left is left"
                    viewBox={`0 0 ${layout.width} ${layout.height}`}
                    preserveAspectRatio="xMidYMid meet"
                    className="vehicle-plan h-full w-full rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-surface-1)]"
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerCancel}
                >
                    {layout.records.filter((record) => record.kind === "centerline").map((record) => (
                        <line key={record.id} className="vehicle-plan__frame" x1={record.x1} y1={record.y1} x2={record.x2} y2={record.y2} strokeDasharray="2 4" />
                    ))}
                    {layout.records.filter((record) => record.kind === "origin").map((record) => (
                        <g key={record.id} className="vehicle-plan__origin" aria-hidden="true">
                            <line x1={record.svgX - 6} y1={record.svgY} x2={record.svgX + 6} y2={record.svgY} />
                            <line x1={record.svgX} y1={record.svgY - 6} x2={record.svgX} y2={record.svgY + 6} />
                            <text x={record.svgX + 8} y={record.svgY - 6}>origin</text>
                        </g>
                    ))}
                    {layout.records.filter((record) => record.kind === "forward").map((record) => (
                        <g key={record.id} className="vehicle-plan__frame" aria-hidden="true">
                            <path d={`M${record.svgX} ${record.svgY - 10} L${record.svgX - 4} ${record.svgY} L${record.svgX + 4} ${record.svgY} Z`} fill="currentColor" />
                            <text x={record.svgX + 8} y={record.svgY}>FWD</text>
                        </g>
                    ))}
                    {layout.records.filter((record) => record.kind === "side-label").map((record) => (
                        <text key={record.id} className="vehicle-plan__frame" x={record.svgX} y={record.svgY} textAnchor="middle">{record.text}</text>
                    ))}
                    {layout.records.filter((record) => record.kind === "body").map((record) => (
                        <rect key={record.id} x={record.x} y={record.y} width={record.width} height={record.height} fill="none" className="vehicle-plan__frame" />
                    ))}
                    {layout.records.filter((record) => (record.kind === "wheel-path" || record.kind === "steering-footprint") && record.points.length > 2).map((record) => (
                        <path
                            key={record.id}
                            className={record.kind === "wheel-path" ? "vehicle-plan__path" : "vehicle-plan__footprint"}
                            data-direction={record.direction}
                            d={`${pathFrom(record.points)} Z`}
                            aria-hidden="true"
                        />
                    ))}
                    {layout.records.filter((record) => record.kind === "dimension-line").map((record) => (
                        <g key={record.id} className="vehicle-plan__dimension" aria-hidden="true">
                            <line x1={record.x1} y1={record.y1} x2={record.x2} y2={record.y2} />
                            <text x={(record.x1 + record.x2) / 2 + 4} y={(record.y1 + record.y2) / 2}>{record.text}</text>
                        </g>
                    ))}
                    {layout.records.filter((record) => record.kind === "radius-line").map((record) => (
                        <g key={record.id} className={`vehicle-plan__${record.construction}`} data-construction={record.construction}>
                            <line className="vehicle-plan__radius" x1={record.x1} y1={record.y1} x2={record.x2} y2={record.y2} />
                            {record.label && (
                                <text x={record.labelX} y={record.labelY}>{record.label}</text>
                            )}
                        </g>
                    ))}
                    {layout.records.filter((record) => (record.kind === "simulator-arc" || record.kind === "ackermann-arc") && segmentsOf(record).length > 0).map((record) => (
                        <g key={record.id} className={`vehicle-plan__${record.construction}`} data-construction={record.construction}>
                            {segmentsOf(record).map((segment, index) => (
                                <path key={`${record.id}-${index}`} d={pathFrom(segment)} fill="none" strokeWidth="1.5" strokeDasharray={record.kind === "ackermann-arc" ? "4 3" : undefined} />
                            ))}
                        </g>
                    ))}
                    {layout.records.filter((record) => record.kind === "wheel").map((record) => {
                        const cx = record.x + record.width / 2;
                        const cy = record.y + record.height / 2;
                        return (
                            <rect
                                key={record.id}
                                x={record.x}
                                y={record.y}
                                width={record.width}
                                height={record.height}
                                className={`vehicle-plan__wheel${record.steerable ? " vehicle-plan__wheel--steer" : ""}${record.locked ? " vehicle-plan__wheel--locked" : ""}`}
                                transform={`rotate(${planYawDegrees(record.yaw)} ${cx} ${cy})`}
                            />
                        );
                    })}
                    {layout.records.filter((record) => record.kind === "turn-center").map((record) => (
                        <g key={record.id} className={`vehicle-plan__${record.construction}`} data-construction={record.construction}>
                            <circle cx={record.svgX} cy={record.svgY} r="3" fill={record.construction === "ackermann" ? "none" : "currentColor"} stroke="currentColor" />
                            {record.clamped && (
                                <path
                                    d={`M${record.svgX + record.nx * 8} ${record.svgY + record.ny * 8} L${record.svgX + record.nx * 8 - record.ny * 3.5} ${record.svgY + record.ny * 8 + record.nx * 3.5} L${record.svgX + record.nx * 8 + record.ny * 3.5} ${record.svgY + record.ny * 8 - record.nx * 3.5} Z`}
                                    fill="currentColor"
                                />
                            )}
                        </g>
                    ))}
                    {layout.records.filter((record) => record.kind === "axle-handle" || record.kind === "track-handle").map((record) => {
                        const kind = record.kind === "axle-handle" ? "axle" : "track";
                        const disabled = readOnly || record.locked;
                        const axleName = record.axle === "front" ? "Front" : "Rear";
                        const label = kind === "axle" ? `${axleName} axle position` : `${axleName} track`;
                        const shown = kind === "axle" ? record.value : record.value * 2;
                        const valueText = kind === "axle"
                            ? `${shown.toFixed(3)} meters forward`
                            : `${shown.toFixed(3)} meters track`;
                        const active = activeHandle === record.id;
                        const width = kind === "axle" ? 28 : 8;
                        const height = kind === "axle" ? 8 : 18;
                        return (
                            <g key={record.id}>
                                <rect
                                    className={`vehicle-plan__handle vehicle-plan__handle--${kind}${disabled ? " vehicle-plan__handle--locked" : ""}`}
                                    x={record.svgX - width / 2}
                                    y={record.svgY - height / 2}
                                    width={width}
                                    height={height}
                                    rx="2"
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
                                    onFocus={() => setActiveHandle(record.id)}
                                    onBlur={(event) => {
                                        finishKeys(event);
                                        setActiveHandle((current) => (current === record.id ? null : current));
                                    }}
                                    onPointerDown={(event) => onPointerDown(event, record, kind)}
                                >
                                    <title>{disabled ? `${label} is locked` : `${label}. ${valueText}`}</title>
                                </rect>
                                {active && !disabled && (
                                    <text className="vehicle-plan__badge" x={record.svgX + 16} y={record.svgY - 8}>{valueText}</text>
                                )}
                            </g>
                        );
                    })}
                </svg>
            </div>
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--slate-muted)]" aria-label="Plan legend">
                <li className="vehicle-plan__legend vehicle-plan__legend--simulator">{simulatorLabel}</li>
                {showAckermann && (
                    <li className="vehicle-plan__legend vehicle-plan__legend--ackermann">Ideal Ackermann, rear axle. Illustration, not the predicted path.</li>
                )}
                {layout.records.some((record) => record.kind === "steering-footprint") && (
                    <li className="vehicle-plan__legend vehicle-plan__legend--footprint">Full-lock footprint</li>
                )}
                {layout.records.some((record) => record.kind === "wheel-path") && (
                    <li className="vehicle-plan__legend vehicle-plan__legend--path">Tightest turn at full lock</li>
                )}
            </ul>
            <ul className="space-y-1 text-[11px] text-[var(--slate-muted)]">
                {layout.records.filter((record) => record.kind === "dimension").map((record) => (
                    <li key={record.id}>{record.text}</li>
                ))}
            </ul>
            <div aria-live="polite" className="text-[11px] leading-relaxed text-[var(--slate-fg-2)]">
                {projection.diagnostics.map((entry) => entry.message).join(" ")}
            </div>
            <label className="block text-[13px] font-medium text-[var(--slate-fg-2)]">
                <span className="flex items-center justify-between gap-2">
                    Preview steering angle
                    <span className="font-mono text-[11px] font-normal text-[var(--slate-muted)]">{previewDegrees.toFixed(1)}°</span>
                </span>
                <input
                    className="mt-1 w-full"
                    type="range"
                    aria-label="Preview steering angle"
                    min={-limitDegrees}
                    max={limitDegrees}
                    step="any"
                    value={previewDegrees}
                    disabled={readOnly}
                    onChange={(event) => onSteeringPreview?.(degToRad(Number(event.target.value)))}
                    onDoubleClick={() => onSteeringPreview?.(0)}
                />
            </label>
            <div className="flex justify-end">
                <Button
                    size="compact"
                    disabled={readOnly || Math.abs(preview) < 1e-6}
                    aria-label="Reset preview steering angle"
                    onClick={() => onSteeringPreview?.(0)}
                >
                    Reset
                </Button>
            </div>
        </div>
    );
}
