import { cn } from "./cn";

export function MenuButton({
    children,
    onClick,
    disabled = false,
    variant = "default",
    active = false,
    compact = false,
    iconOnly = false,
    title,
    ariaLabel,
    className,
    type = "button",
}) {
    const base =
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border text-[11px] font-medium tracking-wide select-none transition-colors";

    const variants = {
        default:
            "border-zinc-700/90 bg-zinc-900/90 text-zinc-100 hover:bg-zinc-800/90 focus:outline-none focus:ring-2 focus:ring-sky-400/60",
        ghost:
            "border-transparent bg-zinc-900/50 text-zinc-300 hover:bg-zinc-800/70 focus:outline-none focus:ring-2 focus:ring-sky-400/60",
        primary:
            "border-sky-400/70 bg-sky-500/20 text-sky-100 hover:bg-sky-500/30 focus:outline-none focus:ring-2 focus:ring-sky-400/60",
        danger:
            "border-rose-500/70 bg-rose-500/20 text-rose-100 hover:bg-rose-500/30 focus:outline-none focus:ring-2 focus:ring-rose-400/60",
    };

    return (
        <button
            type={type}
            title={title}
            aria-label={ariaLabel || title}
            onClick={disabled ? undefined : onClick}
            disabled={disabled}
            className={cn(
                base,
                iconOnly ? "h-8 w-8 p-0" : compact ? "px-2.5 py-1.5" : "px-3 py-1.5",
                variants[variant] || variants.default,
                active && "border-sky-400/90 bg-sky-500/35 text-sky-50",
                disabled && "opacity-50 cursor-not-allowed",
                className
            )}
        >
            {children}
        </button>
    );
}
