import {
    VISUAL_PREVIEW_ERROR_CODES,
    VisualPreviewError,
    defaultVisualLodPolicy,
    selectVisualLodUri,
    sha256FromUri,
} from "../../../simulation/visual/VisualLayer.js";
import { compareUtf8 } from "../../../simulation/world/WorldDescription.js";
import {
    VISUAL_RESIDENCY_LIMITS,
    getVisualScaleProfile,
} from "../../../simulation/visual/VisualScaleProfile.js";

function translationOfMatrix(matrix = []) {
    return {
        x: Number(matrix[12] ?? 0) || 0,
        y: Number(matrix[13] ?? 0) || 0,
        z: Number(matrix[14] ?? 0) || 0,
    };
}

function toPosition(value) {
    if (!value) return { x: 0, y: 0, z: 0 };
    if (typeof value.x === "number" || typeof value.z === "number") {
        return {
            x: Number(value.x ?? 0) || 0,
            y: Number(value.y ?? 0) || 0,
            z: Number(value.z ?? 0) || 0,
        };
    }
    return { x: 0, y: 0, z: 0 };
}

export function visualDistanceMeters(from, to) {
    const a = toPosition(from);
    const b = toPosition(to);
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.hypot(dx, dy, dz);
}

export function instanceTranslation(instance) {
    return translationOfMatrix(instance?.matrix);
}

function chunkDistance(chunk, instancesById, origin) {
    let nearest = Number.POSITIVE_INFINITY;
    for (const instanceId of chunk.instanceIds ?? []) {
        const instance = instancesById.get(instanceId);
        if (!instance) continue;
        nearest = Math.min(nearest, visualDistanceMeters(origin, instanceTranslation(instance)));
    }
    return Number.isFinite(nearest) ? nearest : Number.POSITIVE_INFINITY;
}

function compareChunk(left, right) {
    if (left.required !== right.required) return left.required ? -1 : 1;
    if (left.distance !== right.distance) return left.distance - right.distance;
    return compareUtf8(left.id, right.id);
}

export function emptyResidencySnapshot() {
    return {
        requiredChunkIds: [],
        residentChunkIds: [],
        queuedChunkIds: [],
        requiredChunks: 0,
        residentChunks: 0,
        queuedChunks: 0,
        selectedLods: {},
        memory: null,
        evictions: 0,
        pressure: {
            encodedCpu: 0,
            decodedCpu: 0,
            gpu: 0,
            transient: 0,
            unified: 0,
        },
        prefetchShed: 0,
        retainCommittedAoi: false,
    };
}

export class VisualChunkResidencyController {
    constructor({
        policy = defaultVisualLodPolicy(),
        requiredRadiusMeters = VISUAL_RESIDENCY_LIMITS.requiredRadiusMeters,
        prefetchRadiusMeters = VISUAL_RESIDENCY_LIMITS.prefetchRadiusMeters,
        maxResidentChunks = VISUAL_RESIDENCY_LIMITS.maxResidentChunks,
        profile = getVisualScaleProfile(),
    } = {}) {
        this.policy = policy;
        this.requiredRadiusMeters = requiredRadiusMeters;
        this.prefetchRadiusMeters = prefetchRadiusMeters;
        this.maxResidentChunks = maxResidentChunks;
        this.profileId = profile.id;
        this.evictions = 0;
        this.prefetchShed = 0;
    }

    normalizeInterest(interest = {}) {
        const required = [...new Set((interest.requiredChunkIds ?? []).map(String))]
            .sort(compareUtf8);
        return {
            position: toPosition(interest.position),
            requiredChunkIds: required,
        };
    }

