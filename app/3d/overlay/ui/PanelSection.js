export function PanelSection({ title, children }) {
    return (
        <section className="rounded-xl border border-zinc-700/80 bg-zinc-900/70 p-2.5">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                {title}
            </p>
            <div className="space-y-1.5">{children}</div>
        </section>
    );
}
