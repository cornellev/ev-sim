import { Data } from "../data/Data";
import * as THREE from "three";
import * as Noise from "noisejs";
import { Box } from "../data/objects/Box";

/***
 * @param {Data} data
 */
export function BasicScene(data) {
    const db = data.objects();
    const noise = new Noise.Noise(Math.random());

    const size = 50;

    // create some boxes on a grid with heights based on Perlin noise
    for (let i = -(size / 2); i <= size / 2; i++) {
        for (let j = -(size / 2); j <= size / 2; j++) {
            const height = (noise.perlin2(i / 5, j / 5) + 1) * 5;
            if (height < 4.5) continue;
            const box = new Box(
                new THREE.Vector3(i * 5, 0, j * 5),
                new THREE.Vector3(4, Math.pow(2, height * 0.5), 4),
            ).color(0x228B22 * (0.5 + height / 20));
            db.addObject(box);
        }
    }

    console.log("Basic scene created");
}