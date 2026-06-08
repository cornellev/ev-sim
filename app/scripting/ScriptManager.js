
import { getRegisteredBlockType, registerBlockType } from "./BlockRegistry.js";
import { assertSupportedArtifact } from "./runtime/Artifact.js";
import { compileVisualScript } from "./runtime/Compiler.js";
import { createVisualScriptRunner } from "./runtime/Runner.js";

export { clearBlockTypeRegistryForTests, getRegisteredBlockType, registerBlockType } from "./BlockRegistry.js";

class Connection {
    constructor(outputUnit, outputLabel, inputUnit, inputLabel) {
        this.outputUnit = outputUnit;
        this.outputLabel = outputLabel;
        this.inputUnit = inputUnit;
        this.inputLabel = inputLabel;
    }

    /**
     * @returns {{unit: UnitBlock, label: String}}
     */
    getOutput() {
        return { unit: this.outputUnit, label: this.outputLabel };
    }

    getInput() {
        return { unit: this.inputUnit, label: this.inputLabel };
    }

    matches(outputUUID, outputLabel, inputUUID, inputLabel) {
        return this.outputUnit.uuid === outputUUID && this.outputLabel === outputLabel && this.inputUnit.uuid === inputUUID && this.inputLabel === inputLabel;
    }
}

export function storeData(uuid, data) {
    const event = new CustomEvent('data-stored', { detail: { uuid, data } });
    document.dispatchEvent(event);
}

export function reregister(uuid) {
    const event = new CustomEvent('reregister-unit', { detail: { uuid } });
    document.dispatchEvent(event);
}



export class BlockOutput {
    constructor() {
        this.map = {};
    }

    set(label, type) {
        this.map[label] = type;
        return this;
    }
    
    get(label) {
        if (!Object.keys(this.map).includes(label)) return null;

        return this.map[label];
    }

    has(label) {
        return Object.prototype.hasOwnProperty.call(this.map, label);
    }
}

export class UnitBlock {
    
    constructor(uuid) {
        this.inputs = {};
        this.outputs = {};

        this.manager = null;
        
        this.uuid = uuid;
        this.state = {};

        this.typeMap = {
            outputs: {},
            inputs: {}
        };

        this.register();

        this.updateNofitications = new Set();
    }

    register() {

    }

    typeId() {
        return this.constructor.blockType || this.constructor.name;
    }

    onConnectionsUpdate() {

    }

    reregister() {
        this.typeMap = {
            outputs: {},
            inputs: {}
        };

        this.register();
    }

    /**
     * 
     * @param {ScriptManager} manager 
     */
    setManager(manager) {
        this.manager = manager;
    }

    serializeState() {
        return { ...this.state };
    }

    hydrateState(state = {}) {
        this.state = { ...state };
        this.reregister();
    }

    serializeRuntimeState() {
        return {};
    }

    hydrateRuntimeState() {

    }

    getStateValue(key, domId, fallback = null) {
        if (Object.prototype.hasOwnProperty.call(this.state, key)) {
            return this.state[key];
        }

        if (typeof document !== "undefined" && domId) {
            const value = document.getElementById(domId)?.value;
            if (value !== undefined && value !== null && value !== "") {
                return value;
            }
        }

        return fallback;
    }

    getProgramPortDefinition() {
        return null;
    }

    resolveInputLabel(label) {
        return label;
    }

    resolveOutputLabel(label) {
        return label;
    }

    registerInput(label, type) {
        this.typeMap.inputs[label] = type;
    }

    editInput(label, newType) {
        if (!this.typeMap.inputs[label]) throw new Error("Input label not found");
        this.typeMap.inputs[label] = newType;
    }

    registerOutput(label, type) {
        this.typeMap.outputs[label] = type;
    }

    editOutput(label, newType) {
        if (!this.typeMap.outputs[label]) throw new Error("Output label not found");
        this.typeMap.outputs[label] = newType;
    }

    inputType(label) {
        return this.typeMap.inputs[this.resolveInputLabel(label)];
    }

    outputType(label) {
        return this.typeMap.outputs[this.resolveOutputLabel(label)];
    }

    hasInput(label) {
        return !!this.inputs[this.resolveInputLabel(label)];
    }

    hasOutput(label) {
        return !!this.outputs[this.resolveOutputLabel(label)];
    }

