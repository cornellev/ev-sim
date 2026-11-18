import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Parser } from "acorn";
import jsx from "acorn-jsx";

import { SIMULATION_VISIBILITY_GROUPS, focusSimulationVisibility } from "../app/3d/overlay/simulationVisibility.js";

test("pointer navigation focuses the panel body and keyboard navigation focuses its controls", () => {
    const focused = [];
    const body = {
        focus: () => focused.push("body"),
        querySelector: (selector) => ({ focus: () => focused.push(selector) }),
    };
    focusSimulationVisibility(body, false);
    focusSimulationVisibility(body, false, "occupancy");
    assert.deepEqual(focused, ["body", "body"], "pointer entry and Back must not select a toggle or category");
    focusSimulationVisibility(body, true);
    focusSimulationVisibility(body, true, "occupancy");
    assert.deepEqual(focused.slice(2), ['[role="switch"]', '[data-visibility-category="occupancy"]']);
    assert.doesNotThrow(() => focusSimulationVisibility(null, true));
});

test("visibility submenus include each working display control once and exclude runtime systems", async () => {
    assert.deepEqual(SIMULATION_VISIBILITY_GROUPS.map((group) => group.title), [
        "Panels", "Autonomy & estimates", "Roads & trajectories", "Occupancy", "Diagnostics",
    ]);
    const optionIds = SIMULATION_VISIBILITY_GROUPS.flatMap((group) => group.options);
    const expected = [
        "vehicleHierarchy", "sensorPanel", "oracle", "candidate", "ekf", "estimateClone",
        "lanes", "controls", "pastTrajectories", "oracleOccupancy", "lidarOccupancy",
        "stackOccupancy", "scenarioDiagnostics", "sensorMarkers", "originMarker",
    ];
    assert.equal(new Set(optionIds).size, optionIds.length, "a switch must appear in only one submenu");
    assert.deepEqual([...optionIds].sort(), [...expected].sort());
    assert.ok(SIMULATION_VISIBILITY_GROUPS.every((group) => group.options.length <= 4));
    for (const runtimeId of ["agents", "environment", "sensors", "scripting", "physics", "realtime", "deterministic"]) {
        assert.ok(!optionIds.includes(runtimeId), `${runtimeId} is not a visibility control`);
    }

    const source = await readFile(new URL("../app/3d/overlay/SimulationMenu.js", import.meta.url), "utf8");
    const ast = Parser.extend(jsx()).parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const component = ast.body.find((node) => node.type === "ExportNamedDeclaration"
        && node.declaration?.id?.name === "SimulationMenu").declaration;
    const options = component.body.body.filter((node) => node.type === "VariableDeclaration")
        .flatMap((node) => node.declarations).find((node) => node.id.name === "visibilityOptions").init;
    assert.deepEqual(options.properties.map((property) => property.key.name).sort(), [...optionIds].sort(),
        "every menu entry must have a rendered switch, with no hidden or missing controls");
});
