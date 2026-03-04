import { MAX_BOXES, MAX_TRIANGLES } from "../data/ObjectDatabase";
import { Box } from "../data/objects/Box";
import { Triangle } from "../data/objects/Triangle";
import { common, Shader, standardVTX } from "../shaders/Shader";
import Device from "./Device";
import * as THREE from "three";

const frag3d = `
precision highp float;

// common defs
${common()}

// box struct
${new Box().getStruct().toString()}

// triangle struct
${new Triangle().getStruct().toString()}

// box array via data textures
#define MAX_BOXES ${MAX_BOXES}
#define MAX_TRIANGLES ${MAX_TRIANGLES}
uniform sampler2D u_boxPosTex;
uniform sampler2D u_boxScaleTex;
uniform int boxCount;

// every 3 points defines a triangle
uniform sampler2D u_triPosTex;
uniform int triCount;

uniform vec3 u_origin;

uniform float u_time;
uniform vec2 u_resolution;

uniform float u_thetaStart;
uniform float u_thetaEnd;
uniform float u_thetaStep;

uniform float u_phiStart;
uniform float u_phiEnd;
uniform float u_phiStep;

uniform float u_range;

// obx
${new Box().getSDF()}

// triangle (kept for potential future use)
${new Triangle().getSDF()}

// Möller–Trumbore ray-triangle intersection.
// Returns the distance along the ray to the hit, or -1.0 if no intersection.
float rayTriangleIntersect(vec3 orig, vec3 dir, vec3 v0, vec3 v1, vec3 v2) {
    vec3 e1 = v1 - v0;
    vec3 e2 = v2 - v0;
    vec3 h = cross(dir, e2);
    float a = dot(e1, h);
    if (abs(a) < 1e-6) return -1.0; // ray parallel to triangle
    float f = 1.0 / a;
    vec3 s = orig - v0;
    float u = f * dot(s, h);
    if (u < 0.0 || u > 1.0) return -1.0;
    vec3 q = cross(s, e1);
    float v = f * dot(dir, q);
    if (v < 0.0 || u + v > 1.0) return -1.0;
    float t = f * dot(e2, q);
    if (t < 1e-4) return -1.0; // behind origin
    return t;
}

struct Hit {
    bool hit;
    float distance;
};

Hit raycast(float theta, float phi) {
    // direction vector in 3D
    vec3 dir = vec3(
        cos(phi) * cos(theta),
        sin(phi),
        cos(phi) * sin(theta)
    );

    // --- Exact triangle intersections (Möller–Trumbore) ---
    // SDF marching is unreliable for infinitely thin surfaces: a ray at a
    // shallow angle can step over the surface without ever triggering the
    // hit threshold. Analytical intersection has no such problem.
    float triHitDist = -1.0;
    int tb = 0;
    for (int j = 0; j < MAX_TRIANGLES; j++) {
        if (tb >= triCount) break;
        float idx = float(j * 3);
        float texWidth = float(MAX_TRIANGLES * 3);
        vec2 uvA = vec2((idx + 0.5) / texWidth, 0.5);

        if (texture2D(u_triPosTex, uvA).w == 0.0) {
            // skip empty triangle
            continue;
        }

        vec3 va = texture2D(u_triPosTex, uvA).xyz;
        vec3 vb = texture2D(u_triPosTex, vec2((idx + 1.5) / texWidth, 0.5)).xyz;
        vec3 vc = texture2D(u_triPosTex, vec2((idx + 2.5) / texWidth, 0.5)).xyz;

        float t = rayTriangleIntersect(u_origin, dir, va, vb, vc);
        if (t > 0.0 && t < u_range) {
            if (triHitDist < 0.0 || t < triHitDist) {
                triHitDist = t;
            }
        }

        ++tb;
    }

    // --- SDF march for boxes ---
    float totalDistance = 0.0;
    float maxDistance = u_range;
    float hitThreshold = 0.01;
    bool boxHit = false;
    
    for (int i = 0; i < 256; i++) {
        vec3 currentPos = u_origin + dir * totalDistance;
        
        float minDist = 10000.0;
        int bb = 0;
        for (int j = 0; j < MAX_BOXES; j++) {
            if (bb >= boxCount) break;
            float idx = float(j);
            float texWidth = float(MAX_BOXES);
            float uCoord = (idx + 0.5) / texWidth;
            vec2 uv = vec2(uCoord, 0.5);

            if (texture2D(u_boxPosTex, uv).w == 0.0) {
                // skip empty box
                continue;
            }

            Box box;
            box.position = texture2D(u_boxPosTex, uv).xyz;
            box.scale = texture2D(u_boxScaleTex, uv).xyz;

            float dist = sdBox(currentPos, box);
            if (dist < minDist) {
                minDist = dist;
            }

            ++bb;
        }
        
        if (minDist < hitThreshold) {
            boxHit = true;
            break;
        }
        
        totalDistance += minDist * 0.9; // safety factor
        if (totalDistance > maxDistance) {
            break;
        }
    }

    // Return the closer of a box hit or a triangle hit
    Hit result;
    if (boxHit && (triHitDist < 0.0 || totalDistance <= triHitDist)) {
        result.hit = true;
        result.distance = totalDistance;
    } else if (triHitDist > 0.0) {
        result.hit = true;
        result.distance = triHitDist;
    } else {
        result.hit = false;
        result.distance = totalDistance;
    }
    return result;
}

void main() {
    // Map each pixel in the offscreen buffer to a unique
    // (theta, phi) pair. X corresponds to theta index,
    // Y corresponds to phi index.
    int xIndex = int(gl_FragCoord.x);
    int yIndex = int(gl_FragCoord.y);

    float theta = u_thetaStart + float(xIndex) * u_thetaStep;
    float phi   = u_phiStart + float(yIndex) * u_phiStep;

    float thetaRad = toRadians(theta);
    float phiRad   = toRadians(phi);

    Hit hitResult = raycast(thetaRad, phiRad);
    
    if (hitResult.hit) {
        float intensity = 1.0 - (hitResult.distance / u_range);
        gl_FragColor = vec4(vec3(intensity), 1.0);
    } else {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    }
}
`;


