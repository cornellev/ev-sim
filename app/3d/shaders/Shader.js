import * as THREE from 'three';
import { withPixelPackBufferUnbound } from '../util/glReadback.js';

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
        this._busy = false;
        this._pixelBuffer = null;

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

        this._pixelBuffer = new Float32Array(4 * w * h);

        this._scene = scene2;
        this._camera = cam2;
        this._mat = mat;
        this._quad = quad;
        this._renderTarget = rt;
    }

    /**
     * Perform one shader pass, update uniforms, render to the
     * internal render target and notify listeners with the pixel data.
     * Call this once per frame from your render loop.
     * @param {Object} uniforms THREE-style uniform descriptors, e.g. { foo: { value: ... } }
     */
    update(uniforms = {}) {
        if (!this._mat || !this._renderer || !this._renderTarget || this._busy) return;

        // console.log(uniforms)

        this._busy = true;

        const { w, h } = this.size;

        // update time uniform
        const currentTime = Date.now();
        if (this._mat.uniforms.u_time) {
            this._mat.uniforms.u_time.value = (currentTime - this.startTime) / 1000;
        }

        // update custom uniforms: assign full descriptors, same as in R3F code
        // (mat.uniforms[key] = uniforms[key])
        for (const key in uniforms) {
            this._mat.uniforms[key] = uniforms[key];
        }

        // render to offscreen target
        this._renderer.setRenderTarget(this._renderTarget);
        this._renderer.render(this._scene, this._camera);
        this._renderer.setRenderTarget(null);

        // read back pixels (synchronously in three.js). Unbind any PIXEL_PACK
        // buffer first: Spark's SparkRenderer can leave a PBO bound across
        // frames, which makes this readPixels throw INVALID_OPERATION.
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

        // notify listeners
        for (const listener of this.listeners) {
            listener(this._pixelBuffer);
        }

        this._busy = false;
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
}