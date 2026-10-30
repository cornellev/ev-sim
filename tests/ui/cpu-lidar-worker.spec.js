import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("CPU module worker preserves capture bytes while browser animation frames continue", async ({ page, context }) => {
    const imports = {
        three: "/test-modules/node_modules/three/build/three.module.js",
        "three-mesh-bvh": "/test-modules/node_modules/three-mesh-bvh/src/index.js",
        "@noble/hashes/sha2.js": "/test-modules/node_modules/@noble/hashes/sha2.js",
        "@noble/hashes/utils.js": "/test-modules/node_modules/@noble/hashes/utils.js",
    };
    // Workers do not inherit document import maps. Serve the same source graph
    // with package imports resolved for both the page and the real module worker.
    await context.route("**/test-modules/**", async (route) => {
        const relative = decodeURIComponent(new URL(route.request().url()).pathname.split("/test-modules/")[1]);
        if (relative.split("/").includes("..")) return route.abort();
        let source = await readFile(`${process.cwd()}/${relative}`, "utf8");
        source = source.replace(/from (["'])([^"']+)\1/g, (match, quote, name) => (
            imports[name] ? `from ${quote}${imports[name]}${quote}` : match
        ));
        return route.fulfill({ contentType: "text/javascript", body: source });
    });
    await page.goto("/_not-found");
    const result = await page.evaluate(async () => {
        const { BrowserCpuLidarRuntime } = await import("/test-modules/app/3d/devices/BrowserCpuLidarRuntime.js");
        const { CpuLidarScene } = await import("/test-modules/app/simulation/sensors/CpuLidarScene.js");
        const { createBoxLidarTwin, hashLidarGeometry } = await import("/test-modules/app/simulation/lidar/LidarGeometry.js");
        const description = {
            kind: "cev-sim.lidar-geometry", version: 1,
            coordinateFrame: { units: "meters", upAxis: "+Y", forwardAxis: "+X" },
            staticPrimitives: Array.from({ length: 500 }, (_, index) => createBoxLidarTwin({
                id: `box-${String(index).padStart(4, "0")}`, sourceId: `box-${index}`,
                center: { x: (index % 25) * 3 - 36, y: 0, z: Math.floor(index / 25) * 3 - 27 },
                size: { x: 1, y: 2, z: 1 }, instanceId: index + 1,
            })), actors: [],
        };
        const resource = { description, hash: hashLidarGeometry(description) };
        const config = {
            id: "lidar", parentId: "ego", pose: { position: { x: 0, y: 0, z: 0 }, rotation: {} },
            calibration: { scanLayout: {
                channels: Array.from({ length: 32 }, (_, index) => ({ elevationDeg: index - 16, azimuthOffsetDeg: 0 })),
                azimuthsDeg: Array.from({ length: 1800 }, (_, index) => index * 0.2), minRangeM: 0.2, maxRangeM: 150,
            } },
        };
        const vehicles = [{ id: "ego", position: { x: 0, y: 0, z: 0 }, rotation: {} }];
        const runtime = new BrowserCpuLidarRuntime();
        const inline = new CpuLidarScene(resource);
        let frame = 0;
        let frames = 0;
        const animate = () => { frames += 1; frame = requestAnimationFrame(animate); };
        try {
            await runtime.prepare({ lidarGeometry: resource }, [config]);
            animate();
            let actual;
            for (let i = 0; i < 3; i += 1) actual = await runtime.capture(config, vehicles);
            cancelAnimationFrame(frame);
            const expected = new Uint8Array(inline.capture(config, vehicles).buffer);
            const bytes = new Uint8Array(actual.buffer);
            return { implementation: runtime.status.implementation, frames: frames - 1,
                equal: bytes.every((value, index) => value === expected[index]) };
        } finally { cancelAnimationFrame(frame); runtime.dispose(); inline.dispose(); }
    });
    expect(result.implementation).toBe("worker");
    expect(result.equal).toBe(true);
    expect(result.frames).toBeGreaterThan(0);
});
