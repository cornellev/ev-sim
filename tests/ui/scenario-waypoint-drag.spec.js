import { expect, test } from "@playwright/test";
import { duffyRoutingFixture } from "../helpers/duffyRouting.js";

async function jsonRequest(request, method, url, data) {
    const response = await request[method](url, { data });
    expect(response.ok(), `${url}: ${await response.text()}`).toBeTruthy();
    return response.json();
}

async function markerCenter(marker) {
    const bounds = await marker.boundingBox();
    expect(bounds).not.toBeNull();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

test("Duffy routes verify through HTTP and waypoint drags preview freely then snap once on release", async ({ page, request }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const suffix = Date.now().toString(36);
    const environmentId = `pw-duffy-env-${suffix}`;
    const scenarioId = `pw-duffy-route-${suffix}`;
    const fixture = duffyRoutingFixture();
    try {
        const environment = await jsonRequest(request, "post", "/api/storage/environments", {
            id: environmentId, name: "Duffy route regression", templateId: "blank",
        });
        await jsonRequest(request, "put", `/api/storage/environments/${environmentId}`, {
            expectedRevision: environment.revision,
            supportedRoadGeometryVersions: [1, 2],
            manifest: {
                ...environment,
                roadsAuthored: true,
                document: { ...environment.document, roadsAuthored: true, roads: fixture.roads },
            },
        });
        await jsonRequest(request, "post", "/api/storage/scenarios", {
            kind: "cev-sim.scenario", version: 1,
            id: scenarioId, name: `Duffy route ${suffix}`,
            environment: { id: environmentId, expectedHash: null },
            actors: [{ id: "ego", name: "Ego", role: "ego", enabled: true }],
            routes: [{ id: "ego-route", name: "Ego route", actorId: "ego", waypoints: fixture.waypoints, verification: null }],
        });
        await page.goto("/");
        const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
        if (await opener.isVisible()) await opener.click();
        else await page.keyboard.press("Escape");
        await page.getByRole("dialog", { name: "Workspaces" }).getByRole("button", { name: /^Scenarios/i }).click();
        await page.locator(`[data-scenario-id="${scenarioId}"]`).click();
        await page.getByRole("tab", { name: "Routes", exact: true }).click();
        await page.getByRole("button", { name: "Edit route" }).click();
        const map = page.getByRole("img", { name: /^Road map for placing/i });
        const surface = map.locator("..");
        const marker = map.getByRole("button", { name: "start S" });
        const inspector = page.getByLabel("Selected waypoint");
        // The north spur puts the horizontal route at the bottom of the fitted
        // view. Move it clear of the zoom HUD before interacting with markers.
        const mapBounds = await map.boundingBox();
        await page.mouse.move(mapBounds.x + mapBounds.width * 0.8, mapBounds.y + mapBounds.height * 0.4);
        await page.mouse.down();
        await page.mouse.move(mapBounds.x + mapBounds.width * 0.8, mapBounds.y + mapBounds.height * 0.4 - 120, { steps: 4 });
        await page.mouse.up();
        const verify = async () => {
            const responsePromise = page.waitForResponse((response) => response.url().endsWith(`/scenarios/${scenarioId}/verify-route`));
            await page.getByRole("button", { name: "Verify", exact: true }).click();
            const result = await (await responsePromise).json();
            expect(result.ok, JSON.stringify(result.issues)).toBe(true);
            expect(result.verification.algorithmVersion).toBe(7);
            expect(result.verification.edgeTraversal.map((step) => [step.edgeId, step.direction, step.fromLaneId])).toEqual([
                ["junction-west", -1, "lane-1"], ["east-junction", -1, "lane-1"],
            ]);
            await expect(map.locator('[data-route-path="verified"]')).toBeVisible();
            await expect(page.getByRole("button", { name: /Continue/ })).toBeEnabled();
            return result;
        };
        await verify();
        await marker.click();
        const initial = await markerCenter(marker);
        const coordinates = await inspector.locator("dd").allTextContents();
        const mapCenter = await surface.getAttribute("data-map-center");
        const target = { x: initial.x + 50, y: initial.y + 30 };

        let releaseVerification;
        let responseReady = false;
        const verificationGate = new Promise((resolve) => { releaseVerification = resolve; });
        const verificationPattern = `**/api/storage/scenarios/${scenarioId}/verify-route`;
        await page.route(verificationPattern, async (intercepted) => {
            const response = await intercepted.fetch();
            responseReady = true;
            await verificationGate;
            await intercepted.fulfill({ response });
        });
        await page.getByRole("button", { name: "Verify", exact: true }).click();
        await expect.poll(() => responseReady).toBe(true);

        // Watch the static scene while the marker follows an off-road pointer.
        await map.evaluate((svg) => {
            window.__waypointRoadMutations = [];
            window.__waypointRoadObserver = new MutationObserver((records) => window.__waypointRoadMutations.push(...records.map((record) => record.type)));
            for (const layer of svg.querySelectorAll("[data-map-layer]")) {
                window.__waypointRoadObserver.observe(layer, { subtree: true, attributes: true, childList: true, characterData: true });
            }
        });
        await page.mouse.move(initial.x, initial.y);
        await page.mouse.down();
        await page.mouse.move(target.x, target.y, { steps: 16 });
        await expect(marker).toHaveAttribute("data-dragging", "true");
        const preview = await markerCenter(marker);
        expect(Math.hypot(preview.x - target.x, preview.y - target.y)).toBeLessThan(1);
        expect(await inspector.locator("dd").allTextContents()).toEqual(coordinates);
        await expect(map.locator('[data-route-path="verified"]')).toHaveCount(0);
        expect(await page.evaluate(() => window.__waypointRoadMutations)).toEqual([]);
        await expect(surface).toHaveAttribute("data-map-center", mapCenter);

        releaseVerification();
        await expect(page.getByText("Route changed while verification was running")).toBeVisible();
        expect(await inspector.locator("dd").allTextContents()).toEqual(coordinates);
        await expect(marker).toHaveAttribute("data-dragging", "true");
        await page.unroute(verificationPattern);

        await page.keyboard.press("Escape");
        await page.mouse.up();
        expect(await markerCenter(marker)).toEqual(initial);
        expect(await inspector.locator("dd").allTextContents()).toEqual(coordinates);
        await expect(map.locator('[data-route-path="verified"]')).toBeVisible();

        // Pointer cancellation also discards the preview and its queued frame.
        await page.mouse.move(initial.x, initial.y);
        await page.mouse.down();
        await page.mouse.move(target.x, target.y, { steps: 4 });
        await surface.dispatchEvent("pointercancel", { pointerId: 1 });
        await page.mouse.up();
        expect(await markerCenter(marker)).toEqual(initial);
        expect(await inspector.locator("dd").allTextContents()).toEqual(coordinates);

        await page.mouse.move(initial.x, initial.y);
        await page.mouse.down();
        await page.mouse.move(target.x, target.y, { steps: 16 });
        await page.mouse.up();
        await expect(marker).not.toHaveAttribute("data-dragging");
        await expect(marker).not.toHaveAttribute("transform");
        expect(await inspector.locator("dd").allTextContents()).not.toEqual(coordinates);
        const snapped = await markerCenter(marker);
        expect(Math.abs(snapped.y - target.y)).toBeGreaterThan(20);
        await expect(page.getByRole("button", { name: /Continue/ })).toBeDisabled();
        expect(await page.evaluate(() => window.__waypointRoadMutations)).toEqual([]);
        await page.evaluate(() => window.__waypointRoadObserver.disconnect());

        const result = await verify();
        expect(result.waypoints[0].anchor.laneId).toBe("lane-1");
        const verifiedPosition = await markerCenter(marker);
        expect(Math.hypot(verifiedPosition.x - snapped.x, verifiedPosition.y - snapped.y)).toBeLessThan(1);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByText("Scenario saved")).toBeVisible();
        const saved = await jsonRequest(request, "get", `/api/storage/scenarios/${scenarioId}`);
        expect(saved.routes[0].waypoints[0].anchor.laneId).toBe("lane-1");
        expect(saved.routes[0].verification.algorithmVersion).toBe(7);
    } finally {
        await request.delete(`/api/storage/scenarios/${scenarioId}`);
        const response = await request.get(`/api/storage/environments/${environmentId}`);
        if (response.ok()) {
            const environment = await response.json();
            if (environment) await request.delete(`/api/storage/environments/${environmentId}?expectedRevision=${environment.revision}`);
        }
    }
});
