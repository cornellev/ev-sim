import { createRequire } from "node:module";

import { supervisorError } from "./HeadlessProtocol.js";

const PACKAGE_VERSION = createRequire(import.meta.url)("../../package.json").version;
const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|software rasterizer/i;

function utf8Bytes(value) {
    return Buffer.byteLength(JSON.stringify(value));
}

function outputBytes(request) {
    if (request.type === "camera") return request.width * request.height * 4 * 3;
    return request.width * request.height * 4 * 4 * 3;
}

function infrastructureError(message, details = null) {
    const error = supervisorError("WORKER_CRASHED", message, details);
    error.infrastructureFailure = true;
    return error;
}

export class ChromiumWebGlRendererAdapter {
    constructor(config = {}) {
        this.config = config;
        this.browser = null;
        this.page = null;
        this.provenance = null;
    }

    async start(contextCount) {
        if (!this.config.chromiumExecutable) {
            throw new Error("renderer.chromiumExecutable is not configured.");
        }
        const { chromium } = await import("playwright-core");
        const args = [...(this.config.launchArgs || [])];
        if (this.config.angle) args.push(`--use-angle=${this.config.angle}`);
        if (this.config.disableSandbox) args.push("--no-sandbox");
        this.browser = await chromium.launch({
            executablePath: this.config.chromiumExecutable,
            headless: true,
            args,
        });
        this.page = await this.browser.newPage();
        this.browser.on("disconnected", () => { this.browser = null; });
        const probe = await this.page.evaluate(async ({ count }) => {
            const contexts = [];
            for (let index = 0; index < count; index += 1) {
                const canvas = new OffscreenCanvas(4, 4);
                const gl = canvas.getContext("webgl2", {
                    antialias: false,
                    depth: true,
                    preserveDrawingBuffer: false,
                });
                if (!gl) throw new Error("WebGL2 context creation failed.");
                contexts.push({ canvas, gl });
            }
            globalThis.__cevGpuContexts = contexts;
            const gl = contexts[0].gl;
            const debug = gl.getExtension("WEBGL_debug_renderer_info");
            const floatExtension = gl.getExtension("EXT_color_buffer_float");
            const texture = gl.createTexture();
            const framebuffer = gl.createFramebuffer();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 1, 1);
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
            const floatFramebufferComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
            let readbackCheck = false;
            if (floatFramebufferComplete) {
                const pbo = gl.createBuffer();
                gl.viewport(0, 0, 1, 1);
                gl.clearColor(1, 0.5, 0.25, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
                gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
                const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
                gl.flush();
                await new Promise((resolve, reject) => {
                    const poll = () => {
                        const result = gl.clientWaitSync(fence, 0, 0);
                        if (result === gl.TIMEOUT_EXPIRED) setTimeout(poll, 0);
                        else if (result === gl.WAIT_FAILED) reject(new Error("Probe readback fence failed."));
                        else resolve();
                    };
                    setTimeout(poll, 0);
                });
                const check = new Float32Array(4);
                gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, check);
                readbackCheck = Math.abs(check[0] - 1) < 1e-6 && Math.abs(check[1] - 0.5) < 1e-6;
                gl.deleteSync(fence);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                gl.deleteBuffer(pbo);
            }
            gl.deleteFramebuffer(framebuffer);
            gl.deleteTexture(texture);
            return {
                webglVersion: gl.getParameter(gl.VERSION),
                shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
                vendor: gl.getParameter(gl.VENDOR),
                renderer: debug
                    ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
                    : gl.getParameter(gl.RENDERER),
                unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : "",
                maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
                maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
                maxViewportDimensions: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)),
                extensions: gl.getSupportedExtensions() || [],
                floatColorBuffer: Boolean(floatExtension),
                floatFramebufferComplete,
                readbackCheck,
                contextCount: contexts.length,
            };
        }, { count: contextCount });
        const version = await this.browser.version();
        this.provenance = {
            chromiumVersion: version,
            sidecarVersion: PACKAGE_VERSION,
            executable: this.config.chromiumExecutable,
            launchArguments: args,
            sandboxEnabled: !this.config.disableSandbox,
            angle: this.config.angle || null,
            ...probe,
        };
        return this.provenance;
    }

    async captureGroup(scene, requests, contextIndex) {
        if (!this.page || !this.browser) throw infrastructureError("Chromium renderer is not running.");
        try {
            const values = await this.page.evaluate(async ({ jobs, resolvedScene, slot }) => {
                const context = globalThis.__cevGpuContexts?.[slot];
                if (!context?.gl || context.gl.isContextLost()) throw new Error("WebGL2 context is lost.");
                const gl = context.gl;
                const quaternion = (rotation = {}) => {
                    const x = Number(rotation.x || 0) / 2;
                    const y = Number(rotation.y || 0) / 2;
                    const z = Number(rotation.z || 0) / 2;
                    const cx = Math.cos(x);
                    const sx = Math.sin(x);
                    const cy = Math.cos(y);
                    const sy = Math.sin(y);
                    const cz = Math.cos(z);
                    const sz = Math.sin(z);
                    return [
                        sx * cy * cz + cx * sy * sz,
                        cx * sy * cz - sx * cy * sz,
                        cx * cy * sz + sx * sy * cz,
                        cx * cy * cz - sx * sy * sz,
                    ];
                };
                const multiplyQuaternion = (a, b) => [
                    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
                    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
                    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
                    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
                ];
                const rotate = (value, q) => {
                    const [x, y, z] = value;
                    const [qx, qy, qz, qw] = q;
                    const ix = qw * x + qy * z - qz * y;
                    const iy = qw * y + qz * x - qx * z;
                    const iz = qw * z + qx * y - qy * x;
                    const iw = -qx * x - qy * y - qz * z;
                    return [
                        ix * qw + iw * -qx + iy * -qz - iz * -qy,
                        iy * qw + iw * -qy + iz * -qx - ix * -qz,
                        iz * qw + iw * -qz + ix * -qy - iy * -qx,
                    ];
                };
                const boxTriangles = (primitive) => {
                    const c = primitive.center;
                    const s = primitive.size;
                    const hx = s.x * 0.5;
                    const hy = s.y * 0.5;
                    const hz = s.z * 0.5;
                    const v = [
                        [c.x - hx, c.y - hy, c.z - hz], [c.x + hx, c.y - hy, c.z - hz],
                        [c.x + hx, c.y + hy, c.z - hz], [c.x - hx, c.y + hy, c.z - hz],
                        [c.x - hx, c.y - hy, c.z + hz], [c.x + hx, c.y - hy, c.z + hz],
                        [c.x + hx, c.y + hy, c.z + hz], [c.x - hx, c.y + hy, c.z + hz],
                    ];
                    return [
                        [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
                        [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
                        [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
                    ].map((face) => face.map((index) => v[index]));
                };
                const primitiveTriangles = (primitive) => primitive.shape === "triangle"
                    ? [primitive.vertices.map((value) => [value.x, value.y, value.z])]
                    : boxTriangles(primitive);
                const trianglesFor = (job) => {
                    const triangles = [];
                    const append = (primitive, transform = null) => {
                        for (let vertices of primitiveTriangles(primitive)) {
                            if (transform) {
                                vertices = vertices.map((vertex) => {
                                    const rotated = rotate(vertex, transform.quaternion);
                                    return rotated.map((value, index) => value + transform.position[index]);
                                });
                            }
                            const a = vertices[0];
                            const b = vertices[1];
                            const c = vertices[2];
                            const ab = b.map((value, index) => value - a[index]);
                            const ac = c.map((value, index) => value - a[index]);
                            const normal = [
                                ab[1] * ac[2] - ab[2] * ac[1],
                                ab[2] * ac[0] - ab[0] * ac[2],
                                ab[0] * ac[1] - ab[1] * ac[0],
                            ];
                            const length = Math.hypot(...normal) || 1;
                            triangles.push({
                                vertices,
                                normal: normal.map((value) => value / length),
                                semanticId: Number(primitive.semanticId || 0),
                                instanceId: Number(primitive.instanceId || 0),
                            });
                        }
                    };
                    for (const primitive of resolvedScene.staticPrimitives || []) append(primitive);
                    const vehicles = new Map((job.vehicles || []).map((vehicle) => [vehicle.id, vehicle]));
                    for (const actor of resolvedScene.actors || []) {
                        if (actor.actorId === job.sensor.parentId) continue;
                        const vehicle = vehicles.get(actor.actorId);
                        if (!vehicle) continue;
                        const transform = {
                            position: [vehicle.position.x, vehicle.position.y, vehicle.position.z],
                            quaternion: quaternion(vehicle.rotation),
                        };
                        for (const primitive of actor.primitives || []) append(primitive, transform);
                    }
                    return triangles;
                };
                const compile = (type, source) => {
                    const shader = gl.createShader(type);
                    gl.shaderSource(shader, source);
                    gl.compileShader(shader);
                    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                        throw new Error(gl.getShaderInfoLog(shader) || "GPU sensor shader compilation failed.");
                    }
                    return shader;
                };
                const renderLidar = (job) => {
                    const triangles = trianglesFor(job);
                    if (triangles.length === 0) return [];
                    const packed = new Float32Array(triangles.length * 16);
                    triangles.forEach((triangle, index) => {
                        const offset = index * 16;
                        packed.set([...triangle.vertices[0], triangle.semanticId], offset);
                        packed.set([...triangle.vertices[1], triangle.instanceId], offset + 4);
                        packed.set([...triangle.vertices[2], 0], offset + 8);
                        packed.set([...triangle.normal, 0], offset + 12);
                    });
                    const triangleTexture = gl.createTexture();
                    gl.bindTexture(gl.TEXTURE_2D, triangleTexture);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, triangles.length, 0, gl.RGBA, gl.FLOAT, packed);
                    const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
                        const vec2 p[3] = vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));
                        void main(){gl_Position=vec4(p[gl_VertexID],0.,1.);}`);
                    const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
                        precision highp float; precision highp int;
                        uniform sampler2D uTriangles; uniform int uCount;
                        uniform vec3 uOrigin; uniform vec4 uQuaternion;
                        uniform vec3 uScan; uniform vec2 uElevation; uniform float uRange;
                        out vec4 color;
                        vec3 rotateQ(vec3 v, vec4 q){return v+2.*cross(q.xyz,cross(q.xyz,v)+q.w*v);}
                        float hit(vec3 ro,vec3 rd,vec3 a,vec3 b,vec3 c){
                            vec3 e1=b-a,e2=c-a,p=cross(rd,e2); float d=dot(e1,p);
                            if(abs(d)<1e-7)return -1.; float inv=1./d; vec3 t=ro-a;
                            float u=dot(t,p)*inv; if(u<0.||u>1.)return -1.; vec3 q=cross(t,e1);
                            float v=dot(rd,q)*inv; if(v<0.||u+v>1.)return -1.; return dot(e2,q)*inv;
                        }
                        void main(){
                            float theta=radians(uScan.x+floor(gl_FragCoord.x)*uScan.z);
                            float phi=radians(uElevation.x+floor(gl_FragCoord.y)*uElevation.y);
                            vec3 rd=normalize(rotateQ(vec3(cos(phi)*cos(theta),sin(phi),cos(phi)*sin(theta)),uQuaternion));
                            float best=uRange+1.; float incidence=0.; float semantic=0.; float instance=0.;
                            for(int i=0;i<${triangles.length};i++){
                                vec4 av=texelFetch(uTriangles,ivec2(0,i),0); vec4 bv=texelFetch(uTriangles,ivec2(1,i),0);
                                vec3 cv=texelFetch(uTriangles,ivec2(2,i),0).xyz; vec3 n=texelFetch(uTriangles,ivec2(3,i),0).xyz;
                                float distance=hit(uOrigin,rd,av.xyz,bv.xyz,cv);
                                if(distance>=0.0001&&distance<=uRange&&distance<best){best=distance;incidence=abs(dot(n,rd));semantic=av.w;instance=bv.w;}
                            }
                            color=best<=uRange?vec4(best,incidence,semantic,instance):vec4(0.);
                        }`);
                    const program = gl.createProgram();
                    gl.attachShader(program, vertex);
                    gl.attachShader(program, fragment);
                    gl.linkProgram(program);
                    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                        throw new Error(gl.getProgramInfoLog(program) || "GPU LiDAR shader linking failed.");
                    }
                    const parent = (job.vehicles || []).find((vehicle) => vehicle.id === job.sensor.parentId);
                    if (!parent) throw new Error(`GPU sensor parent ${job.sensor.parentId} is missing.`);
                    const vehicleQ = quaternion(parent.rotation);
                    const pose = job.sensor.pose || {};
                    const localPosition = [pose.position?.x || 0, pose.position?.z || 0, pose.position?.y || 0];
                    const rotatedPosition = rotate(localPosition, vehicleQ);
                    const origin = rotatedPosition.map((value, index) => value
                        + [parent.position.x, parent.position.y, parent.position.z][index]);
                    const localQ = quaternion({
                        x: pose.rotation?.x || 0,
                        y: pose.rotation?.z || 0,
                        z: pose.rotation?.y || 0,
                    });
                    const sensorQ = multiplyQuaternion(vehicleQ, localQ);
                    gl.useProgram(program);
                    gl.uniform1i(gl.getUniformLocation(program, "uTriangles"), 0);
                    gl.uniform1i(gl.getUniformLocation(program, "uCount"), triangles.length);
                    gl.uniform3fv(gl.getUniformLocation(program, "uOrigin"), origin);
                    gl.uniform4fv(gl.getUniformLocation(program, "uQuaternion"), sensorQ);
                    const calibration = job.sensor.calibration;
                    gl.uniform3f(gl.getUniformLocation(program, "uScan"), calibration.azimuth.startDeg, calibration.azimuth.endDeg, calibration.azimuth.stepDeg);
                    gl.uniform2f(gl.getUniformLocation(program, "uElevation"), calibration.elevation.startDeg, calibration.elevation.stepDeg);
                    gl.uniform1f(gl.getUniformLocation(program, "uRange"), calibration.range);
                    const vao = gl.createVertexArray();
                    gl.bindVertexArray(vao);
                    gl.drawArrays(gl.TRIANGLES, 0, 3);
                    gl.bindVertexArray(null);
                    gl.deleteVertexArray(vao);
                    gl.deleteProgram(program);
                    gl.deleteShader(vertex);
                    gl.deleteShader(fragment);
                    return [triangleTexture];
                };
                const renderCamera = (job) => {
                    const triangles = trianglesFor(job);
                    if (triangles.length === 0) return;
                    const materials = new Map((resolvedScene.materials || []).map((entry) => [
                        Number(entry.semanticId),
                        (entry.colorRgba || [128, 128, 128, 255]).map((value) => Number(value) / 255),
                    ]));
                    const vertices = new Float32Array(triangles.length * 3 * 7);
                    let cursor = 0;
                    for (const triangle of triangles) {
                        const color = materials.get(triangle.semanticId) || [0.5, 0.5, 0.5, 1];
                        for (const vertexPosition of triangle.vertices) {
                            vertices.set([...vertexPosition, ...color], cursor);
                            cursor += 7;
                        }
                    }
                    const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
                        precision highp float;
                        layout(location=0) in vec3 position; layout(location=1) in vec4 inputColor;
                        uniform vec3 uOrigin; uniform vec4 uInverseQuaternion;
                        uniform vec4 uProjection; out vec4 vertexColor;
                        vec3 rotateQ(vec3 v, vec4 q){return v+2.*cross(q.xyz,cross(q.xyz,v)+q.w*v);}
                        void main(){
                            vec3 p=rotateQ(position-uOrigin,uInverseQuaternion);
                            float f=uProjection.x; float aspect=uProjection.y;
                            float near=uProjection.z; float far=uProjection.w;
                            gl_Position=vec4(p.x*f/aspect,p.y*f,((far+near)/(near-far))*p.z+(2.*far*near)/(near-far),-p.z);
                            vertexColor=inputColor;
                        }`);
                    const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
                        precision highp float; in vec4 vertexColor; out vec4 color;
                        void main(){color=vertexColor;}`);
                    const program = gl.createProgram();
                    gl.attachShader(program, vertex);
                    gl.attachShader(program, fragment);
                    gl.linkProgram(program);
                    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                        throw new Error(gl.getProgramInfoLog(program) || "GPU camera shader linking failed.");
                    }
                    const parent = (job.vehicles || []).find((vehicle) => vehicle.id === job.sensor.parentId);
                    if (!parent) throw new Error(`GPU sensor parent ${job.sensor.parentId} is missing.`);
                    const vehicleQ = quaternion(parent.rotation);
                    const pose = job.sensor.pose || {};
                    const localPosition = [pose.position?.x || 0, pose.position?.z || 0, pose.position?.y || 0];
                    const rotatedPosition = rotate(localPosition, vehicleQ);
                    const origin = rotatedPosition.map((value, index) => value
                        + [parent.position.x, parent.position.y, parent.position.z][index]);
                    const mountQ = multiplyQuaternion(vehicleQ, quaternion({
                        x: pose.rotation?.x || 0,
                        y: pose.rotation?.z || 0,
                        z: pose.rotation?.y || 0,
                    }));
                    const cameraQ = multiplyQuaternion(mountQ, quaternion({ y: -Math.PI / 2 }));
                    const inverseQ = [-cameraQ[0], -cameraQ[1], -cameraQ[2], cameraQ[3]];
                    const buffer = gl.createBuffer();
                    const vao = gl.createVertexArray();
                    gl.bindVertexArray(vao);
                    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STREAM_DRAW);
                    gl.enableVertexAttribArray(0);
                    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
                    gl.enableVertexAttribArray(1);
                    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
                    gl.enable(gl.DEPTH_TEST);
                    gl.depthFunc(gl.LEQUAL);
                    gl.useProgram(program);
                    gl.uniform3fv(gl.getUniformLocation(program, "uOrigin"), origin);
                    gl.uniform4fv(gl.getUniformLocation(program, "uInverseQuaternion"), inverseQ);
                    const calibration = job.sensor.calibration;
                    gl.uniform4f(
                        gl.getUniformLocation(program, "uProjection"),
                        1 / Math.tan(calibration.verticalFovDeg * Math.PI / 360),
                        job.width / job.height,
                        calibration.near,
                        calibration.far,
                    );
                    gl.drawArrays(gl.TRIANGLES, 0, triangles.length * 3);
                    gl.disable(gl.DEPTH_TEST);
                    gl.bindVertexArray(null);
                    gl.deleteVertexArray(vao);
                    gl.deleteBuffer(buffer);
                    gl.deleteProgram(program);
                    gl.deleteShader(vertex);
                    gl.deleteShader(fragment);
                };
                const readback = async (job, float, clearColor) => {
                    const { width, height } = job;
                    context.canvas.width = width;
                    context.canvas.height = height;
                    const texture = gl.createTexture();
                    const framebuffer = gl.createFramebuffer();
                    const pbo = gl.createBuffer();
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                    gl.texStorage2D(gl.TEXTURE_2D, 1, float ? gl.RGBA32F : gl.RGBA8, width, height);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
                    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                        throw new Error("GPU sensor framebuffer is incomplete.");
                    }
                    gl.viewport(0, 0, width, height);
                    gl.clearColor(...clearColor);
                    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
                    const renderResources = job.type === "lidar3d" ? renderLidar(job) : [];
                    if (job.type === "camera") renderCamera(job);
                    const byteLength = width * height * 4 * (float ? 4 : 1);
                    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
                    gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLength, gl.STREAM_READ);
                    gl.readPixels(0, 0, width, height, gl.RGBA, float ? gl.FLOAT : gl.UNSIGNED_BYTE, 0);
                    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
                    gl.flush();
                    await new Promise((resolve, reject) => {
                        const poll = () => {
                            const result = gl.clientWaitSync(fence, 0, 0);
                            if (result === gl.TIMEOUT_EXPIRED) setTimeout(poll, 0);
                            else if (result === gl.WAIT_FAILED) reject(new Error("GPU readback fence failed."));
                            else resolve();
                        };
                        setTimeout(poll, 0);
                    });
                    const output = float ? new Float32Array(width * height * 4) : new Uint8Array(byteLength);
                    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, output);
                    gl.deleteSync(fence);
                    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                    gl.deleteBuffer(pbo);
                    gl.deleteFramebuffer(framebuffer);
                    gl.deleteTexture(texture);
                    for (const resource of renderResources) gl.deleteTexture(resource);
                    return Array.from(output);
                };
                const output = [];
                for (const job of jobs) {
                    output.push({
                        id: job.id,
                        type: job.type,
                        data: await readback(
                            job,
                            job.type === "lidar3d",
                            job.type === "camera" ? job.clearColor : [0, 0, 0, 0],
                        ),
                    });
                }
                return output;
            }, { jobs: requests, resolvedScene: scene, slot: contextIndex });
            return values.map((entry) => ({
                ...entry,
                data: entry.type === "camera"
                    ? Uint8Array.from(entry.data)
                    : Float32Array.from(entry.data),
            }));
        } catch (error) {
            throw infrastructureError(`GPU capture failed: ${error.message}`);
        }
    }

    isRunning() {
        return Boolean(this.browser && this.page);
    }

    async close() {
        await this.browser?.close().catch(() => {});
        this.browser = null;
        this.page = null;
    }
}

