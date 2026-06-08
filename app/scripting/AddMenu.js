import { createRef, useEffect, useState } from "react";
import NumberUnit, { NumberUnitClass } from "./units/math/Number";
import { CalculationBlock, CalculationUnit } from "./units/math/Calculation";
import { ROSInputBlock, ROSInputUnit, ROSOutputBlock, ROSOutputUnit } from "./units/ROSUnit";
import { Float64ToInt32, Float64ToInt32Block, Int32ToFloat64, Int32ToFloat64Block } from "./units/conversions/NumberConversions";
import { E, EBlock, GoldenRatio, GoldenRatioBlock, PI, PIBlock, Tau, TauBlock } from "./units/math/Constants";
import { RandomNumber, RandomNumberBlock } from "./units/math/Random";
import { Noise, NoiseBlock } from "./units/math/tex/Noise";
import { MultiplyTex, MultiplyTexBlock, Scale } from "./units/math/tex/Scale";
import { Mask, MaskBlock } from "./units/math/tex/Mask";
import { LiDAR2DUnit } from "./units/devices/LiDAR2d";
import { IfBlock, IfUnit } from "./units/statements/If";
import { Conjugation, ConjugationBlock, Equality, EqualityBlock } from "./units/statements/Equality";
import { StringBlock, StringUnit } from "./units/objects/String";
import {
    BlendTextureBlock,
    BlendTextureUnit,
    HeightToSlopeBlock,
    HeightToSlopeUnit,
    NormalizeTextureBlock,
    NormalizeTextureUnit,
    TerrainNoiseBlock,
    TerrainNoiseUnit,
    TerraceTextureBlock,
    TerraceTextureUnit,
} from "./units/math/Terrain";
import {
    LowPassFilterBlock,
    LowPassFilterUnit,
    RateLimiterBlock,
    RateLimiterUnit,
    SampleTextureBlock,
    SampleTextureUnit,
    SensorFusionBlock,
    SensorFusionUnit,
    ThresholdGateBlock,
    ThresholdGateUnit,
} from "./units/math/SensorFlow";
import {
    GaussianNoiseBlock,
    GaussianNoiseUnit,
    JitterBlock,
    JitterUnit,
    RandomRangeBlock,
    RandomRangeUnit,
    RemapRangeBlock,
    RemapRangeUnit,
    SeededRandomBlock,
    SeededRandomUnit,
    WeightedSelectBlock,
    WeightedSelectUnit,
} from "./units/math/Randomization";
import { ProgramInputBlock, ProgramInputUnit, ProgramOutputBlock, ProgramOutputUnit } from "./units/program/ProgramIO";

function genUUID() {
    return Math.random().toString(36).substring(2, 9);
}

