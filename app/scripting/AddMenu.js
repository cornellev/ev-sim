import { useEffect, useMemo, useState } from "react";
import {
    IconAbc, IconActivity, IconArrowsExchange, IconBinaryTree2, IconBox, IconBug,
    IconCar, IconCategory, IconChevronDown, IconChevronRight, IconCode, IconDatabase,
    IconDice, IconFunction, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand,
    IconMathFunction, IconMessage, IconMountain, IconPlugConnected, IconPlus, IconRoute,
    IconSearch, IconVector, IconX,
} from "@tabler/icons-react";
import { createCatalogUnitUUID, groupedUnitCatalog } from "./UnitCatalog";

const CATEGORY_META = {
    all: { label: "All", icon: IconCategory, accent: "text-zinc-100" },
    expressions: { label: "Expressions", icon: IconMathFunction, accent: "text-rose-300" },
    constants: { label: "Constants", icon: IconFunction, accent: "text-amber-300" },
    texture1d: { label: "Texture 1D", icon: IconVector, accent: "text-blue-300" },
    terrain: { label: "Terrain", icon: IconMountain, accent: "text-lime-300" },
    sensorflow: { label: "Sensor flow", icon: IconActivity, accent: "text-cyan-300" },
    randomization: { label: "Random", icon: IconDice, accent: "text-fuchsia-300" },
    conversions: { label: "Conversions", icon: IconArrowsExchange, accent: "text-orange-300" },
    objects: { label: "Objects", icon: IconAbc, accent: "text-yellow-200" },
    statements: { label: "Logic", icon: IconBinaryTree2, accent: "text-emerald-300" },
    program: { label: "Program", icon: IconCode, accent: "text-sky-300" },
    signals: { label: "Signals", icon: IconDatabase, accent: "text-indigo-300" },
    topics: { label: "Topics", icon: IconMessage, accent: "text-teal-300" },
    simulator: { label: "Simulator", icon: IconCar, accent: "text-green-300" },
    mission: { label: "Mission", icon: IconRoute, accent: "text-violet-300" },
    bindings: { label: "Bindings", icon: IconPlugConnected, accent: "text-purple-300" },
    diagnostics: { label: "Diagnostics", icon: IconBug, accent: "text-red-300" },
};

function cx(...classes) {
    return classes.filter(Boolean).join(" ");
}

function isEditableTarget(target) {
    if (!target || typeof target.closest !== "function") return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable]")) || target.isContentEditable;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function categoryMeta(category) {
    if (CATEGORY_META[category]) return CATEGORY_META[category];

    const label = String(category || "blocks")
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());

    return { label, icon: IconBox, accent: "text-zinc-300" };
}

function flattenCatalogGroups(groups) {
    return Object.entries(groups).flatMap(([category, units]) => (
        units.map((unit) => ({ ...unit, category }))
    ));
}

function matchesQuery(unit, query) {
    if (!query) return true;

    const haystack = [
        unit.name,
        unit.category,
        unit.type
    ].filter(Boolean).join(" ").toLowerCase();

    return haystack.includes(query.toLowerCase());
}

function groupUnits(units) {
    return units.reduce((groups, unit) => {
        if (!groups[unit.category]) groups[unit.category] = [];
        groups[unit.category].push(unit);
        return groups;
    }, {});
}

