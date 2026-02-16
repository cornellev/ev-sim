
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

        this.typeMap = {
            outputs: {},
            inputs: {}
        };

        this.register();
    }

    register() {

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

        this.notifyUpdate();
    }

    addOutput(label, connection) {
        if (!Object.keys(this.outputs).includes(label)) {
            this.outputs[label] = [];
        }
        
        this.outputs[label].push(connection);

        this.notifyUpdate();
    }

    notifyUpdate() {
        this.onConnectionsUpdate();
        for (const output in this.outputs) {
            const connections = this.outputs[output];
            connections.forEach(conn => {
                conn.inputUnit.notifyUpdate();
            });
        }
        for (const input in this.inputs) {
            const connection = this.inputs[input];
            connection.getOutput().unit.notifyUpdate();
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


export class ScriptManager {
    constructor() {
        this.units = [];

        this.head = null;

        this.storedData = {};
    }

    getStoredData(uuid) {
        return this.storedData[uuid];
    }

    storeData(uuid, data) {
        this.storedData[uuid] = data;
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

        // create connection
        const connection = new Connection(outputUnit, outputLabel, inputUnit, inputLabel);
        outputUnit.addOutput(outputLabel, connection);
        inputUnit.addInput(inputLabel, connection);

//        console.log(this);
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

    removeUnit(uuid) {
        this.units = this.units.filter(unit => unit.uuid !== uuid);
    }

    checkValidity() {
        if (!this.head) return false;

        const visited = new Set();
        const stack = [this.head];

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