import { Switch } from "../../../ui";

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
        <div className="flex items-center gap-2 border-b border-[var(--slate-border-60)] py-2 last:border-b-0">
            {icon && <span className="text-[var(--slate-muted)]">{icon}</span>}
            <Switch
                className={`min-w-0 flex-1 ${className || ""}`}
                label={label}
                description={hint}
                checked={checked}
                onCheckedChange={onChange}
                disabled={disabled}
            />
        </div>
    );
}
