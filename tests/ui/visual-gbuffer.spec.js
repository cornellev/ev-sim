import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const repositoryRoot = process.cwd();

async function installModuleRoutes(page) {
    await page.route("**/test-modules/**", async (route) => {
        const marker = "/test-modules/";
        const pathname = new URL(route.request().url()).pathname;
        const relative = decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length));
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
}

test("VIS-06b G-buffer products stay aligned while analytic truth remains separate", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(() => {
        const width = 8;
        const height = 4;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const gl = canvas.getContext("webgl2", { antialias: false, alpha: true });
        if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
            throw new Error("WebGL2 float color buffers are required for G-GBUFFER.");
        }

        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error(gl.getShaderInfoLog(shader));
            }
            return shader;
        };
        const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
            in vec2 position;
            uniform float clipDepth;
            uniform float axialDepth;
            out vec2 uv;
            out vec3 worldPosition;
            void main() {
                uv = position * 0.5 + 0.5;
                worldPosition = vec3(position, axialDepth);
                gl_Position = vec4(position, clipDepth, 1.0);
            }
        `);
        const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
            precision highp float;
            precision highp int;
            in vec2 uv;
            in vec3 worldPosition;
            uniform int captureMode;
            uniform vec4 beauty;
            uniform uint objectId;
            uniform uint materialId;
            uniform uint semanticId;
            uniform uint instanceId;
            uniform float confidence;
            uniform float minX;
            uniform float maxX;
            uniform bool visible;
            uniform bool useAlpha;
            uniform sampler2D alphaTexture;
            uniform mat3 alphaTransform;
            uniform float alphaFactor;
            uniform float alphaCutoff;
            out vec4 outputValue;

            vec4 packUint32(uint value) {
                return vec4(uvec4(
                    value & 255u,
                    (value >> 8u) & 255u,
                    (value >> 16u) & 255u,
                    (value >> 24u) & 255u
                )) / 255.0;
            }

            void main() {
                if (!visible || uv.x < minX || uv.x >= maxX) discard;
                float alpha = alphaFactor;
                if (useAlpha) {
                    vec2 alphaUv = (alphaTransform * vec3(uv, 1.0)).xy;
                    alpha *= texture(alphaTexture, alphaUv).a;
                }
                if (alphaCutoff > 0.0 && alpha < alphaCutoff) discard;
                vec3 geometricNormal = normalize(cross(dFdx(worldPosition), dFdy(worldPosition)));
                if (!gl_FrontFacing) geometricNormal = -geometricNormal;
                if (captureMode == 0) outputValue = beauty;
                else if (captureMode == 1) outputValue = vec4(worldPosition.z, 0.0, 0.0, 1.0);
                else if (captureMode == 2) outputValue = vec4(geometricNormal, 1.0);
                else if (captureMode == 3) outputValue = packUint32(objectId);
                else if (captureMode == 4) outputValue = packUint32(materialId);
                else if (captureMode == 5) outputValue = vec4(worldPosition, 1.0);
                else if (captureMode == 6) outputValue = vec4(confidence, 0.0, 0.0, 1.0);
                else if (captureMode == 8) outputValue = packUint32(semanticId);
                else if (captureMode == 9) outputValue = packUint32(instanceId);
                else outputValue = vec4(1.0, 0.0, 0.0, 1.0);
            }
        `);
        const program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program));
        }

        const vao = gl.createVertexArray();
        const vertexBuffer = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 1, -1, -1, 1,
            -1, 1, 1, -1, 1, 1,
        ]), gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program, "position");
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

        const makeTarget = (internalFormat, format, type) => {
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            const depth = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
            const framebuffer = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                throw new Error("G-buffer framebuffer is incomplete.");
            }
            return { texture, depth, framebuffer, format, type };
        };
        const byteTarget = makeTarget(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
        const floatTarget = makeTarget(gl.RGBA32F, gl.RGBA, gl.FLOAT);

        const alphaTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, alphaTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([
            255, 255, 255, 255,
            255, 255, 255, 0,
        ]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        const uniforms = Object.fromEntries([
            "captureMode", "beauty", "objectId", "materialId", "semanticId", "instanceId",
            "confidence", "minX", "maxX", "visible", "useAlpha", "alphaTexture",
            "alphaTransform", "alphaFactor", "alphaCutoff", "clipDepth", "axialDepth",
        ].map((name) => [name, gl.getUniformLocation(program, name)]));
        const identityUv = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const visualSurfaces = [
            { clip: 0.5, depth: 4, minX: 0, maxX: 0.75, color: [0, 1, 0, 1], object: 2, material: 2, confidence: 1 },
            { clip: 0.2, depth: 2, minX: 0, maxX: 0.5, color: [1, 0, 0, 1], object: 1, material: 1, confidence: 1, alpha: true },
            { clip: 0.1, depth: 1.5, minX: 0.5, maxX: 0.625, color: [1, 1, 0, 1], object: 0, material: 0, confidence: 0 },
            { clip: 0.0, depth: 1, minX: 0, maxX: 1, color: [0, 0, 1, 1], object: 3, material: 3, confidence: 1, visible: false },
        ];
        const analyticSurfaces = [
            { clip: 0.6, depth: 6, minX: 0, maxX: 0.75, semantic: 8, instance: 80 },
            { clip: 0.3, depth: 3, minX: 0, maxX: 0.25, semantic: 7, instance: 70 },
        ];

        const render = (mode, family) => {
            const target = [0, 3, 4, 8, 9].includes(mode) ? byteTarget : floatTarget;
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
            gl.viewport(0, 0, width, height);
            gl.clearColor(0, 0, 0, 0);
            gl.clearDepth(1);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LESS);
            gl.useProgram(program);
            gl.bindVertexArray(vao);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, alphaTexture);
            gl.uniform1i(uniforms.alphaTexture, 0);
            gl.uniformMatrix3fv(uniforms.alphaTransform, false, identityUv);
            gl.uniform1i(uniforms.captureMode, mode);
            for (const surface of family === "visual" ? visualSurfaces : analyticSurfaces) {
                gl.uniform1f(uniforms.clipDepth, surface.clip);
                gl.uniform1f(uniforms.axialDepth, surface.depth);
                gl.uniform1f(uniforms.minX, surface.minX);
                gl.uniform1f(uniforms.maxX, surface.maxX);
                gl.uniform1i(uniforms.visible, surface.visible === false ? 0 : 1);
                gl.uniform1i(uniforms.useAlpha, surface.alpha ? 1 : 0);
                gl.uniform1f(uniforms.alphaFactor, 1);
                gl.uniform1f(uniforms.alphaCutoff, surface.alpha ? 0.5 : 0);
                gl.uniform4fv(uniforms.beauty, surface.color ?? [0, 0, 0, 1]);
                gl.uniform1ui(uniforms.objectId, surface.object ?? 0);
                gl.uniform1ui(uniforms.materialId, surface.material ?? 0);
                gl.uniform1ui(uniforms.semanticId, surface.semantic ?? 0);
                gl.uniform1ui(uniforms.instanceId, surface.instance ?? 0);
                gl.uniform1f(uniforms.confidence, surface.confidence ?? 0);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            }
            const pixels = target.type === gl.FLOAT
                ? new Float32Array(width * height * 4)
                : new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, target.format, target.type, pixels);
            const topLeft = new pixels.constructor(pixels.length);
            const rowLength = width * 4;
            for (let row = 0; row < height; row += 1) {
                topLeft.set(pixels.subarray((height - row - 1) * rowLength, (height - row) * rowLength), row * rowLength);
            }
            return topLeft;
        };

        const at = (pixels, x, y) => [...pixels.slice((y * width + x) * 4, (y * width + x + 1) * 4)];
        const decodeId = (rgba) => (rgba[0] | (rgba[1] << 8) | (rgba[2] << 16) | (rgba[3] << 24)) >>> 0;
        const visual = {
            beauty: render(0, "visual"), depth: render(1, "visual"), normal: render(2, "visual"),
            object: render(3, "visual"), material: render(4, "visual"), position: render(5, "visual"),
            confidence: render(6, "visual"), validity: render(7, "visual"),
        };
        const analytic = {
            depth: render(1, "analytic"), semantic: render(8, "analytic"),
            instance: render(9, "analytic"), validity: render(7, "analytic"),
        };
        const points = { target: [1, 0], occluder: [1, 3], unbound: [4, 2], background: [7, 2] };
        const samples = {};
        for (const [name, [x, y]] of Object.entries(points)) {
            samples[name] = {
                beauty: at(visual.beauty, x, y),
                depth: at(visual.depth, x, y)[0],
                normal: at(visual.normal, x, y).slice(0, 3),
                object: decodeId(at(visual.object, x, y)),
                material: decodeId(at(visual.material, x, y)),
                positionZ: at(visual.position, x, y)[2],
                confidence: at(visual.confidence, x, y)[0],
                validity: at(visual.validity, x, y)[0],
            };
        }
        const targetMask = Object.values(points).map(([x, y]) => decodeId(at(visual.object, x, y)) === 2 ? 255 : 0);
        const analyticSamples = {
            near: {
                depth: at(analytic.depth, 1, 2)[0], semantic: decodeId(at(analytic.semantic, 1, 2)),
                instance: decodeId(at(analytic.instance, 1, 2)), validity: at(analytic.validity, 1, 2)[0],
            },
            far: {
                depth: at(analytic.depth, 3, 2)[0], semantic: decodeId(at(analytic.semantic, 3, 2)),
                instance: decodeId(at(analytic.instance, 3, 2)), validity: at(analytic.validity, 3, 2)[0],
            },
        };

        for (const target of [byteTarget, floatTarget]) {
            gl.deleteFramebuffer(target.framebuffer);
            gl.deleteRenderbuffer(target.depth);
            gl.deleteTexture(target.texture);
        }
        gl.deleteTexture(alphaTexture);
        gl.deleteBuffer(vertexBuffer);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        return { samples, targetMask, analyticSamples };
    });

    expect(result.samples.occluder).toEqual({
        beauty: [255, 0, 0, 255], depth: 2, normal: [0, 0, 1], object: 1,
        material: 1, positionZ: 2, confidence: 1, validity: 1,
    });
    expect(result.samples.target).toEqual({
        beauty: [0, 255, 0, 255], depth: 4, normal: [0, 0, 1], object: 2,
        material: 2, positionZ: 4, confidence: 1, validity: 1,
    });
    expect(result.samples.unbound).toEqual({
        beauty: [255, 255, 0, 255], depth: 1.5, normal: [0, 0, 1], object: 0,
        material: 0, positionZ: 1.5, confidence: 0, validity: 1,
    });
    expect(result.samples.background).toEqual({
        beauty: [0, 0, 0, 0], depth: 0, normal: [0, 0, 0], object: 0,
        material: 0, positionZ: 0, confidence: 0, validity: 0,
    });
    expect(result.targetMask).toEqual([255, 0, 0, 0]);
    expect(result.analyticSamples).toEqual({
        near: { depth: 3, semantic: 7, instance: 70, validity: 1 },
        far: { depth: 6, semantic: 8, instance: 80, validity: 1 },
    });
});

