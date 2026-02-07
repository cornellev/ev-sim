import { Data } from "./Data";

export class Database {
    constructor(parent) {
        this.parent = parent || new Data();
    }

    /**
     * @returns {Data}
     */
    getParent() {
        return this.parent;
    }
}