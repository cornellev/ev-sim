import { linspace, nearestRoadEdge, sampleRoadFrame, sampleRouteFrame } from "../../../roads/PathFrame.js";
import { sampleRoute } from "../../../scenarios/route/Route.js";
import { cloneValue } from "../../runtime/SignalStore.js";
import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import {
    POSE3D_TYPE,
    ROAD_ID_TYPE,
    UNIT,
    UNIT_TYPE,
    finiteFloat,
    finiteInt32,
    normalizePose3d,
} from "../../types/PortTypes.js";

export const MAX_SCATTER_COUNT = 256;
export const SPAWN_PROP_OVERLAY_ERROR = "Spawn Prop requires an episode overlay (bind the script to episode-reset).";
export const SCATTER_SOURCE_ERROR = "Scatter Features requires exactly one of route or edgeId.";

function freezePort(port) {
    return Object.freeze({ label: port.label, type: port.type });
}

function freezePorts(inputs, outputs) {
    return Object.freeze({
        inputs: Object.freeze(inputs.map(freezePort)),
        outputs: Object.freeze(outputs.map(freezePort)),
    });
}

function defineBlock({ type, ports, execute, valid }) {
    class Block extends UnitBlock {
        static blockType = type;

        register() {
            for (const port of ports.inputs) this.registerInput(port.label, port.type);
            for (const port of ports.outputs) this.registerOutput(port.label, port.type);
        }

        valid() {
            if (valid) return valid.call(this);
            return ports.inputs.every((port) => this.hasInput(port.label));
        }

        execute() {
            return execute.call(this);
        }
    }

    try {
        Object.defineProperty(Block, "name", { value: type });
    } catch {
        // Class name is non-configurable in some engines; blockType is the authority.
    }

    return Block;
}

function runtimeContext(unit) {
    return unit.manager?.getRuntimeContext?.() ?? {};
}

function runtimeRandom(unit) {
    const random = runtimeContext(unit).random;
    const value = typeof random === "function" ? Number(random()) : 0;
    return Number.isFinite(value) ? value : 0;
}

function spawnHost(unit) {
    const spawnProp = runtimeContext(unit).spawnProp;
    if (typeof spawnProp !== "function") {
        throw new Error(SPAWN_PROP_OVERLAY_ERROR);
    }
    return spawnProp;
}

function clampCount(value, max) {
    return Math.min(max, Math.max(0, finiteInt32(value)));
}

function clamp01(value) {
    const numeric = finiteFloat(value);
    if (numeric < 0) return 0;
    if (numeric > 1) return 1;
    return numeric;
}

const FRAME_ALONG_PATH_PORTS = freezePorts(
    [
        { label: "route", type: "route" },
        { label: "percent", type: "float64" },
        { label: "lateral", type: "float64" },
    ],
    [
        { label: "pose", type: POSE3D_TYPE },
        { label: "found", type: "boolean" },
    ],
);

const SAMPLE_ROAD_PORTS = freezePorts(
    [
        { label: "edgeId", type: ROAD_ID_TYPE },
        { label: "percent", type: "float64" },
        { label: "lateral", type: "float64" },
    ],
    [
        { label: "pose", type: POSE3D_TYPE },
        { label: "found", type: "boolean" },
    ],
);

const GET_NEAREST_ROAD_PORTS = freezePorts(
    [
        { label: "pose", type: POSE3D_TYPE },
    ],
    [
        { label: "edgeId", type: ROAD_ID_TYPE },
        { label: "found", type: "boolean" },
        { label: "distance", type: "float64" },
    ],
);

const SPAWN_PROP_PORTS = freezePorts(
    [
        { label: "assetId", type: "string" },
        { label: "pose", type: POSE3D_TYPE },
        { label: "id", type: "string" },
    ],
    [
        { label: "then", type: UNIT_TYPE },
        { label: "id", type: "string" },
        { label: "ok", type: "boolean" },
    ],
);

const SCATTER_FEATURES_PORTS = freezePorts(
    [
        { label: "route", type: "route" },
        { label: "edgeId", type: ROAD_ID_TYPE },
        { label: "count", type: "int32" },
        { label: "sideOffset", type: "float64" },
        { label: "centerProbability", type: "float64" },
        { label: "alongJitter", type: "float64" },
        { label: "lateralJitter", type: "float64" },
        { label: "assetId", type: "string" },
    ],
    [
        { label: "then", type: UNIT_TYPE },
        { label: "ids", type: "array[string]" },
        { label: "count", type: "int32" },
    ],
);

export const FrameAlongPathBlock = defineBlock({
    type: "FrameAlongPathBlock",
    ports: FRAME_ALONG_PATH_PORTS,
    execute() {
        const frame = sampleRouteFrame(
            this.getInput("route"),
            this.getInput("percent"),
            this.getInput("lateral"),
        );
        return new BlockOutput()
            .set("pose", cloneValue(frame.pose))
            .set("found", frame.found);
    },
});

