import { VISUAL_PREVIEW_ERROR_CODES, VisualPreviewError } from "../../../simulation/visual/VisualLayer.js";
import { getVisualScaleProfile } from "../../../simulation/visual/VisualScaleProfile.js";

export const VISUAL_MEMORY_KINDS = Object.freeze({
    encodedCpu: "encodedCpu",
    decodedCpu: "decodedCpu",
    gpu: "gpu",
    transient: "transient",
});

export class VisualBudgetError extends VisualPreviewError {
    constructor(message, { kind = null, requestedBytes = 0, usedBytes = 0, ceilingBytes = 0 } = {}) {
        super(VISUAL_PREVIEW_ERROR_CODES.BUDGET_EXCEEDED, message);
        this.name = "VisualBudgetError";
        this.kind = kind;
        this.requestedBytes = requestedBytes;
        this.usedBytes = usedBytes;
        this.ceilingBytes = ceilingBytes;
    }
}

function positiveCeiling(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export class VisualMemoryLedger {
    constructor({
        profile = getVisualScaleProfile(),
        ceilings = null,
        unifiedCeiling = undefined,
    } = {}) {
        const resolved = ceilings ?? {
            encodedCpu: profile.ceilings.encodedCpuBytes,
            decodedCpu: profile.ceilings.decodedCpuBytes,
            gpu: profile.ceilings.gpuBytes,
            transient: profile.ceilings.transientBytes,
        };
        this.profileId = profile.id ?? null;
        this.ceilings = {
            encodedCpu: positiveCeiling(resolved.encodedCpu, profile.ceilings.encodedCpuBytes),
            decodedCpu: positiveCeiling(resolved.decodedCpu, profile.ceilings.decodedCpuBytes),
            gpu: positiveCeiling(resolved.gpu, profile.ceilings.gpuBytes),
            transient: positiveCeiling(resolved.transient, profile.ceilings.transientBytes),
        };
        this.unifiedCeiling = unifiedCeiling === undefined
            ? profile.ceilings.unifiedMemoryBytes
            : unifiedCeiling;
        this.used = {
            encodedCpu: 0,
            decodedCpu: 0,
            gpu: 0,
            transient: 0,
        };
        this._reservations = new Map();
        this._nextId = 1;
    }

    unifiedUsed() {
        return this.used.encodedCpu + this.used.decodedCpu + this.used.gpu + this.used.transient;
    }

    pressure() {
        const ratio = (used, ceiling) => (ceiling > 0 ? used / ceiling : 0);
        return {
            encodedCpu: ratio(this.used.encodedCpu, this.ceilings.encodedCpu),
            decodedCpu: ratio(this.used.decodedCpu, this.ceilings.decodedCpu),
            gpu: ratio(this.used.gpu, this.ceilings.gpu),
            transient: ratio(this.used.transient, this.ceilings.transient),
            unified: this.unifiedCeiling ? ratio(this.unifiedUsed(), this.unifiedCeiling) : 0,
        };
    }

    snapshot() {
        return {
            profileId: this.profileId,
            used: {
                ...this.used,
                unified: this.unifiedUsed(),
            },
            ceilings: {
                ...this.ceilings,
                unified: this.unifiedCeiling,
            },
            liveReservations: this._reservations.size,
            pressure: this.pressure(),
        };
    }

    canReserve(kind, bytes) {
        assertKind(kind);
        const requested = assertBytes(bytes);
        if (this.used[kind] + requested > this.ceilings[kind]) return false;
        if (this.unifiedCeiling != null && this.unifiedUsed() + requested > this.unifiedCeiling) return false;
        return true;
    }

    reserve(kind, bytes, { label = kind } = {}) {
        assertKind(kind);
        const requested = assertBytes(bytes);
        if (this.used[kind] + requested > this.ceilings[kind]) {
            throw new VisualBudgetError(
                `Visual ${kind} reservation of ${requested} bytes exceeds the ${this.ceilings[kind]} byte ceiling.`,
                {
                    kind,
                    requestedBytes: requested,
                    usedBytes: this.used[kind],
                    ceilingBytes: this.ceilings[kind],
                },
            );
        }
        if (this.unifiedCeiling != null && this.unifiedUsed() + requested > this.unifiedCeiling) {
            throw new VisualBudgetError(
                `Visual unified-memory reservation of ${requested} bytes exceeds the ${this.unifiedCeiling} byte ceiling.`,
                {
                    kind: "unified",
                    requestedBytes: requested,
                    usedBytes: this.unifiedUsed(),
                    ceilingBytes: this.unifiedCeiling,
                },
            );
        }
        this.used[kind] += requested;
        const id = this._nextId;
        this._nextId += 1;
        this._reservations.set(id, { kind, bytes: requested, label });
        return id;
    }

    release(id) {
        if (id == null) return 0;
        const entry = this._reservations.get(id);
        if (!entry) return 0;
        this.used[entry.kind] -= entry.bytes;
        if (this.used[entry.kind] < 0) this.used[entry.kind] = 0;
        this._reservations.delete(id);
        return entry.bytes;
    }

    releaseAll() {
        for (const id of [...this._reservations.keys()]) this.release(id);
    }

    liveReservationCount() {
        return this._reservations.size;
    }
}

function assertKind(kind) {
    if (!Object.values(VISUAL_MEMORY_KINDS).includes(kind)) {
        throw new TypeError(`Unknown visual memory kind ${kind}.`);
    }
}

function assertBytes(bytes) {
    const parsed = Number(bytes);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError("Visual memory reservations require a non-negative safe integer byte count.");
    }
    return parsed;
}