function CategoryButton({
    category,
    count,
    active,
    compact = false,
    onClick
}) {
    const meta = categoryMeta(category);
    const Icon = meta.icon;

    if (compact) {
        return (
            <button
                type="button"
                aria-label={meta.label}
                title={meta.label}
                className={cx(
                    "group relative flex h-9 w-9 items-center justify-center rounded-[var(--radius)] border transition-[transform,background-color,border-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97]",
                    active
                        ? "border-white/18 bg-white/12 text-white"
                        : "border-transparent bg-transparent text-zinc-500 hover:border-white/10 hover:bg-white/7 hover:text-zinc-100"
                )}
                onClick={onClick}
            >
                <Icon className={cx("h-4 w-4", active ? "text-white" : meta.accent)} stroke={1.75} />
            </button>
        );
    }

    return (
        <button
            type="button"
            className={cx(
                "group flex h-8 w-full items-center gap-2 rounded-[var(--radius)] px-2 text-left text-[12px] transition-[transform,background-color,border-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.98]",
                active
                    ? "bg-white/10 text-white"
                    : "text-zinc-400 hover:bg-white/6 hover:text-zinc-100"
            )}
            onClick={onClick}
        >
            <Icon className={cx("h-4 w-4 shrink-0", active ? "text-white" : meta.accent)} stroke={1.75} />
            <span className="min-w-0 flex-1 truncate">{meta.label}</span>
            <span className={cx(
                "rounded-[4px] px-1.5 py-0.5 font-mono text-[11px]",
                active ? "bg-white/12 text-zinc-200" : "bg-white/6 text-zinc-500"
            )}>
                {count}
            </span>
        </button>
    );
}

