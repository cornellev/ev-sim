import { Button, IconButton } from "../../../ui";

export function MenuButton({
    children,
    onClick,
    disabled = false,
    variant = "default",
    active,
    compact = false,
    iconOnly = false,
    title,
    ariaLabel,
    className,
    type = "button",
}) {
    if (iconOnly) {
        return (
            <IconButton
                type={type}
                label={ariaLabel || title}
                tooltip={title}
                onClick={onClick}
                disabled={disabled}
                variant={variant}
                active={active}
                aria-pressed={typeof active === "boolean" ? active : undefined}
                className={className}
            >
                {children}
            </IconButton>
        );
    }

    return (
        <Button
            type={type}
            variant={variant}
            size={compact ? "compact" : "default"}
            title={title}
            aria-label={ariaLabel || title}
            onClick={onClick}
            disabled={disabled}
            data-active={active || undefined}
            aria-pressed={typeof active === "boolean" ? active : undefined}
            className={className}
        >
            {children}
        </Button>
    );
}
