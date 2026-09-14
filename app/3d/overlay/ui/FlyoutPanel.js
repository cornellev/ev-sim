import { cn } from "./cn";

export function FlyoutPanel({ title, subtitle, children, fill = false }) {
    return (
        <div
            className={cn(
                "menu-flyout-panel w-[320px] rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] p-3 text-[var(--slate-fg)] shadow-[var(--slate-shadow-overlay)] backdrop-blur-[14px]",
                fill
                    ? "flex h-full min-h-0 flex-col overflow-hidden"
                    : "max-h-[min(680px,calc(100dvh-120px))] overflow-y-auto",
            )}
        >
            <div className="mb-2 shrink-0 border-b border-[var(--slate-border-60)] pb-2">
                <p className="text-[13px] font-semibold text-[var(--slate-fg)]">{title}</p>
                {subtitle && <p className="mt-0.5 text-[11px] text-[var(--slate-muted)]">{subtitle}</p>}
            </div>
            <div className={cn("space-y-2", fill && "min-h-0 flex-1 overflow-y-auto")}>
                {children}
            </div>
        </div>
    );
}
