import { useEffect, useMemo, useState } from "react";
import { createCatalogUnitUUID, groupedUnitCatalog } from "./UnitCatalog";

export function AddMenu({ onAddUnit = () => {} }) {
    const [visible, setVisible] = useState(false);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const groupedUnits = useMemo(() => groupedUnitCatalog(), []);

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                setVisible((prev) => !prev);
            }
            if (e.key === "Escape") {
                setVisible(false);
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, []);

    useEffect(() => {
        const handleMouseMove = (e) => {
            if (visible) return;
            setPosition({ x: e.clientX, y: e.clientY });
        };

        document.addEventListener("mousemove", handleMouseMove);
        return () => {
            document.removeEventListener("mousemove", handleMouseMove);
        };
    }, [visible]);

    return (
        <>
            {visible && (
                <div
                    className="fixed z-50 hide-scrollbar"
                    style={{
                        top: position.y,
                        left: position.x,
                        userSelect: visible ? "auto" : "none",
                        pointerEvents: visible ? "auto" : "none",
                        maxHeight: "400px",
                        overflowY: "auto"
                    }}
                >
                    <div className="min-w-[240px] max-h-72 overflow-y-auto rounded-md border border-white/10 bg-[#202020]/95 text-[13px] text-white shadow-[0_18px_52px_rgba(0,0,0,0.35)] backdrop-blur mod-scrollbar">
                        <div className="border-b border-white/10 px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-zinc-400">
                            Add
                        </div>
                        {Object.entries(groupedUnits).map(([category, units]) => (
                            <div key={category} className="py-1">
                                <div className="px-3 py-1 text-[11px] uppercase tracking-[0.06em] text-zinc-500">
                                    {category}
                                </div>
                                {units.map((unit) => (
                                    <button
                                        type="button"
                                        key={`${category}-${unit.name}`}
                                        className="block w-full px-5 py-[5px] text-left text-[#e0e0e0] transition-[transform,background-color,color] duration-150 hover:bg-[#4772b3] hover:text-white active:scale-[0.98]"
                                        onClick={() => {
                                            onAddUnit(unit, createCatalogUnitUUID(), position);
                                            setVisible(false);
                                        }}
                                    >
                                        {unit.name}
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </>
    );
}
