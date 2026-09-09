import { expect, test } from "@playwright/test";

async function openVisualLab(page) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
    await expect(opener).toBeVisible({ timeout: 30_000 });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Visual Lab/i }).click();
    await expect(page.getByText("Inspect what survives the bake")).toBeVisible();
}

test("Visual Lab reopens synchronized comparison notes and renders retained geometry", async ({ page, request }) => {
    test.setTimeout(120_000);
    const reviewId = "experiment-0-room-review";
    const existing = await request.get(`/api/storage/visual-lab/reviews/${reviewId}`);
    if (existing.ok()) {
        const review = await existing.json();
        if (review) await request.delete(`/api/storage/visual-lab/reviews/${reviewId}?expectedRevision=${review.revision}`);
    }

    try {
        await openVisualLab(page);
        await expect(page.getByText("A · Source render")).toBeVisible();
        await expect(page.getByText("B · Baked-scene render")).toBeVisible();
        await expect(page.getByText("Camera, sample, and condition agree")).toBeVisible();
        await expect(page.getByText("blocked partial bindings")).toBeVisible();

        await page.getByLabel("View or path").selectOption("path:normal-walkthrough");
        await expect(page.getByText(/1 \/ 25/)).toBeVisible();
        await page.getByRole("button", { name: "Next frame" }).click();
        await expect(page.getByText(/2 \/ 25/)).toBeVisible();
        await page.getByRole("button", { name: "Save close-up" }).click();

        await page.getByPlaceholder("Describe the visible defect and expected appearance.").fill("Table edge loses its rounded profile during motion.");
        await page.getByRole("button", { name: "Attach to B" }).click();
        await page.getByRole("button", { name: "Save review" }).click();
        await expect(page.getByRole("button", { name: "Save review" })).not.toHaveAttribute("data-loading", "true");

        const report = await request.get(`/api/storage/visual-lab/reviews/${reviewId}/report`);
        expect(report.ok()).toBeTruthy();
        expect(await report.text()).toContain("Table edge loses its rounded profile");

        const persisted = await request.get(`/api/storage/visual-lab/reviews/${reviewId}`);
        expect(persisted.ok()).toBeTruthy();
        expect((await persisted.json()).defects[0].text).toBe("Table edge loses its rounded profile during motion.");
        await page.getByRole("radio", { name: "Live 3D" }).click();
        await expect(page.getByText(/Locked calibrated view/)).toBeVisible();
        const liveViewport = page.getByTestId("visual-lab-live-canvas");
        const canvas = liveViewport.locator("canvas");
        await expect(canvas).toBeVisible();
        await expect.poll(async () => liveViewport.evaluate((container) => {
            const surface = container.querySelector("canvas");
            if (!surface) return null;
            const containerRect = container.getBoundingClientRect();
            const canvasRect = surface.getBoundingClientRect();
            return Math.abs((surface.width / surface.height) - (1280 / 720)) < 0.01
                && canvasRect.width <= containerRect.width + 1
                && canvasRect.height <= containerRect.height + 1;
        })).toBe(true);
        const dimensions = await liveViewport.evaluate((container) => {
            const surface = container.querySelector("canvas");
            const containerRect = container.getBoundingClientRect();
            return {
                containerWidth: containerRect.width,
                containerHeight: containerRect.height,
                canvasWidth: surface.getBoundingClientRect().width,
                canvasHeight: surface.getBoundingClientRect().height,
                drawingAspect: surface.width / surface.height,
                displayAspect: containerRect.width / containerRect.height,
            };
        });
        expect(dimensions.containerWidth).toBeGreaterThan(600);
        expect(dimensions.containerHeight).toBeGreaterThan(300);
        expect(dimensions.canvasWidth).toBeLessThanOrEqual(dimensions.containerWidth);
        expect(dimensions.canvasHeight).toBeLessThanOrEqual(dimensions.containerHeight);
        expect(dimensions.drawingAspect).toBeCloseTo(1280 / 720, 2);

        const scenePicker = page.getByLabel("Live 3D scene");
        await expect(scenePicker.locator("option")).toHaveCount(2);
        await scenePicker.selectOption("b0-simple");
        await expect(liveViewport).toHaveAttribute("data-live-scene", "b0-simple");
        await page.getByLabel("Asset to add").selectOption("chair-a");
        await expect(liveViewport).toHaveAttribute("data-selected-object", "chair-a-copy-1");
        await expect(liveViewport).toHaveAttribute("data-outline-object", "chair-a-copy-1");
        await expect(page.getByText("chair-a-copy-1", { exact: true })).toBeVisible();
        await scenePicker.selectOption("b1-detailed");
        await expect(liveViewport).toHaveAttribute("data-live-scene", "b1-detailed");
        await expect(liveViewport).toHaveAttribute("data-selected-object", "chair-a-copy-1");
        await expect(liveViewport).toHaveAttribute("data-outline-object", "chair-a-copy-1");

        const viewport = page.viewportSize();
        await page.setViewportSize({
            width: Math.max(960, viewport.width - 160),
            height: Math.max(640, viewport.height - 80),
        });
        await expect.poll(async () => liveViewport.evaluate((container) => {
            const surface = container.querySelector("canvas");
            const containerRect = container.getBoundingClientRect();
            const canvasRect = surface.getBoundingClientRect();
            return canvasRect.width <= containerRect.width + 1
                && canvasRect.height <= containerRect.height + 1
                && Math.abs((surface.width / surface.height) - (1280 / 720)) < 0.01;
        })).toBe(true);
        const resizedWidth = await liveViewport.evaluate((container) => container.getBoundingClientRect().width);
        expect(resizedWidth).not.toBeCloseTo(dimensions.containerWidth, 0);
    } finally {
        const stored = await request.get(`/api/storage/visual-lab/reviews/${reviewId}`);
        if (stored.ok()) {
            const review = await stored.json();
            if (review) await request.delete(`/api/storage/visual-lab/reviews/${reviewId}?expectedRevision=${review.revision}`);
        }
    }
});

