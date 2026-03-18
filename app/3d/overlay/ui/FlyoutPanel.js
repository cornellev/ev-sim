export function FlyoutPanel({ title, subtitle, children }) {
    return (
        <div className="w-[320px] rounded-2xl border border-zinc-700/80 bg-zinc-950/85 p-3 text-zinc-100 shadow-[0_30px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
            <div className="mb-2 border-b border-zinc-700/80 pb-2">
                <p className="text-[11px] font-semibold tracking-wide text-zinc-100">{title}</p>
                {subtitle && <p className="mt-0.5 text-[10px] text-zinc-400">{subtitle}</p>}
            </div>
            <div className="space-y-2">{children}</div>
        </div>
    );
}
