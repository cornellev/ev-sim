import { createRef, useEffect, useState } from "react";
import NumberUnit from "./units/math/Number";
import { CalculationUnit } from "./units/math/Calculation";
import { ROSInputUnit, ROSOutputUnit } from "./units/ROSUnit";
import { Float64ToInt32, Int32ToFloat64 } from "./units/conversions/NumberConversions";
import { E, GoldenRatio, PI, Tau } from "./units/math/Constants";
import { RandomNumber } from "./units/math/Random";

function genUUID() {
    return Math.random().toString(36).substring(2, 9);
}

const units = {
    expressions: [
        {
            name: "Number",
            obj: () => {
                return <NumberUnit key={Math.random()} _uuid={genUUID()} />
            }
        },
        {
            name: "Calculation",
            obj: () => {
                return <CalculationUnit key={Math.random()} _uuid={genUUID()} />
            }
        },
        {
            name: "Random Number",
            obj: () => {
                return <RandomNumber key={Math.random()} _uuid={genUUID()} />
            }
        }
    ],
    constants: [
        {
            name: "π (Pi)",
            obj: () => {
                return <PI key={Math.random()} _uuid={genUUID()} />
            }
        },
        {
            name: "e (Euler's Number)",
            obj: () => {
                return <E key={Math.random()} _uuid={genUUID()} />
            }
        },
        {
            name: "τ (Tau)",
            obj: () => {
                return <Tau key={Math.random()} _uuid={genUUID()} />
            }
        },
        {
            name: "Golden Ratio (φ)",
            obj: () => {
                return <GoldenRatio key={Math.random()} _uuid={genUUID()} />
            }
        }
    ],
    conversions: [
        {
            name: "Float64 to Int32",
            obj: () => {
                return <Float64ToInt32 key={Math.random()} _uuid={genUUID()} />
            }
        },
        {
            name: "Int32 to Float64",
            obj: () => {
                return <Int32ToFloat64 key={Math.random()} _uuid={genUUID()} />
            }
        }
    ],
    ros: [
        {
            name: "ROS Input",
            obj: () => {
                return <ROSInputUnit key={Math.random()} _uuid={genUUID()} />
            }
        },
        {
            name: "ROS Output",
            obj: () => {
                return <ROSOutputUnit key={Math.random()} _uuid={genUUID()} />
            }
        }
    ]
}

const symbols = {
    expressions: "",
    constants: "",
    conversions: "", // to be done, svgs
    ros: "" // to be done, svgs
}


export function AddMenu({ onAddUnit=(u)=>{} }) {
    const [visible, setVisible] = useState(false);
    const [position, setPosition] = useState({ x: 0, y: 0 });

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                setVisible((prev) => !prev);
            }
            if (e.key === "Escape") {
                setVisible(false);
            }
        }

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        }
    }, []);

    useEffect(() => {
        const handleMouseMove = (e) => {
            if (visible) return;
            setPosition({ x: e.clientX, y: e.clientY });
        };

        document.addEventListener('mousemove', handleMouseMove);
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
        };
    }, [visible]);

    return (
        <>
            {visible && 
                <div 
                    className="fixed z-50 hide-scrollbar" 
                    style={{ top: position.y, left: position.x, userSelect: visible ? 'auto' : 'none', pointerEvents: visible ? 'auto' : 'none',
                        // hide scroll bar but allow scrolling
                        maxHeight: '400px',
                        overflowY: 'auto'
                     }}
                >
                    <div className="bg-[#2b2b2b] border border-[#111111] rounded-sm shadow-xl text-[13px] text-white min-w-[220px] max-h-64 overflow-y-auto select-none mod-scrollbar">
                        <div className="px-3 py-2 border-b border-[#3a3a3a] uppercase tracking-[0.08em] text-[11px] text-[#bfbfbf]">
                            Add
                        </div>
                        {Object.keys(units).map((category, index) => (
                            <div key={index} className="py-1">
                                <div className="px-3 py-1 text-[11px] uppercase tracking-[0.06em] text-[#b0b0b0]">
                                    {category}
                                </div>
                                {units[category].map((unit, uIndex) => (
                                    <div 
                                        key={uIndex} 
                                        className="px-5 py-[3px] cursor-pointer hover:bg-[#4772b3] hover:text-white text-[#e0e0e0]"
                                        onClick={() => {
                                            const unitElement = unit.obj();
                                            onAddUnit(unitElement);
                                            setVisible(false);
                                        }}
                                    >
                                        {unit.name}
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            }
        </>
    )
        
}