
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

const BLOCK_TYPE_REGISTRY = new Map();

export function registerBlockType(typeId, blockClass) {
    if (!typeId || !blockClass) return;
    blockClass.blockType = typeId;
    BLOCK_TYPE_REGISTRY.set(typeId, blockClass);
}

export function getRegisteredBlockType(typeId) {
    return BLOCK_TYPE_REGISTRY.get(typeId) || null;
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
        return !!this.map[label];
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
        return this.typeMap.inputs[label];
    }

    outputType(label) {
        return this.typeMap.outputs[label];
    }

    hasInput(label) {
        return !!this.inputs[label];
    }

    hasOutput(label) {
        return !!this.outputs[label];
    }

    addInput(label, connection) {
        if (this.inputs[label]) throw new Error("Input with this name already exists");
        this.inputs[label] = connection;

        this.notifyUpdate(crypto.randomUUID());
    }

    addOutput(label, connection) {
        if (!Object.keys(this.outputs).includes(label)) {
            this.outputs[label] = [];
        }
        
        this.outputs[label].push(connection);

        this.notifyUpdate(crypto.randomUUID());
    }

    removeInput(label) {
        if (!this.inputs[label]) return;
        delete this.inputs[label];
        this.notifyUpdate(crypto.randomUUID());
    }

    removeOutputConnection(label, predicate) {
        if (!Object.keys(this.outputs).includes(label)) return;

        const before = this.outputs[label].length;
        this.outputs[label] = this.outputs[label].filter((connection) => !predicate(connection));

        if (this.outputs[label].length === 0) {
            delete this.outputs[label];
        }

        if (before !== (this.outputs[label]?.length || 0)) {
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
        if (!this.inputs[label]) throw new Error("Input not found");
        const crossOut = this.inputs[label].getOutput();
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

        const inputPorts = compiledProgram?.interface?.inputs || [];
        const providedInputs = {};

        inputPorts.forEach((inputPort) => {
            providedInputs[inputPort.label] = this.getInput(inputPort.label);
        });

        const run = ScriptManager.runCompiled(compiledProgram, providedInputs);
        const output = new BlockOutput();

        const outputPorts = compiledProgram?.interface?.outputs || [];
        outputPorts.forEach((outputPort) => {
            output.set(outputPort.label, run.outputs[outputPort.label]);
        });

        return output;
    }
}

registerBlockType("CompiledProgramUnitBlock", CompiledProgramUnitBlock);


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
            return;
        }

        //console.log(outputUnit, outputLabel)

        if (!outputUnit.outputType(outputLabel)) {
            console.error("Output label not found in output unit. Check scripting.md");
            return;
        }

        if (!inputUnit.inputType(inputLabel)) {
            console.error("Input label not found in input unit. Check scripting.md");
            return;
        }

        // check type compatibility (for now, just check if they are the same)
        const outputType = outputUnit.outputType(outputLabel);
        const inputType = inputUnit.inputType(inputLabel);

        if (outputType !== inputType) {
            console.error("Type mismatch between output and input. Check scripting.md");
            return;
        }

        const existing = (outputUnit.outputs[outputLabel] || []).some((connection) =>
            connection.matches(outputUUID, outputLabel, inputUUID, inputLabel)
        );

        if (existing) {
            return;
        }

        // create connection
        const connection = new Connection(outputUnit, outputLabel, inputUnit, inputLabel);
        outputUnit.addOutput(outputLabel, connection);
        inputUnit.addInput(inputLabel, connection);

//        console.log(this);
    }

    disconnectUnits(outputUUID, outputLabel, inputUUID, inputLabel) {
        const outputUnit = this.units.find(u => u.uuid === outputUUID);
        const inputUnit = this.units.find(u => u.uuid === inputUUID);

        if (!outputUnit || !inputUnit) {
            return false;
        }

        let removedConnection = null;
        outputUnit.removeOutputConnection(outputLabel, (connection) => {
            const shouldRemove = connection.matches(outputUUID, outputLabel, inputUUID, inputLabel);
            if (shouldRemove) {
                removedConnection = connection;
            }
            return shouldRemove;
        });

        if (!removedConnection) {
            return false;
        }

        if (inputUnit.inputs[inputLabel] === removedConnection) {
            inputUnit.removeInput(inputLabel);
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
                result: null,
                outputs: this.getExternalOutputs()
            };
        }

        const result = this.execute();
        return {
            result,
            outputs: this.getExternalOutputs()
        };
    }

    compile(name = "compiled-program") {
        const seenConnections = new Set();
        const connections = [];
        const programInterface = {
            inputs: [],
            outputs: []
        };

        const units = this.units.map((unit) => {
            const port = unit.getProgramPortDefinition();
            if (port && port.role === "input") {
                programInterface.inputs.push(port);
            }
            if (port && port.role === "output") {
                programInterface.outputs.push(port);
            }

            Object.entries(unit.outputs).forEach(([label, outputConnections]) => {
                outputConnections.forEach((connection) => {
                    const input = connection.getInput();
                    const key = [unit.uuid, label, input.unit.uuid, input.label].join("|");
                    if (seenConnections.has(key)) return;
                    seenConnections.add(key);

                    connections.push({
                        outputUUID: unit.uuid,
                        outputLabel: label,
                        inputUUID: input.unit.uuid,
                        inputLabel: input.label
                    });
                });
            });

            return {
                uuid: unit.uuid,
                type: unit.typeId(),
                state: unit.serializeState(),
                storedData: this.storedData[unit.uuid]
            };
        });

        return {
            version: 1,
            name,
            head: this.head,
            units,
            connections,
            interface: programInterface
        };
    }

    static fromCompiled(compiledProgram) {
        const manager = new ScriptManager();

        (compiledProgram.units || []).forEach((unitDef) => {
            const UnitClass = getRegisteredBlockType(unitDef.type);
            if (!UnitClass) {
                throw new Error(`Unknown block type \"${unitDef.type}\". Register it first with registerBlockType().`);
            }

            const unit = new UnitClass(unitDef.uuid);
            manager.addUnit(unit);
            if (unitDef.storedData !== undefined) {
                manager.storedData[unitDef.uuid] = unitDef.storedData;
            }
            if (unitDef.state) {
                unit.hydrateState(unitDef.state);
            }
        });

        (compiledProgram.connections || []).forEach((connection) => {
            manager.connectUnits(
                connection.outputUUID,
                connection.outputLabel,
                connection.inputUUID,
                connection.inputLabel
            );
        });

        if (compiledProgram.head) {
            manager.setHead(compiledProgram.head);
        }

        return manager;
    }

    static runCompiled(compiledProgram, inputs = {}) {
        const manager = ScriptManager.fromCompiled(compiledProgram);
        return manager.executeProgram(inputs);
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
                stack.push(connections.getOutput().unit.uuid);
            }
        }

        return true;
    }
    
}