export class LiDAR3d extends Device {
    constructor(position, rotation, range=10, thetaStep=1, thetaRange=[0,360], phiStep=1, phiRange=[-20,20]) {
        super("LiDAR 3D", {
            range,
            theta: {
                step: thetaStep,
                range: thetaRange
            },
            phi: {
                step: phiStep,
                range: phiRange
            },
            position,
            rotation
        });
        
        this.range = range;
        this.thetaStep = thetaStep;
        this.thetaRange = thetaRange;
        this.phiStep = phiStep;
        this.phiRange = phiRange;

        this.rays = [];
        
        this.shader = new Shader(
            Math.ceil((thetaRange[1] - thetaRange[0]) / thetaStep),
            Math.ceil((phiRange[1] - phiRange[0]) / phiStep),
            standardVTX,
            frag3d,
            {
                u_origin: { value: position },
                u_thetaStart: { value: thetaRange[0] },
                u_thetaEnd: { value: thetaRange[1] },
                u_thetaStep: { value: thetaStep },
                u_phiStart: { value: phiRange[0] },
                u_phiEnd: { value: phiRange[1] },
                u_phiStep: { value: phiStep },
                u_range: { value: range },
                boxCount: { value: 0 },
                triCount: { value: 0 },
                u_boxPosTex: { value: null },
                u_boxScaleTex: { value: null },
                u_triPosTex: { value: null },
            }
        );

        this.shader.onData(this.emitRays.bind(this));

        this.lines = null;

        this.debug = false;
    }

    onParentUpdate() {
        this.pointsGroup.position.copy(this.getPosition());
        if (this.lines) {
            this.lines.position.copy(this.getPosition());
        }
    }

