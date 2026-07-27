export function ControlGroup({ title, children }) {
    return (
        <div className="flex items-center gap-2">
            <p className="select-none whitespace-nowrap text-[12px] font-medium text-[var(--slate-muted)]">
                {title}
            </p>
            <div className="flex items-center gap-1.5">{children}</div>
        </div>
    );
}
