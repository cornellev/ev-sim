'use client';

import { vector3Patch } from "../../editor/presentation/fieldModel.js";
import { FieldRow } from "./FieldRow";
import { useNumberInput } from "./NumberField";

function useAxis(axis, { id, descriptor, value, mixed, disabled, onCommit, onScrubStart, onScrubEnd }) {
    return useNumberInput({
        id: `${id}-${axis}`,
        descriptor,
        value: mixed ? undefined : value?.[axis],
        mixed,
        disabled,
        issues: [],
        ariaLabel: `${descriptor.label} ${axis.toUpperCase()}`,
        onCommit: (next) => onCommit?.(vector3Patch(descriptor, value, axis, next).value),
        onScrubStart,
        onScrubEnd,
    });
}

/** Three numeric inputs under one label; each axis commits the whole vector. */
export function Vector3Field(props) {
    const { id, descriptor, mixed, issues, onReset, canReset } = props;
    const axes = [["x", useAxis("x", props)], ["y", useAxis("y", props)], ["z", useAxis("z", props)]];
    return (
        <FieldRow id={`${id}-x`} label={descriptor.label} units={descriptor.units} issues={issues} mixed={mixed} canReset={canReset} onReset={onReset}>
            <div className="grid grid-cols-3 gap-1">
                {axes.map(([axis, { input }]) => (
                    <div key={axis} className="relative">
                        <span aria-hidden="true" className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[11px] text-[var(--slate-muted)]">{axis.toUpperCase()}</span>
                        <div className="[&>input]:pl-5">{input}</div>
                    </div>
                ))}
            </div>
        </FieldRow>
    );
}
