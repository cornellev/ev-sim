export function ControlGroup({ title, children }) {
    return (
        <div className="flex items-center gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-300 select-none whitespace-nowrap">
                {title}
            </p>
            <div className="flex items-center gap-1.5">{children}</div>
        </div>
    );
}
