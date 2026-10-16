"use client";

import { DragNumber } from "./DragNumber.js";
import { Field } from "../../ui/FormControls.js";

export function standardAxleCards(wheels = []) {
    return ["front", "rear"].flatMap((id) => {
        const members = wheels.filter((wheel) => wheel.axle === id);
        const left = members.find((wheel) => wheel.side === "left");
        const right = members.find((wheel) => wheel.side === "right");
        if (!left || !right || members.length !== 2) return [];
        return [{
            id,
            left,
            right,
            locked: Boolean(left.visual || right.visual),
            x: left.position.x,
            y: left.position.y,
            halfTrack: Math.abs(left.position.z),
            radius: left.radius,
            width: left.width,
        }];
    });
}

export function axleSummary(axle) {
    const title = axle.id === "front" ? "Front axle" : "Rear axle";
    const steer = axle.id === "front" ? "steers" : "fixed";
    const lock = axle.locked ? " · bound" : "";
    return {
        title,
        detail: `x ${axle.x.toFixed(2)} · track ${(axle.halfTrack * 2).toFixed(2)} · dia ${(axle.radius * 2).toFixed(2)} · ${steer}${lock}`,
    };
}

function AxleNumber({
    label,
    ariaLabel,
    value,
    min,
    disabled,
    onBegin,
    onPreview,
    onCommit,
    onCancel,
}) {
    return (
        <Field label={label}>
            <DragNumber
                aria-label={ariaLabel || label}
                className="sf-input"
                value={value}
                min={min}
                step={0.01}
                disabled={disabled}
                onGestureStart={onBegin}
                onChange={onPreview}
                onGestureEnd={onCommit}
                onGestureCancel={onCancel}
            />
        </Field>
    );
}

export function AxleFields({
    axle,
    onBeginGesture,
    onPreviewGesture,
    onCommitGesture,
    onCancelGesture,
    onDetach,
}) {
    const title = axle.id === "front" ? "Front axle" : "Rear axle";
    const edit = (patch) => onPreviewGesture(axle.id, patch);
    return (
        <section aria-label={title}>
            {axle.locked && (
                <p className="mb-2 text-[11px] leading-relaxed text-[var(--slate-muted)]">Detach the model-bound wheels before editing this axle.</p>
            )}
            <div className="grid grid-cols-2 gap-2">
                <AxleNumber
                    label="X (m)"
                    ariaLabel={`${title} X (m)`}
                    value={axle.x}
                    disabled={axle.locked}
                    onBegin={() => onBeginGesture(axle.id)}
                    onPreview={(next) => edit({ x: next })}
                    onCommit={onCommitGesture}
                    onCancel={onCancelGesture}
                />
                <AxleNumber
                    label="Track (m)"
                    ariaLabel={`${title} track (m)`}
                    value={axle.halfTrack * 2}
                    min={0}
                    disabled={axle.locked}
                    onBegin={() => onBeginGesture(axle.id)}
                    onPreview={(next) => edit({ z: next / 2 })}
                    onCommit={onCommitGesture}
                    onCancel={onCancelGesture}
                />
                <AxleNumber
                    label="Height (m)"
                    ariaLabel={`${title} height (m)`}
                    value={axle.y}
                    disabled={axle.locked}
                    onBegin={() => onBeginGesture(axle.id)}
                    onPreview={(next) => edit({ y: next })}
                    onCommit={onCommitGesture}
                    onCancel={onCancelGesture}
                />
                <AxleNumber
                    label="Radius (m)"
                    ariaLabel={`${title} radius (m)`}
                    value={axle.radius}
                    min={0.01}
                    disabled={axle.locked}
                    onBegin={() => onBeginGesture(axle.id)}
                    onPreview={(next) => edit({ radius: next })}
                    onCommit={onCommitGesture}
                    onCancel={onCancelGesture}
                />
                <AxleNumber
                    label="Width (m)"
                    ariaLabel={`${title} width (m)`}
                    value={axle.width}
                    min={0.01}
                    disabled={axle.locked}
                    onBegin={() => onBeginGesture(axle.id)}
                    onPreview={(next) => edit({ width: next })}
                    onCommit={onCommitGesture}
                    onCancel={onCancelGesture}
                />
            </div>
            <p className="mt-2 text-[11px] text-[var(--slate-muted)]">Height is the wheel-center height. Track is the full width from left to right.</p>
            <div className="mt-3 flex gap-3">
                {axle.left.visual?.kind === "model-node" && (
                    <button type="button" onClick={() => onDetach(axle.left.id)} className="text-[11px] text-[var(--slate-fg-2)]">Detach left</button>
                )}
                {axle.right.visual?.kind === "model-node" && (
                    <button type="button" onClick={() => onDetach(axle.right.id)} className="text-[11px] text-[var(--slate-fg-2)]">Detach right</button>
                )}
            </div>
        </section>
    );
}