    plan(descriptor, interest = {}) {
        const normalized = this.normalizeInterest(interest);
        const instancesById = new Map((descriptor?.instances ?? []).map((instance) => [instance.id, instance]));
        const chunks = [...(descriptor?.chunks ?? [])].map((chunk) => {
            const distance = chunkDistance(chunk, instancesById, normalized.position);
            const required = distance <= this.requiredRadiusMeters
                || normalized.requiredChunkIds.includes(chunk.id);
            const prefetch = !required && distance <= this.prefetchRadiusMeters;
            return {
                id: chunk.id,
                instanceIds: [...(chunk.instanceIds ?? [])],
                distance,
                required,
                prefetch,
            };
        }).sort(compareChunk);

        const required = chunks.filter((chunk) => chunk.required);
        const prefetch = chunks.filter((chunk) => chunk.prefetch);
        if (required.length > this.maxResidentChunks) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.BUDGET_EXCEEDED,
                `Required visual residency ${required.length} exceeds the ${this.maxResidentChunks} chunk cap.`,
            );
        }

        const selectedLods = {};
        const selectedLodUris = new Set();
        for (const instance of descriptor?.instances ?? []) {
            const distance = visualDistanceMeters(normalized.position, instanceTranslation(instance));
            const uri = selectVisualLodUri(instance, distance, this.policy);
            selectedLods[instance.id] = {
                uri,
                digest: sha256FromUri(uri),
                index: Math.min(
                    instance.lodLevels.indexOf(uri),
                    instance.lodLevels.length - 1,
                ),
                distance,
            };
            selectedLodUris.add(uri);
        }

        const prefetchBudget = Math.max(0, this.maxResidentChunks - required.length);
        const admittedPrefetch = prefetch.slice(0, prefetchBudget);
        this.prefetchShed = prefetch.length - admittedPrefetch.length;

        return {
            interest: normalized,
            required,
            prefetch: admittedPrefetch,
            shedPrefetch: prefetch.slice(prefetchBudget),
            selectedLods,
            selectedLodUris: [...selectedLodUris].sort(compareUtf8),
            policyHash: null,
        };
    }

    neededDigests(descriptor, plan) {
        const wantedChunks = new Set([
            ...plan.required.map((chunk) => chunk.id),
            ...plan.prefetch.map((chunk) => chunk.id),
        ]);
        const wantedInstances = new Set();
        for (const chunk of descriptor.chunks ?? []) {
            if (!wantedChunks.has(chunk.id)) continue;
            for (const instanceId of chunk.instanceIds) wantedInstances.add(instanceId);
        }
        const digests = new Set();
        const materialsById = new Map((descriptor.materials ?? []).map((material) => [material.id, material]));
        for (const instance of descriptor.instances ?? []) {
            if (!wantedInstances.has(instance.id)) continue;
            const lod = plan.selectedLods[instance.id];
            if (lod?.digest) digests.add(lod.digest);
            for (const materialId of instance.materialIds ?? []) {
                const material = materialsById.get(materialId);
                for (const texture of material?.textures ?? []) {
                    const digest = sha256FromUri(texture.assetUri);
                    if (digest) digests.add(digest);
                }
            }
        }
        return digests;
    }

    snapshot({
        plan = null,
        residentChunkIds = [],
        queuedChunkIds = [],
        memory = null,
        retainCommittedAoi = false,
    } = {}) {
        const requiredChunkIds = (plan?.required ?? []).map((chunk) => chunk.id);
        const resident = [...residentChunkIds].sort(compareUtf8);
        const queued = [...queuedChunkIds].sort(compareUtf8);
        const selectedLods = {};
        for (const [instanceId, lod] of Object.entries(plan?.selectedLods ?? {})) {
            selectedLods[instanceId] = lod.uri;
        }
        return {
            requiredChunkIds,
            residentChunkIds: resident,
            queuedChunkIds: queued,
            requiredChunks: requiredChunkIds.length,
            residentChunks: resident.length,
            queuedChunks: queued.length,
            selectedLods,
            memory,
            evictions: this.evictions,
            prefetchShed: this.prefetchShed,
            pressure: memory?.pressure ?? emptyResidencySnapshot().pressure,
            retainCommittedAoi,
        };
    }

    recordEviction(count = 1) {
        this.evictions += count;
    }
}