/** Supervisor-owned FIFO pool with a single Chromium page and fixed contexts. */
export class PooledGpuRenderer {
    constructor(config = {}, { adapterFactory = null } = {}) {
        this.config = {
            contextPoolSize: 1,
            sceneCacheBytes: 512 * 1024 * 1024,
            globalGpuBytes: 2 * 1024 * 1024 * 1024,
            ...config,
        };
        this.adapterFactory = adapterFactory || ((options) => new ChromiumWebGlRendererAdapter(options));
        this.adapter = null;
        this.probeResult = null;
        this.startPromise = null;
        this.scenes = new Map();
        this.sceneBytes = 0;
        this.queue = [];
        this.availableContexts = [];
        this.environmentBytes = new Map();
        this.browserLaunches = 0;
        this.busyContexts = 0;
        this.adapterGeneration = 0;
        this.resetPromise = null;
        this.closed = false;
    }

    async probe() {
        await this.resetPromise;
        if (this.probeResult) return this.probeResult;
        if (!this.config.chromiumExecutable) {
            this.probeResult = { available: false, reason: "renderer.chromiumExecutable is not configured." };
            return this.probeResult;
        }
        try {
            await this._start();
            const software = SOFTWARE_RENDERERS.test(this.adapter.provenance?.renderer || "");
            const formats = this.adapter.provenance?.floatColorBuffer
                && this.adapter.provenance?.floatFramebufferComplete
                && this.adapter.provenance?.readbackCheck !== false;
            const available = formats && !software;
            this.probeResult = {
                available,
                reason: available ? "" : software
                    ? "Software WebGL renderer is not a production GPU capability."
                    : "Required float WebGL2 render targets are unavailable.",
                production: !software,
                provenance: this.adapter.provenance,
            };
        } catch (error) {
            await this.adapter?.close().catch(() => {});
            this.adapter = null;
            this.startPromise = null;
            this.probeResult = { available: false, reason: error.message };
        }
        return this.probeResult;
    }

