import { Database } from "./Database";
import { Box } from "./objects/Box";
import { GLSLObject, Object } from "./objects/Object";
import * as THREE from "three";
import { Triangle } from "./objects/Triangle";

const MAX_BOXES = 2000;
const MAX_TRIANGLES = 5000;

export { MAX_BOXES, MAX_TRIANGLES };

class ObjectEvent {
    static TYPES = ["add", "remove", "update"];
    constructor(type, object) {
        this.type = type;
        this.object = object;
    }
}

/**
 * 
 * @param {ObjectDatabase} obj 
 * @returns 
 */
function setupTextures(obj) {
    obj.textures = {
        data: {
            _boxPosData: new Float32Array(4 * MAX_BOXES),
            _boxScaleData: new Float32Array(4 * MAX_BOXES),
            _trianglePosData: new Float32Array(4 * MAX_TRIANGLES * 3),
        },
        textures: {
            _boxPosTexture: null,
            _boxScaleTexture: null,
            _trianglePosTexture: null,
        },
        counts: {
            boxCount: 0,
            triCount: 0,
        },
    };

    obj.textures.textures._boxPosTexture = new THREE.DataTexture(
        obj.textures.data._boxPosData,
        MAX_BOXES,
        1,
        THREE.RGBAFormat,
        THREE.FloatType
    );
    obj.textures.textures._boxPosTexture.needsUpdate = true;
    obj.textures.textures._boxPosTexture.minFilter = THREE.NearestFilter;
    obj.textures.textures._boxPosTexture.magFilter = THREE.NearestFilter;
    obj.textures.textures._boxPosTexture.wrapS = THREE.ClampToEdgeWrapping;
    obj.textures.textures._boxPosTexture.wrapT = THREE.ClampToEdgeWrapping;

    obj.textures.textures._boxScaleTexture = new THREE.DataTexture(
        obj.textures.data._boxScaleData,
        MAX_BOXES,
        1,
        THREE.RGBAFormat,
        THREE.FloatType
    );
    obj.textures.textures._boxScaleTexture.needsUpdate = true;
    obj.textures.textures._boxScaleTexture.minFilter = THREE.NearestFilter;
    obj.textures.textures._boxScaleTexture.magFilter = THREE.NearestFilter;
    obj.textures.textures._boxScaleTexture.wrapS = THREE.ClampToEdgeWrapping;
    obj.textures.textures._boxScaleTexture.wrapT = THREE.ClampToEdgeWrapping;

    obj.textures.textures._trianglePosTexture = new THREE.DataTexture(
        obj.textures.data._trianglePosData,
        MAX_TRIANGLES * 3,
        1,
        THREE.RGBAFormat,
        THREE.FloatType
    );
    obj.textures.textures._trianglePosTexture.needsUpdate = true;
    obj.textures.textures._trianglePosTexture.minFilter = THREE.NearestFilter;
    obj.textures.textures._trianglePosTexture.magFilter = THREE.NearestFilter;
    obj.textures.textures._trianglePosTexture.wrapS = THREE.ClampToEdgeWrapping;
    obj.textures.textures._trianglePosTexture.wrapT = THREE.ClampToEdgeWrapping;
}

export class ObjectDatabase extends Database {
    constructor(parent) {
        super(parent);
        this.objects = [];
        this.inScene = [];

        this._maxX = 50;
        this._maxY = 50;

        setupTextures(this);

        this.notifiers = {
            box: (box) => {
                const uuid = box._uuid;
                const index = this.objects.findIndex((obj) => obj._uuid === uuid);
                if (index === -1) return;

                const boxCount = this.textures.counts.boxCount;
                const dataIndex = index * 4;

                // update position data
                this.textures.data._boxPosData[dataIndex + 0] = box.position.x;
                this.textures.data._boxPosData[dataIndex + 1] = box.position.y;
                this.textures.data._boxPosData[dataIndex + 2] = box.position.z;
                this.textures.data._boxPosData[dataIndex + 3] = 1.0;

                // update scale data
                this.textures.data._boxScaleData[dataIndex + 0] = box.scale.x;
                this.textures.data._boxScaleData[dataIndex + 1] = box.scale.y;
                this.textures.data._boxScaleData[dataIndex + 2] = box.scale.z;
                this.textures.data._boxScaleData[dataIndex + 3] = 1.0;

                // mark textures as needing update
                this.textures.textures._boxPosTexture.needsUpdate = true;
                this.textures.textures._boxScaleTexture.needsUpdate = true;
            },
            triangle: (triangle) => {
                const uuid = triangle._uuid;
                const index = this.objects.findIndex((obj) => obj._uuid === uuid);
                if (index === -1) return;

                const triCount = this.textures.counts.triCount;
                const dataIndex = index * 12;

                // update position data
                this.textures.data._trianglePosData[dataIndex + 0] = triangle.a.x;
                this.textures.data._trianglePosData[dataIndex + 1] = triangle.a.y;
                this.textures.data._trianglePosData[dataIndex + 2] = triangle.a.z;
                this.textures.data._trianglePosData[dataIndex + 3] = 1.0;

                // update position data for b
                this.textures.data._trianglePosData[dataIndex + 4] = triangle.b.x;
                this.textures.data._trianglePosData[dataIndex + 5] = triangle.b.y;
                this.textures.data._trianglePosData[dataIndex + 6] = triangle.b.z;
                this.textures.data._trianglePosData[dataIndex + 7] = 1.0;

                // update position data for c
                this.textures.data._trianglePosData[dataIndex + 8] = triangle.c.x;
                this.textures.data._trianglePosData[dataIndex + 9] = triangle.c.y;
                this.textures.data._trianglePosData[dataIndex + 10] = triangle.c.z;
                this.textures.data._trianglePosData[dataIndex + 11] = 1.0;

                // mark textures as needing update
                this.textures.textures._trianglePosTexture.needsUpdate = true;
            },
        }
    }

