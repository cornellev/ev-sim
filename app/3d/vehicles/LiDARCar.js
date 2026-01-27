import * as THREE from "three";
import { useEffect, useState } from "react";
import { Box } from "../objects/Box";
import { Point3D } from "../objects/Object";
import { common, Shader, ShaderMesh } from "../Shaders";



export class SharedLidarState {
    constructor() {
        this.objects = [];
        this.origin = new Point3D(4, 0, 4);
        this.distances = [];
    }

    boxes() {
        return this.objects.filter(obj => obj.getType() === "Box");
    }
}


export function LiDARCar({ objs }) {
    const [lidarState, setLidarState] = useState(new SharedLidarState());
    const [distances, setDistances] = useState([]);

    useEffect(() => {
        const newLidarState = new SharedLidarState();
        newLidarState.objects = objs;
        newLidarState.origin = lidarState.origin;
        newLidarState.distances = lidarState.distances;
        console.log("LiDARCar registered objects:", objs);
        setLidarState(newLidarState);
    }, [objs])

    const checkAndUpdateDistances = (newDistances) => {
        let changed = false;
        if (newDistances.length !== lidarState.distances.length) {
            changed = true;
        } else {
            for (let i = 0; i < newDistances.length; i++) {
                if (newDistances[i] !== lidarState.distances[i]) {
                    changed = true;
                    break;
                }
            }
        }

        if (changed) {
            setDistances(newDistances);
        }
    }

    return (
        <>
        <LidarCalculator lidarState={lidarState} onDistancesUpdate={checkAndUpdateDistances} />
        {/* <LiDARTest3D lidarState={lidarState} /> */}
        <mesh position={lidarState.origin.toArray()}>
            <sphereGeometry args={[0.05, 16, 16]} />
            <meshStandardMaterial color="yellow" />
        </mesh>
        <mesh>
        {/* <LidarDisplay distances={distances} origin={lidarState.origin} /> */}
        </mesh>
        </>
    )
}

export function LidarDisplay({ distances, origin }) {
    // we'll create lines from the origin to the points at the distances
    return (
        <group>
        {distances.map((distance, index) => {
            if (distance > 19.9) return null; // skip max distance points

            const per = 360.0 / distances.length;
            const angle = per * index;
            const dir = new THREE.Vector3(Math.cos(THREE.MathUtils.degToRad(angle)), 0, Math.sin(THREE.MathUtils.degToRad(angle)));
            const endPoint = new THREE.Vector3().addVectors(origin.toVector3(), dir.multiplyScalar(distance));
            const geometry = new THREE.BufferGeometry().setFromPoints([origin.toVector3(), endPoint]);
            return (
                <line key={index} geometry={geometry}>
                    <lineBasicMaterial color="red" />
                </line>
            )
        })}
        </group>
    )
}

export function LiDAR3DCar({ objs }) {
    const [lidarState, setLidarState] = useState(new SharedLidarState());
    const lidarSpecs = Lidar3DSpecifications.SparseTest;
    const [distances, setDistances] = useState([]);
    
    useEffect(() => {
        const newLidarState = new SharedLidarState();
        newLidarState.objects = objs;
        newLidarState.origin = lidarState.origin;
        newLidarState.distances = lidarState.distances;
        console.log("LiDAR3DCar registered objects:", objs);
        setLidarState(newLidarState);
    }, [objs])
    
    const checkAndUpdateDistances = (newDistances) => {
        let changed = false;
        if (newDistances.length !== lidarState.distances.length) {
            changed = true;
        } else {
            for (let i = 0; i < newDistances.length; i++) {
                if (newDistances[i] !== lidarState.distances[i]) {
                    changed = true;
                    break;
                }
            }
        }

        if (changed) {
            //console.log(newDistances.length)
            setDistances(newDistances);
        }
    }

    return (
        <>
        <LidarCalculator3D lidarState={lidarState} onDistancesUpdate={checkAndUpdateDistances} lidarSpecs={lidarSpecs} />
        <mesh position={lidarState.origin.toArray()}>
            <sphereGeometry args={[0.05, 16, 16]} />
            <meshStandardMaterial color="yellow" />
        </mesh>
        <mesh>
        <Lidar3DDisplay distances={distances} origin={lidarState.origin} lidarSpecs={lidarSpecs} />
        </mesh>
        </>
    )
}

