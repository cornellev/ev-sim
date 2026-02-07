import { MAX_BOXES } from "../data/ObjectDatabase";
import { Box } from "../data/objects/Box";
import { common, Shader, standardVTX } from "../shaders/Shader";
import Device from "./Device";
import * as THREE from "three";

const frag3d = `
precision highp float;

// common defs
${common()}

// box struct
${new Box().getStruct().toString()}

// box array via data textures
#define MAX_BOXES ${MAX_BOXES}
uniform sampler2D u_boxPosTex;
uniform sampler2D u_boxScaleTex;
uniform int boxCount;

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

    // march the ray
    float totalDistance = 0.0;
    float maxDistance = u_range;
    float hitThreshold = 0.01;
    bool hit = false;
    
    for (int i = 0; i < 256; i++) {
        vec3 currentPos = u_origin + dir * totalDistance;
        
        // find the minimum distance to any box
        float minDist = 10000.0;
        int b = 0;
        for (int j = 0; j < MAX_BOXES; j++) {
            if (b >= boxCount) break;
            float idx = float(j);
            float texWidth = float(MAX_BOXES);
            float u = (idx + 0.5) / texWidth;
            vec2 uv = vec2(u, 0.5);

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

            ++b;
        }
        
        if (minDist < hitThreshold) {
            hit = true;
            break;
        }
        
        totalDistance += minDist * 0.9; // safety factor
        if (totalDistance > maxDistance) {
            break;
        }
    }

    Hit result;
    result.hit = hit;
    result.distance = totalDistance;
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
        });
        this.position = position;
        this.rotation = rotation;
        
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
                u_origin: { value: this.position },
                u_thetaStart: { value: thetaRange[0] },
                u_thetaEnd: { value: thetaRange[1] },
                u_thetaStep: { value: thetaStep },
                u_phiStart: { value: phiRange[0] },
                u_phiEnd: { value: phiRange[1] },
                u_phiStep: { value: phiStep },
                u_range: { value: range },
                boxCount: { value: 0 },
                u_boxPosTex: { value: null },
                u_boxScaleTex: { value: null },
            }
        );

        this.shader.onData(this.emitRays.bind(this));

        this.lines = null;

        this.debug = false;
    }


    setup(scene) {
        const geometry = new THREE.CircleGeometry(0.1, 16);
        const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        this.pointsGroup = new THREE.Group();
        scene.add(this.pointsGroup);

        this.shader.setup(this.getParent().getParent().renderer);

        this.shader.setupTextureInScene(scene, {
            x: 0, y: 20, z: 0
        }, 1);

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

        lineGroup.position.copy(this.position);

        scene.add(lineGroup);
        this.lines = lineGroup;
    }

    execute() {
        const { posTexture, scaleTexture, count } = this.getParent().getParent().objects().t_boxes();

        this.shader.update({
            u_origin: { value: this.position },
            boxCount: { value: count },
            u_boxPosTex: { value: posTexture },
            u_boxScaleTex: { value: scaleTexture },
        })
    }

    emitRays(buffer) {
        if (!this.lines) return;

        this.lines.position.copy(this.position);
        const thetaStart = this.settings.theta.range[0];
        const thetaStep = this.settings.theta.step;
        const phiStart = this.settings.phi.range[0];
        const phiStep = this.settings.phi.step;

        const thetaCount = Math.ceil((this.settings.theta.range[1] - this.settings.theta.range[0]) / this.settings.theta.step);
        const maxLines = this.lines.children.length;

        if (!this.debug) return;

        for (let i = 0; i < buffer.length; i += 4) {
            // buffer[i] contains grayscale intensity where
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