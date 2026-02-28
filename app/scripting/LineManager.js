import { useEffect, useRef, useState } from "react"
import { TYPES } from "./Constants";

export function Line({ lineId, start = { x: 0, y: 0 }, end = { x: 0, y: 0 }, color = "white", onDeleted=() => {} }) {
    const [selected, setSelected] = useState(false);

    useEffect(() => {
        if (!selected) return;

        const handleKeyDown = (e) => {
            // console.log(e.key)
            if (e.key === "Delete" || e.key === "Backspace") {
                // console.log("Deleting line");
                onDeleted(lineId);
            }
        }

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        }
    }, [selected]);

    // Calculate control points for a smooth cubic Bézier curve
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    // Control points: horizontally offset for left-to-right, vertically for top-to-bottom
    const c1 = { x: start.x + dx * 0.25, y: start.y };
    const c2 = { x: end.x - dx * 0.25, y: end.y };
    const path = `M ${start.x},${start.y} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`;
    return (
        <svg className="absolute top-0 left-0 w-full h-full pointer-events-none">
            <path
                d={path}
                stroke="white"
                strokeWidth="12"
                fill="none"
                strokeOpacity={"0"}
                pointerEvents="stroke"
                onClick={() => {
                    setSelected(!selected);
                }}
            />
            <path
                d={path}
                stroke="white"
                strokeWidth="6"
                fill="none"
                strokeOpacity={selected ? "0.2" : "0"}
                pointerEvents="stroke"
                onClick={() => {
                    setSelected(!selected);
                }}
            />
            <path
                d={path}
                stroke={color}
                strokeWidth="2"
                fill="none"
            />
        </svg>
    );
}

function sourceToInfo(source) {
    // get data-encoded tag
    const str = source.dataset.encoded;
    if (!str) return null;
    const [uuid, label, type] = str.split('|');
    return { uuid, label, type };
}

function isSameConnection(aFrom, aTo, bFrom, bTo) {
    return aFrom?.uuid === bFrom?.uuid && aFrom?.label === bFrom?.label && aTo?.uuid === bTo?.uuid && aTo?.label === bTo?.label;
}

