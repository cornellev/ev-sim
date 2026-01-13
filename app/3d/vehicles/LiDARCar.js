import * as THREE from "three";
import { useEffect, useState } from "react";
import { Box } from "../objects/Box";
import { Point3D } from "../objects/Object";
import { Shader } from "../Shaders";



export class SharedLidarState {
    constructor() {
        this.objects = [];
        this.origin = new Point3D(1, 0, 0);
    }

    boxes() {
        return this.objects.filter(obj => obj.getType() === "Box");
    }
}


export function LiDARCar({ objs }) {
    const [lidarState, setLidarState] = useState(new SharedLidarState());

    useEffect(() => {
        const lidarState = new SharedLidarState();
        lidarState.objects = objs;
        console.log("LiDARCar registered objects:", objs);
        setLidarState(lidarState);
    }, [objs])

    return (
        <>
        <LidarCalculator lidarState={lidarState} />
        <mesh position={lidarState.origin.toArray()}>
            <sphereGeometry args={[0.05, 16, 16]} />
            <meshStandardMaterial color="yellow" />
        </mesh>
        </>
    )
}

const MAX_BOXES = 10;

const frag = `
precision highp float;

// box struct
${Box.getGLSLStruct()}

// box array
#define MAX_BOXES ${MAX_BOXES}
uniform Box boxes[MAX_BOXES];
uniform int boxCount;

uniform vec3 u_origin;

uniform float u_time;

// box
${Box.getSDF()}

varying vec2 vUv;

void main() {
    // we'll create a grid around the origin and check if it's inside any box
    // grid size is from -10 to 10 in x and z
    float gridSize = 10.0;
    float spacing = 20.0 / 256.0; // assuming 256x256 texture
    
    vec3 point = vec3(
        u_origin.x + (vUv.x - 0.5) * spacing * 256.0,
        u_origin.y,
        u_origin.z + (vUv.y - 0.5) * spacing * 256.0
    );

    float minDist = 10000.0;
    for (int i = 0; i < MAX_BOXES; i++) {
        if (i >= boxCount) break;
        float dist = sdBox(point, boxes[i]);
        if (dist < minDist) {
            minDist = dist;
        }
    }

    // if minDist is less than a threshold, color it white, else black
    if (minDist < 0.0) {
        gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
    } else {
        gl_FragColor = vec4((10.0 - minDist) / 20.0, 0.0, 0.0, 1.0);
    }

    //gl_FragColor = vec4(boxes[2].position.x / 4.0, 1.0, 1.0, 1.0);
}
`;

export function LidarCalculator({ lidarState }) {
    const w = 256, h = 256;

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
                
                
            }}
        />
    )
}
