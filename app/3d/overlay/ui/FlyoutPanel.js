export function FlyoutPanel({ title, subtitle, children }) {
    return (
        <div className="menu-flyout-panel max-h-[min(680px,calc(100dvh-120px))] w-[320px] overflow-y-auto rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] p-3 text-[var(--slate-fg)] shadow-[var(--slate-shadow-overlay)] backdrop-blur-[14px]">
            <div className="mb-2 border-b border-[var(--slate-border-60)] pb-2">
                <p className="text-[13px] font-semibold text-[var(--slate-fg)]">{title}</p>
                {subtitle && <p className="mt-0.5 text-[11px] text-[var(--slate-muted)]">{subtitle}</p>}
            </div>
            <div className="space-y-2">{children}</div>
        </div>
    );
}