    async _start() {
        await this.resetPromise;
        if (this.adapter) return;
        this.startPromise ||= (async () => {
            this.adapter = this.adapterFactory(this.config);
            await this.adapter.start(this.config.contextPoolSize);
            this.browserLaunches += 1;
            this.adapterGeneration += 1;
            this.availableContexts = Array.from(
                { length: this.config.contextPoolSize },
                (_, index) => index,
            );
        })();
        return this.startPromise;
    }

    _cacheScene(resource) {
        const hash = String(resource?.hash || "");
        if (!hash || !resource?.description) throw new Error("A resolved render scene is required.");
        const existing = this.scenes.get(hash);
        if (existing) {
            this.scenes.delete(hash);
            this.scenes.set(hash, existing);
            return existing;
        }
        const bytes = utf8Bytes(resource.description);
        if (bytes > this.config.sceneCacheBytes) throw supervisorError("RESOURCE_LIMIT", "Render scene exceeds the renderer cache budget.");
        while (this.sceneBytes + bytes > this.config.sceneCacheBytes && this.scenes.size > 0) {
            const [oldestHash, oldest] = this.scenes.entries().next().value;
            this.scenes.delete(oldestHash);
            this.sceneBytes -= oldest.bytes;
        }
        const cached = { hash, description: resource.description, bytes };
        this.scenes.set(hash, cached);
        this.sceneBytes += bytes;
        return cached;
    }

