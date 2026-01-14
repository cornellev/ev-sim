import * as THREE from "three";
import { useFBO } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";


import { LidarCalculator } from "./vehicles/LiDARCar";

const vtx = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export function common() {
    return `
    // common GLSL definitions
    #define PI 3.1415926

    // common GLSL functions
    float toRadians(float degrees) {
        return degrees * (PI / 180.0);
    }
        
    float toDegrees(float radians) {
        return radians * (180.0 / PI);
    }
    `
}

/**
 * Component that sets up a shader to render to a texture and read back the data.
 * @param {number} w - Width of the render target.
 * @param {number} h - Height of the render target.
 * @param {function} onData - Callback function to receive the pixel data.
 * @param {string} frag - Fragment shader code.
 * @param {object} uniforms - Uniforms to pass to the shader. (u_time and u_resolution are provided automatically)
 */
export function Shader({w, h, onData, frag, uniforms, debug=false}) {
    const { gl } = useThree();

    const rt = useFBO(w, h, {
        type: THREE.FloatType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        stencilBuffer: false,
    });

    const scene = useMemo(() => new THREE.Scene(), []);
    const camera = useMemo(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), []);
    const mat = useMemo(
        () => 
            new THREE.ShaderMaterial({
                vertexShader: vtx,
                fragmentShader: frag,
                uniforms: Object.assign({
                    u_resolution: { value: new THREE.Vector2(w, h) },
                    u_time: { value: 0 },
                }, uniforms),
            })
    );

    const quad = useMemo(() => new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat), [mat]);

    const busy = useRef(false);

    useMemo(() => {
        scene.add(quad);
    }, [scene, quad]);

    useEffect(() => {
        Object.keys(uniforms).forEach((key) => {
            mat.uniforms[key] = uniforms[key];
        });
    }, [uniforms])

    useFrame(async ({ clock }) => {
        if (busy.current) return;
        busy.current = true;

        mat.uniforms.u_time.value = clock.elapsedTime;

        gl.setRenderTarget(rt);
        gl.render(scene, camera);
        gl.setRenderTarget(null);

//        console.log(mat.uniforms);

        const pixelBuffer = new Float32Array(4 * w * h);
        const buff = await gl.readRenderTargetPixelsAsync(rt, 0, 0, w, h, pixelBuffer);
        onData(buff)

        busy.current = false;
    })

    return (
        <>
        { debug && (
            <mesh>
                <planeGeometry args={[2, 2]} />
                <meshBasicMaterial map={rt.texture} toneMapped={false} />
            </mesh>
        )}
        </>
    );
}

export function Shaders() {
    return (
        <>
            {/* <LidarCalculator /> */}
        </>
    );
}