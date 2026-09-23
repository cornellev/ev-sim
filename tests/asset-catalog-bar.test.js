import assert from "node:assert/strict";
import test from "node:test";

import {
    catalogFiltersActive,
    resolveImportSource,
    showImportSourcePicker,
} from "../app/3d/overlay/workspace/assetCatalogBarState.js";

test("catalog display filters are inactive at the defaults", () => {
    assert.equal(catalogFiltersActive({ kind: "all", sort: "name", showArchived: false }), false);
    assert.equal(catalogFiltersActive(), false);
});

test("catalog display filters are active when kind, sort, or archived differ", () => {
    assert.equal(catalogFiltersActive({ kind: "models", sort: "name", showArchived: false }), true);
    assert.equal(catalogFiltersActive({ kind: "builtins", sort: "name", showArchived: false }), true);
    assert.equal(catalogFiltersActive({ kind: "all", sort: "updated", showArchived: false }), true);
    assert.equal(catalogFiltersActive({ kind: "all", sort: "name", showArchived: true }), true);
});

test("the upload grant picker is hidden unless two or more sources exist", () => {
    assert.equal(showImportSourcePicker(undefined), false);
    assert.equal(showImportSourcePicker([]), false);
    assert.equal(showImportSourcePicker([{ id: "owned-lab", label: "owned-lab" }]), false);
    assert.equal(showImportSourcePicker([
        { id: "owned-lab", label: "Owned lab" },
        { id: "field-kit", label: "Field kit" },
    ]), true);
});

test("import source resolution keeps the current grant, else the first, else none", () => {
    const sources = [
        { id: "owned-lab", label: "Owned lab" },
        { id: "field-kit", label: "Field kit" },
    ];
    assert.equal(resolveImportSource(sources, "field-kit"), "field-kit");
    assert.equal(resolveImportSource(sources, "missing"), "owned-lab");
    assert.equal(resolveImportSource(sources, ""), "owned-lab");
    assert.equal(resolveImportSource([{ id: "owned-lab" }], ""), "owned-lab");
    assert.equal(resolveImportSource([], "owned-lab"), "");
    assert.equal(resolveImportSource(undefined, "owned-lab"), "");
});
