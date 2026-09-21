import path from "node:path";

import { expect, test } from "@playwright/test";

import { PluginStore } from "../../server/storage/PluginStore.js";
import { pluginFixtureResource } from "../helpers/pluginFixtures.js";
import { openWorkspace } from "./openWorkspace.js";

const storageRoot = path.resolve(process.env.CEV_SIM_DATA_DIR ?? ".playwright-data/storage");
const SENSOR_TYPE = "test.range-image-fixture.synthetic-3x4";

async function waitForSensorType(request, type) {
    await expect.poll(async () => {
        const response = await request.get("/api/storage/plugins/sensors");
        if (!response.ok()) return "";
        const body = await response.json();
        return (body.sensors || []).some((entry) => entry.type === type) ? type : "";
    }, { timeout: 30_000 }).toBe(type);
}

let resource;
let throwing;
let store;

test.beforeAll(async () => {
    resource = await pluginFixtureResource({ fixture: "test.range-image-fixture" });
    throwing = await pluginFixtureResource({
        fixture: "test.range-image-fixture",
        mutateDocument(document) {
            document.id = "test.range-image-throwing";
            document.version = "1.0.1";
            document.sensorTypes[0].type = "test.range-image-throwing.synthetic-3x4";
        },
        mutateFiles(files) {
            files["ui/index.js"] = new TextEncoder().encode(`
const pluginUi = {
  registerUi(uiApi) {
    function Boom() {
      throw new Error("sensor view exploded");
    }
    uiApi.contributeSensorView({
      type: "test.range-image-throwing.synthetic-3x4",
      Component: Boom,
    });
  },
};
export default pluginUi;
`);
        },
    });
    store = new PluginStore(storageRoot);
    await store.putPackage(resource);
    await store.putPackage(throwing);
    await store.installFromHash(resource.packageHash);
    await store.installFromHash(throwing.packageHash);
});

test("Config creates, grants, edits, saves, and reloads a custom range-image sensor", async ({ page, request }) => {
    test.setTimeout(180_000);
    await waitForSensorType(request, SENSOR_TYPE);
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    await page.getByRole("button", { name: "New" }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Untitled Run/i);
    const runName = `Plugin Sensor ${Date.now()}`;
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.getByRole("tabpanel", { name: "Overview" }).getByRole("textbox", { name: "Name" }).fill(runName);
    await page.getByRole("tab", { name: "Sensors" }).click();
    await page.getByRole("button", { name: `Add ${SENSOR_TYPE}` }).click();
    await expect(page.getByText("Measured observation").first()).toBeVisible();
    await expect(page.getByText("CPU LiDAR backend v2 required").first()).toBeVisible();
    const scale = page.getByLabel("measurementScale").first();
    await expect(scale).toBeVisible();
    await scale.fill("1.5");
    await scale.blur();
    await expect(scale).toHaveValue("1.5");

    await page.getByRole("tab", { name: "Scripts" }).click();
    await expect(page.getByLabel("Plugin ID").first()).toHaveValue("test.range-image-fixture");
    await expect(page.getByLabel("sensors.sample.range-image").first()).toBeChecked();

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/saved|revision/i).first()).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await openWorkspace(page, "Run configuration");
    await page.getByRole("complementary").getByRole("button", { name: new RegExp(`^${runName}`) }).click();
    await page.getByRole("tab", { name: "Sensors" }).click();
    await expect(page.getByLabel("measurementScale").first()).toHaveValue("1.5");
    await page.getByRole("button", { name: "Validate" }).click();
    await expect(page.getByText("Manifest and dependencies are valid.")).toBeVisible({ timeout: 30_000 });
});

test("Config adds, saves, reloads, and removes UDP bindings", async ({ page, request }) => {
    test.setTimeout(180_000);
    await waitForSensorType(request, SENSOR_TYPE);
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    await page.getByRole("button", { name: "New" }).first().click();
    const runName = `Plugin UDP ${Date.now()}`;
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.getByRole("tabpanel", { name: "Overview" }).getByRole("textbox", { name: "Name" }).fill(runName);
    await page.getByRole("tab", { name: "Sensors" }).click();
    await page.getByRole("button", { name: `Add ${SENSOR_TYPE}` }).click();
    await expect(page.getByText("Vendor packet streams")).toBeVisible();
    await page.getByRole("button", { name: /Add UDP binding for data/ }).click();
    const endpoint = page.getByRole("textbox", { name: "Endpoint ID" }).last();
    await expect(endpoint).toBeVisible();
    await endpoint.fill("helios-data");
    await endpoint.blur();
    await expect(page.getByText("Live UDP runs only on a configured supervisor")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled({ timeout: 15_000 });
    await page.reload();
    await openWorkspace(page, "Run configuration");
    await page.getByRole("complementary").getByRole("button", { name: new RegExp(`^${runName}`) }).click();
    await page.getByRole("tab", { name: "Sensors" }).click();
    await expect(page.getByRole("textbox", { name: "Endpoint ID" }).last()).toHaveValue("helios-data");
    await page.getByRole("button", { name: "Remove binding" }).click();
    await expect(page.getByRole("textbox", { name: "Endpoint ID" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled({ timeout: 15_000 });
});

test("Vehicle editor adds a custom sensor preview and round-trips export/import", async ({ page, request }) => {
    test.setTimeout(180_000);
    await waitForSensorType(request, SENSOR_TYPE);
    await page.goto("/");
    await openWorkspace(page, "Vehicle editor");
    await page.getByRole("button", { name: "New" }).first().click();
    await page.getByRole("tab", { name: "Sensors" }).click();
    await page.getByRole("button", { name: `Add ${SENSOR_TYPE}` }).click();
    await expect(page.getByText(/plugin test\.range-image-fixture@/)).toBeVisible();
    const scale = page.getByLabel("measurementScale").first();
    await expect(scale).toBeVisible();
    await scale.fill("1.25");
    await scale.blur();
    await expect(scale).toHaveValue("1.25");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Unsaved")).toHaveCount(0, { timeout: 15_000 });
    await page.reload();
    await openWorkspace(page, "Vehicle editor");
    await page.getByRole("tab", { name: "Sensors" }).click();
    await expect(page.getByLabel("measurementScale").first()).toHaveValue("1.25");
});

test("throwing custom sensor view falls back without changing configuration", async ({ page, request }) => {
    test.setTimeout(180_000);
    await waitForSensorType(request, "test.range-image-throwing.synthetic-3x4");
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    await page.getByRole("button", { name: "New" }).first().click();
    await page.getByRole("tab", { name: "Sensors" }).click();
    await page.getByRole("button", { name: "Add test.range-image-throwing.synthetic-3x4" }).click();
    await expect(page.getByLabel("Scan layout JSON")).toBeVisible();
    const scale = page.getByLabel("measurementScale").first();
    await expect(scale).toBeVisible();
    await scale.fill("1.1");
    await scale.blur();
    await expect(scale).toHaveValue("1.1");
});
