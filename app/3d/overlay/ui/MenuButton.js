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
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border text-[11px] font-medium tracking-wide select-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97]";

    const variants = {
        default: {
            idle: "border-zinc-700/90 bg-zinc-900/90 text-zinc-100 hover:bg-zinc-800/90 focus:outline-none focus:ring-2 focus:ring-sky-400/60",
            active: "border-sky-400/90 bg-sky-500/35 text-sky-50 hover:bg-sky-500/40 focus:outline-none focus:ring-2 focus:ring-sky-400/60",
        },
        ghost: {
            idle: "border-transparent bg-zinc-900/50 text-zinc-300 hover:bg-zinc-800/70 focus:outline-none focus:ring-2 focus:ring-sky-400/60",
            active: "border-sky-400/80 bg-sky-500/30 text-sky-50 hover:bg-sky-500/35 focus:outline-none focus:ring-2 focus:ring-sky-400/60",
        },
        primary: {
            idle: "border-sky-400/70 bg-sky-500/20 text-sky-100 hover:bg-sky-500/30 focus:outline-none focus:ring-2 focus:ring-sky-400/60",
            active: "border-sky-300/90 bg-sky-500/45 text-sky-50 hover:bg-sky-500/50 focus:outline-none focus:ring-2 focus:ring-sky-400/60 shadow-[0_0_18px_rgba(56,189,248,0.25)]",
        },
        danger: {
            idle: "border-rose-500/70 bg-rose-500/20 text-rose-100 hover:bg-rose-500/30 focus:outline-none focus:ring-2 focus:ring-rose-400/60",
            active: "border-rose-300/90 bg-rose-500/45 text-rose-50 hover:bg-rose-500/50 focus:outline-none focus:ring-2 focus:ring-rose-400/60 shadow-[0_0_18px_rgba(244,63,94,0.22)]",
        },
    };

    const visualState = variants[variant] || variants.default;

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
                active ? visualState.active : visualState.idle,
                disabled && "opacity-50 cursor-not-allowed active:scale-100",
                className
            )}
        >
            {children}
        </button>
    );
}