test("Three aligned adapter renders owned appearance and analytic scenes without material replacement", async ({ page }) => {
    await installModuleRoutes(page);
    await page.goto("/");
    await page.setContent(`<script type="importmap">${JSON.stringify({
        imports: { three: "/test-modules/node_modules/three/build/three.module.js" },
    })}</script>`);
    const result = await page.evaluate(async () => {
        const THREE = await import("three");
        const {
            AlignedCaptureProducts,
        } = await import("/test-modules/app/3d/environment/visual/AlignedCaptureProducts.js");
        const {
            createOwnedCaptureScene,
            createVisualCameraCalibration,
            createVisualCaptureInput,
            createVisualCapturePassSet,
            VISUAL_CAPTURE_PASS_FAMILIES,
        } = await import("/test-modules/app/3d/environment/visual/VisualCapturePipeline.js");

        const canvas = document.createElement("canvas");
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
        renderer.setPixelRatio(1);
        renderer.setSize(4, 4, false);
        const camera = new THREE.PerspectiveCamera();
        const appearance = new THREE.Scene();
        const green = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        const red = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const target = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), green);
        target.position.z = -4;
        const occluder = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), red);
        occluder.position.z = -2;
        appearance.add(target, occluder);
        appearance.updateMatrixWorld(true);

        const truth = new THREE.Scene();
        const truthMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const truthSurface = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), truthMaterial);
        truthSurface.position.z = -3;
        truth.add(truthSurface);
        truth.updateMatrixWorld(true);

        const visualHandle = createOwnedCaptureScene({ role: "measured-appearance", scene: appearance });
        const analyticHandle = createOwnedCaptureScene({ role: "analytic-truth", scene: truth });
        const calibration = createVisualCameraCalibration({
            width: 4,
            height: 4,
            intrinsics: { fx: 2, fy: 2, cx: 1.5, cy: 1.5 },
            near: 0.1,
            far: 10,
            distortionModel: "none",
            distortion: [],
        });
        const visualPassSet = createVisualCapturePassSet({
            family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
            captureInput: createVisualCaptureInput({
                calibration,
                pose: { matrixWorld: new THREE.Matrix4().elements },
                sceneHandle: visualHandle,
                captureTimeNs: 42,
            }),
            bindings: [
                { renderableId: "target", objectKey: "target", materialKeys: ["green"] },
                { renderableId: "occluder", objectKey: "occluder", materialKeys: ["red"] },
            ],
            sourceUseHashes: ["a".repeat(64)],
        });
        const analyticPassSet = createVisualCapturePassSet({
            family: VISUAL_CAPTURE_PASS_FAMILIES.analytic,
            captureInput: createVisualCaptureInput({
                calibration,
                pose: { matrixWorld: new THREE.Matrix4().elements },
                sceneHandle: analyticHandle,
                captureTimeNs: 42,
            }),
            bindings: [{ renderableId: "truth", semanticId: 7, instanceId: 70 }],
        });
        const rights = [];
        const aligned = new AlignedCaptureProducts({
            renderer,
            camera,
            visualSceneHandle: visualHandle,
            analyticSceneHandle: analyticHandle,
            authorizeSourceUse: async (request) => rights.push(request),
        });
        const output = await aligned.capture({
            visualPassSet,
            visualRenderables: new Map([["target", target], ["occluder", occluder]]),
            analyticPassSet,
            analyticRenderables: new Map([["truth", truthSurface]]),
            signal: new AbortController().signal,
        });
        const sample = (products, index) => ({
            beauty: products.beauty ? [...products.beauty.slice(index * 4, index * 4 + 4)] : null,
            depth: products.axialDepth?.[index] ?? null,
            normal: products.geometricNormal ? [...products.geometricNormal.slice(index * 3, index * 3 + 3)] : null,
            object: products.objectId?.[index] ?? null,
            material: products.materialId?.[index] ?? null,
            position: products.worldPosition ? [...products.worldPosition.slice(index * 3, index * 3 + 3)] : null,
            confidence: products.confidence?.[index] ?? null,
            validity: products.validity[index],
            semantic: products.semanticId?.[index] ?? null,
            instance: products.instanceId?.[index] ?? null,
        });
        const response = {
            center: sample(output.visual.products, 5),
            corner: sample(output.visual.products, 0),
            analytic: sample(output.analytic.products, 5),
            rights,
            materialsUnchanged: target.material === green && occluder.material === red && truthSurface.material === truthMaterial,
        };
        aligned.dispose();
        renderer.dispose();
        target.geometry.dispose();
        occluder.geometry.dispose();
        truthSurface.geometry.dispose();
        green.dispose();
        red.dispose();
        truthMaterial.dispose();
        return response;
    });

    expect(result.center.beauty).toEqual([255, 0, 0, 255]);
    expect(result.center.depth).toBeCloseTo(2, 5);
    expect(result.center.normal).toEqual([0, 0, 1]);
    expect(result.center.object).toBe(1);
    expect(result.center.material).toBe(2);
    expect(result.center.position[2]).toBeCloseTo(-2, 5);
    expect(result.center.confidence).toBe(1);
    expect(result.center.validity).toBe(1);
    expect(result.corner.beauty).toEqual([0, 255, 0, 255]);
    expect(result.corner.object).toBe(2);
    expect(result.corner.material).toBe(1);
    expect(result.analytic.depth).toBeCloseTo(3, 5);
    expect(result.analytic.semantic).toBe(7);
    expect(result.analytic.instance).toBe(70);
    expect(result.analytic.validity).toBe(1);
    expect(result.rights).toEqual([{
        useHash: "a".repeat(64), operations: ["display", "machine-interpretation"],
    }]);
    expect(result.materialsUnchanged).toBe(true);
});
