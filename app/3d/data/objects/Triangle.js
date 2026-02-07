import * as THREE from "three";
import { GLSLObject, Struct } from "./Object";

export class Triangle extends GLSLObject {
    constructor(a, b, c) {
        super(false, false, false);
        this.a = a;
        this.b = b;
        this.c = c;
    }

    getStruct() {
        return new Struct("Triangle")
            .addField("vec3", "a")
            .addField("vec3", "b")
            .addField("vec3", "c");
    }

    /**
     * @source https://iquilezles.org/articles/distfunctions/
     * @returns {String}
     */
    getSDF() {
        return `` + 
`float udTriangle( vec3 p, vec3 a, vec3 b, vec3 c )
{
  vec3 ba = b - a; vec3 pa = p - a;
  vec3 cb = c - b; vec3 pb = p - b;
  vec3 ac = a - c; vec3 pc = p - c;
  vec3 nor = cross( ba, ac );

  return sqrt(
    (sign(dot(cross(ba,nor),pa)) +
     sign(dot(cross(cb,nor),pb)) +
     sign(dot(cross(ac,nor),pc))<2.0)
     ?
     min( min(
     dot2(ba*clamp(dot(ba,pa)/dot2(ba),0.0,1.0)-pa),
     dot2(cb*clamp(dot(cb,pb)/dot2(cb),0.0,1.0)-pb) ),
     dot2(ac*clamp(dot(ac,pc)/dot2(ac),0.0,1.0)-pc) )
     :
     dot(nor,pa)*dot(nor,pa)/dot2(nor) );
}
     
float udTriangle(vec3 p, Triangle triangle) {
    return udTriangle(p, triangle.a, triangle.b, triangle.c);
}
`;
    }

    /**
     * 
     * @param {THREE.Scene} scene 
     */
    addToScene(scene) {
        const triangle = new THREE.Triangle(this.a, this.b, this.c);
        const geometry = new THREE.BufferGeometry();
        const vertices = new Float32Array([
            triangle.a.x, triangle.a.y, triangle.a.z,
            triangle.b.x, triangle.b.y, triangle.b.z,
            triangle.c.x, triangle.c.y, triangle.c.z,
        ]);
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({ color: this.getColor(), side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);

        this._mesh = mesh;
    }
}