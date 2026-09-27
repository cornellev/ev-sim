import { expect, test } from "@playwright/test";

const RUNNING = "a".repeat(40);
const REMOTE = "b".repeat(40);
const REMOTE_NEXT = "c".repeat(40);

test("revision notice opens when the process is behind and stays dismissed for that remote commit", async ({ page }) => {
    test.setTimeout(120_000);
    let payload = revisionPayload("behind", REMOTE);
    await page.route("**/api/revision", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
    }));

    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "Simulator is out of date" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("origin/main");
    await expect(dialog).toContainText("a".repeat(12));
    await expect(dialog).toContainText("3 commits ahead of this process");

    await dialog.getByRole("button", { name: "Dismiss" }).click();
    await expect(dialog).toHaveCount(0);

    const dismissedReload = page.waitForResponse((response) => response.url().includes("/api/revision"));
    await page.reload();
    await dismissedReload;
    await expect(dialog).toHaveCount(0);

    payload = revisionPayload("behind", REMOTE_NEXT);
    const nextReload = page.waitForResponse((response) => response.url().includes("/api/revision"));
    await page.reload();
    await nextReload;
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("c".repeat(12));
});

test("revision notice stays closed when the process contains the remote tip", async ({ page }) => {
    test.setTimeout(120_000);
    await page.route("**/api/revision", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(revisionPayload("current", RUNNING, { ahead: 0, behind: 0 })),
    }));
    const seen = page.waitForResponse((response) => response.url().includes("/api/revision"));
    await page.goto("/");
    await seen;
    await expect(page.getByRole("dialog", { name: "Simulator is out of date" })).toHaveCount(0);
});

function revisionPayload(state, remoteCommit, overrides = {}) {
    return {
        kind: "cev-sim.revision-status",
        version: 1,
        state,
        runningCommit: RUNNING,
        remoteCommit,
        remoteName: "origin",
        remoteBranch: "main",
        remoteRef: "origin/main",
        ahead: 0,
        behind: 3,
        checkedAt: "2026-09-27T00:00:00.000Z",
        detail: null,
        ...overrides,
    };
}
