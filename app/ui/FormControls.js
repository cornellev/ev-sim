'use client';

import { cloneElement, isValidElement, useId } from "react";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { Accordion, Collapsible, Select as SelectPrimitive, Switch as SwitchPrimitive, Tabs, ToggleGroup } from "radix-ui";

import { cx } from "./cx";

export function Field({ label, hint, error, required, children, className, id: providedId }) {
    const generatedId = useId();
    const id = providedId || generatedId;
    const descriptionId = hint || error ? `${id}-description` : undefined;
    const control = isValidElement(children)
        ? cloneElement(children, {
            id: children.props.id || id,
            "aria-invalid": error ? true : children.props["aria-invalid"],
            "aria-describedby": descriptionId || children.props["aria-describedby"],
        })
        : children;

    return (
        <div className={cx("sf-field", className)} data-invalid={Boolean(error) || undefined}>
            {label && (
                <label className="sf-field__label" htmlFor={id}>
                    {label}
                    {required && <span className="sf-field__required">Required</span>}
                </label>
            )}
            {control}
            {(error || hint) && (
                <p
                    id={descriptionId}
                    className={cx("sf-field__message", error && "sf-field__message--error")}
                    role={error ? "alert" : undefined}
                >
                    {error || hint}
                </p>
            )}
        </div>
    );
}

export function TextInput({ className, ...props }) {
    return <input className={cx("sf-input", className)} {...props} />;
}

export function Textarea({ className, ...props }) {
    return <textarea className={cx("sf-input", "sf-textarea", className)} {...props} />;
}

export function NativeSelect({ className, children, ...props }) {
    return <select className={cx("sf-input", "sf-native-select", className)} {...props}>{children}</select>;
}

export function Switch({ checked, onCheckedChange, label, description, disabled, className, tone = "default", ...props }) {
    const id = useId();
    const labeled = Boolean(label || description);
    const activateFromRow = (event) => {
        if (disabled) return;
        const node = event.target instanceof Element ? event.target : event.target?.parentElement;
        if (node?.closest("label, button")) return;
        onCheckedChange?.(!checked);
    };
    return (
        <div
            className={cx("sf-switch-row", tone !== "default" && `sf-switch-row--${tone}`, className)}
            onClick={labeled ? activateFromRow : undefined}
        >
            {labeled && (
                <label className="sf-switch-copy" htmlFor={id}>
                    {label && <span className="sf-switch-copy__label">{label}</span>}
                    {description && <span className="sf-switch-copy__description">{description}</span>}
                </label>
            )}
            <SwitchPrimitive.Root
                id={id}
                className="sf-switch"
                checked={checked}
                onCheckedChange={onCheckedChange}
                disabled={disabled}
                {...props}
            >
                <SwitchPrimitive.Thumb className="sf-switch__thumb" />
            </SwitchPrimitive.Root>
        </div>
    );
}

export function SegmentedControl({ value, onValueChange, items, label, className }) {
    return (
        <ToggleGroup.Root
            type="single"
            value={value}
            onValueChange={(next) => next && onValueChange?.(next)}
            aria-label={label}
            className={cx("sf-segmented", className)}
        >
            {items.map((item) => (
                <ToggleGroup.Item key={item.value} value={item.value} className="sf-segmented__item">
                    {item.label}
                </ToggleGroup.Item>
            ))}
        </ToggleGroup.Root>
    );
}

export const TabsRoot = Tabs.Root;

export function TabsList({ className, ...props }) {
    return <Tabs.List className={cx("sf-tabs", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }) {
    return <Tabs.Trigger className={cx("sf-tabs__trigger", className)} {...props} />;
}

export function TabsContent({ className, ...props }) {
    return <Tabs.Content className={cx("sf-tabs__content", className)} {...props} />;
}

export function Disclosure({
    label,
    detail = null,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    className,
}) {
    return (
        <Collapsible.Root
            className={cx("sf-disclosure", className)}
            open={open}
            defaultOpen={open === undefined ? defaultOpen : undefined}
            onOpenChange={onOpenChange}
        >
            <Collapsible.Trigger className="sf-disclosure__trigger">
                <IconChevronDown className="sf-disclosure__chevron" size={14} stroke={1.75} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {detail && <span className="sf-disclosure__detail">{detail}</span>}
            </Collapsible.Trigger>
            <Collapsible.Content className="sf-disclosure__content">{children}</Collapsible.Content>
        </Collapsible.Root>
    );
}

export function AccordionRoot({ value, onValueChange, children, className, type = "multiple" }) {
    return (
        <Accordion.Root className={cx("sf-accordion", className)} type={type} value={value} onValueChange={onValueChange}>
            {children}
        </Accordion.Root>
    );
}

export function AccordionItem({ value, label, detail = null, children }) {
    return (
        <Accordion.Item className="sf-accordion__item" value={value} data-wheel-row={value}>
            <Accordion.Header className="sf-accordion__header">
                <Accordion.Trigger className="sf-accordion__trigger">
                    <IconChevronDown className="sf-accordion__chevron" size={14} stroke={1.75} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                    {detail && <span className="sf-accordion__detail">{detail}</span>}
                </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content className="sf-accordion__content">{children}</Accordion.Content>
        </Accordion.Item>
    );
}

export function Select({ value, onValueChange, items, placeholder, label, className, disabled }) {
    return (
        <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
            <SelectPrimitive.Trigger className={cx("sf-input", "sf-select", className)} aria-label={label}>
                <SelectPrimitive.Value placeholder={placeholder} />
                <SelectPrimitive.Icon><IconChevronDown size={14} stroke={1.75} /></SelectPrimitive.Icon>
            </SelectPrimitive.Trigger>
            <SelectPrimitive.Portal>
                <SelectPrimitive.Content className="sf-select-content" position="popper" sideOffset={5}>
                    <SelectPrimitive.Viewport className="sf-select-viewport">
                        {items.map((item) => (
                            <SelectPrimitive.Item key={item.value} value={item.value} className="sf-select-item">
                                <SelectPrimitive.ItemText>{item.label}</SelectPrimitive.ItemText>
                                <SelectPrimitive.ItemIndicator><IconCheck size={14} stroke={1.75} /></SelectPrimitive.ItemIndicator>
                            </SelectPrimitive.Item>
                        ))}
                    </SelectPrimitive.Viewport>
                </SelectPrimitive.Content>
            </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
    );
}
