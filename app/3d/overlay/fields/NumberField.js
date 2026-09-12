'use client';

import { useRef, useState } from "react";
import {
    formatFieldNumber,
    parseNumberDraft,
    scrubFieldValue,
    stepFieldValue,
} from "../../editor/presentation/fieldModel.js";
import { FieldRow, controlDescribedBy } from "./FieldRow";
import { cn } from "../ui/cn";

const INPUT_CLASS = "h-7 w-full min-w-0 rounded-[var(--radius)] border border-[var(--slate-border-70)] bg-[var(--slate-surface-2)] px-2 text-right font-mono text-[12px] tabular-nums text-[var(--slate-fg)] outline-none placeholder:text-[var(--slate-muted)] focus-visible:ring-2 focus-visible:ring-[var(--slate-ring)] aria-[invalid=true]:border-[var(--slate-danger-border)] disabled:opacity-50";

/**
 * Numeric input: typed drafts commit on Enter/blur, Escape reverts, arrow
 * keys step (Shift ×10, Alt ×0.1), and dragging the label scrubs the value.
 * Invalid drafts stay visible with their issue; the document only changes on
 * a successful commit.
 */
export function useNumberInput({ id, descriptor, value, mixed = false, disabled = false, issues = [], onCommit, onScrubStart, onScrubEnd, className, ariaLabel }) {
    const committed = Number.isFinite(value) ? formatFieldNumber(value, descriptor) : "";
    const [draft, setDraft] = useState(null);
    const scrubRef = useRef(null);
    const shown = draft ?? (mixed ? "" : committed);

    // A rejected commit (`onCommit` returns false) keeps the draft and its
    // issue visible; the document only changes on an accepted commit.
    const commit = (text) => {
        const parsed = parseNumberDraft(text, descriptor);
        if (!parsed.ok) {
            if (String(text ?? "").trim() === "") setDraft(null);
            return;
        }
        if (!mixed && Number.isFinite(value) && Math.abs(parsed.value - value) < 1e-12) {
            setDraft(null);
            return;
        }
        const accepted = onCommit?.(parsed.value);
        if (accepted !== false) setDraft(null);
    };

    const onKeyDown = (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
            event.preventDefault();
            commit(event.currentTarget.value);
        } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(null);
            event.currentTarget.blur();
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const parsed = parseNumberDraft(event.currentTarget.value, descriptor);
            const base = parsed.ok ? parsed.value : (Number.isFinite(value) ? value : 0);
            const next = stepFieldValue(base, descriptor, event.key === "ArrowUp" ? 1 : -1, { shift: event.shiftKey, alt: event.altKey });
            const accepted = onCommit?.(next);
            if (accepted !== false) setDraft(null);
        }
    };

    const scrubHandlers = disabled || descriptor.readOnly ? null : {
        onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            scrubRef.current = { pointerId: event.pointerId, startX: event.clientX, start: Number.isFinite(value) ? value : 0, moved: false, last: null };
            onScrubStart?.();
        },
        onPointerMove: (event) => {
            const scrub = scrubRef.current;
            if (!scrub || scrub.pointerId !== event.pointerId) return;
            const next = scrubFieldValue(scrub.start, event.clientX - scrub.startX, descriptor, { shift: event.shiftKey, alt: event.altKey });
            if (scrub.last !== null && Math.abs(next - scrub.last) < 1e-12) return;
            scrub.last = next;
            scrub.moved = true;
            setDraft(formatFieldNumber(next, descriptor));
        },
        onPointerUp: (event) => {
            const scrub = scrubRef.current;
            if (!scrub || scrub.pointerId !== event.pointerId) return;
            scrubRef.current = null;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
            onScrubEnd?.();
            const accepted = scrub.moved && scrub.last !== null && Math.abs(scrub.last - scrub.start) > 1e-12 ? onCommit?.(scrub.last) : true;
            if (accepted !== false) setDraft(null);
        },
        onPointerCancel: () => {
            scrubRef.current = null;
            setDraft(null);
            onScrubEnd?.();
        },
    };

    const input = (
        <input
            id={id}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={shown}
            placeholder={mixed ? "Mixed" : undefined}
            disabled={disabled}
            readOnly={descriptor.readOnly || undefined}
            aria-label={ariaLabel}
            aria-invalid={issues.length > 0 || undefined}
            aria-describedby={controlDescribedBy(id, issues, mixed)}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => { if (draft !== null) commit(event.target.value); }}
            onKeyDown={onKeyDown}
            onFocus={(event) => event.target.select()}
            className={cn(INPUT_CLASS, className)}
        />
    );
    return { input, scrubHandlers };
}

export function NumberField({ id, descriptor, value, mixed, disabled, issues, onCommit, onReset, canReset, onScrubStart, onScrubEnd }) {
    const { input, scrubHandlers } = useNumberInput({ id, descriptor, value, mixed, disabled, issues, onCommit, onScrubStart, onScrubEnd });
    return (
        <FieldRow id={id} label={descriptor.label} units={descriptor.units} issues={issues} mixed={mixed} canReset={canReset} onReset={onReset} scrubHandlers={scrubHandlers}>
            {input}
        </FieldRow>
    );
}
