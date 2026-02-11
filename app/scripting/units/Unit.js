import { useEffect, useRef, useState } from "react";
import { TYPES } from "../Constants";

function InputRow({ label="in", type="float64", parentID }) {
    const mainType = TYPES[type.replace(/\[.*?\]/, '')];
    const subType = TYPES[type.match(/\[(.*?)\]/)?.[1]];

    return (
        <div className="mb-2 flex items-center">
            {type !== "caption" && <div className={`w-3 h-3 rounded-full mr-2 input-${type.replace(/\[.*?\]/, '')} input parent-${parentID}`} style={{
                backgroundColor: mainType ? mainType : "rgb(150,150,150)"
            }} data-encoded={parentID + "|" + label + "|" + type}>
                <div className={`w-1.5 h-1.5 rounded-full m-[3px]`} style={{
                    backgroundColor: subType ? subType : "#393939"
                }}></div>
            </div>}
            <span className={"text-xs select-none " + (type === "caption" ? "italic" : "")}>{label}</span>
        </div>
    )
}

function OutputRow({ label="out", type="float64", parentID }) {
    const mainType = TYPES[type.replace(/\[.*?\]/, '')];
    const subType = TYPES[type.match(/\[(.*?)\]/)?.[1]];

    return (
        <div className="mb-2 flex items-center justify-end">
            <span className={"text-xs select-none " + (type === "caption" ? "italic" : "")}>{label}</span>
            {type !== "caption" && <div className={`w-3 h-3 rounded-full ml-2 output-${type.replace(/\[.*?\]/, '')} output parent-${parentID}`} style={{
                backgroundColor: mainType ? mainType : "rgb(150,150,150)"
            }}  data-encoded={parentID + "|" + label + "|" + type}>
                <div className={`w-1.5 h-1.5 rounded-full m-[3px]`} style={{
                    backgroundColor: subType ? subType : "#2b2b2b"
                }}></div>
            </div>}
        </div>
    )
}

export default function Unit({ children, title="default title", hasOptions=false, inputs=[], outputs=[], _uuid=null }) {
    const [position, setPosition] = useState({ x: 100, y: 100 });
    const [uuid, setUUID] = useState(null);
    const [selected, setSelected] = useState(false);

    // make sure inputs/output labels are unique within this unit by throwing an error if there are duplicates
    useEffect(() => {
        const labels = [...inputs.map(i => i.label), ...outputs.map(o => o.label)];
        const uniqueLabels = new Set(labels);
        if (uniqueLabels.size !== labels.length) {
            throw new Error(`Duplicate input/output labels in unit "${title}". Labels must be unique within a unit.`);
        }
    }, []);

    useEffect(() => {
        setUUID(_uuid || Math.random().toString(36).substring(2, 9));
    }, []);

    const ref = useRef();
    const titleRef = useRef();
    const positionRef = useRef(position);

    const singleColumn = inputs.length === 0 || outputs.length === 0;

    useEffect(() => {
        positionRef.current = position;
    }, [position]);

    useEffect(() => {
        if (titleRef.current === null) return;

        const onMouseDown = (e) => {
            setSelected(true);
        }

        titleRef.current.addEventListener('mousedown', onMouseDown);
        return () => {
            if (titleRef.current === null) return;
            titleRef.current.removeEventListener('mousedown', onMouseDown);
        }
    }, [titleRef.current, selected])

    useEffect(() => {
        if (ref.current === null) return;
        if (selected) {
            ref.current.style.boxShadow = "0 0 10px 2px rgba(81, 203, 238, 1)";
        } else {
            ref.current.style.boxShadow = "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)";
        }

        if (!selected) {
            const onMouseClickOutside = (e) => {
                if (ref.current && !ref.current.contains(e.target)) {
                    setSelected(false);
                }
            }
            
            document.addEventListener('mousedown', onMouseClickOutside);
        } else {
            const onKeyPress = (e) => {
                if (e.key === "Escape") {
                    setSelected(false);
                } else if (e.key === "Delete" || e.key === "Backspace") {
                    document.dispatchEvent(new CustomEvent('delete-unit', { detail: { uuid } }));
                    setSelected(false);
                }
            }
            document.addEventListener('keydown', onKeyPress);
            return () => {
                document.removeEventListener('keydown', onKeyPress);
            }
        }
    }, [selected])

    // add drag functionality
    useEffect(() => {
        if (ref.current === null) return;

        const element = titleRef.current;
        if (!element) return;

        const dragState = { isDragging: false, startX: 0, startY: 0 };
        
        function onMouseDown(e) {
            e.preventDefault();
            dragState.isDragging = true;
            const current = positionRef.current;
            dragState.startX = e.clientX - current.x;
            dragState.startY = e.clientY - current.y;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        }

        function onMouseMove(e) {
            if (!dragState.isDragging) return;
            const newX = e.clientX - dragState.startX;
            const newY = e.clientY - dragState.startY;
            setPosition({ x: newX, y: newY });
        }
        
        function onMouseUp() {
            dragState.isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }
        
        element.addEventListener('mousedown', onMouseDown);
        return () => {
            element.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
    }, []);

    useEffect(() => {
        if (!ref.current) return;
        ref.current.style.transform = `translate(${position.x}px, ${position.y}px)`;
    }, [position]);

    return (
        <div className="min-w-[160px] bg-[#393939] text-white rounded-lg shadow-lg" ref={ref} data-uuid={uuid}>
            <div className="bg-[#393939] border-b border-[#252525] rounded-t-lg pb-2 pt-2 p-3" ref={titleRef}>
                <h4 className="text-xs select-none">{title}</h4>
            </div>
            { (outputs.length > 0 || inputs.length > 0) && <div className={`mt-[0px] grid ${singleColumn ? 'grid-cols-1' : 'grid-cols-2'} gap-2 ${hasOptions ? 'border-b border-[#252525]' : 'rounded-b-lg' }`}>
                {inputs.length > 0 && <div className={`inputs bg-[#393939] pl-3 pt-2 ${hasOptions ? '' : 'rounded-bl-lg'}`}>
                    {inputs.map((input, index) => (
                        <InputRow key={index} label={input.label} type={input.type} parentID={uuid} />
                    ))}
                </div>}
                {outputs.length > 0 && <div className={`outputs bg-[#2b2b2b] pr-3 pt-2 ${hasOptions ? '' : 'rounded-br-lg'}`}>
                    {outputs.map((output, index) => (
                        <OutputRow key={index} label={output.label} type={output.type} parentID={uuid} />
                    ))}
                </div>}
            </div>}
            {
                hasOptions &&
                <div className="bg-[#393939] rounded-b-lg p-3">
                    {children}
                </div>
            }
        </div>
    )
}

export function TestingUnit() {
    return (
        <Unit title="Testing Unit" hasOptions={true}
        inputs={
            [
                {label: "input 1", type: "float64"},
                {label: "input 2", type: "string"},
                {label: "input 3", type: "boolean"},
                {label: "array input", type: "array[float64]"},
            ]
        }
        outputs={
            [
                {label: "output 1", type: "float64"},
                {label: "output 2", type: "custom[string]"},
                {label: "status", type: "caption"},
                {label: "output 3", type: "boolean"},
            ]}>
            This is a testing unit with some options.
        </Unit>
    )
}