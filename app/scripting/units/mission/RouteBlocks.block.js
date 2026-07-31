import { sampleRoute, sampleRouteSection, routeSectionCount } from "../../../scenarios/route/Route.js";
import { BlockOutput, UnitBlock } from "../../ScriptManager.js";

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