export function Lidar3DDisplay({ distances, origin, lidarSpecs=new Lidar3DSpecifications() }) {
    // we'll create lines from the origin to the points at the distances
    return (
        <group>
        {distances.map((distance, index) => {
            // console.log("Distance", index, distance);
            if (distance > 19.9) return null; // skip max distance points
            if (distance == 0) return null; // skip zero distance points

            const theta = index % Math.ceil(360.0 / lidarSpecs.thetaStep) * lidarSpecs.thetaStep + 180.0;
            const phi = Math.floor(index / Math.ceil(360.0 / lidarSpecs.thetaStep)) * lidarSpecs.phiStep - (lidarSpecs.fov / 2); // center around 0

            const thetaRad = THREE.MathUtils.degToRad(theta);
            const phiRad = THREE.MathUtils.degToRad(phi);

            const dir = new THREE.Vector3(
                Math.cos(phiRad) * Math.cos(thetaRad),
                Math.sin(phiRad),
                Math.cos(phiRad) * Math.sin(thetaRad)
            );
            
            const endPoint = new THREE.Vector3().addVectors(origin.toVector3(), dir.multiplyScalar(distance));
            const geometry = new THREE.BufferGeometry().setFromPoints([origin.toVector3(), endPoint]);
            return (
                <line key={index} geometry={geometry}>
                    <lineBasicMaterial color="red" />
                </line>
            )
        })}
        </group>
    )
}


const MAX_BOXES = 10;

const frag = `
precision highp float;

// common defs
${common()}

// box struct
${Box.getGLSLStruct()}

// box array
#define MAX_BOXES ${MAX_BOXES}
uniform Box boxes[MAX_BOXES];
uniform int boxCount;

uniform vec3 u_origin;

uniform float u_time;
uniform vec2 u_resolution;

// box
${Box.getSDF()}

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
    float maxDistance = 20.0;
    float hitThreshold = 0.01;
    bool hit = false;
    
    for (int i = 0; i < 256; i++) {
        vec3 currentPos = u_origin + dir * totalDistance;
        
        // find the minimum distance to any box
        float minDist = 10000.0;
        for (int j = 0; j < MAX_BOXES; j++) {
            if (j >= boxCount) break;
            float dist = sdBox(currentPos, boxes[j]);
            if (dist < minDist) {
                minDist = dist;
            }
        }
        
        if (minDist < hitThreshold) {
            hit = true;
            break;
        }
        
        totalDistance += minDist / 1.5;
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
    float per = 360.0 / (u_resolution.x * u_resolution.y);
    // gl_FragCoord is at pixel centers (e.g. 0.5, 1.5, ...). Convert to integer pixel indices
    // so the first pixel maps to angle 0.
    vec2 pixel = floor(gl_FragCoord.xy);
    float angle = per * (pixel.x + pixel.y * u_resolution.x);

    Hit hitResult = raycast(angle);
    bool hit = hitResult.hit;
    float totalDistance = hitResult.distance;
    float maxDistance = 20.0;

    if (hit) {
        // encode distance as grayscale
        float intensity = 1.0 - (totalDistance / maxDistance);
        gl_FragColor = vec4(vec3(intensity), 1.0);
    } else {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    }

    //gl_FragColor = vec4(angle / 360.0, 0.0, 0.0, 1.0);
}
`;

const frag3d = `
precision highp float;

// common defs
${common()}

// box struct
${Box.getGLSLStruct()}

// box array
#define MAX_BOXES ${MAX_BOXES}
uniform Box boxes[MAX_BOXES];
uniform int boxCount;

uniform vec3 u_origin;

uniform float u_time;
uniform vec2 u_resolution;

uniform float fov;
uniform float thetaStep;
uniform float phiStep;

// box
${Box.getSDF()}

varying vec2 vUv;

void main() {
    vec2 pixel = gl_FragCoord.xy; // vec2(floor(gl_FragCoord.x * u_resolution.x), floor(gl_FragCoord.y * u_resolution.y));
    int i = int(pixel.x + (pixel.y * u_resolution.x));
    
    float theta = floatMod((float(i) * thetaStep), 360.0);
    float phi = ((float(i) * thetaStep) / 360.0) * phiStep - (fov / 2.0);

    float thetaRad = toRadians(theta);
    float phiRad = toRadians(phi);

    // direction vector in 3D
    vec3 dir = vec3(
        cos(phiRad) * cos(thetaRad),
        sin(phiRad),
        cos(phiRad) * sin(thetaRad)
    );

    // march the ray
    float totalDistance = 0.0;
    float maxDistance = 20.0;
    float hitThreshold = 0.01;
    bool hit = false;
    
    for (int i = 0; i < 256; i++) {
        vec3 currentPos = u_origin + dir * totalDistance;
        
        // find the minimum distance to any box
        float minDist = 10000.0;
        for (int j = 0; j < MAX_BOXES; j++) {
            if (j >= boxCount) break;
            float dist = sdBox(currentPos, boxes[j]);
            if (dist < minDist) {
                minDist = dist;
            }
        }
        
        if (minDist < hitThreshold) {
            hit = true;
            break;
        }
        
        totalDistance += minDist / 1.5;
        if (totalDistance > maxDistance) {
            break;
        }
    }

    if (hit) {
        //TODO: do three casts for RGB and encode more info
        // encode distance as grayscale
        float intensity = 1.0 - (totalDistance / maxDistance);
        gl_FragColor = vec4(vec3(intensity), 1.0);
    } else {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        //gl_FragColor = vec4(float(phi) / (fov / 2.0), 0.0, 0.0, 1.0);
    }
}
`;

