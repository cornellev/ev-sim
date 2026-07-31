import Unit from "../Unit";
import {
    FollowRouteBlock,
    FollowRouteSectionBlock,
    RouteSectionCountBlock,
} from "./RouteBlocks.block.js";

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

export {
    FollowRouteBlock,
    FollowRouteSectionBlock,
    RouteSectionCountBlock,
} from "./RouteBlocks.block.js";

