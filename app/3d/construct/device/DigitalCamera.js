import { useState } from "react";
import Device from "./Device";
import { Outlines } from "@react-three/drei";

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
            onSelected(index);
        }

        return (
            <mesh position={[position.x, position.y, position.z]} ref={objectRef} {...(selected && onSelected ? {} : { onClick: raycast })}>
                { selected && <Outlines color={{r: 242, g: 204, b: 36}} transparent={false} thickness={5} /> }
                <boxGeometry args={[1, 0.5, 0.5]} />
                <meshStandardMaterial color={"black"} />
            </mesh>
        )
    }
}