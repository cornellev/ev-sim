
export class UnitBlock {
    
    constructor() {
        this.inputs = {};
        this.outputs = {};

        this.manager = null;
    }

    /**
     * 
     * @param {ScriptManager} manager 
     */
    setManager(manager) {
        this.manager = manager;
    }

    addInput(name, type) {
        this.inputs[name] = type;
    }

    addOutput(name, type) {
        this.outputs[name] = type;
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
            for (const output in unit.outputs) {
                const connections = unit.outputs[output];
                for (const conn of connections) {
                    stack.push(conn);
                }
            }
        }

        return true;
    }
    
}