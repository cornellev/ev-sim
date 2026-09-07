import { VISUAL_PREVIEW_ERROR_CODES, VisualPreviewError } from "../../../simulation/visual/VisualLayer.js";
import { getVisualScaleProfile } from "../../../simulation/visual/VisualScaleProfile.js";
import { VisualBudgetError, VISUAL_MEMORY_KINDS } from "../visual/VisualMemoryLedger.js";

export const BAKE_MEMORY_KINDS = Object.freeze({
    renderTarget: "renderTarget",
    passBuffer: "passBuffer",
    readback: "readback",
    lidar: "lidar",
    modelStaging: "modelStaging",
    telemetryPreview: "telemetryPreview",
    projectedOverlay: "projectedOverlay",
});

function kindToLedger(kind) {
    if (kind === BAKE_MEMORY_KINDS.projectedOverlay) return VISUAL_MEMORY_KINDS.gpu;
    if (kind === BAKE_MEMORY_KINDS.telemetryPreview) return VISUAL_MEMORY_KINDS.transient;
    if (kind === BAKE_MEMORY_KINDS.modelStaging) return VISUAL_MEMORY_KINDS.transient;
    return VISUAL_MEMORY_KINDS.transient;
}

export class BakeMemoryLedger {
    constructor({
        profile = getVisualScaleProfile(),
        ceilingBytes = profile.ceilings.bakeBufferBytes,
        maxProjections = profile.residency.maxProjections,
    } = {}) {
        this.profileId = profile.id;
        this.ceilingBytes = ceilingBytes;
        this.maxProjections = maxProjections;
        this.usedBytes = 0;
        this.projections = 0;
        this._reservations = new Map();
        this._nextId = 1;
        this._pipelineHeld = false;
    }

    snapshot() {
        return {
            profileId: this.profileId,
            usedBytes: this.usedBytes,
            ceilingBytes: this.ceilingBytes,
            liveReservations: this._reservations.size,
            projections: this.projections,
            maxProjections: this.maxProjections,
            pipelineHeld: this._pipelineHeld,
        };
    }

    canReserve(bytes) {
        const requested = assertBytes(bytes);
        return this.usedBytes + requested <= this.ceilingBytes;
    }

    reserve(kind, bytes, { label = kind } = {}) {
        if (!Object.values(BAKE_MEMORY_KINDS).includes(kind)) {
            throw new TypeError(`Unknown bake memory kind ${kind}.`);
        }
        const requested = assertBytes(bytes);
        if (this.usedBytes + requested > this.ceilingBytes) {
            throw new VisualBudgetError(
                `Bake ${kind} reservation of ${requested} bytes exceeds the ${this.ceilingBytes} byte ceiling.`,
                {
                    kind,
                    requestedBytes: requested,
                    usedBytes: this.usedBytes,
                    ceilingBytes: this.ceilingBytes,
                },
            );
        }
        this.usedBytes += requested;
        const id = this._nextId;
        this._nextId += 1;
        this._reservations.set(id, { kind, bytes: requested, label, ledgerKind: kindToLedger(kind) });
        return id;
    }

    release(id) {
        if (id == null) return 0;
        const entry = this._reservations.get(id);
        if (!entry) return 0;
        this.usedBytes = Math.max(0, this.usedBytes - entry.bytes);
        this._reservations.delete(id);
        return entry.bytes;
    }

    releaseAll() {
        for (const id of [...this._reservations.keys()]) this.release(id);
        this.projections = 0;
        this._pipelineHeld = false;
    }

    async withPipelineReservation(bytes, work) {
        if (this._pipelineHeld) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.BUDGET_EXCEEDED,
                "Bake harness already has an active sample/view pipeline reservation.",
            );
        }
        const id = this.reserve(BAKE_MEMORY_KINDS.passBuffer, bytes, { label: "pipeline" });
        this._pipelineHeld = true;
        try {
            return await work(id);
        } finally {
            this._pipelineHeld = false;
            this.release(id);
        }
    }

    assertProjectionBudget({ count = 1, bytes = 0, required = false } = {}) {
        if (this.projections + count > this.maxProjections) {
            if (required) {
                throw new VisualBudgetError(
                    `Required bake projection would exceed the ${this.maxProjections} overlay cap.`,
                    {
                        kind: BAKE_MEMORY_KINDS.projectedOverlay,
                        requestedBytes: bytes,
                        usedBytes: this.usedBytes,
                        ceilingBytes: this.ceilingBytes,
                    },
                );
            }
            return false;
        }
        if (!this.canReserve(bytes)) {
            if (required) {
                throw new VisualBudgetError(
                    "Required bake projection exceeds the overlay byte ceiling.",
                    {
                        kind: BAKE_MEMORY_KINDS.projectedOverlay,
                        requestedBytes: bytes,
                        usedBytes: this.usedBytes,
                        ceilingBytes: this.ceilingBytes,
                    },
                );
            }
            return false;
        }
        return true;
    }

    addProjection(bytes) {
        const id = this.reserve(BAKE_MEMORY_KINDS.projectedOverlay, bytes, { label: "projection" });
        this.projections += 1;
        return id;
    }

    removeProjection(id) {
        this.release(id);
        this.projections = Math.max(0, this.projections - 1);
    }

    liveReservationCount() {
        return this._reservations.size;
    }
}

export function estimatePassSetBytes({
    width,
    height,
    passCount = 2,
    includeLidar = true,
    lidarWidth = 640,
    lidarHeight = 360,
} = {}) {
    const frame = Math.max(0, width) * Math.max(0, height) * 4;
    const lidar = includeLidar ? Math.max(0, lidarWidth) * Math.max(0, lidarHeight) * 16 : 0;
    return (frame * (passCount + 2)) + lidar;
}

function assertBytes(bytes) {
    const parsed = Number(bytes);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError("Bake memory reservations require a non-negative safe integer byte count.");
    }
    return parsed;
}