    async captureGroup({ environmentKey, scene, requests, maxGpuBytes, timeoutMs = 30_000 }) {
        if (this.closed) throw infrastructureError("GPU renderer pool is closed.");
        if (this.adapter?.isRunning?.() === false) {
            this._invalidateAdapter(
                this.adapter,
                this.adapterGeneration,
                infrastructureError("Chromium renderer disconnected."),
            );
            await this.resetPromise;
        }
        const probe = await this.probe();
        if (!probe.available) throw infrastructureError(`GPU backend unavailable: ${probe.reason}`);
        const cached = this._cacheScene(scene);
        const allocation = cached.bytes + requests.reduce((total, request) => total + outputBytes(request), 0);
        if (allocation > maxGpuBytes) {
            throw supervisorError("RESOURCE_LIMIT", `GPU job requires ${allocation} bytes; environment limit is ${maxGpuBytes}.`);
        }
        const others = [...this.environmentBytes.entries()]
            .filter(([key]) => key !== environmentKey)
            .reduce((total, [, value]) => total + value, 0);
        if (others + allocation > this.config.globalGpuBytes) {
            throw supervisorError("RESOURCE_LIMIT", "GPU renderer global allocation budget is exhausted.");
        }
        this.environmentBytes.set(environmentKey, allocation);
        return new Promise((resolve, reject) => {
            this.queue.push({
                cached,
                requests,
                resolve,
                reject,
                timeoutMs: Math.max(1, Number(timeoutMs) || 30_000),
            });
            this._drain();
        });
    }