export function LineManager({ units, notifyConnection=(from, to) => {}, onDeleteConnection=(from, to) => {} }) {
    const [lines, setLines] = useState([]);
    const [lineInProgress, setLineInProgress] = useState(null);
    const linesRef = useRef(lines);

    useEffect(() => {
        linesRef.current = lines;
    }, [lines]);

    const deleteLine = (lineId) => {
        const line = linesRef.current.find((item) => item.id === lineId);
        if (line) {
            onDeleteConnection(sourceToInfo(line.startSource), sourceToInfo(line.endTarget));
        }

        setLines((prevLines) => prevLines.filter((item) => item.id !== lineId));
    }

    // add lines
    useEffect(() => {
        const inputs = document.querySelectorAll('.input');

        const onMouseDownOverTarget = (e) => {
//            console.log("Mouse down over input", e.target);
            const rect = e.target.getBoundingClientRect();
            const startX = rect.left + rect.width / 2;
            const startY = rect.top + rect.height / 2;
            // check if e.target has class 'input-<type>'
            const hasInputClass = Array.from(e.target.classList).some(cls => cls.startsWith('input-'));
            const source = hasInputClass ? e.target : e.target.closest('.input');
             
            setLineInProgress({ start: { x: startX, y: startY }, end: { x: startX, y: startY }, source });
//            console.log("Started line from", e.target);
        }

        for (let input of inputs) {
            input.addEventListener('mousedown', onMouseDownOverTarget);
        }

        return () => {
            for (let input of inputs) {
                if (input) input.removeEventListener('mousedown', onMouseDownOverTarget);
            }
        };
    }, [units])

    useEffect(() => {
        if (!lineInProgress) return;

        function onMouseMove(e) {
            if (lineInProgress) {
                setLineInProgress({
                    ...lineInProgress,
                    end: { x: e.clientX, y: e.clientY }
                });
            }
        }

        function onMouseUp(e) {
            if (lineInProgress) {
                const outputs = document.querySelectorAll('.output');

                const thisType = lineInProgress.source.className.includes('input-') ? lineInProgress.source.className.split('input-')[1].split(' ')[0] : null;
                const thisParentID = lineInProgress.source.className.includes('parent-') ? lineInProgress.source.className.split('parent-')[1].split(' ')[0] : null;

                let connected = false;
                for (let output of outputs) {
                    const outputType = output.className.includes('output-') ? output.className.split('output-')[1].split(' ')[0] : null;
                    const outputParentID = output.className.includes('parent-') ? output.className.split('parent-')[1].split(' ')[0] : null;

                    // only connect if not the same parent unit
                    if (thisParentID === outputParentID) continue;
                    if (thisType !== outputType) continue;

                    const rect = output.getBoundingClientRect();
                    const outputX = rect.left + rect.width / 2;
                    const outputY = rect.top + rect.height / 2;
                    const distance = Math.hypot(e.clientX - outputX, e.clientY - outputY);

                    if (distance < 10) { // within 10 pixels
                        const fromInfo = sourceToInfo(lineInProgress.source);
                        const toInfo = sourceToInfo(output);

                        const duplicate = lines.some((line) => isSameConnection(
                            sourceToInfo(line.startSource),
                            sourceToInfo(line.endTarget),
                            fromInfo,
                            toInfo
                        ));

                        if (duplicate) {
                            connected = true;
                            break;
                        }

                        setLines((prevLines) => [...prevLines, {
                            id: crypto.randomUUID(),
                            start: lineInProgress.start,
                            end: { x: outputX, y: outputY },
                            startSource: lineInProgress.source,
                            endTarget: output,
                            color: TYPES[thisType] || 'white'
                        }]);
                        notifyConnection(fromInfo, toInfo || output);
                        connected = true;
                        break;
                    }
                }
                if (!connected) {
                    console.log("Line not connected to any output, cancelling.");
                }
                setLineInProgress(null);
            }
        }

        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('mousemove', onMouseMove);
        return () => {
            document.removeEventListener('mouseup', onMouseUp);
            document.removeEventListener('mousemove', onMouseMove);
        };
    }, [lineInProgress, lines, notifyConnection]);

    useEffect(() => {
        const onDeleteUnit = (e) => {
            const unitUUID = e.detail?.uuid;
            if (!unitUUID) return;

            const currentLines = linesRef.current;
            const toRemove = currentLines.filter((line) => {
                const from = sourceToInfo(line.startSource);
                const to = sourceToInfo(line.endTarget);
                return from?.uuid === unitUUID || to?.uuid === unitUUID;
            });

            toRemove.forEach((line) => {
                onDeleteConnection(sourceToInfo(line.startSource), sourceToInfo(line.endTarget));
            });

            setLines(currentLines.filter((line) => {
                const from = sourceToInfo(line.startSource);
                const to = sourceToInfo(line.endTarget);
                return from?.uuid !== unitUUID && to?.uuid !== unitUUID;
            }));
        };

        document.addEventListener('delete-unit', onDeleteUnit);
        return () => {
            document.removeEventListener('delete-unit', onDeleteUnit);
        };
    }, [onDeleteConnection]);

    useEffect(() => {
        const handleResize = () => {
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.startSource) {
                    const rect = line.startSource.getBoundingClientRect();
                    line.start = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                }
                if (line.endTarget) {
                    const rect = line.endTarget.getBoundingClientRect();
                    line.end = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                }
            }
            setLines([...lines]);
        };

        const interval = setInterval(handleResize, 10);
        return () => clearInterval(interval);
    }, [lines])

    return (
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-10">
            {lineInProgress && <Line start={lineInProgress.start} end={lineInProgress.end} />}
            {lines.map((line, index) => (
                <Line key={line.id || index} lineId={line.id} start={line.start} end={line.end} color={line.color} onDeleted={deleteLine} />
            ))}
        </div>
    )
}