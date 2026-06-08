import { useEffect, useRef, useState } from "react";
import Grid from "./Grid";
import { LineManager } from "./LineManager";
import {
    createOutputNodePort,
    createCompiledProgramUnit,
    hasDuplicateOutputLabels,
    OutputNodeBlock,
    OUTPUT_NODE_MAX_OUTPUTS,
    OutputNodeUnit,
    normalizeOutputNodeState,
    SUPPORTED_TYPES,
} from "./units/program/ProgramIO";
import { AddMenu } from "./AddMenu";
import { CompiledProgramUnitBlock, ScriptManager } from "./ScriptManager";
import { registerBuiltInBlocks } from "./registerBuiltInBlocks";
import { TYPES } from "./Constants";
import { FaCheckCircle } from "react-icons/fa";
import { FaCircleXmark } from "react-icons/fa6";

registerBuiltInBlocks();

const OUTPUT_NODE_DEFAULT = normalizeOutputNodeState({
    outputs: [createOutputNodePort(0)]
});

function getNextOutputPortId(outputs) {
    const existingIds = new Set(outputs.map((output) => output.id));
    let index = outputs.length + 1;
    let id = `output-${index}`;

    while (existingIds.has(id)) {
        index += 1;
        id = `output-${index}`;
    }

    return id;
}

function OutputNodeSidebar({ config, onChange, valid }) {
    const outputState = normalizeOutputNodeState(config);
    const outputs = outputState.outputs;
    const duplicateLabels = hasDuplicateOutputLabels(outputs);
    const canAddOutput = outputs.length < OUTPUT_NODE_MAX_OUTPUTS;

    const updateOutput = (id, patch) => {
        onChange({
            outputs: outputs.map((output) => (
                output.id === id
                    ? { ...output, ...patch }
                    : output
            ))
        });
    };

    const addOutput = () => {
        if (!canAddOutput) return;

        const nextIndex = outputs.length;
        const id = getNextOutputPortId(outputs);
        const previousType = outputs[outputs.length - 1]?.type || "float64";

        onChange({
            outputs: [
                ...outputs,
                createOutputNodePort(nextIndex, {
                    id,
                    label: `output ${nextIndex + 1}`,
                    type: previousType
                })
            ]
        });
    };

    const removeOutput = (id) => {
        if (outputs.length <= 1) return;

        onChange({
            outputs: outputs.filter((output) => output.id !== id)
        });
    };

    return (
        <aside className="fixed right-4 top-4 z-40 w-[300px] rounded-md border border-white/10 bg-[#202020]/95 text-white shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur">
            <div className="border-b border-white/10 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium tracking-normal">OutputNode</h2>
                    <span className={`rounded-full px-2 py-1 text-[11px] ${valid && !duplicateLabels ? "bg-emerald-400/12 text-emerald-200" : "bg-white/8 text-zinc-300"}`}>
                        {valid && !duplicateLabels ? "Ready" : "Invalid"}
                    </span>
                </div>
            </div>

            <div className="max-h-[calc(100vh-112px)] overflow-y-auto px-4 py-4">
                <div className="space-y-3">
                    {outputs.map((output, index) => (
                        <div key={output.id} className="rounded-sm border border-white/10 bg-[#171717] p-3">
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <div className="text-xs text-zinc-400">Output {index + 1}</div>
                                <button
                                    type="button"
                                    disabled={outputs.length <= 1}
                                    onClick={() => removeOutput(output.id)}
                                    className="rounded-sm px-2 py-1 text-[11px] text-zinc-400 transition-[transform,background-color,color] duration-150 hover:bg-white/8 hover:text-white active:scale-[0.98] disabled:pointer-events-none disabled:opacity-35"
                                >
                                    Remove
                                </button>
                            </div>

                            <label className="block">
                                <span className="mb-1.5 block text-xs text-zinc-400">Label</span>
                                <input
                                    value={output.label}
                                    className="w-full rounded-sm border border-white/10 bg-[#101010] px-3 py-2 text-sm text-white outline-none transition-[border-color,box-shadow] duration-150 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
                                    onChange={(event) => updateOutput(output.id, { label: event.target.value })}
                                />
                            </label>

                            <label className="mt-3 block">
                                <span className="mb-1.5 block text-xs text-zinc-400">Type</span>
                                <div className="flex items-center gap-2">
                                    <span
                                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                                        style={{ backgroundColor: TYPES[output.type.replace(/\[.*?\]/, "")] || TYPES[output.type] || "rgb(150,150,150)" }}
                                    />
                                    <select
                                        value={output.type}
                                        className="min-w-0 flex-1 rounded-sm border border-white/10 bg-[#101010] px-3 py-2 text-sm text-white outline-none transition-[border-color,box-shadow] duration-150 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
                                        onChange={(event) => updateOutput(output.id, { type: event.target.value })}
                                    >
                                        {SUPPORTED_TYPES.map((type) => (
                                            <option key={type} value={type}>{type}</option>
                                        ))}
                                    </select>
                                </div>
                            </label>
                        </div>
                    ))}
                </div>

                {duplicateLabels && (
                    <p className="mt-3 text-xs text-rose-200">Output labels must be unique.</p>
                )}

                <button
                    type="button"
                    disabled={!canAddOutput}
                    onClick={addOutput}
                    className="mt-4 w-full rounded-sm border border-white/10 bg-white/8 px-3 py-2 text-sm text-white transition-[transform,background-color,border-color] duration-150 hover:border-white/18 hover:bg-white/12 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45"
                >
                    Add Output
                </button>
            </div>
        </aside>
    );
}