export function LidarCalculator({ lidarState, onDistancesUpdate }) {
    const w = 32, h = 32;

    useEffect(() => {
        console.log("LiDARCar using boxes:", lidarState.boxes());
        console.log(new Array(MAX_BOXES).fill(0).map((_, i) => {
            return lidarState.boxes()[i] ? lidarState.boxes()[i].toGLSLObject() : {
                position: new THREE.Vector3(0, 0, 0),
                size: new THREE.Vector3(0, 0, 0)
            }
        }))

    }, [lidarState]);

    return (
        <Shader 
            frag={frag}
            w={w} 
            h={h}
            debug={false}
            uniforms={{ 
                u_origin: {
                    value: lidarState.origin.toArray()
                },
                boxCount: {
                    value: lidarState.boxes().length
                },
                boxes: {
                    value: new Array(MAX_BOXES).fill(0).map((_, i) => {
                        return lidarState.boxes()[i] ? lidarState.boxes()[i].toGLSLObject() : {
                            position: new THREE.Vector3(0, 0, 0),
                            size: new THREE.Vector3(0, 0, 0)
                        }
                    })
                }
            }}
            onData={(data) => {
                // create texture from data
                const distances = [];
                for (let i = 0; i < w * h; i++) {
                    // convert vec3 -> float
                    const c1 = data[i * 4];
                    // alpha is ignored
                    // const a = data[i * 4 + 3];

                    // reconstruct distance
                    const intensity = c1; // assuming grayscale, so r=g=b
                    const maxDistance = 20.0;
                    const distance = (1.0 - intensity) * maxDistance;
                    distances.push(distance);
                }
                if (onDistancesUpdate) {
                    onDistancesUpdate(distances);
                }
            }}
        />
    )
}

class Lidar3DSpecifications {
    static Helios32 = new Lidar3DSpecifications(26, 0.5, 0.1);
    static SparseTest = new Lidar3DSpecifications(30, 5, 2);
    constructor(fov=30, thetaStep=1, phiStep=1) {
        this.fov = fov;
        this.thetaStep = thetaStep;
        this.phiStep = phiStep;
    }
}

export function LidarCalculator3D({ lidarState, onDistancesUpdate, lidarSpecs=new Lidar3DSpecifications() }) {
    const w = Math.ceil(360.0 / lidarSpecs.thetaStep);
    const h = Math.ceil(lidarSpecs.fov / lidarSpecs.phiStep);
    useEffect(() => {
        // console.log("LiDARCar using boxes:", lidarState.boxes());
        // console.log(new Array(MAX_BOXES).fill(0).map((_, i) => {
        //     return lidarState.boxes()[i] ? lidarState.boxes()[i].toGLSLObject() : {
        //         position: new THREE.Vector3(0, 0, 0),
        //         size: new THREE.Vector3(0, 0, 0)
        //     }
        // }))
    }, [lidarState]);

    return (
        <Shader 
            frag={frag3d}
            w={w} 
            h={h}
            debug={false}
            uniforms={{
                u_origin: {
                    value: lidarState.origin.toArray()
                },
                boxCount: {
                    value: lidarState.boxes().length
                },
                boxes: {
                    value: new Array(MAX_BOXES).fill(0).map((_, i) => {
                        return lidarState.boxes()[i] ? lidarState.boxes()[i].toGLSLObject() : {
                            position: new THREE.Vector3(0, 0, 0),
                            size: new THREE.Vector3(0, 0, 0)
                        }
                    })
                },
                fov: {
                    value: lidarSpecs.fov
                },
                thetaStep: {
                    value: lidarSpecs.thetaStep
                },
                phiStep: {
                    value: lidarSpecs.phiStep
                }
            }}
            onData={(data) => {
                // create texture from data
                const distances = [];
                for (let i = 0; i < w * h; i++) {
                    // convert vec3 -> float
                    const c1 = data[i * 4];
                    // alpha is ignored
                    // const a = data[i * 4 + 3];

                    // reconstruct distance
                    const intensity = c1; // assuming grayscale, so r=g=b
                    const maxDistance = 20.0;
                    const distance = (1.0 - intensity) * maxDistance;
                    distances.push(distance);
                }
                if (onDistancesUpdate) {
                    onDistancesUpdate(distances);
                }
            }}
        />
    )
}