    _invalidateAdapter(adapter, generation, error) {
        if (this.adapter !== adapter || this.adapterGeneration !== generation) return;
        this.adapter = null;
        this.startPromise = null;
        this.probeResult = null;
        this.availableContexts = [];
        const failure = infrastructureError(`GPU renderer must restart: ${error.message}`);
        for (const queued of this.queue.splice(0)) queued.reject(failure);
        const closing = Promise.resolve().then(() => adapter.close()).catch(() => {});
        let cleanup;
        cleanup = closing.finally(() => {
            if (this.resetPromise === cleanup) this.resetPromise = null;
        });
        this.resetPromise = cleanup;
    }

    _drain() {
        while (this.availableContexts.length > 0 && this.queue.length > 0) {
            const context = this.availableContexts.shift();
            const job = this.queue.shift();
            const adapter = this.adapter;
            const generation = this.adapterGeneration;
            this.busyContexts += 1;
            let timer;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(infrastructureError(
                    `GPU capture exceeded its ${job.timeoutMs}-ms wall timeout.`,
                )), job.timeoutMs);
            });
            Promise.race([adapter.captureGroup(job.cached.description, job.requests, context), timeout])
                .then(job.resolve)
                .catch((error) => {
                    job.reject(error);
                    this._invalidateAdapter(adapter, generation, error);
                })
                .finally(() => {
                    clearTimeout(timer);
                    this.busyContexts -= 1;
                    if (this.adapter === adapter && this.adapterGeneration === generation) {
                        this.availableContexts.push(context);
                        this.availableContexts.sort((left, right) => left - right);
                    }
                    this._drain();
                });
        }
    }

    releaseEnvironment(environmentKey) {
        this.environmentBytes.delete(environmentKey);
    }

    diagnostics() {
        return {
            browserLaunches: this.browserLaunches,
            contextCount: this.browserLaunches > 0 ? this.config.contextPoolSize : 0,
            busyContexts: this.busyContexts,
            queuedJobs: this.queue.length,
            sceneCount: this.scenes.size,
            sceneBytes: this.sceneBytes,
            trackedGpuBytes: [...this.environmentBytes.values()].reduce((total, value) => total + value, 0),
            provenance: this.probeResult?.provenance || null,
        };
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        const error = infrastructureError("GPU renderer pool closed.");
        for (const job of this.queue.splice(0)) job.reject(error);
        await this.resetPromise;
        await this.adapter?.close().catch(() => {});
        this.adapter = null;
        this.environmentBytes.clear();
        this.scenes.clear();
        this.sceneBytes = 0;
    }
}
