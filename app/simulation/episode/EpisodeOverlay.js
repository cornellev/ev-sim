import { FEATURE_GEOMETRY_BY_TYPE } from "../../3d/editor/objects/types/builtinProp.js";
import { createObstacleLidarPrimitives } from "../lidar/LidarGeometry.js";
import { compareUtf8, createFeatureObstacle } from "../world/WorldDescription.js";
import { normalizePose3d } from "../../scripting/types/PortTypes.js";

const EPISODE_ID_PREFIX = "episode:";

function roundCoord(value) {
    return Math.round(Number(value) * 1e6) / 1e6;
}

/**
 * Per-episode prop overlay. Lives on the kernel, never mutates `worldHash`.
 * Spawn is upsert-by-id: the same id on a later tick replaces pose/type.
 */
export class EpisodeOverlay {
    constructor() {
        this._records = new Map();
        this._serials = new Map();
    }

    get size() {
        return this._records.size;
    }

    _overlayId(id) {
        const overlayId = String(id ?? "").trim();
        if (!overlayId) return "";
        return overlayId.startsWith(EPISODE_ID_PREFIX) ? overlayId : `${EPISODE_ID_PREFIX}${overlayId}`;
    }

    get(id) {
        const overlayId = this._overlayId(id);
        return overlayId ? this._records.get(overlayId) ?? null : null;
    }

    assertOwner(id, scriptId) {
        const record = this.get(id);
        const owner = String(scriptId ?? "");
        if (record && record.scriptId !== owner) {
            throw new TypeError(`Overlay "${record.id}" is owned by "${record.scriptId}".`);
        }
        return record;
    }

    serialSnapshot() {
        return Object.fromEntries([...this._serials.entries()]
            .sort(([left], [right]) => compareUtf8(left, right))
            .map(([key, serial]) => [key, serial]));
    }

    captureState() {
        return {
            records: this.snapshot(),
            serials: this.serialSnapshot(),
        };
    }

    restoreState(state = null) {
        this.clear();
        if (!state) return;
        for (const [key, serial] of Object.entries(state.serials ?? {})) {
            this._serials.set(key, serial);
        }
        for (const record of state.records ?? []) {
            this.upsert({
                id: record.id,
                assetId: record.assetId,
                pose: record.pose,
                scriptId: record.scriptId,
            });
        }
        this._serials.clear();
        for (const [key, serial] of Object.entries(state.serials ?? {})) {
            this._serials.set(key, serial);
        }
    }

    clear() {
        this._records.clear();
        this._serials.clear();
    }

    upsert({ id, assetId, pose, scriptId } = {}) {
        const type = String(assetId ?? "").trim() || "barrel";
        if (!FEATURE_GEOMETRY_BY_TYPE[type]) {
            throw new TypeError(`Unknown feature type "${type}".`);
        }
        const pose3 = normalizePose3d(pose);
        const scriptKey = String(scriptId ?? "script");
        let overlayId = String(id ?? "").trim();
        if (!overlayId) {
            const serial = this._serials.get(scriptKey) ?? 0;
            this._serials.set(scriptKey, serial + 1);
            overlayId = `${EPISODE_ID_PREFIX}${scriptKey}:${serial}`;
        } else if (!overlayId.startsWith(EPISODE_ID_PREFIX)) {
            overlayId = `${EPISODE_ID_PREFIX}${overlayId}`;
        }

        const rotationY = pose3.rotation.y;
        const feature = {
            id: overlayId,
            type,
            x: roundCoord(pose3.position.x),
            z: roundCoord(pose3.position.z),
            rotationY,
            dir: 0,
        };
        const compiled = createFeatureObstacle(feature);
        const obstacle = { ...compiled, id: overlayId };
        const record = {
            id: overlayId,
            assetId: type,
            scriptId: scriptKey,
            pose: {
                position: {
                    x: feature.x,
                    y: (compiled.minY + compiled.maxY) * 0.5,
                    z: feature.z,
                },
                rotation: { x: 0, y: rotationY, z: 0, order: pose3.rotation.order },
            },
            obstacle,
            lidarPrimitives: createObstacleLidarPrimitives(obstacle),
        };
        this._records.set(overlayId, record);
        return overlayId;
    }

    snapshot() {
        return this.list().map((record) => ({
            id: record.id,
            assetId: record.assetId,
            scriptId: record.scriptId,
            pose: {
                position: { ...record.pose.position },
                rotation: { ...record.pose.rotation },
            },
        }));
    }

    toObstacles() {
        return this.list().map((record) => record.obstacle);
    }

    toLidarPrimitives() {
        return this.list().flatMap((record) => record.lidarPrimitives);
    }

    list() {
        return [...this._records.values()].sort((left, right) => compareUtf8(left.id, right.id));
    }
}
