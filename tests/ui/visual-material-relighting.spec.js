import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const repositoryRoot = process.cwd();

test("VIS-10b intrinsic diffuse relights once while captured-radiance unlit stays fixed", async ({ page }) => {
    await page.route("**/test-modules/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const relative = decodeURIComponent(pathname.slice(pathname.indexOf("/test-modules/") + 14));
        if (relative.split("/").includes("..")) {
            await route.abort();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "text/javascript; charset=utf-8",
            body: await readFile(`${repositoryRoot}/${relative}`, "utf8"),
        });
    });
    await page.goto("/");
    await page.setContent(`<script type="importmap">${JSON.stringify({
        imports: { three: "/test-modules/node_modules/three/build/three.module.js" },
    })}</script>`);
    const result = await page.evaluate(async () => {
        const THREE = await import("three");
        const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        renderer.setSize(32, 32, false);
        const target = new THREE.WebGLRenderTarget(32, 32, {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
        });
        target.texture.colorSpace = THREE.LinearSRGBColorSpace;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0, 0, 0);
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
        camera.position.set(0, 0, 2);
        camera.lookAt(0, 0, 0);
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5));
        scene.add(plane);
        const light = new THREE.DirectionalLight(0xffffff, 1);
        light.position.set(0, 0, 2);
        scene.add(light);
        const pixel = new Uint8Array(4);
        const render = (material, intensity) => {
            plane.material = material;
            light.intensity = intensity;
            renderer.setRenderTarget(target);
            renderer.render(scene, camera);
            renderer.readRenderTargetPixels(target, 16, 16, 1, 1, pixel);
            return [...pixel];
        };
        const intrinsic = new THREE.MeshLambertMaterial({ color: new THREE.Color(0.5, 0.5, 0.5) });
        const captured = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.5, 0.5) });
        const intrinsicBright = render(intrinsic, 1);
        const intrinsicDim = render(intrinsic, 0.4);
        const capturedBright = render(captured, 1);
        const capturedDim = render(captured, 0.4);
        intrinsic.dispose();
        captured.dispose();
        plane.geometry.dispose();
        target.dispose();
        renderer.dispose();
        return { intrinsicBright, intrinsicDim, capturedBright, capturedDim };
    });
    expect(result.intrinsicBright[0]).toBeGreaterThan(result.intrinsicDim[0]);
    expect(result.intrinsicDim[0] / result.intrinsicBright[0]).toBeGreaterThan(0.3);
    expect(result.intrinsicDim[0] / result.intrinsicBright[0]).toBeLessThan(0.5);
    expect(result.capturedBright).toEqual(result.capturedDim);
});