    setup(scene) {
        const geometry = new THREE.SphereGeometry(0.1, 8, 8);
        const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        this.pointsGroup = new THREE.Group();
        this.pointsGroup.position.copy(this.getPosition());
        this.pointsGroup.add(new THREE.Mesh(geometry, material));
        
        scene.add(this.pointsGroup);

        this.shader.setup(this.getParent().getParent().renderer);

        // this.shader.setupTextureInScene(scene, {
        //     x: 0, y: 20, z: 0
        // }, 1);

        const createLine =(p1, p2, mat) => {
            const points = [];
            points.push(p1);
            points.push(p2);
            const geo = new THREE.BufferGeometry().setFromPoints(points);
            const line = new THREE.Line(geo, mat);
            scene.add(line);
            return line;
        }

        const lineGroup = new THREE.Group();
        const mat = new THREE.LineBasicMaterial({ color: 0xff0000 });

        // Pre-create one line per (theta, phi) pair. Lines are
        // stored row-major: all theta for a given phi, then next phi.
        if (this.debug) {
            for (let j = this.phiRange[0]; j <= this.phiRange[1]; j += this.phiStep) {
                const phiRad = THREE.MathUtils.degToRad(j);
                for (let i = this.thetaRange[0]; i <= this.thetaRange[1]; i += this.thetaStep) {
                    const thetaRad = THREE.MathUtils.degToRad(i);
                    const dir = new THREE.Vector3(
                        Math.cos(phiRad) * Math.cos(thetaRad),
                        Math.sin(phiRad),
                        Math.cos(phiRad) * Math.sin(thetaRad)
                    );

                    const line = createLine(
                        new THREE.Vector3(0.0, 0.0, 0.0),
                        dir.clone().multiplyScalar(this.range),
                        mat
                    );
                    lineGroup.add(line);
                }
            }
        }

        lineGroup.position.copy(this.getPosition());

        scene.add(lineGroup);
        this.lines = lineGroup;
    }

    execute() {
        const { posTexture, scaleTexture, count } = this.getParent().getParent().objects().t_boxes();
        const { posTexture: triPosTexture, count: triCount } = this.getParent().getParent().objects().t_triangles();

        this.shader.update({
            u_origin: { value: this.getPosition() },
            boxCount: { value: count },
            u_boxPosTex: { value: posTexture },
            triCount: { value: triCount },
            u_triPosTex: { value: triPosTexture },
            u_boxScaleTex: { value: scaleTexture },
        })
    }

    emitRays(buffer) {
        if (!this.lines) return;

        this.lines.position.copy(this.getPosition());
        const thetaStart = this.settings.theta.range[0];
        const thetaStep = this.settings.theta.step;
        const phiStart = this.settings.phi.range[0];
        const phiStep = this.settings.phi.step;

        const thetaCount = Math.ceil((this.settings.theta.range[1] - this.settings.theta.range[0]) / this.settings.theta.step);
        const maxLines = this.lines.children.length;

        if (!this.debug) return;

        for (let i = 0; i < buffer.length; i += 4) {
            // buffer[i] contains grayscale intensity (0–255) where
            // intensity = 1.0 - (distance / range)
            // so distance = (1.0 - intensity) * range
            const intensity = buffer[i];
            const dist = (1.0 - intensity) * this.settings.range;
            const index = i / 4;

            if (index >= maxLines) break;

            const thetaIndex = index % thetaCount;
            const phiIndex = Math.floor(index / thetaCount);

            const theta = thetaStart + thetaIndex * thetaStep;
            const phi = phiStart + phiIndex * phiStep;

            if (theta > this.settings.theta.range[1] || phi > this.settings.phi.range[1]) {
                continue;
            }

            const thetaRad = THREE.MathUtils.degToRad(theta);
            const phiRad = THREE.MathUtils.degToRad(phi);

            const radius = dist > 0.0 ? dist : this.settings.range;

            const x = radius * Math.cos(phiRad) * Math.cos(thetaRad);
            const y = radius * Math.sin(phiRad);
            const z = radius * Math.cos(phiRad) * Math.sin(thetaRad);

            const line = this.lines.children[index];
            const positions = line.geometry.attributes.position.array;
            // start at origin of group, end at (x, y, z)
            positions[0] = 0.0;
            positions[1] = 0.0;
            positions[2] = 0.0;
            positions[3] = x;
            positions[4] = y;
            positions[5] = z;
            line.geometry.attributes.position.needsUpdate = true;
        }
    }
        
}