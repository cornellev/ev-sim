export function PanelSection({ title, children }) {
    return (
        <section className="border-b border-[var(--slate-border-60)] py-2.5 last:border-b-0">
            <p className="mb-2 text-[12px] font-semibold text-[var(--slate-fg-2)]">
                {title}
            </p>
            <div className="space-y-1.5">{children}</div>
        </section>
    );
}