    addInput(label, connection) {
        const resolvedLabel = this.resolveInputLabel(label);
        if (this.inputs[resolvedLabel]) throw new Error("Input with this name already exists");
        this.inputs[resolvedLabel] = connection;

        this.notifyUpdate(crypto.randomUUID());
    }

    addOutput(label, connection) {
        const resolvedLabel = this.resolveOutputLabel(label);
        if (!Object.keys(this.outputs).includes(resolvedLabel)) {
            this.outputs[resolvedLabel] = [];
        }
        
        this.outputs[resolvedLabel].push(connection);

        this.notifyUpdate(crypto.randomUUID());
    }

    removeInput(label) {
        const resolvedLabel = this.resolveInputLabel(label);
        if (!this.inputs[resolvedLabel]) return;
        delete this.inputs[resolvedLabel];
        this.notifyUpdate(crypto.randomUUID());
    }

    removeOutputConnection(label, predicate) {
        const resolvedLabel = this.resolveOutputLabel(label);
        if (!Object.keys(this.outputs).includes(resolvedLabel)) return;

        const before = this.outputs[resolvedLabel].length;
        this.outputs[resolvedLabel] = this.outputs[resolvedLabel].filter((connection) => !predicate(connection));

        if (this.outputs[resolvedLabel].length === 0) {
            delete this.outputs[resolvedLabel];
        }

        if (before !== (this.outputs[resolvedLabel]?.length || 0)) {
            this.notifyUpdate(crypto.randomUUID());
        }
    }

    getStoredData() {
        if (!this.manager) return undefined;
        return this.manager.getStoredData(this.uuid);
    }

    notifyUpdate(key) {
        if (key == null) return;
        if (this.updateNofitications.has(key)) return; // prevent infinite loops

        this.updateNofitications.add(key);
        
        this.onConnectionsUpdate();

        for (const output in this.outputs) {
            const connections = this.outputs[output];
            connections.forEach(conn => {
                conn.inputUnit.notifyUpdate(key);
            });
        }
        for (const input in this.inputs) {
            const connection = this.inputs[input];
            connection.getOutput().unit.notifyUpdate(key);
        }
    }

    getInput(label) {
        const resolvedLabel = this.resolveInputLabel(label);
        if (!this.inputs[resolvedLabel]) throw new Error("Input not found");
        const crossOut = this.inputs[resolvedLabel].getOutput();
        if (!crossOut.unit.valid()) return null;

        return crossOut.unit.execute().get(crossOut.label);
    }

    execute() {
        
    }

    valid() {
        // to be overridden in subclasses, return false to prevent compilation
        return false;
    }
}

export class CompiledProgramUnitBlock extends UnitBlock {
    constructor(uuid) {
        super(uuid);
        this.runner = null;
    }

    register() {
        const compiledProgram = this.state?.compiledProgram;
        const inputPorts = compiledProgram?.interface?.inputs || [];
        const outputPorts = compiledProgram?.interface?.outputs || [];

        inputPorts.forEach((inputPort) => {
            this.registerInput(inputPort.label, inputPort.type);
        });

        outputPorts.forEach((outputPort) => {
            this.registerOutput(outputPort.label, outputPort.type);
        });
    }

    hydrateState(state = {}) {
        super.hydrateState(state);
        this.runner = null;
    }

    valid() {
        const compiledProgram = this.state?.compiledProgram;
        if (!compiledProgram) return false;

        const inputPorts = compiledProgram?.interface?.inputs || [];
        return inputPorts.every((inputPort) => this.hasInput(inputPort.label));
    }

    execute() {
        const compiledProgram = this.state?.compiledProgram;
        if (!compiledProgram) {
            return new BlockOutput();
        }

        assertSupportedArtifact(compiledProgram);

        const inputPorts = compiledProgram?.interface?.inputs || [];
        const providedInputs = {};

        inputPorts.forEach((inputPort) => {
            providedInputs[inputPort.label] = this.getInput(inputPort.label);
        });

        if (!this.runner) {
            this.runner = ScriptManager.createRunner(compiledProgram);
        }

        const run = this.runner.run(providedInputs);
        if (run.status === "failure") {
            throw new Error(`Imported compiled program failed: ${run.e?.message || "unknown error"}`);
        }

        const output = new BlockOutput();

        const outputPorts = compiledProgram?.interface?.outputs || [];
        outputPorts.forEach((outputPort) => {
            output.set(outputPort.label, run.outputs[outputPort.label]);
        });

        return output;
    }
}

