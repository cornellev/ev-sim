'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "./cn";

function enabledItems(options = []) {
    return options.filter((option) => option && option.disabled !== true);
}

function clampPosition(x, y, width, height, padding = 8) {
    const maxX = Math.max(padding, window.innerWidth - width - padding);
    const maxY = Math.max(padding, window.innerHeight - height - padding);
    return {
        left: Math.min(Math.max(padding, x), maxX),
        top: Math.min(Math.max(padding, y), maxY),
    };
}

function MenuList({
    options,
    onClose,
    onRun,
    nested = false,
    openPath,
    setOpenPath,
    path = [],
}) {
    const items = Array.isArray(options) ? options : [];
    return (
        <ul role={nested ? "menu" : undefined} className="min-w-[168px] p-1">
            {items.map((option) => {
                const hasChildren = Array.isArray(option.children) && option.children.length > 0;
                const itemPath = [...path, option.id];
                const open = openPath.length >= itemPath.length && itemPath.every((id, index) => openPath[index] === id);
                return (
                    <li
                        key={option.id}
                        className="relative"
                        onMouseEnter={() => {
                            if (option.disabled) return;
                            setOpenPath(hasChildren ? itemPath : path);
                        }}
                    >
                        <button
                            type="button"
                            role="menuitem"
                            data-menu-id={option.id}
                            disabled={option.disabled}
                            aria-disabled={option.disabled || undefined}
                            aria-haspopup={hasChildren ? "menu" : undefined}
                            aria-expanded={hasChildren ? open : undefined}
                            onClick={() => {
                                if (option.disabled) return;
                                if (hasChildren) {
                                    setOpenPath(itemPath);
                                    return;
                                }
                                onRun(option);
                            }}
                            className={cn(
                                "flex w-full items-center justify-between gap-3 rounded-[var(--radius)] px-2 py-1 text-left text-[12px] hover:bg-[var(--slate-surface-hover)] focus-visible:bg-[var(--slate-surface-hover)] focus-visible:outline-none disabled:opacity-40",
                                option.danger ? "text-[var(--slate-danger)]" : "text-[var(--slate-fg)]",
                            )}
                        >
                            <span>{option.label}</span>
                            {hasChildren && <span aria-hidden="true" className="text-[var(--slate-muted)]">›</span>}
                        </button>
                        {hasChildren && open && (
                            <div className="absolute left-full top-0 z-10 -ml-0.5">
                                <div className="rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] shadow-[var(--slate-shadow-overlay)]">
                                    <MenuList
                                        options={option.children}
                                        onClose={onClose}
                                        onRun={onRun}
                                        nested
                                        openPath={openPath}
                                        setOpenPath={setOpenPath}
                                        path={itemPath}
                                    />
                                </div>
                            </div>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

/**
 * Viewport-clamped context menu with nested options, keyboard navigation,
 * outside-click/scroll dismissal, and focus restoration.
 */
export function ContextMenuSurface({
    open,
    x = 0,
    y = 0,
    options = [],
    returnFocus = null,
    onClose,
}) {
    const rootRef = useRef(null);
    const [openPath, setOpenPath] = useState([]);

    const close = useCallback(() => {
        onClose?.();
        const target = returnFocus;
        if (target && typeof target.focus === "function") {
            queueMicrotask(() => target.focus?.());
        }
    }, [onClose, returnFocus]);

    const run = useCallback((option) => {
        if (!option || option.disabled) return;
        option.run?.();
        close();
    }, [close]);

    useLayoutEffect(() => {
        if (!open) return undefined;
        const node = rootRef.current;
        if (!node) return undefined;
        const rect = node.getBoundingClientRect();
        const next = clampPosition(x, y, rect.width, rect.height);
        node.style.left = `${next.left}px`;
        node.style.top = `${next.top}px`;
        const first = enabledItems(options)[0];
        if (first) node.querySelector(`[data-menu-id="${CSS.escape(first.id)}"]`)?.focus();
        return undefined;
    }, [open, options, x, y]);

    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
            if (rootRef.current?.contains(event.target)) return;
            close();
        };
        const onScroll = () => close();
        const onKeyDown = (event) => {
            if (!rootRef.current?.contains(event.target) && event.key !== "Escape") return;
            const items = [...rootRef.current.querySelectorAll('[role="menuitem"]:not([disabled])')];
            const index = items.indexOf(document.activeElement);
            if (event.key === "Escape") {
                event.preventDefault();
                close();
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                items[(index + 1) % items.length]?.focus();
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                items[(index - 1 + items.length) % items.length]?.focus();
            } else if (event.key === "Home") {
                event.preventDefault();
                items[0]?.focus();
            } else if (event.key === "End") {
                event.preventDefault();
                items.at(-1)?.focus();
            } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                document.activeElement?.click();
            } else if (event.key === "ArrowRight") {
                const id = document.activeElement?.getAttribute("data-menu-id");
                const option = items.length ? options.find((entry) => entry.id === id) ?? null : null;
                if (option?.children?.length) {
                    event.preventDefault();
                    setOpenPath([option.id]);
                }
            } else if (event.key === "ArrowLeft") {
                if (openPath.length > 0) {
                    event.preventDefault();
                    setOpenPath((current) => current.slice(0, -1));
                }
            }
        };
        document.addEventListener("mousedown", onPointerDown);
        window.addEventListener("scroll", onScroll, true);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            window.removeEventListener("scroll", onScroll, true);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [close, open, openPath.length, options]);

    if (!open) return null;
    return (
        <div
            ref={rootRef}
            role="menu"
            data-context-menu="true"
            className="fixed z-50 rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] shadow-[var(--slate-shadow-overlay)]"
            style={{ left: x, top: y }}
            onContextMenu={(event) => event.preventDefault()}
        >
            <MenuList options={options} onClose={close} onRun={run} openPath={openPath} setOpenPath={setOpenPath} />
        </div>
    );
}
