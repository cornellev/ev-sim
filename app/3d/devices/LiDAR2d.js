import { MAX_BOXES } from "../data/ObjectDatabase";
import { Box } from "../data/objects/Box";
import { common, Shader, standardVTX } from "../shaders/Shader";
import Device from "./Device";
import * as THREE from "three";

const frag2d = `
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
uniform float u_range;

// box
${new Box().getSDF()}

varying vec2 vUv;

struct Hit {
    bool hit;
    float distance;
};

Hit raycast(float angle) {
    // direction vector in the XY plane
    vec3 dir = vec3(cos(toRadians(angle)), 0.0, sin(toRadians(angle)));
    
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
            b++;
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
    // we'll use vUv to calculate the angle of the ray
    int index = (int(gl_FragCoord.x) + int(gl_FragCoord.y) * int(u_resolution.x));
    float angle = u_thetaStart + float(index) * u_thetaStep;
    if (angle > u_thetaEnd) {
        // outside of range
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    Hit hitResult = raycast(angle);
    bool hit = hitResult.hit;
    float totalDistance = hitResult.distance;
    float maxDistance = u_range;

    if (hit) {
        // encode distance as grayscale
        float intensity = 1.0 - (totalDistance / maxDistance);
        gl_FragColor = vec4(vec3(intensity), 1.0);
    } else {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    }

//     gl_FragColor = vec4(u_range / 20.0, 0.0, 0.0, 1.0);
}
`;

export class LiDAR2d extends Device {
    constructor(position, rotation, range=10, thetaStep=1, thetaRange=[0,360]) {
        super("LiDAR 2D", {
            range,
            thetaStep,
            thetaRange
        });

        this.position = position;
        this.rotation = rotation;

        this.thetaStep = thetaStep;
        this.thetaRange = thetaRange;
        this.range = range;

        this.rays = [];
        this.distances = [];

        const points = Math.ceil((thetaRange[1]-thetaRange[0])/thetaStep);

        this.shader = new Shader(
            Math.ceil(Math.sqrt(points)), Math.ceil(Math.sqrt(points)),
            standardVTX,
            frag2d,
            {
                u_origin: { value: this.position },
                u_thetaStart: { value: thetaRange[0] },
                u_thetaEnd: { value: thetaRange[1] },
                u_thetaStep: { value: thetaStep },
                u_range: { value: range },
                boxCount: { value: 0 },
                u_boxPosTex: { value: this._boxPosTexture },
                u_boxScaleTex: { value: this._boxScaleTexture }
            }
        );

        this.shader.onData(this.emitRays.bind(this))

        this.lines = null;
    }

    setup(scene) {
        const geometry = new THREE.CircleGeometry(0.1, 16);
        const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        const circle = new THREE.Mesh(geometry, material);
        circle.position.copy(this.position)
        //circle.rotation.set(this.rotation.x, this.rotation.y, this.rotation.z + Math.PI / 2);
        scene.add(circle);
        this._mesh = circle;
        
        this.shader.setup(this.getParent().getParent().renderer);

        // for debug
        this.shader.setupTextureInScene(scene, { x: 0, y: 17, z: 0}, 1);
        
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
        for (let i = this.thetaRange[0]; i <= this.thetaRange[1]; i += this.thetaStep) {
            const line = createLine(
                new THREE.Vector3(0.0, 0.0, 0.0),
                new THREE.Vector3(
                    this.range * Math.cos(THREE.MathUtils.degToRad(i)),
                    0.0,
                    this.range * Math.sin(THREE.MathUtils.degToRad(i))
                ),
                mat
            );
            lineGroup.add(line);
        }

        lineGroup.position.copy(this.position);

        scene.add(lineGroup);
        this.lines = lineGroup;
    }

    execute() {
        const { posTexture, scaleTexture, count } = this.getParent().getParent().objects().t_boxes();

        //console.log(boxScaleTexture);

        // update box scale texture
        // posTexture.needsUpdate = true;

        this.shader.update({
            u_origin: { value: this.position },
            boxCount: { value: count },
            u_boxPosTex: { value: posTexture },
            u_boxScaleTex: { value: scaleTexture },
        })
    }

    emitRays(buffer) {
        const scene = this.getParent().getParent().scene;
        const thetaStart = this.settings.thetaRange[0];
        const thetaStep = this.settings.thetaStep;
        const points = Math.ceil((this.settings.thetaRange[1]-this.settings.thetaRange[0])/this.settings.thetaStep);

        if (!this.lines) return;
        
        this.lines.position.copy(this.position);
        
        for (let i = 0; i < buffer.length; i += 4) {
            // buffer[i] contains the grayscale intensity where
            // intensity = 1.0 - (distance / range)
            // so distance = (1.0 - intensity) * range
            const intensity = buffer[i];
            const dist = (1.0 - intensity) * this.settings.range;
            const index = i / 4;
            const angle = thetaStart + index * thetaStep;

            if (angle > this.settings.thetaRange[1]) {
                break;
            }

            this.distances[index] = dist ;
            

            // update line geometry
            const line = this.lines.children[index];
            const positions = line.geometry.attributes.position.array;
            positions[3] = (dist > 0.0 ? dist : this.settings.range) * Math.cos(THREE.MathUtils.degToRad(angle));
            positions[4] = 0.0;
            positions[5] = (dist > 0.0 ? dist : this.settings.range) * Math.sin(THREE.MathUtils.degToRad(angle));
            line.geometry.attributes.position.needsUpdate = true;
        }

        // console.log(this.distances)
    }
}