function CategoryFilterPanel({
    categoryOrder,
    categoryCounts,
    activeCategory,
    collapsed,
    onToggle,
    onSelect,
}) {
    const activeMeta = categoryMeta(activeCategory);

    return (
        <div className="border-b border-white/8">
            <button
                type="button"
                aria-expanded={!collapsed}
                aria-label={collapsed ? `Expand categories, ${activeMeta.label}` : "Collapse categories"}
                className="group flex w-full items-center gap-2 px-3 py-2 text-left transition-[background-color,color] duration-150 hover:bg-white/6"
                onClick={onToggle}
            >
                {collapsed
                    ? <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-colors duration-150 group-hover:text-zinc-300" stroke={1.75} aria-hidden="true" />
                    : <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-colors duration-150 group-hover:text-zinc-300" stroke={1.75} aria-hidden="true" />}
                <span className="text-[11px] font-medium text-zinc-400 transition-colors duration-150 group-hover:text-zinc-200">
                    Categories
                </span>
                <span className="h-px flex-1 bg-white/8" />
                {collapsed && (
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[11px] text-zinc-500">{activeMeta.label}</span>
                        <span className="font-mono text-[11px] text-zinc-600">{categoryCounts[activeCategory] || 0}</span>
                    </span>
                )}
            </button>
            {!collapsed && (
                <div className="grid grid-cols-2 gap-1 px-2 pb-2">
                    <CategoryButton
                        category="all"
                        count={categoryCounts.all || 0}
                        active={activeCategory === "all"}
                        onClick={() => onSelect("all")}
                    />
                    {categoryOrder.map((category) => (
                        <CategoryButton
                            key={category}
                            category={category}
                            count={categoryCounts[category] || 0}
                            active={activeCategory === category}
                            onClick={() => onSelect(category)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function BlockRow({ unit, onAdd }) {
    const meta = categoryMeta(unit.category);
    const Icon = meta.icon;

    return (
        <button
            type="button"
            className="group flex w-full items-center gap-2 rounded-[var(--radius)] border border-transparent px-2 py-1.5 text-left transition-[transform,background-color,border-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-white/10 hover:bg-white/7 active:scale-[0.99]"
            onClick={onAdd}
        >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius)] border border-white/8 bg-[var(--slate-surface-2)] text-zinc-300 transition-colors duration-150 group-hover:border-white/14 group-hover:bg-[var(--slate-surface-hover)]">
                <Icon className={cx("h-4 w-4", meta.accent)} stroke={1.75} />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium leading-4 text-zinc-100">{unit.name}</span>
                <span className="block truncate text-[11px] leading-4 text-zinc-500">{meta.label}</span>
            </span>
            <IconPlus className="h-4 w-4 shrink-0 text-zinc-500 transition-colors duration-150 group-hover:text-zinc-100" stroke={1.75} />
        </button>
    );
}

export function AddMenu({ onAddUnit = () => {} }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [activeCategory, setActiveCategory] = useState("all");
    const [categoriesCollapsed, setCategoriesCollapsed] = useState(false);
    const [lastCanvasPointer, setLastCanvasPointer] = useState({ x: 420, y: 180 });
    const groupedUnits = useMemo(() => groupedUnitCatalog(), []);
    const allUnits = useMemo(() => flattenCatalogGroups(groupedUnits), [groupedUnits]);
    const categoryOrder = useMemo(() => Object.keys(groupedUnits), [groupedUnits]);
    const categoryCounts = useMemo(() => {
        const counts = Object.fromEntries(
            Object.entries(groupedUnits).map(([category, units]) => [category, units.length])
        );
        counts.all = allUnits.length;
        return counts;
    }, [allUnits.length, groupedUnits]);

    const visibleUnits = useMemo(() => {
        return allUnits.filter((unit) => {
            const categoryMatch = activeCategory === "all" || unit.category === activeCategory;
            return categoryMatch && matchesQuery(unit, query.trim());
        });
    }, [activeCategory, allUnits, query]);

    const visibleGroups = useMemo(() => groupUnits(visibleUnits), [visibleUnits]);

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === "a" && (e.ctrlKey || e.metaKey) && !isEditableTarget(e.target)) {
                e.preventDefault();
                setOpen((prev) => !prev);
            }
            if (e.key === "Escape") {
                setOpen(false);
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, []);

    useEffect(() => {
        const handleMouseMove = (e) => {
            if (e.target?.closest?.("[data-block-library]")) return;
            setLastCanvasPointer({ x: e.clientX, y: e.clientY });
        };

        document.addEventListener("mousemove", handleMouseMove);
        return () => {
            document.removeEventListener("mousemove", handleMouseMove);
        };
    }, []);

    const getSpawnPosition = () => {
        const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
        const sidebarEdge = open ? 354 : 72;

        return {
            x: Math.max(sidebarEdge + 24, lastCanvasPointer.x),
            y: clamp(lastCanvasPointer.y, 96, Math.max(120, viewportHeight - 140))
        };
    };

    const addUnit = (unit) => {
        onAddUnit(unit, createCatalogUnitUUID(), getSpawnPosition());
    };

    const listedCategoryOrder = activeCategory === "all"
        ? categoryOrder
        : categoryOrder.filter((category) => category === activeCategory);

    return (
        <aside
            data-block-library
            className={cx(
                "fixed bottom-4 left-3 top-[72px] z-50 flex overflow-hidden rounded-[4px] border border-white/10 bg-[var(--slate-surface-1)] text-white shadow-[0_16px_40px_rgba(0,0,0,0.28)] transition-[width,background-color,border-color] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
                open ? "w-[330px] max-[899px]:w-[min(330px,calc(100vw-24px))]" : "w-[52px]"
            )}
        >
            <div className="flex w-[52px] shrink-0 flex-col items-center border-r border-white/8 bg-[var(--slate-bg)] py-2">
                <button
                    type="button"
                    aria-label={open ? "Collapse block library" : "Expand block library"}
                    title={open ? "Collapse block library" : "Expand block library"}
                    className="mb-2 flex h-9 w-9 items-center justify-center rounded-[var(--radius)] border border-white/10 bg-white/6 text-zinc-200 transition-[transform,background-color,border-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-white/18 hover:bg-white/10 hover:text-white active:scale-[0.97]"
                    onClick={() => setOpen((value) => !value)}
                >
                    {open
                        ? <IconLayoutSidebarLeftCollapse className="h-4 w-4" stroke={1.75} />
                        : <IconLayoutSidebarLeftExpand className="h-4 w-4" stroke={1.75} />}
                </button>

                <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-1 hide-scrollbar">
                    <CategoryButton
                        category="all"
                        count={categoryCounts.all || 0}
                        compact
                        active={activeCategory === "all"}
                        onClick={() => {
                            setActiveCategory("all");
                            setOpen(true);
                        }}
                    />
                    {categoryOrder.map((category) => (
                        <CategoryButton
                            key={category}
                            category={category}
                            count={categoryCounts[category] || 0}
                            compact
                            active={activeCategory === category}
                            onClick={() => {
                                setActiveCategory(category);
                                setOpen(true);
                            }}
                        />
                    ))}
                </div>
            </div>

            {open && <div className={cx(
                "flex min-w-0 flex-1 flex-col transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
                open ? "translate-x-0 opacity-100" : "-translate-x-2 opacity-0"
            )}>
                <div className="border-b border-white/8 px-3 py-3">
                    <div className="mb-2 flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                            <h2 className="truncate text-sm font-medium tracking-normal text-zinc-50">Blocks</h2>
                            <div className="mt-0.5 font-mono text-[11px] text-zinc-500">
                                {visibleUnits.length} of {allUnits.length}
                            </div>
                        </div>
                        <button
                            type="button"
                            aria-label="Close block library"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)] border border-white/8 bg-white/5 text-zinc-400 transition-[transform,background-color,border-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-white/16 hover:bg-white/10 hover:text-white active:scale-[0.97]"
                            onClick={() => setOpen(false)}
                        >
                            <IconX className="h-4 w-4" stroke={1.75} />
                        </button>
                    </div>

                    <label className="relative block">
                        <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" stroke={1.75} />
                        <input
                            value={query}
                            placeholder="Search blocks"
                            className="h-8 w-full rounded-[var(--radius)] border border-white/10 bg-[var(--slate-bg)] pl-8 pr-8 text-[12px] text-zinc-100 outline-none transition-[border-color,background-color,box-shadow] duration-150 placeholder:text-zinc-600 focus:border-white/22 focus:bg-[var(--slate-surface-2)] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]"
                            onChange={(event) => setQuery(event.target.value)}
                        />
                        {query.length > 0 && (
                            <button
                                type="button"
                                aria-label="Clear search"
                                className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-[4px] text-zinc-500 transition-[background-color,color] duration-150 hover:bg-white/8 hover:text-zinc-200"
                                onClick={() => setQuery("")}
                            >
                                <IconX className="h-3.5 w-3.5" stroke={1.75} />
                            </button>
                        )}
                    </label>
                </div>

                <CategoryFilterPanel
                    categoryOrder={categoryOrder}
                    categoryCounts={categoryCounts}
                    activeCategory={activeCategory}
                    collapsed={categoriesCollapsed}
                    onToggle={() => setCategoriesCollapsed((value) => !value)}
                    onSelect={setActiveCategory}
                />

                <div className="min-h-0 flex-1 overflow-y-auto p-2 mod-scrollbar">
                    {visibleUnits.length === 0 ? (
                        <div className="rounded-[var(--radius)] border border-white/8 bg-white/[0.03] px-3 py-6 text-center text-[12px] text-zinc-500">
                            No blocks found
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {listedCategoryOrder.map((category) => {
                                const units = visibleGroups[category] || [];
                                if (units.length === 0) return null;
                                const meta = categoryMeta(category);

                                return (
                                    <section key={category}>
                                        <div className="mb-1.5 flex items-center gap-2 px-1">
                                            <span className="text-[11px] font-medium text-zinc-400">
                                                {meta.label}
                                            </span>
                                            <span className="h-px flex-1 bg-white/8" />
                                            <span className="font-mono text-[11px] text-zinc-600">{units.length}</span>
                                        </div>
                                        <div className="space-y-1">
                                            {units.map((unit) => (
                                                <BlockRow
                                                    key={`${unit.category}-${unit.name}-${unit.type || "component"}`}
                                                    unit={unit}
                                                    onAdd={() => addUnit(unit)}
                                                />
                                            ))}
                                        </div>
                                    </section>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>}
        </aside>
    );
}
