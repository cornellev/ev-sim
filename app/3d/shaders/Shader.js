import * as THREE from 'three';
import { getWebGL2Context, PixelPackSlot, withPixelPackBufferUnbound } from '../util/glReadback.js';

export function common() {
    return `` +
`// common GLSL definitions
#define PI 3.1415926

// common GLSL functions
float toRadians(float degrees) {
    return degrees * (PI / 180.0);
}
    
float toDegrees(float radians) {
    return radians * (180.0 / PI);
}

float floatMod(float a, float b) {
    return a - b * floor(a / b);
}

float dot2(vec2 v) {
    return dot(v, v);
}

float dot2(vec3 v) {
    return dot(v, v);
}
`
}

export const standardVTX = `` + 
`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class Shader {
    constructor(w, h, vertexSource, fragmentSource, uniforms={}) {
        this.vertexSource = vertexSource;
        this.fragmentSource = fragmentSource;
        this.size = {w, h};
        this.uniforms = uniforms;

        this.listeners = [];

        this.startTime = 0;
        this._scene = null;
        this._camera = null;
        this._mat = null;
        this._quad = null;
        this._renderTarget = null;
        this._renderer = null;
        this._inPass = false;
        this._pixelBuffer = null;
        this._pack = null;
        this._asyncDisabled = false;

        //console.log(fragmentSource);
    }

    getVertexSource() {
        return this.vertexSource;
    }

    getFragmentSource() {
        return this.fragmentSource;
    }

    onData(callback) {
        this.listeners.push(callback);
    }

    /**
     * Initialize the offscreen shader pass.
     * @param {THREE.WebGLRenderer} renderer
     */
    setup(renderer) {
        const { w, h } = this.size;
        this.startTime = Date.now();

        this._renderer = renderer;

        const scene2 = new THREE.Scene();
        const cam2 = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const mat = new THREE.ShaderMaterial({
            vertexShader: this.getVertexSource(),
            fragmentShader: this.getFragmentSource(),
            uniforms: Object.assign({
                u_resolution: { value: new THREE.Vector2(w, h) },
                u_time: { value: 0 },
            }, this.uniforms),
        });

        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
        scene2.add(quad);

        const rt = new THREE.WebGLRenderTarget(w, h, {
            type: THREE.FloatType,
            format: THREE.RGBAFormat,
            depthBuffer: false,
            stencilBuffer: false,
        });

        this._scene = scene2;
        this._camera = cam2;
        this._mat = mat;
        this._quad = quad;
        this._renderTarget = rt;
    }

    _ensurePixelBuffer() {
        const { w, h } = this.size;
        const pixelBufferLength = 4 * w * h;
        if (this._pixelBuffer?.length !== pixelBufferLength) {
            this._pixelBuffer = new Float32Array(pixelBufferLength);
        }
        return this._pixelBuffer;
    }

    _ensurePack() {
        if (this._asyncDisabled) return null;
        const gl = getWebGL2Context(this._renderer);
        if (!gl) return null;
        const byteLength = this.size.w * this.size.h * 16;
        if (this._pack && this._pack.byteLength === byteLength) return this._pack;
        this._pack?.dispose?.();
        this._pack = new PixelPackSlot(gl, byteLength);
        return this._pack;
    }

    get usesAsyncReadback() {
        return !this._asyncDisabled && Boolean(getWebGL2Context(this._renderer));
    }

    /**
     * Copy a completed PIXEL_PACK read into the CPU buffer and notify listeners.
     * Returns false when a previous GPU read is still in flight (timeout 0).
     */
    completePending() {
        if (!this._pack?.pending) return true;
        this._ensurePixelBuffer();
        if (!this._pack.poll(this._pixelBuffer)) return false;
        for (const listener of this.listeners) listener(this._pixelBuffer);
        return true;
    }

    /**
     * Perform one shader pass, update uniforms, render to the
     * internal render target and notify listeners with the pixel data.
     * On WebGL2, `readPixels` is issued into a PIXEL_PACK buffer and listeners
     * receive the previous pass (typically one sensor period later).
     * @param {Object} uniforms THREE-style uniform descriptors, e.g. { foo: { value: ... } }
     */
    update(uniforms = {}) {
        if (!this._mat || !this._renderer || !this._renderTarget || this._inPass) return false;
        this._inPass = true;
        try {
            if (!this.completePending()) return false;
            return this._submit(uniforms);
        } finally {
            this._inPass = false;
        }
    }

    _submit(uniforms = {}) {
        const { w, h } = this.size;
        this._ensurePixelBuffer();

        for (const key in uniforms) {
            this._mat.uniforms[key] = uniforms[key];
        }

        const previousTarget = this._renderer.getRenderTarget();
        try {
            this._renderer.setRenderTarget(this._renderTarget);
            this._renderer.render(this._scene, this._camera);

            const pack = this._ensurePack();
            if (pack) {
                try {
                    const gl = pack.gl;
                    pack.begin(0, 0, w, h, gl.RGBA, gl.FLOAT);
                    return true;
                } catch {
                    this._asyncDisabled = true;
                    this._pack?.dispose?.();
                    this._pack = null;
                }
            }

            withPixelPackBufferUnbound(this._renderer, () => {
                this._renderer.readRenderTargetPixels(
                    this._renderTarget,
                    0,
                    0,
                    w,
                    h,
                    this._pixelBuffer,
                );
            });
            for (const listener of this.listeners) listener(this._pixelBuffer);
            return true;
        } finally {
            this._renderer.setRenderTarget(previousTarget);
        }
    }

    /**
     * Get the texture containing the shader output, useful for debug quads.
     */
    getTexture() {
        return this._renderTarget ? this._renderTarget.texture : null;
    }


    setupTextureInScene(scene, position={x:0, y:0, z:0}, size=1) {
        const texture = this.getTexture();
        if (!texture) return;

        const mat = new THREE.MeshBasicMaterial({ map: texture });
        const geo = new THREE.PlaneGeometry(this.size.w * size, this.size.h * size);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(position.x, position.y, position.z);
        scene.add(mesh);
        return mesh;
    }

    dispose() {
        this._renderTarget?.dispose?.();
        this._quad?.geometry?.dispose?.();
        this._mat?.dispose?.();
        this._quad?.removeFromParent?.();

        this._scene = null;
        this._camera = null;
        this._mat = null;
        this._quad = null;
        this._renderTarget = null;
        this._renderer = null;
        this._pixelBuffer = null;
        this._pack?.dispose?.();
        this._pack = null;
        this._asyncDisabled = false;
        this._inPass = false;
        this.listeners = [];
    }
}
