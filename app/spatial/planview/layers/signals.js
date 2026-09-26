import { SIGNAL_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";

registerPlanLayer({
    id: "signals",
    label: "Signals",
    group: "signals",
    defaultVisible: true,
    project(frame) {
        return (frame?.signals ?? []).map((signal) => ({
            kind: "circle",
            center: { x: signal.position.x, z: signal.position.z },
            radiusPx: 6,
            fill: SIGNAL_COLORS[signal.state] || SIGNAL_COLORS.unknown,
            stroke: "#181a1b",
            strokeWidth: 1,
        }));
    },
});