test("Experiment 1 locked live view agrees with measured B4 brightness and calibrated framing", async ({ page }) => {
    test.setTimeout(120_000);
    await openVisualLab(page);
    await page.getByLabel("Case").selectOption("experiment-1-room");
    await expect(page.getByText("ready complete bindings")).toBeVisible();
    await page.getByLabel("B candidate").selectOption("experiment-1-b4-combined");
    await page.getByLabel("B output").selectOption("b4-browser-ordinary-environment-base-combined");
    await page.getByRole("radio", { name: "Live 3D" }).click();
    await expect(page.getByText(/Locked calibrated view/)).toBeVisible();
    const canvas = page.getByTestId("visual-lab-live-canvas").locator("canvas");
    await expect(canvas).toBeVisible();
    await page.waitForTimeout(750);
    const liveFps = await page.evaluate(() => new Promise((resolve) => {
        let firstTime = null;
        let frameCount = 0;
        const observe = (time) => {
            if (firstTime == null) firstTime = time;
            frameCount += 1;
            if (frameCount === 121) {
                resolve(120_000 / (time - firstTime));
                return;
            }
            requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
    }));
    expect(liveFps).toBeGreaterThanOrEqual(30);
    const comparison = await canvas.evaluate(async (surface) => {
        const width = 320;
        const height = 180;
        const pixels = async (source) => {
            const target = new OffscreenCanvas(width, height);
            const context = target.getContext("2d", { willReadFrequently: true });
            context.drawImage(source, 0, 0, width, height);
            return context.getImageData(0, 0, width, height).data;
        };
        const response = await fetch("/visual-lab/experiment-1/browser/b4-browser/b4-browser-ordinary-environment-base-combined/stills/room-north-west.png");
        const retained = await createImageBitmap(await response.blob());
        const livePixels = await pixels(surface);
        const retainedPixels = await pixels(retained);
        const statistics = (values) => {
            let luminance = 0;
            let edge = 0;
            for (let index = 0; index < values.length; index += 4) {
                luminance += values[index] * 0.2126 + values[index + 1] * 0.7152 + values[index + 2] * 0.0722;
            }
            for (let y = 1; y < height; y += 1) {
                for (let x = 1; x < width; x += 1) {
                    const offset = (y * width + x) * 4;
                    const left = offset - 4;
                    const above = offset - width * 4;
                    edge += Math.abs(values[offset] - values[left]) + Math.abs(values[offset] - values[above]);
                }
            }
            return { meanLuminance: luminance / (width * height), normalizedEdge: edge / (width * height * 510) };
        };
        return { live: statistics(livePixels), retained: statistics(retainedPixels), aspect: surface.width / surface.height };
    });
    expect(comparison.aspect).toBeCloseTo(1280 / 720, 2);
    expect(Math.abs(comparison.live.meanLuminance - comparison.retained.meanLuminance)).toBeLessThan(12);
    expect(Math.abs(comparison.live.normalizedEdge - comparison.retained.normalizedEdge)).toBeLessThan(0.025);
});
