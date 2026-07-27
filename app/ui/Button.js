'use client';

import { forwardRef } from "react";
import { Slot, Tooltip } from "radix-ui";

import { cx } from "./cx";

export const Button = forwardRef(function Button({
    asChild = false,
    className,
    children,
    variant = "default",
    size = "default",
    loading = false,
    disabled,
    type = "button",
    ...props
}, ref) {
    const Component = asChild ? Slot.Root : "button";
    return (
        <Component
            ref={ref}
            className={cx("sf-button", `sf-button--${variant}`, `sf-button--${size}`, className)}
            aria-busy={loading || undefined}
            data-loading={loading || undefined}
            disabled={asChild ? undefined : disabled || loading}
            type={asChild ? undefined : type}
            {...props}
        >
            {loading && <span className="sf-spinner" aria-hidden="true" />}
            <span className="sf-button__content">{children}</span>
        </Component>
    );
});

export const IconButton = forwardRef(function IconButton({
    label,
    tooltip = label,
    className,
    children,
    size = "compact",
    variant = "ghost",
    active,
    ...props
}, ref) {
    const button = (
        <button
            ref={ref}
            type="button"
            className={cx("sf-icon-button", `sf-icon-button--${size}`, `sf-icon-button-variant--${variant}`, className)}
            aria-label={label}
            data-active={active || undefined}
            {...props}
        >
            {children}
        </button>
    );

    if (!tooltip) return button;
    return (
        <Tooltip.Root>
            <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
            <Tooltip.Portal>
                <Tooltip.Content className="sf-tooltip" sideOffset={7}>
                    {tooltip}
                    <Tooltip.Arrow className="sf-tooltip__arrow" />
                </Tooltip.Content>
            </Tooltip.Portal>
        </Tooltip.Root>
    );
});
