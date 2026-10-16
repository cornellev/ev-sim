import * as THREE from "three";
import { standardVTX } from "../shaders/Shader.js";
import { lidarViewportDisplayRange, lidarViewportFraming } from "./lidarViewportFraming.js";

const displayFragment = `
precision highp float;
uniform sampler2D u_hits;
uniform float u_displayRange;
varying vec2 vUv;

void main() {
    vec4 hit = texture2D(u_hits, vUv);
    if (hit.r <= 0.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }
    float span = max(u_displayRange, 1e-3);
    float t = clamp(log(1.0 + hit.r) / log(1.0 + span), 0.0, 1.0);
    // A small floor keeps the farthest hit distinct from a miss.
    float shade = max(1.0 - t, 0.04);
    gl_FragColor = vec4(shade, shade, shade, 1.0);
}
`;

function quad(material) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    return mesh;
}

/**
 * Presents the analytic LiDAR shader from the viewport camera.
 * Sensor products keep using Shader.update(); this pass does not read pixels back.
 */
export class LidarViewportPreview {
    /**
     * @param {{ objects?: Function, simulation?: Function }} data
     */
    constructor(data) {
        this.data = data;
        this.enabled = false;
        this._width = 0;
        this._height = 0;
        this._frag3d = null;
        this._shaderRequest = null;
        this._savedClear = new THREE.Color();
        this._hitTarget = null;
        this._hitScene = null;
        this._hitCamera = null;
        this._hitMaterial = null;
        this._hitQuad = null;
        this._displayScene = null;
        this._displayCamera = null;
        this._displayMaterial = null;
        this._displayQuad = null;
    }

    /**
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        this.enabled = enabled === true;
        if (this.enabled) this._ensureShader();
    }

    /**
     * @param {THREE.WebGLRenderer} renderer
     * @param {THREE.PerspectiveCamera} camera
     * @returns {boolean}
     */
    render(renderer, camera) {
        if (!this.enabled || !renderer || !camera) return false;
        if (!this._frag3d) {
            this._ensureShader();
            this._presentBlack(renderer);
            return true;
        }

        const framing = lidarViewportFraming(camera);
        const database = this.data?.objects?.();
        const boxes = database?.t_boxes?.();
        const triangles = database?.t_triangles?.();
        const spheres = database?.t_spheres?.() ?? { posTexture: null, tagTexture: null, count: 0 };
        if (!boxes?.posTexture || !triangles?.posTexture) {
            this._presentBlack(renderer);
            return true;
        }

        this._ensurePass(framing.width, framing.height);
        this._upload(framing, boxes, triangles, spheres);
        this._draw(renderer, () => {
            renderer.setClearColor(0x000000, 0);
            renderer.setRenderTarget(this._hitTarget);
            renderer.clear();
            renderer.render(this._hitScene, this._hitCamera);
            renderer.setClearColor(0x000000, 1);
            renderer.setRenderTarget(null);
            renderer.render(this._displayScene, this._displayCamera);
        });
        return true;
    }

    dispose() {
        this.enabled = false;
        this._hitTarget?.dispose();
        this._hitMaterial?.dispose();
        this._displayMaterial?.dispose();
        this._hitQuad?.geometry?.dispose();
        this._displayQuad?.geometry?.dispose();
        this._hitTarget = null;
        this._hitScene = null;
        this._hitCamera = null;
        this._hitMaterial = null;
        this._hitQuad = null;
        this._displayScene = null;
        this._displayCamera = null;
        this._displayMaterial = null;
        this._displayQuad = null;
        this._width = 0;
        this._height = 0;
    }

    _ensureShader() {
        if (this._frag3d || this._shaderRequest) return;
        this._shaderRequest = import("../shaders/Lidar3dShader.js")
            .then((mod) => {
                this._frag3d = mod.frag3d;
                this._shaderRequest = null;
                if (this.enabled) this.data?.simulation?.()?.render?.();
            })
            .catch((error) => {
                this._shaderRequest = null;
                console.warn("LiDAR viewport shader failed to load", error);
            });
    }

