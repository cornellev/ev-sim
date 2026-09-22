import { promises as fs } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { pluginFixtureFiles } from "../helpers/pluginFixtures.js";

const destination = path.resolve("plugins/acme.controls");

async function removeFixturePackage(request) {
    const library = await request.get("/api/storage/plugins/library");
    const payload = await library.json();
    for (const entry of payload?.packages ?? []) {
        if (entry.pluginId !== "acme.controls" || entry.version !== "1.0.0") continue;
        await request.post("/api/storage/plugins/remove", {
            data: { pluginId: entry.pluginId, packageHash: entry.packageHash },
        });
    }
}

test.beforeAll(async ({ request }) => {
    const files = await pluginFixtureFiles("acme.controls");
    await fs.rm(destination, { recursive: true, force: true });
    for (const [relative, bytes] of Object.entries(files)) {
        const target = path.join(destination, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
    }
    await removeFixturePackage(request);
});

test.afterAll(async ({ request }) => {
    await fs.rm(destination, { recursive: true, force: true });
    await removeFixturePackage(request);
});

test("plugins pane lists a local package and its details", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
    await expect(opener).toBeVisible();
    await opener.click({ force: true });
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Plugins", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Settings", exact: true })).toBeDisabled();

    const row = dialog.getByRole("button", { name: "acme.controls 1.0.0" });
    await expect(row).toBeVisible();
    await row.click();

    const detail = dialog.getByRole("region", { name: "Plugin details" });
    await expect(detail.getByRole("heading", { name: "acme.controls" })).toBeVisible();
    await expect(detail.getByText("1.0.0")).toBeVisible();
    await expect(detail.getByText("controls.reference")).toBeVisible();
    await expect(detail.getByText("acme.controls.Driver")).toBeVisible();
    await expect(detail.getByText("Not installed")).toBeVisible();
    await detail.getByRole("button", { name: "Install" }).click();
    await expect(detail.getByText("Installed")).toBeVisible();
    await expect(detail.getByRole("button", { name: "Install" })).toHaveCount(0);
    await expect(dialog).toBeVisible();
});