const units = {
    expressions: [
        {
            name: "Number",
            obj: () => {
                return <NumberUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: NumberUnitClass
        },
        {
            name: "Calculation",
            obj: () => {
                return <CalculationUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: CalculationBlock
        },
        {
            name: "Random Number",
            obj: () => {
                return <RandomNumber key={Math.random()} _uuid={genUUID()} />
            },
            class: RandomNumberBlock
        }
    ],
    constants: [
        {
            name: "π (Pi)",
            obj: () => {
                return <PI key={Math.random()} _uuid={genUUID()} />
            },
            class: PIBlock
        },
        {
            name: "e (Euler's Number)",
            obj: () => {
                return <E key={Math.random()} _uuid={genUUID()} />
            },
            class: EBlock
        },
        {
            name: "τ (Tau)",
            obj: () => {
                return <Tau key={Math.random()} _uuid={genUUID()} />
            },
            class: TauBlock
        },
        {
            name: "Golden Ratio (φ)",
            obj: () => {
                return <GoldenRatio key={Math.random()} _uuid={genUUID()} />
            },
            class: GoldenRatioBlock
        }
    ],
    vector2: [
        {
            name: "Noise Texture (tex1d)",
            obj: () => {
                return <Noise key={Math.random()} _uuid={genUUID()} />
            },
            class: NoiseBlock
        },
        {
            name: "Mask Texture (tex1d)",
            obj: () => {
                return <Mask key={Math.random()} _uuid={genUUID()} />
            },
            class: MaskBlock
        },
        {
            name: "Multiply Textures (tex1d)",
            obj: () => {
                return <MultiplyTex key={Math.random()} _uuid={genUUID()} />
            },
            class: MultiplyTexBlock
        },
        {
            name: "Scale Matrix (tex1d)",
            obj: () => {
                return <Scale key={Math.random()} _uuid={genUUID()} />
            },
            class: null
        }
    ],
    terrain: [
        {
            name: "Terrain Noise (tex1d)",
            obj: () => {
                return <TerrainNoiseUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: TerrainNoiseBlock
        },
        {
            name: "Normalize Texture (tex1d)",
            obj: () => {
                return <NormalizeTextureUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: NormalizeTextureBlock
        },
        {
            name: "Blend Texture (tex1d)",
            obj: () => {
                return <BlendTextureUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: BlendTextureBlock
        },
        {
            name: "Terrace Texture (tex1d)",
            obj: () => {
                return <TerraceTextureUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: TerraceTextureBlock
        },
        {
            name: "Height To Slope (tex1d)",
            obj: () => {
                return <HeightToSlopeUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: HeightToSlopeBlock
        }
    ],
    sensorflow: [
        {
            name: "Sample Texture (tex1d -> float64)",
            obj: () => {
                return <SampleTextureUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: SampleTextureBlock
        },
        {
            name: "Low Pass Filter",
            obj: () => {
                return <LowPassFilterUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: LowPassFilterBlock
        },
        {
            name: "Rate Limiter",
            obj: () => {
                return <RateLimiterUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: RateLimiterBlock
        },
        {
            name: "Sensor Fusion",
            obj: () => {
                return <SensorFusionUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: SensorFusionBlock
        },
        {
            name: "Threshold Gate",
            obj: () => {
                return <ThresholdGateUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: ThresholdGateBlock
        }
    ],
    randomization: [
        {
            name: "Random Range",
            obj: () => {
                return <RandomRangeUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: RandomRangeBlock
        },
        {
            name: "Seeded Random",
            obj: () => {
                return <SeededRandomUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: SeededRandomBlock
        },
        {
            name: "Gaussian Noise",
            obj: () => {
                return <GaussianNoiseUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: GaussianNoiseBlock
        },
        {
            name: "Jitter",
            obj: () => {
                return <JitterUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: JitterBlock
        },
        {
            name: "Weighted Select",
            obj: () => {
                return <WeightedSelectUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: WeightedSelectBlock
        },
        {
            name: "Remap Range",
            obj: () => {
                return <RemapRangeUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: RemapRangeBlock
        }
    ],
    conversions: [
        {
            name: "Float64 to Int32",
            obj: () => {
                return <Float64ToInt32 key={Math.random()} _uuid={genUUID()} />
            },
            class: Float64ToInt32Block
        },
        {
            name: "Int32 to Float64",
            obj: () => {
                return <Int32ToFloat64 key={Math.random()} _uuid={genUUID()} />
            },
            class: Int32ToFloat64Block
        }
    ],
    objects: [
        {
            name: "String",
            obj: () => {
                return <StringUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: StringBlock
        }
    ],
    statements: [
        {
            name: "If Statement",
            obj: () => {
                return <IfUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: IfBlock
        },
        {
            name: "Comparison (==, !=, >, <, >=, <=)",
            obj: () => {
                return <Equality key={Math.random()} _uuid={genUUID()} />
            },
            class: EqualityBlock
        },
        {
            name: "Conjunction (AND, OR)",
            obj: () => {
                return <Conjugation key={Math.random()} _uuid={genUUID()} />
            },
            class: ConjugationBlock
        }
    ],
    devices: [
        {
            name: "LiDAR 2D",
            obj: () => {
                return <LiDAR2DUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: null
        }
    ],
    ros: [
        {
            name: "ROS Input",
            obj: () => {
                return <ROSInputUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: ROSInputBlock
        },
        {
            name: "ROS Output",
            obj: () => {
                return <ROSOutputUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: ROSOutputBlock
        }
    ],
    program: [
        {
            name: "Program Input",
            obj: () => {
                return <ProgramInputUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: ProgramInputBlock
        },
        {
            name: "Program Output",
            obj: () => {
                return <ProgramOutputUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: ProgramOutputBlock
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
                                            onAddUnit(unitElement, unit.class, unitElement.props._uuid, position);
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
