import Unit from "../Unit";
import {
    FollowRouteBlock,
    FollowRouteSectionBlock,
    RouteSectionCountBlock,
    ROUTE_HELPER_BLOCK_PORTS,
} from "./RouteBlocks.block.js";

function staticPortsUnit(title, ports) {
    function StaticUnit({ _uuid }) {
        return (
            <Unit
                title={title}
                hasOptions={false}
                _uuid={_uuid}
                inputs={[...ports.inputs]}
                outputs={[...ports.outputs]}
            />
        );
    }
    StaticUnit.displayName = `${title.replace(/\s+/g, "")}Unit`;
    return StaticUnit;
}

export function FollowRouteUnit({ _uuid }) {
    return (
        <Unit
            title="Follow Route"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "route", type: "route" },
                { label: "percent", type: "float64" },
            ]}
            outputs={[{ label: "waypoint", type: "waypoint" }]}
        />
    );
}

export function FollowRouteSectionUnit({ _uuid }) {
    return (
        <Unit
            title="Follow Route Section"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "route", type: "route" },
                { label: "section", type: "int32" },
                { label: "percent", type: "float64" },
            ]}
            outputs={[{ label: "waypoint", type: "waypoint" }]}
        />
    );
}

export function RouteSectionCountUnit({ _uuid }) {
    return (
        <Unit
            title="Route Section Count"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[{ label: "route", type: "route" }]}
            outputs={[{ label: "count", type: "int32" }]}
        />
    );
}

export const WaypointAtIndexUnit = staticPortsUnit("Waypoint At Index", ROUTE_HELPER_BLOCK_PORTS.WaypointAtIndexBlock);
export const SplitWaypointUnit = staticPortsUnit("Split Waypoint", ROUTE_HELPER_BLOCK_PORTS.SplitWaypointBlock);
export const RouteLengthUnit = staticPortsUnit("Route Length", ROUTE_HELPER_BLOCK_PORTS.RouteLengthBlock);
export const DistanceToRouteEndUnit = staticPortsUnit("Distance To Route End", ROUTE_HELPER_BLOCK_PORTS.DistanceToRouteEndBlock);
export const RouteTangentUnit = staticPortsUnit("Route Tangent", ROUTE_HELPER_BLOCK_PORTS.RouteTangentBlock);

export {
    DistanceToRouteEndBlock,
    FollowRouteBlock,
    FollowRouteSectionBlock,
    RouteLengthBlock,
    RouteSectionCountBlock,
    RouteTangentBlock,
    SplitWaypointBlock,
    WaypointAtIndexBlock,
} from "./RouteBlocks.block.js";
