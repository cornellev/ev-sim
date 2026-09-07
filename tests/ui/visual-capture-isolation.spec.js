import { expect, test } from "@playwright/test";

test("owned calibrated capture stays byte-stable across display-scene mutations", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 4;
        canvas.height = 4;
        const gl = canvas.getContext("webgl2", {
            antialias: false,
            depth: true,
            preserveDrawingBuffer: true,
        });
        if (!gl) throw new Error("WebGL2 is required for the capture-isolation gate.");

        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation failed.");
            }
            return shader;
        };
        const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
            const vec2 p[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));
            void main(){gl_Position=vec4(p[gl_VertexID],0.,1.);}`);
        const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
            precision highp float; uniform vec4 uColor; out vec4 color;
            void main(){color=uColor;}`);
        const program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program) || "Shader linking failed.");
        }
        const vao = gl.createVertexArray();

        const capture = async (scene, timestampNs) => {
            const input = Object.freeze({
                timestampNs,
                generation: scene.generation,
                color: Object.freeze([...scene.color]),
                projection: Object.freeze([...scene.projection]),
            });
            await Promise.resolve();
            gl.viewport(0, 0, 4, 4);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.useProgram(program);
            gl.uniform4fv(gl.getUniformLocation(program, "uColor"), input.color);
            gl.bindVertexArray(vao);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            const bytes = new Uint8Array(4 * 4 * 4);
            gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            return { bytes: [...bytes], generation: input.generation, timestampNs: input.timestampNs };
        };

        const projection = [1.6, 0, 0, 0, 0, 4, 0, 0, 0, 0, -1.05, -1, 0, 0, -1.02, 0];
        const owned = { generation: 7, color: [0.2, 0.4, 0.6, 1], projection };
        const preview = {
            assets: ["preview-a"],
            sky: "day",
            exposure: 1,
            material: "matte",
            visible: true,
            activeEnvironment: "igvc",
            bakeOverlays: [],
        };
        const before = await capture(owned, 1_000_000_001);
        const pending = capture(owned, 1_000_000_002);
        preview.assets.push("preview-b");
        preview.sky = "night";
        preview.exposure = 9;
        preview.material = "chrome";
        preview.visible = false;
        preview.activeEnvironment = "warehouse";
        preview.bakeOverlays.push("mask", "splat");
        const during = await pending;
        const after = await capture(owned, 1_000_000_003);
        const recreated = await capture({ ...owned, generation: 8, color: [0.6, 0.4, 0.2, 1] }, 1_000_000_004);

        gl.deleteVertexArray(vao);
        gl.deleteProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        return { before, during, after, recreated, preview };
    });

    expect(result.during.bytes).toEqual(result.before.bytes);
    expect(result.after.bytes).toEqual(result.before.bytes);
    expect(result.during.generation).toBe(7);
    expect(result.recreated.generation).toBe(8);
    expect(result.recreated.bytes).not.toEqual(result.before.bytes);
    expect(result.preview.activeEnvironment).toBe("warehouse");
    expect(result.preview.bakeOverlays).toEqual(["mask", "splat"]);
});