    notifyUpdate() {

    }

    /**
     * @param {Object} object
     */
    addObject(object) {
        if (!object) return;
        if (this.objects.includes(object)) return;
        if (!(object instanceof Object)) return;
        this.objects.push(object);

        // update max dimensions
        // const objMaxX = Math.abs(object.position.x) + object.size.x / 2;
        // const objMaxY = Math.abs(object.position.z) + object.size.z / 2;
        // if (objMaxX > this._maxX) this._maxX = objMaxX;
        // if (objMaxY > this._maxY) this._maxY = objMaxY;

        if (object instanceof Box) {
            object.setNotifyTexture(this.notifiers.box);
            const index = this.boxes().length - 1;
            const dataIndex = index * 4;
            const boxCount = this.textures.counts.boxCount;
            
            // set position data
            this.textures.data._boxPosData[dataIndex + 0] = object.position.x;
            this.textures.data._boxPosData[dataIndex + 1] = object.position.y;
            this.textures.data._boxPosData[dataIndex + 2] = object.position.z;
            this.textures.data._boxPosData[dataIndex + 3] = 1.0;
            
            // set scale data
            this.textures.data._boxScaleData[dataIndex + 0] = object.scale.x;
            this.textures.data._boxScaleData[dataIndex + 1] = object.scale.y;
            this.textures.data._boxScaleData[dataIndex + 2] = object.scale.z;
            this.textures.data._boxScaleData[dataIndex + 3] = 1.0;
            this.textures.counts.boxCount += 1;

            // mark textures as needing update
            this.textures.textures._boxPosTexture.needsUpdate = true;
            this.textures.textures._boxScaleTexture.needsUpdate = true;
        } else if (object instanceof Triangle) {
            object.setNotifyTexture(this.notifiers.triangle);
            const index = this.triangles().length - 1;
            const dataIndex = index * 12;
            const triCount = this.textures.counts.triCount;

            // set position data for a
            this.textures.data._trianglePosData[dataIndex + 0] = object.a.x;
            this.textures.data._trianglePosData[dataIndex + 1] = object.a.y;
            this.textures.data._trianglePosData[dataIndex + 2] = object.a.z;
            this.textures.data._trianglePosData[dataIndex + 3] = 1.0;

            // set position data for b
            this.textures.data._trianglePosData[dataIndex + 4] = object.b.x;
            this.textures.data._trianglePosData[dataIndex + 5] = object.b.y;
            this.textures.data._trianglePosData[dataIndex + 6] = object.b.z;
            this.textures.data._trianglePosData[dataIndex + 7] = 1.0;

            // set position data for c
            this.textures.data._trianglePosData[dataIndex + 8] = object.c.x;
            this.textures.data._trianglePosData[dataIndex + 9] = object.c.y;
            this.textures.data._trianglePosData[dataIndex + 10] = object.c.z;
            this.textures.data._trianglePosData[dataIndex + 11] = 1.0;

            this.textures.counts.triCount += 1;

            // mark textures as needing update
            this.textures.textures._trianglePosTexture.needsUpdate = true;
        }
    }

    /**
     * @param {Object[]} objects
     * @returns 
     */
    addObjects(objects) {
        objects.forEach((obj) => this.addObject(obj));
    }

    /**
     * @returns {Box[]}
     */
    getAll() {
        return this.objects;
    }

    boxes() {
        return this.objects.filter((obj) => obj.constructor.name === "Box");
    }

    t_boxes() {
        return {
            posTexture: this.textures.textures._boxPosTexture,
            scaleTexture: this.textures.textures._boxScaleTexture,
            count: this.textures.counts.boxCount,
        }
    }

    triangles() {
        return this.objects.filter((obj) => obj.constructor.name === "Triangle");
    }
    
    t_triangles() {
        return {
            posTexture: this.textures.textures._trianglePosTexture,
            count: this.textures.counts.triCount,
        }
    }

    scene(scene) {
        this.objects.forEach((obj) => {
            if (this.inScene.includes(obj._uuid)) return;
            obj.addToScene(scene);
            this.inScene.push(obj._uuid);
        });
    }
}