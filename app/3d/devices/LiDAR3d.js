import { Shader, standardVTX } from "../shaders/Shader";
import Device from "./Device";
import { parseLidarHits } from "./LidarHitDecoder";
import { frag3d } from "../shaders/Lidar3dShader";
import * as THREE from "three";

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
                u_boxTagTex: { value: null },
                u_triPosTex: { value: null },
                u_triTagTex: { value: null },
                u_sensorRotation: { value: new THREE.Matrix3() },
            }
        );

        this.shader.onData(this.onShaderUpdate.bind(this));

        this.lines = null;

        this.tags = ["distance", "pointcloud"];

        this.debug = false;

        this.buff = null;
        this.distances = [];
        this.hits = [];
    }

    onParentUpdate() {
        const worldPosition = this.getPosition();
        const worldRotation = this.getRotation();

        this.pointsGroup.position.copy(worldPosition);
        this.pointsGroup.rotation.copy(worldRotation);

        if (this.lines) {
            this.lines.position.copy(worldPosition);
            this.lines.rotation.copy(worldRotation);
        }
    }

    setup(scene) {
        const geometry = new THREE.SphereGeometry(0.1, 8, 8);
        const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        this.pointsGroup = new THREE.Group();
        this.pointsGroup.position.copy(this.getPosition());
        this.pointsGroup.rotation.copy(this.getRotation());
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
        lineGroup.rotation.copy(this.getRotation());

        scene.add(lineGroup);
        this.lines = lineGroup;
    }

    execute() {
        const { posTexture, scaleTexture, tagTexture: boxTagTexture, count } = this.getParent().getParent().objects().t_boxes();
        const { posTexture: triPosTexture, tagTexture: triTagTexture, count: triCount } = this.getParent().getParent().objects().t_triangles();

        const sensorRotationMatrix = new THREE.Matrix3().setFromMatrix4(
            new THREE.Matrix4().makeRotationFromEuler(this.getRotation())
        );

        this.shader.update({
            u_origin: { value: this.getPosition() },
            u_sensorRotation: { value: sensorRotationMatrix },
            boxCount: { value: count },
            u_boxPosTex: { value: posTexture },
            u_boxScaleTex: { value: scaleTexture },
            u_boxTagTex: { value: boxTagTexture },
            triCount: { value: triCount },
            u_triPosTex: { value: triPosTexture },
            u_triTagTex: { value: triTagTexture },
        })
    }

    onShaderUpdate(buffer) {
        this.buff = buffer;
        this.emitRays(buffer);
    }

    parseDistances() {
        if (!this.buff) return;
        
        this.distances = [];
        this.hits = parseLidarHits(this.buff, this.settings.range);
        for (const hit of this.hits) {
            this.distances.push(hit.distance);
        }
    }

    calculateRayAngle(index) {
        const thetaCount = Math.ceil((this.settings.theta.range[1] - this.settings.theta.range[0]) / this.settings.theta.step);
        const thetaIndex = index % thetaCount;
        const phiIndex = Math.floor(index / thetaCount);
        
        const theta = this.settings.theta.range[0] + thetaIndex * this.settings.theta.step;
        const phi = this.settings.phi.range[0] + phiIndex * this.settings.phi.step;

        return {
            theta: THREE.MathUtils.degToRad(theta), 
            phi: THREE.MathUtils.degToRad(phi),
            outOfRange: theta > this.settings.theta.range[1] || phi > this.settings.phi.range[1] 
        };
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