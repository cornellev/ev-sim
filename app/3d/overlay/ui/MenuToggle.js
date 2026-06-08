import { cn } from "./cn";

export function MenuToggle({
    label,
    checked,
    onChange,
    icon,
    hint,
    disabled = false,
    className,
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-700/80 bg-zinc-900/85 px-2 py-1.5 text-left transition-[background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-zinc-800/90 focus:outline-none focus:ring-2 focus:ring-sky-400/60 active:scale-[0.985]",
                disabled && "opacity-50 cursor-not-allowed",
                className
            )}
            disabled={disabled}
            onClick={() => onChange?.(!checked)}
        >
            <div className="min-w-0 flex items-center gap-2">
                {icon && <span className="text-zinc-300">{icon}</span>}
                <div>
                    <p className="text-[11px] font-medium text-zinc-100 select-none truncate">{label}</p>
                    {hint && <p className="text-[10px] text-zinc-400 select-none truncate">{hint}</p>}
                </div>
            </div>
            <span
                className={cn(
                    "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-[background-color,border-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
                    checked
                        ? "border-sky-400/80 bg-sky-500/75"
                        : "border-zinc-500/70 bg-zinc-700/80"
                )}
            >
                <span
                    className={cn(
                        "mx-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] will-change-transform",
                        checked ? "translate-x-4" : "translate-x-0"
                    )}
                />
            </span>
        </button>
    );
}
