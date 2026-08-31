import { assertWorldResource } from "../world/WorldDescription.js";

export class HeadlessWorldRuntime {
    constructor() {
        this.description = null;
        this.worldHash = null;
        this.environment = null;
    }

    prepare(environment, resolvedRun, worldResource = resolvedRun?.world) {
        this.description = assertWorldResource(worldResource);
        this.worldHash = worldResource.hash;
        this.environment = environment ? structuredClone(environment) : null;
        return this.getDeterministicState();
    }

    reset() {
        return this.getDeterministicState();
    }

    finalizeRun() {
        return this.getDeterministicState();
    }

    disposeRun() {
        this.description = null;
        this.worldHash = null;
        this.environment = null;
    }

    getDeterministicState() {
        return this.worldHash ? { worldHash: this.worldHash } : null;
    }
}

