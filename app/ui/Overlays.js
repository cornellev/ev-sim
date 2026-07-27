'use client';

import { Dialog, Popover, ScrollArea, Tooltip } from "radix-ui";
import { IconX } from "@tabler/icons-react";

import { IconButton } from "./Button";
import { cx } from "./cx";

export function UiProvider({ children }) {
    return (
        <Tooltip.Provider delayDuration={450} skipDelayDuration={300}>
            {children}
        </Tooltip.Provider>
    );
}

export function DialogSurface({
    open,
    onOpenChange,
    title,
    description,
    children,
    footer,
    className,
    instant = false,
    showClose = true,
}) {
    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="sf-dialog-overlay" data-instant={instant || undefined} />
                <Dialog.Content className={cx("sf-dialog", className)} data-instant={instant || undefined}>
                    <header className="sf-dialog__header">
                        <div>
                            <Dialog.Title className="sf-dialog__title">{title}</Dialog.Title>
                            {description && <Dialog.Description className="sf-dialog__description">{description}</Dialog.Description>}
                        </div>
                        {showClose && (
                            <Dialog.Close asChild>
                                <IconButton label="Close" tooltip="Close">
                                    <IconX size={16} stroke={1.75} />
                                </IconButton>
                            </Dialog.Close>
                        )}
                    </header>
                    <div className="sf-dialog__body">{children}</div>
                    {footer && <footer className="sf-dialog__footer">{footer}</footer>}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

export function PopoverSurface({ trigger, children, open, onOpenChange, align = "start", sideOffset = 7, className }) {
    return (
        <Popover.Root open={open} onOpenChange={onOpenChange}>
            <Popover.Trigger asChild>{trigger}</Popover.Trigger>
            <Popover.Portal>
                <Popover.Content className={cx("sf-popover", className)} align={align} sideOffset={sideOffset}>
                    {children}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}

export function ScrollPane({ className, viewportClassName, children, ...props }) {
    return (
        <ScrollArea.Root className={cx("sf-scroll-area", className)} {...props}>
            <ScrollArea.Viewport className={cx("sf-scroll-area__viewport", viewportClassName)}>
                {children}
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar className="sf-scroll-area__bar" orientation="vertical">
                <ScrollArea.Thumb className="sf-scroll-area__thumb" />
            </ScrollArea.Scrollbar>
            <ScrollArea.Corner />
        </ScrollArea.Root>
    );
}
