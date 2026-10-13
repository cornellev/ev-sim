/** Wheel, sensor, body, or model selection for a vehicle document. */
export class VehicleSelection {
    constructor() {
        this.kind = null;
        this.id = null;
    }

    select(kind, id = null) {
        this.kind = kind ?? null;
        this.id = id == null ? null : String(id);
        return this.snapshot();
    }

    clear() {
        this.kind = null;
        this.id = null;
        return this.snapshot();
    }

    snapshot() {
        return { kind: this.kind, id: this.id };
    }

    prune(manifest) {
        if (this.kind === "wheel" && !manifest?.wheels?.some((wheel) => wheel.id === this.id)) this.clear();
        if (this.kind === "sensor" && !manifest?.sensors?.some((sensor) => sensor.id === this.id)) this.clear();
        return this.snapshot();
    }
}
