import {
    distanceToRouteEnd,
    routeLength,
    routeSectionCount,
    routeTangentAtPose,
    sampleRoute,
    sampleRouteSection,
} from "../../../scenarios/route/Route.js";
import { cloneValue } from "../../runtime/SignalStore.js";
import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import {
    VEC2_TYPE,
    VEC3_TYPE,
    finiteFloat,
    finiteInt32,
    finiteResult,
    normalizePose3d,
    normalizeVec2,
    normalizeVec3,
} from "../../types/PortTypes.js";
import { ZERO_VEC2, ZERO_VEC3 } from "../geometry/vectorMath.js";

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

function waypointsOf(route) {
    if (Array.isArray(route)) return route;
    return Array.isArray(route?.waypoints) ? route.waypoints : [];
}

function emptyWaypoint() {
    return {
        id: "",
        kind: "",
        position: { ...ZERO_VEC3 },
        order: 0,
    };
}

function unpackWaypoint(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
        id: source.id == null ? "" : String(source.id),
        kind: source.kind == null ? "" : String(source.kind),
        position: normalizeVec3(source.position ?? source),
        order: finiteInt32(source.order ?? source.number),
    };
}

function tangentToVec2(tangent, heading) {
    const yaw = finiteFloat(heading);
    return normalizeVec2({
        x: tangent?.x ?? Math.sin(yaw),
        y: tangent?.z ?? Math.cos(yaw),
    });
}

const WAYPOINT_AT_INDEX_PORTS = freezePorts(
    [
        { label: "route", type: "route" },
        { label: "index", type: "int32" },
    ],
    [
        { label: "waypoint", type: "waypoint" },
        { label: "found", type: "boolean" },
    ],
);
const SPLIT_WAYPOINT_PORTS = freezePorts(
    [{ label: "waypoint", type: "waypoint" }],
    [
        { label: "id", type: "string" },
        { label: "kind", type: "string" },
        { label: "position", type: VEC3_TYPE },
        { label: "order", type: "int32" },
    ],
);
const ROUTE_LENGTH_PORTS = freezePorts(
    [{ label: "route", type: "route" }],
    [{ label: "length", type: "float64" }],
);
const DISTANCE_TO_ROUTE_END_PORTS = freezePorts(
    [
        { label: "route", type: "route" },
        { label: "pose", type: "pose3d" },
    ],
    [{ label: "distance", type: "float64" }],
);
const ROUTE_TANGENT_PORTS = freezePorts(
    [
        { label: "route", type: "route" },
        { label: "pose", type: "pose3d" },
    ],
    [
        { label: "heading", type: "float64" },
        { label: "tangent", type: VEC2_TYPE },
        { label: "progress", type: "float64" },
        { label: "found", type: "boolean" },
    ],
);

export class FollowRouteBlock extends UnitBlock {
    register() {
        this.registerInput("route", "route");
        this.registerInput("percent", "float64");
        this.registerOutput("waypoint", "waypoint");
    }

    valid() {
        return this.hasInput("route") && this.hasInput("percent");
    }

    execute() {
        return new BlockOutput().set(
            "waypoint",
            sampleRoute(this.getInput("route"), this.getInput("percent")),
        );
    }
}

export class FollowRouteSectionBlock extends UnitBlock {
    register() {
        this.registerInput("route", "route");
        this.registerInput("section", "int32");
        this.registerInput("percent", "float64");
        this.registerOutput("waypoint", "waypoint");
    }

    valid() {
        return this.hasInput("route") && this.hasInput("section") && this.hasInput("percent");
    }

    execute() {
        return new BlockOutput().set(
            "waypoint",
            sampleRouteSection(
                this.getInput("route"),
                this.getInput("section"),
                this.getInput("percent"),
            ),
        );
    }
}

export class RouteSectionCountBlock extends UnitBlock {
    register() {
        this.registerInput("route", "route");
        this.registerOutput("count", "int32");
    }

    valid() {
        return this.hasInput("route");
    }

    execute() {
        return new BlockOutput().set("count", routeSectionCount(this.getInput("route")));
    }
}

export const WaypointAtIndexBlock = defineBlock({
    type: "WaypointAtIndexBlock",
    ports: WAYPOINT_AT_INDEX_PORTS,
    execute() {
        const list = waypointsOf(this.getInput("route"));
        const index = finiteInt32(this.getInput("index"));
        if (index < 0 || index >= list.length) {
            return new BlockOutput().set("waypoint", emptyWaypoint()).set("found", false);
        }
        return new BlockOutput().set("waypoint", cloneValue(list[index])).set("found", true);
    },
});

export const SplitWaypointBlock = defineBlock({
    type: "SplitWaypointBlock",
    ports: SPLIT_WAYPOINT_PORTS,
    execute() {
        const waypoint = unpackWaypoint(this.getInput("waypoint"));
        return new BlockOutput()
            .set("id", waypoint.id)
            .set("kind", waypoint.kind)
            .set("position", waypoint.position)
            .set("order", waypoint.order);
    },
});

export const RouteLengthBlock = defineBlock({
    type: "RouteLengthBlock",
    ports: ROUTE_LENGTH_PORTS,
    execute() {
        return new BlockOutput().set("length", finiteResult(routeLength(this.getInput("route"))));
    },
});

export const DistanceToRouteEndBlock = defineBlock({
    type: "DistanceToRouteEndBlock",
    ports: DISTANCE_TO_ROUTE_END_PORTS,
    execute() {
        return new BlockOutput().set(
            "distance",
            finiteResult(distanceToRouteEnd(this.getInput("route"), normalizePose3d(this.getInput("pose")))),
        );
    },
});

export const RouteTangentBlock = defineBlock({
    type: "RouteTangentBlock",
    ports: ROUTE_TANGENT_PORTS,
    execute() {
        const result = routeTangentAtPose(this.getInput("route"), normalizePose3d(this.getInput("pose")));
        if (!result) {
            return new BlockOutput()
                .set("heading", 0)
                .set("tangent", { ...ZERO_VEC2 })
                .set("progress", 0)
                .set("found", false);
        }
        return new BlockOutput()
            .set("heading", finiteFloat(result.heading))
            .set("tangent", tangentToVec2(result.tangent, result.heading))
            .set("progress", finiteFloat(result.projection?.progress))
            .set("found", true);
    },
});

export const ROUTE_HELPER_BLOCKS = Object.freeze({
    WaypointAtIndexBlock,
    SplitWaypointBlock,
    RouteLengthBlock,
    DistanceToRouteEndBlock,
    RouteTangentBlock,
});

export const ROUTE_HELPER_BLOCK_PORTS = Object.freeze({
    WaypointAtIndexBlock: WAYPOINT_AT_INDEX_PORTS,
    SplitWaypointBlock: SPLIT_WAYPOINT_PORTS,
    RouteLengthBlock: ROUTE_LENGTH_PORTS,
    DistanceToRouteEndBlock: DISTANCE_TO_ROUTE_END_PORTS,
    RouteTangentBlock: ROUTE_TANGENT_PORTS,
});