export default function Scripting({ output, input}) {
    const headUUID = useRef("head-uuid");
    const manager = useRef(new ScriptManager());
    const [valid, setValid] = useState(false);
    const [outputNodeConfig, setOutputNodeConfig] = useState(OUTPUT_NODE_DEFAULT);
    const compiledRef = useRef(null);

    const [unitChildren, setUnitChildren] = useState([]);
    const importInputRef = useRef(null);

    useEffect(() => {
        const headUnit = new OutputNodeBlock(headUUID.current);
        manager.current.addUnit(headUnit);
        manager.current.setHead(headUUID.current);
        manager.current.storeData(headUUID.current, OUTPUT_NODE_DEFAULT);
        headUnit.hydrateState(OUTPUT_NODE_DEFAULT);
        setValid(manager.current.checkValidity());
    }, []);

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

    const disconnectOutputNodePorts = (portIds) => {
        if (portIds.length === 0) return;

        const block = manager.current.units.find((unit) => unit.uuid === headUUID.current);
        const uniquePortIds = [...new Set(portIds)];

        uniquePortIds.forEach((portId) => {
            const connection = block?.inputs?.[portId];
            if (!connection) return;

            const output = connection.getOutput();
            manager.current.disconnectUnits(output.unit.uuid, output.label, headUUID.current, portId);
        });

        document.dispatchEvent(new CustomEvent('delete-port-connections', {
            detail: {
                uuid: headUUID.current,
                labels: uniquePortIds,
                notifyBackend: false
            }
        }));
    };

    const updateOutputNodeConfig = (patch) => {
        const previous = normalizeOutputNodeState(outputNodeConfig);
        const next = normalizeOutputNodeState(patch);
        const nextById = new Map(next.outputs.map((output) => [output.id, output]));
        const disconnectedPortIds = previous.outputs
            .filter((output) => {
                const nextOutput = nextById.get(output.id);
                return !nextOutput || nextOutput.type !== output.type;
            })
            .map((output) => output.id);

        disconnectOutputNodePorts(disconnectedPortIds);

        setOutputNodeConfig(next);
        manager.current.storeData(headUUID.current, next);

        const block = manager.current.units.find((unit) => unit.uuid === headUUID.current);
        if (block) {
            block.hydrateState(next);
        }

        setValid(manager.current.checkValidity());
    };

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
        const connected = manager.current.connectUnits(outputUUID, outputLabel, inputUUID, inputLabel);

        setValid(manager.current.checkValidity());
        return connected;
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
            if (unitIdToDelete === headUUID.current) return;

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

            ScriptManager.createRunner(parsed);

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

    const outputNodeElement = (
        <OutputNodeUnit
            key="output-node"
            _uuid={headUUID.current}
            outputs={outputNodeConfig.outputs}
        />
    );
    const visibleUnitChildren = [outputNodeElement, ...unitChildren];

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
        <OutputNodeSidebar
            config={outputNodeConfig}
            onChange={updateOutputNodeConfig}
            valid={valid}
        />
        <div className="w-[100vw] h-[100vh] bg-[#292929]">
            <Grid />
            <LineManager units={visibleUnitChildren} notifyConnection={onConnectUnits} onDeleteConnection={onDeleteConnection} />
            <AddMenu onAddUnit={addUnit} />
            
            <div className="absolute top-4 left-4 text-white" ref={unitParentRef}>
                {visibleUnitChildren}
            </div>
        </div>
        </>
    );
}
