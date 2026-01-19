import { useEffect, useState } from "react";
import { Box } from "../objects/Box";
import { Point3D } from "../objects/Object";
import { LiDAR3DCar, LiDARCar } from "../vehicles/LiDARCar";


export default function Basic() {
    const [obstacles, setObstacles] = useState([]);

    useEffect(() => {
        const obstacles = [];
        for (let i = 0; i < 5; i++) {
            obstacles.push(
                new Box(new Point3D((i + 1) * 2, 0, 0), Math.random() * 2, 0.5, Math.random() * 2)
            );
        }

        setObstacles(obstacles);
    }, []);
    

    return (
        <>
        <group>
            {obstacles.map(obj => obj.toMesh())}
        </group>
        <LiDAR3DCar objs={obstacles} />
        </>
    );
}