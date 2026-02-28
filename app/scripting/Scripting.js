import { useEffect, useRef, useState } from "react";
import Grid from "./Grid";
import { LineManager } from "./LineManager";
import { ROSInputUnit, ROSOutputBlock, ROSOutputUnit } from "./units/ROSUnit";
import { createCompiledProgramUnit } from "./units/program/ProgramIO";
import Unit, { TestingUnit } from "./units/Unit";
import NumberUnit from "./units/math/Number";
import { AddMenu } from "./AddMenu";
import { CompiledProgramUnitBlock, ScriptManager } from "./ScriptManager";
import { FaCheckCircle } from "react-icons/fa";
import { FaCircleXmark } from "react-icons/fa6";

export default function Scripting({ output, input}) {
    const headUUID = useRef("head-uuid");
    const [valid, setValid] = useState(false);
    const compiledRef = useRef(null);

    const [unitChildren, setUnitChildren] = useState([
        <ROSOutputUnit key="ros-output" input={input} _uuid={headUUID.current} />
    ]);
    const importInputRef = useRef(null);

    useEffect(() => {
        // add head unit to manager
        const headUnit = new ROSOutputBlock(headUUID.current);
        manager.current.addUnit(headUnit);
        manager.current.setHead(headUUID.current);
    }, []);

    const manager = useRef(new ScriptManager());

    useEffect(() => {
        if (!manager.current) return;

        const onData = (e) => {
            const { uuid, data } = e.detail;
            manager.current.storeData(uuid, data);
        }

        const onReregister = (e) => {
            const { uuid } = e.detail;
            const block = manager.current.units.find(u => u.uuid === uuid);
            if (block) {
                block.reregister();
                setValid(manager.current.checkValidity());
            }
        }

        document.addEventListener('data-stored', onData);
        document.addEventListener('reregister-unit', onReregister);

        return () => {
            document.removeEventListener('data-stored', onData);
            document.removeEventListener('reregister-unit', onReregister);
        }
    }, [manager])

    const addUnit = (unitElement, inst, uuid, position) => {
        if (inst) manager.current.addUnit(new inst(uuid));
        setUnitChildren((prev) => [...prev, unitElement]);

        if (position && uuid) {
            setTimeout(() => {
                document.dispatchEvent(new CustomEvent('position-unit', { detail: { uuid, position } }));
            }, 0);
        }
    };

    const onConnectUnits = (from, to) => {
        const outputUUID = to.uuid;
        const outputLabel = to.label;
        const inputUUID = from.uuid;
        const inputLabel = from.label;
        manager.current.connectUnits(outputUUID, outputLabel, inputUUID, inputLabel);

        setValid(manager.current.checkValidity());
    };

    const onDeleteConnection = (from, to) => {
        if (!from || !to) return;

        manager.current.disconnectUnits(to.uuid, to.label, from.uuid, from.label);
        setValid(manager.current.checkValidity());
    };
    
    const unitParentRef = useRef();

    useEffect(() => {
        const onDeleteUnit = (e) => {
            const unitIdToDelete = e.detail.uuid;
            manager.current.removeUnit(unitIdToDelete);

            setUnitChildren((prev) => prev.filter((unit) => unit.props['_uuid'] !== unitIdToDelete));
            setValid(manager.current.checkValidity());
        }

        document.addEventListener('delete-unit', onDeleteUnit);

        return () => {
            document.removeEventListener('delete-unit', onDeleteUnit);
        }
    }, []);

    useEffect(() => {
        if (!manager.current) return;

        setValid(manager.current.checkValidity());
    }, [unitChildren, manager]);

    const attemptExecute = () => {
        try {
            const output = manager.current.execute();
            console.log("Execution output:", output);
        } catch (err) {
            console.error("Error during execution:", err);
        }
    }

    const compileProgram = () => {
        try {
            const compiled = manager.current.compile(`program-${Date.now()}`);
            compiledRef.current = compiled;

            const payload = JSON.stringify(compiled, null, 2);
            const blob = new Blob([payload], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${compiled.name}.json`;
            anchor.click();
            URL.revokeObjectURL(url);

            console.log("Compiled program:", compiled);
        } catch (err) {
            console.error("Error compiling program:", err);
        }
    }

    const runCompiled = () => {
        try {
            if (!compiledRef.current) {
                compiledRef.current = manager.current.compile(`program-${Date.now()}`);
            }

            const run = ScriptManager.runCompiled(compiledRef.current, {});
            console.log("Compiled run result:", run);
        } catch (err) {
            console.error("Error running compiled program:", err);
        }
    }

    const importCompiledProgram = () => {
        importInputRef.current?.click();
    }

    const onImportCompiledFile = async (event) => {
        try {
            const file = event.target.files?.[0];
            if (!file) return;

            const text = await file.text();
            const parsed = JSON.parse(text);

            if (!parsed || !Array.isArray(parsed.units) || !parsed.interface) {
                throw new Error("Selected file is not a valid compiled program artifact.");
            }

            compiledRef.current = parsed;

            const uuid = crypto.randomUUID();
            const block = new CompiledProgramUnitBlock(uuid);
            block.hydrateState({
                compiledProgram: parsed,
                name: parsed.name || "Imported Program"
            });
            manager.current.addUnit(block);

            const CompiledUnit = createCompiledProgramUnit(parsed, parsed.name || "Imported Program");
            const unitElement = <CompiledUnit key={Math.random()} _uuid={uuid} />;
            const position = {
                x: Math.max(24, window.innerWidth / 2 - 120),
                y: Math.max(24, window.innerHeight / 2 - 80)
            };

            setUnitChildren((prev) => [...prev, unitElement]);
            setTimeout(() => {
                document.dispatchEvent(new CustomEvent('position-unit', { detail: { uuid, position } }));
            }, 0);

            setValid(manager.current.checkValidity());
            console.log("Imported compiled program:", parsed);
        } catch (err) {
            console.error("Error importing compiled program:", err);
        } finally {
            if (event.target) {
                event.target.value = "";
            }
        }
    }

    return (
        <>
        <div className="fixed top-2 left-2 z-100 bg-black/60 rounded px-2 py-1 flex items-center gap-2 text-xs text-gray-400" style={{pointerEvents: 'none', minWidth: '120px'}}>
            { valid ? (
                <span className="flex items-center gap-2">
                    <FaCheckCircle className="text-gray-400" size={12} />
                    <span>Program is valid</span>
                </span>
            ) : (
                <span className="flex items-center gap-2">
                    <FaCircleXmark className="text-gray-400" size={12} />
                    <span>Program is invalid</span>
                </span>
            )}
        </div>
        <div className="fixed top-10 left-5 z-100">
            <button onClick={attemptExecute} className="rounded-sm bg-blue-500 text-white px-3 py-1 cursor-pointer">Execute</button>
        </div>
        <div className="fixed top-10 left-28 z-100 flex gap-2">
            <button onClick={compileProgram} className="rounded-sm bg-[#4f4f4f] text-white px-3 py-1 cursor-pointer">Compile</button>
            <button onClick={runCompiled} className="rounded-sm bg-[#4f4f4f] text-white px-3 py-1 cursor-pointer">Run Compiled</button>
            <button onClick={importCompiledProgram} className="rounded-sm bg-[#4f4f4f] text-white px-3 py-1 cursor-pointer">Import Compiled</button>
            <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={onImportCompiledFile}
            />
        </div>
        <div className="w-[100vw] h-[100vh] bg-[#292929]">
            <Grid />
            <LineManager units={unitChildren} notifyConnection={onConnectUnits} onDeleteConnection={onDeleteConnection} />
            <AddMenu onAddUnit={addUnit} />
            
            <div className="absolute top-4 left-4 text-white" ref={unitParentRef}>
                {unitChildren}
            </div>
        </div>
        </>
    );
}