registerBlockType("CompiledProgramUnitBlock", CompiledProgramUnitBlock);


// Below, this I made myself

export class ScriptManager {
    constructor() {
        this.units = [];

        this.head = null;

        this.storedData = {};
        this.externalInputs = {};
        this.externalOutputs = {};
    }

    getStoredData(uuid) {
        return this.storedData[uuid];
    }

    storeData(uuid, data) {
        this.storedData[uuid] = data;
        // update
        this.units.find(u => u.uuid === uuid)?.notifyUpdate(crypto.randomUUID());
    }

    setRuntimeInputs(inputs = {}) {
        this.externalInputs = inputs || {};
    }

    resolveExternalInput(label, fallback = null) {
        if (Object.prototype.hasOwnProperty.call(this.externalInputs, label)) {
            return this.externalInputs[label];
        }
        return fallback;
    }

    setExternalOutput(label, value) {
        this.externalOutputs[label] = value;
    }

    getExternalOutputs() {
        return { ...this.externalOutputs };
    }
    
    setHead(uuid) {
        this.head = uuid;
    }

    /**
     * @param {UnitBlock} unit 
     */
    addUnit(unit) {
        unit.setManager(this);
        this.units.push(unit);
    }

    connectUnits(outputUUID, outputLabel, inputUUID, inputLabel) {
        // console.log("Connecting units:", outputUUID, outputLabel, "to", inputUUID, inputLabel);
        // console.log("Current units in manager:", this.units);

        const outputUnit = this.units.find(u => u.uuid === outputUUID);
        const inputUnit = this.units.find(u => u.uuid === inputUUID);

        // console.log(this.units, outputUnit, inputUnit);
        // console.log("Output unit:", outputUnit, "Input unit:", inputUnit);

        if (!outputUnit || !inputUnit) {
            console.error("Invalid UUIDs for connection. Did you forget to pass the UUID to the unit component? Check scripting.md", outputUUID, inputUUID, this.units);
            return false;
        }

        //console.log(outputUnit, outputLabel)

        if (!outputUnit.outputType(outputLabel)) {
            console.error("Output label not found in output unit. Check scripting.md");
            return false;
        }

        if (!inputUnit.inputType(inputLabel)) {
            console.error("Input label not found in input unit. Check scripting.md");
            return false;
        }

        // check type compatibility (for now, just check if they are the same)
        const resolvedOutputLabel = outputUnit.resolveOutputLabel(outputLabel);
        const resolvedInputLabel = inputUnit.resolveInputLabel(inputLabel);
        const outputType = outputUnit.outputType(resolvedOutputLabel);
        const inputType = inputUnit.inputType(resolvedInputLabel);

        if (outputType !== inputType) {
            console.error("Type mismatch between output and input. Check scripting.md");
            return false;
        }

        const existing = (outputUnit.outputs[resolvedOutputLabel] || []).some((connection) =>
            connection.matches(outputUUID, resolvedOutputLabel, inputUUID, resolvedInputLabel)
        );

        if (existing) {
            return true;
        }

        // create connection
        const connection = new Connection(outputUnit, resolvedOutputLabel, inputUnit, resolvedInputLabel);
        outputUnit.addOutput(resolvedOutputLabel, connection);
        inputUnit.addInput(resolvedInputLabel, connection);

//        console.log(this);
        return true;
    }

    disconnectUnits(outputUUID, outputLabel, inputUUID, inputLabel) {
        const outputUnit = this.units.find(u => u.uuid === outputUUID);
        const inputUnit = this.units.find(u => u.uuid === inputUUID);

        if (!outputUnit || !inputUnit) {
            return false;
        }

        const resolvedOutputLabel = outputUnit.resolveOutputLabel(outputLabel);
        const resolvedInputLabel = inputUnit.resolveInputLabel(inputLabel);
        let removedConnection = null;
        outputUnit.removeOutputConnection(resolvedOutputLabel, (connection) => {
            const shouldRemove = connection.matches(outputUUID, resolvedOutputLabel, inputUUID, resolvedInputLabel);
            if (shouldRemove) {
                removedConnection = connection;
            }
            return shouldRemove;
        });

        if (!removedConnection) {
            return false;
        }

        if (inputUnit.inputs[resolvedInputLabel] === removedConnection) {
            inputUnit.removeInput(resolvedInputLabel);
        }

        return true;
    }

