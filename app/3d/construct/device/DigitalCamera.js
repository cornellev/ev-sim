import { useState } from "react";
import Device from "./Device";
import { Outlines } from "@react-three/drei";
import { useLoader } from "@react-three/fiber";
// import glb loader
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";

export default class DigitalCamera extends Device {
    constructor() {
        super("Digital Camera", {
            resolution: {
                w: 1920,
                h: 1080
            },
            fov: 90
        });
    }

    getMesh({ position, objectRef, selected, onSelected, index }) {
        const raycast = (event) => {
            event.stopPropagation();
            if (onSelected) onSelected(index);
        }

        const gltf = useLoader(GLTFLoader, '/objects/Webcam.glb');

        return (
            <mesh position={[position.x, position.y, position.z]} ref={objectRef} {...(selected && onSelected ? {} : { onClick: raycast })}>
                {/* { selected && <Outlines color={{r: 242, g: 204, b: 36}} transparent={false} thickness={5} /> } */}
                <primitive object={gltf.scene} scale={0.5} />
            </mesh>
        )
    }
}