export const SampleRoadBlock = defineBlock({
    type: "SampleRoadBlock",
    ports: SAMPLE_ROAD_PORTS,
    execute() {
        const frame = sampleRoadFrame(
            runtimeContext(this).world,
            this.getInput("edgeId"),
            this.getInput("percent"),
            this.getInput("lateral"),
        );
        return new BlockOutput()
            .set("pose", cloneValue(frame.pose))
            .set("found", frame.found);
    },
});

export const GetNearestRoadBlock = defineBlock({
    type: "GetNearestRoadBlock",
    ports: GET_NEAREST_ROAD_PORTS,
    execute() {
        const nearest = nearestRoadEdge(
            runtimeContext(this).world,
            normalizePose3d(this.getInput("pose")),
        );
        return new BlockOutput()
            .set("edgeId", nearest.edgeId)
            .set("found", nearest.found)
            .set("distance", nearest.distance);
    },
});

export const SpawnPropBlock = defineBlock({
    type: "SpawnPropBlock",
    ports: SPAWN_PROP_PORTS,
    valid() {
        return this.hasInput("assetId") && this.hasInput("pose");
    },
    execute() {
        const spawnProp = spawnHost(this);
        const context = runtimeContext(this);
        const overlayId = spawnProp({
            assetId: this.getInput("assetId"),
            pose: normalizePose3d(this.getInput("pose")),
            id: this.hasInput("id") ? this.getInput("id") : "",
            scriptId: context.scriptId,
        });
        return new BlockOutput()
            .set("then", UNIT)
            .set("id", String(overlayId ?? ""))
            .set("ok", true);
    },
});

export const ScatterFeaturesBlock = defineBlock({
    type: "ScatterFeaturesBlock",
    ports: SCATTER_FEATURES_PORTS,
    valid() {
        return this.hasInput("count")
            && this.hasInput("sideOffset")
            && this.hasInput("centerProbability")
            && this.hasInput("alongJitter")
            && this.hasInput("lateralJitter")
            && this.hasInput("assetId");
    },
    execute() {
        const spawnProp = spawnHost(this);
        const context = runtimeContext(this);
        const route = this.hasInput("route") ? this.getInput("route") : null;
        const edgeId = this.hasInput("edgeId") ? String(this.getInput("edgeId") ?? "").trim() : "";
        const routeOk = sampleRoute(route, 0) !== null;
        if (routeOk === Boolean(edgeId)) {
            throw new Error(SCATTER_SOURCE_ERROR);
        }
        const count = clampCount(this.getInput("count"), MAX_SCATTER_COUNT);
        const sideOffset = finiteFloat(this.getInput("sideOffset"));
        const centerProbability = clamp01(this.getInput("centerProbability"));
        const alongJitter = finiteFloat(this.getInput("alongJitter"));
        const lateralJitter = finiteFloat(this.getInput("lateralJitter"));
        const assetId = this.getInput("assetId");
        const percents = linspace(0, 1, count);
        const ids = [];
        for (let index = 0; index < count; index += 1) {
            const along = clamp01(percents[index] + alongJitter * (runtimeRandom(this) * 2 - 1));
            const centered = runtimeRandom(this) < centerProbability;
            const sign = runtimeRandom(this) < 0.5 ? -1 : 1;
            const lateral = (centered ? 0 : sign * sideOffset)
                + lateralJitter * (runtimeRandom(this) * 2 - 1);
            const frame = routeOk
                ? sampleRouteFrame(route, along, lateral)
                : sampleRoadFrame(context.world, edgeId, along, lateral);
            if (!frame.found) continue;
            ids.push(spawnProp({
                assetId,
                pose: frame.pose,
                id: `episode:${context.scriptId ?? "script"}:${index}`,
                scriptId: context.scriptId,
            }));
        }
        return new BlockOutput()
            .set("then", UNIT)
            .set("ids", ids)
            .set("count", ids.length);
    },
});

export const WORLD_BLOCKS = Object.freeze({
    FrameAlongPathBlock,
    SampleRoadBlock,
    GetNearestRoadBlock,
    SpawnPropBlock,
    ScatterFeaturesBlock,
});

export const WORLD_BLOCK_PORTS = Object.freeze({
    FrameAlongPathBlock: FRAME_ALONG_PATH_PORTS,
    SampleRoadBlock: SAMPLE_ROAD_PORTS,
    GetNearestRoadBlock: GET_NEAREST_ROAD_PORTS,
    SpawnPropBlock: SPAWN_PROP_PORTS,
    ScatterFeaturesBlock: SCATTER_FEATURES_PORTS,
});
