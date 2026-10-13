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

function AxleNumber({
    label,
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
                aria-label={label}
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

export function AxleInspector({
    axles,
    onBeginGesture,
    onPreviewGesture,
    onCommitGesture,
    onCancelGesture,
    onDetach,
}) {
    return (
        <div className="space-y-3">
            {axles.map((axle) => {
                const title = axle.id === "front" ? "Front axle" : "Rear axle";
                const edit = (patch) => onPreviewGesture(axle.id, patch);
                return (
                    <section key={axle.id} className="rounded-[var(--radius)] border border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] p-3" aria-label={title}>
                        <h3 className="mb-2 text-[13px] font-semibold text-[var(--slate-fg-2)]">{title}</h3>
                        {axle.locked && (
                            <p className="mb-2 text-[11px] leading-relaxed text-[var(--slate-muted)]">Detach the model-bound wheels before editing this axle.</p>
                        )}
                        <div className="grid grid-cols-2 gap-2">
                            <AxleNumber
                                label={`${title} X (m)`}
                                value={axle.x}
                                disabled={axle.locked}
                                onBegin={() => onBeginGesture(axle.id)}
                                onPreview={(next) => edit({ x: next })}
                                onCommit={onCommitGesture}
                                onCancel={onCancelGesture}
                            />
                            <AxleNumber
                                label={`${title} half-track (m)`}
                                value={axle.halfTrack}
                                min={0}
                                disabled={axle.locked}
                                onBegin={() => onBeginGesture(axle.id)}
                                onPreview={(next) => edit({ z: next })}
                                onCommit={onCommitGesture}
                                onCancel={onCancelGesture}
                            />
                            <AxleNumber
                                label={`${title} Y (m)`}
                                value={axle.y}
                                disabled={axle.locked}
                                onBegin={() => onBeginGesture(axle.id)}
                                onPreview={(next) => edit({ y: next })}
                                onCommit={onCommitGesture}
                                onCancel={onCancelGesture}
                            />
                            <AxleNumber
                                label={`${title} radius (m)`}
                                value={axle.radius}
                                min={0.01}
                                disabled={axle.locked}
                                onBegin={() => onBeginGesture(axle.id)}
                                onPreview={(next) => edit({ radius: next })}
                                onCommit={onCommitGesture}
                                onCancel={onCancelGesture}
                            />
                            <AxleNumber
                                label={`${title} width (m)`}
                                value={axle.width}
                                min={0.01}
                                disabled={axle.locked}
                                onBegin={() => onBeginGesture(axle.id)}
                                onPreview={(next) => edit({ width: next })}
                                onCommit={onCommitGesture}
                                onCancel={onCancelGesture}
                            />
                        </div>
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
            })}
        </div>
    );
}
