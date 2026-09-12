'use client';

import { useState } from "react";
import { NativeSelect, Switch, TextInput } from "../../../ui";
import { FieldRow, controlDescribedBy } from "./FieldRow";

const COMPACT_INPUT = "h-7 min-h-0 px-2 text-[12px]";

function TextLikeField({ id, descriptor, value, mixed, disabled, issues, onCommit, onReset, canReset, type = "text" }) {
    const committed = value === undefined || value === null ? "" : String(value);
    const [draft, setDraft] = useState(null);
    const shown = draft ?? (mixed ? "" : committed);
    const commit = (text) => {
        if (!mixed && text === committed) {
            setDraft(null);
            return;
        }
        const accepted = onCommit?.(text);
        if (accepted !== false) setDraft(null);
    };
    return (
        <FieldRow id={id} label={descriptor.label} units={descriptor.units} issues={issues} mixed={mixed} canReset={canReset} onReset={onReset}>
            <TextInput
                id={id}
                type={type}
                className={COMPACT_INPUT}
                value={shown}
                placeholder={mixed ? "Mixed" : undefined}
                disabled={disabled}
                readOnly={descriptor.readOnly || undefined}
                aria-invalid={issues.length > 0 || undefined}
                aria-describedby={controlDescribedBy(id, issues, mixed)}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={(event) => { if (draft !== null) commit(event.target.value); }}
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") { event.preventDefault(); commit(event.currentTarget.value); }
                    if (event.key === "Escape") { event.preventDefault(); setDraft(null); event.currentTarget.blur(); }
                }}
            />
        </FieldRow>
    );
}

export function TextField(props) {
    return <TextLikeField {...props} type="text" />;
}

/** Enum: a native select so the options never portal outside the workspace (scene picking ignores it). */
export function EnumField({ id, descriptor, value, mixed, disabled, issues, onCommit, onReset, canReset }) {
    const options = descriptor.options ?? [];
    return (
        <FieldRow id={id} label={descriptor.label} issues={issues} mixed={mixed} canReset={canReset} onReset={onReset}>
            <NativeSelect
                id={id}
                className={COMPACT_INPUT}
                value={mixed ? "" : (value ?? "")}
                disabled={disabled || descriptor.readOnly}
                aria-invalid={issues.length > 0 || undefined}
                aria-describedby={controlDescribedBy(id, issues, mixed)}
                onChange={(event) => onCommit?.(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
            >
                {mixed && <option value="" disabled>Mixed</option>}
                {options.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
            </NativeSelect>
        </FieldRow>
    );
}

export function ToggleField({ id, descriptor, value, mixed, disabled, issues, onCommit, onReset, canReset }) {
    return (
        <FieldRow id={id} label={descriptor.label} issues={issues} mixed={mixed} canReset={canReset} onReset={onReset}>
            <div className="flex h-7 items-center justify-end gap-2">
                {mixed && <span className="text-[11px] text-[var(--slate-muted)]">Mixed</span>}
                <Switch
                    id={id}
                    aria-label={descriptor.label}
                    data-mixed={mixed || undefined}
                    checked={mixed ? false : value === true}
                    disabled={disabled || descriptor.readOnly}
                    onCheckedChange={(checked) => onCommit?.(checked === true)}
                />
            </div>
        </FieldRow>
    );
}

export function ColorField({ id, descriptor, value, mixed, disabled, issues, onCommit, onReset, canReset }) {
    return (
        <FieldRow id={id} label={descriptor.label} issues={issues} mixed={mixed} canReset={canReset} onReset={onReset}>
            <input
                id={id}
                type="color"
                value={mixed || typeof value !== "string" ? "#000000" : value}
                disabled={disabled || descriptor.readOnly}
                aria-invalid={issues.length > 0 || undefined}
                aria-describedby={controlDescribedBy(id, issues, mixed)}
                onChange={(event) => onCommit?.(event.target.value)}
                className="h-7 w-full cursor-pointer rounded-[var(--radius)] border border-[var(--slate-border-70)] bg-[var(--slate-surface-2)] p-0.5"
            />
        </FieldRow>
    );
}

/**
 * Asset reference (ED-03): a native select when the descriptor enumerates
 * options, otherwise the identifier read-only. ED-06 wires the catalog.
 */
export function AssetReferenceField(props) {
    if (Array.isArray(props.descriptor.options) && props.descriptor.options.length > 0) return <EnumField {...props} />;
    return <TextLikeField {...props} descriptor={{ ...props.descriptor, readOnly: true }} />;
}
