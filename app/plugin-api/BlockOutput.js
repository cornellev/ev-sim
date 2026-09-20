export class BlockOutput {
    constructor() {
        this.map = {};
    }

    set(label, value) {
        this.map[label] = value;
        return this;
    }

    setDeclared(unit, label, value) {
        if (unit?.outputType(label) !== undefined) this.map[label] = value;
        return this;
    }

    get(label) {
        return Object.prototype.hasOwnProperty.call(this.map, label) ? this.map[label] : null;
    }

    has(label) {
        return Object.prototype.hasOwnProperty.call(this.map, label);
    }
}
