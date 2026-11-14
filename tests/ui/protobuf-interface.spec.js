import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const bundle = JSON.parse(await readFile(new URL("../fixtures/protobuf/run-controls.v13.json", import.meta.url)));
async function openConfig(page) {
    await page.goto("/");
    await page.getByRole("button", { name: "Open workspace switcher" }).first().evaluate((button) => button.click());
    await page.getByRole("dialog", { name: "Workspaces" }).getByRole("button", { name: /^Run configuration/i }).click();
    await expect(page.getByRole("region", { name: "Protobuf interface" }).filter({ visible: true })).toBeVisible({ timeout: 30000 });
}
async function mode(page, value) {
    await page.getByRole("button", { name: "Open workspace switcher" }).first().evaluate((button) => button.click());
    const dialog = page.getByRole("dialog", { name: "Workspaces" }); await dialog.getByRole("button", { name: "Settings", exact: true }).click();
    await dialog.getByRole("group", { name: "Run configuration view" }).getByRole("button", { name: value }).click();
    await dialog.getByRole("button", { name: "Close workspaces" }).click();
}
test("schema file import, route errors and mode switches preserve one shared editor", async ({ page }) => {
    test.setTimeout(90000); await openConfig(page);
    let panel = page.getByRole("region", { name: "Protobuf interface" }).filter({ visible: true });
    await panel.getByLabel("Source ID").fill(`pw-protobuf-${Date.now()}`);
    await panel.getByLabel("Entry files").fill("test.proto");
    await panel.getByLabel("Schema files").setInputFiles({ name: "test.proto", mimeType: "text/plain", buffer: Buffer.from('syntax = "proto3"; package test; message State { double speed = 1; }') });
    await expect(panel.getByLabel("Routes and bootstrap JSON")).toBeVisible();
    await panel.getByLabel("Routes and bootstrap JSON").fill("{");
    await expect(panel.getByText("Interface needs attention")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Save interface" })).toBeDisabled();
    await mode(page, "Advanced"); await page.getByRole("tab", { name: "Protobuf", exact: true }).click();
    panel = page.getByRole("region", { name: "Protobuf interface" }).filter({ visible: true });
    await expect(panel.getByLabel("Routes and bootstrap JSON")).toHaveValue("{");
    await panel.getByLabel("Routes and bootstrap JSON").fill('{"routes":[],"bootstrap":[]}');
    await panel.getByRole("button", { name: "Save interface" }).click();
    await mode(page, "Simple");
    await expect(page.getByLabel("Routes and bootstrap JSON").filter({ visible: true })).toHaveValue('{"routes":[],"bootstrap":[]}');
});

test("interface JSON import works at a narrow width with keyboard access", async ({ page }) => {
    test.setTimeout(90000); await page.setViewportSize({ width: 390, height: 844 }); await openConfig(page);
    const panel = page.getByRole("region", { name: "Protobuf interface" }).filter({ visible: true });
    await panel.getByLabel("Import format").selectOption("interface");
    await panel.getByLabel("Interface JSON file").setInputFiles({ name: "interface.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bundle.resolved.protobufInterface.document)) });
    await expect(panel.getByLabel("Routes and bootstrap JSON")).toBeVisible();
    const editor = panel.getByLabel("Routes and bootstrap JSON"); await editor.focus(); await page.keyboard.press("Tab");
    await expect(panel.getByRole("button", { name: "Save interface" })).toBeFocused();
    expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});
