import assert from "node:assert/strict";
import test from "node:test";

import {
    CENTER_MIN,
    clampVehiclePaneLayout,
    createDefaultVehiclePaneLayout,
    resizeVehiclePane,
    toggleVehiclePane,
    vehiclePaneExtent,
    vehiclePaneGridTemplate,
    VEHICLE_PANE_IDS,
} from "../app/vehicles/editor/workspace/vehiclePaneLayout.js";

test("vehicle panes are hierarchy and inspector and stay inside the center minimum", () => {
    assert.deepEqual([...VEHICLE_PANE_IDS], ["hierarchy", "inspector"]);
    const layout = createDefaultVehiclePaneLayout();
    assert.equal(layout.panes.assets, undefined);
    const squeezed = clampVehiclePaneLayout(layout, { width: CENTER_MIN.width + 40, height: 800 });
    const template = vehiclePaneGridTemplate(squeezed);
    assert.match(template.columns, /minmax\(0, 1fr\)/);
    assert.doesNotMatch(template.rows, /assets/);
    assert.equal(squeezed.panes.hierarchy.collapsed || squeezed.panes.inspector.collapsed, true);
});

test("collapsing a pane uses the rail and resizing expands it again", () => {
    const collapsed = toggleVehiclePane(createDefaultVehiclePaneLayout(), "inspector", true);
    assert.equal(vehiclePaneExtent(collapsed, "inspector"), 28);
    const resized = resizeVehiclePane(collapsed, "inspector", 420);
    assert.equal(resized.panes.inspector.collapsed, false);
    assert.equal(resized.panes.inspector.size, 420);
});