    _ensurePass(width, height) {
        if (!this._hitScene) {
            this._hitMaterial = new THREE.ShaderMaterial({
                vertexShader: standardVTX,
                fragmentShader: this._frag3d,
                depthTest: false,
                depthWrite: false,
                toneMapped: false,
                uniforms: {
                    u_resolution: { value: new THREE.Vector2(width, height) },
                    u_time: { value: 0 },
                    u_origin: { value: new THREE.Vector3() },
                    u_thetaStart: { value: 0 },
                    u_thetaEnd: { value: 0 },
                    u_thetaStep: { value: 1 },
                    u_phiStart: { value: 0 },
                    u_phiEnd: { value: 0 },
                    u_phiStep: { value: 1 },
                    u_range: { value: 1 },
                    boxCount: { value: 0 },
                    triCount: { value: 0 },
                    u_boxPosTex: { value: null },
                    u_boxScaleTex: { value: null },
                    u_boxTagTex: { value: null },
                    u_triPosTex: { value: null },
                    u_triTagTex: { value: null },
                    sphereCount: { value: 0 },
                    u_spherePosTex: { value: null },
                    u_sphereTagTex: { value: null },
                    u_sensorRotation: { value: new THREE.Matrix3() },
                    u_excludedInstanceId: { value: 0 },
                    u_pinhole: { value: 1 },
                },
            });
            this._hitScene = new THREE.Scene();
            this._hitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            this._hitQuad = quad(this._hitMaterial);
            this._hitScene.add(this._hitQuad);

            this._displayMaterial = new THREE.ShaderMaterial({
                vertexShader: standardVTX,
                fragmentShader: displayFragment,
                depthTest: false,
                depthWrite: false,
                toneMapped: false,
                uniforms: {
                    u_hits: { value: null },
                    u_displayRange: { value: 200 },
                },
            });
            this._displayScene = new THREE.Scene();
            this._displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            this._displayQuad = quad(this._displayMaterial);
            this._displayScene.add(this._displayQuad);
        }

        if (!this._hitTarget || this._width !== width || this._height !== height) {
            this._hitTarget?.dispose();
            this._hitTarget = new THREE.WebGLRenderTarget(width, height, {
                type: THREE.FloatType,
                format: THREE.RGBAFormat,
                depthBuffer: false,
                stencilBuffer: false,
                magFilter: THREE.NearestFilter,
                minFilter: THREE.NearestFilter,
                generateMipmaps: false,
            });
            const texture = this._hitTarget.texture;
            texture.minFilter = THREE.NearestFilter;
            texture.magFilter = THREE.NearestFilter;
            texture.generateMipmaps = false;
            texture.colorSpace = THREE.NoColorSpace;
            this._width = width;
            this._height = height;
            this._hitMaterial.uniforms.u_resolution.value.set(width, height);
            this._displayMaterial.uniforms.u_hits.value = texture;
        }
    }

    _upload(framing, boxes, triangles, spheres = { posTexture: null, tagTexture: null, count: 0 }) {
        const uniforms = this._hitMaterial.uniforms;
        uniforms.u_origin.value.copy(framing.origin);
        uniforms.u_sensorRotation.value.copy(framing.sensorRotation);
        uniforms.u_thetaStart.value = framing.thetaRange[0];
        uniforms.u_thetaEnd.value = framing.thetaRange[1];
        uniforms.u_phiStart.value = framing.phiRange[0];
        uniforms.u_phiEnd.value = framing.phiRange[1];
        uniforms.u_range.value = framing.range;
        uniforms.u_pinhole.value = 1;
        uniforms.boxCount.value = boxes.count ?? 0;
        uniforms.triCount.value = triangles.count ?? 0;
        uniforms.u_boxPosTex.value = boxes.posTexture;
        uniforms.u_boxScaleTex.value = boxes.scaleTexture;
        uniforms.u_boxTagTex.value = boxes.tagTexture;
        uniforms.u_triPosTex.value = triangles.posTexture;
        uniforms.u_triTagTex.value = triangles.tagTexture;
        uniforms.sphereCount.value = spheres.count ?? 0;
        uniforms.u_spherePosTex.value = spheres.posTexture;
        uniforms.u_sphereTagTex.value = spheres.tagTexture;
        uniforms.u_excludedInstanceId.value = 0;
        this._displayMaterial.uniforms.u_displayRange.value = lidarViewportDisplayRange(framing.range);
    }

    _presentBlack(renderer) {
        this._draw(renderer, () => {
            renderer.setClearColor(0x000000, 1);
            renderer.setRenderTarget(null);
            renderer.clear();
        });
    }

    _draw(renderer, body) {
        const previousTarget = renderer.getRenderTarget();
        const previousAutoClear = renderer.autoClear;
        renderer.getClearColor(this._savedClear);
        const previousAlpha = renderer.getClearAlpha();
        try {
            renderer.autoClear = true;
            body();
        } finally {
            renderer.setRenderTarget(previousTarget);
            renderer.setClearColor(this._savedClear, previousAlpha);
            renderer.autoClear = previousAutoClear;
        }
    }
}