    execute() {
        if (!this.head) {
            console.error("No head unit set for execution");
            return;
        }

        if (!this.checkValidity()) {
            console.error("Script is not valid, cannot execute");
            return;
        }

        const headUnit = this.units.find(u => u.uuid === this.head);
        if (!headUnit) {
            console.error("Head unit not found");
            return;
        }

        return headUnit.execute();
    }

    executeProgram(inputs = {}) {
        try {
            this.setRuntimeInputs(inputs);
            this.externalOutputs = {};

            const outputUnits = this.units.filter((unit) => unit.constructor.programNodeRole === "output");
            if (outputUnits.length > 0) {
                outputUnits.forEach((unit) => {
                    if (unit.valid()) {
                        unit.execute();
                    }
                });
                return {
                    status: "success",
                    result: null,
                    outputs: this.getExternalOutputs(),
                    e: null
                };
            }

            const result = this.execute();
            return {
                status: "success",
                result,
                outputs: this.getExternalOutputs(),
                e: null
            };
        } catch (err) {
            return {
                status: "failure",
                result: null,
                outputs: {},
                e: {
                    name: err?.name || "Error",
                    message: err?.message || String(err),
                    stack: err?.stack || null
                }
            };
        }
    }

    compile(name = "compiled-program") {
        return compileVisualScript(this, name, getRegisteredBlockType);
    }

    static fromCompiled(compiledProgram) {
        return ScriptManager.createRunner(compiledProgram);
    }

    static runCompiled(compiledProgram, inputs = {}) {
        return ScriptManager.createRunner(compiledProgram).run(inputs);
    }

    static createRunner(compiledProgram) {
        return createVisualScriptRunner(compiledProgram, getRegisteredBlockType);
    }

    static createCompiledProgramBlock(compiledProgram) {
        return class CompiledProgramBlock extends CompiledProgramUnitBlock {
            constructor(uuid) {
                super(uuid);
                this.state = {
                    ...this.state,
                    compiledProgram,
                    name: compiledProgram?.name || "Compiled Program"
                };
                this.reregister();
            }
        }
    }

    removeUnit(uuid) {
        const unit = this.units.find((item) => item.uuid === uuid);
        if (!unit) return;

        const incoming = Object.values(unit.inputs);
        incoming.forEach((connection) => {
            const output = connection.getOutput();
            output.unit.removeOutputConnection(output.label, (candidate) => candidate === connection);
            unit.removeInput(connection.inputLabel);
        });

        const outgoing = Object.values(unit.outputs).flat();
        outgoing.forEach((connection) => {
            const input = connection.getInput();
            input.unit.removeInput(input.label);
            unit.removeOutputConnection(connection.outputLabel, (candidate) => candidate === connection);
        });

        this.units = this.units.filter((item) => item.uuid !== uuid);
        delete this.storedData[uuid];

        if (this.head === uuid) {
            this.head = null;
        }
    }

    checkValidity() {
        const outputUnits = this.units.filter((unit) => unit.constructor.programNodeRole === "output");
        if (!this.head && outputUnits.length === 0) return false;

        const visited = new Set();
        const stack = [];

        if (this.head) {
            stack.push(this.head);
        }

        outputUnits.forEach((unit) => {
            stack.push(unit.uuid);
        });

        while (stack.length > 0) {
            const current = stack.pop();
            if (visited.has(current)) continue;
            visited.add(current);

            const unit = this.units.find(u => u.uuid === current);
            if (!unit) return false; // unit not found

            if (!unit.valid()) return false; // unit is invalid

            // add connected units to stack
            for (const input in unit.inputs) {
                const connections = unit.inputs[input];
                const output = connections.getOutput();
                const outputType = output.unit.outputType(output.label);
                const inputType = unit.inputType(input);
                if (!outputType || !inputType || outputType !== inputType) return false;
                stack.push(output.unit.uuid);
            }
        }

        return true;
    }
    
}
