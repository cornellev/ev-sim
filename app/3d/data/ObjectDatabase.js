import { Database } from "./Database";
import { Box } from "./objects/Box";
import { Object } from "./objects/Object";
import * as THREE from "three";

const MAX_BOXES = 2000;

export { MAX_BOXES };

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
        },
        textures: {
            _boxPosTexture: null,
            _boxScaleTexture: null,
        },
        counts: {
            boxCount: 0,
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
        }
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

    scene(scene) {
        this.objects.forEach((obj) => {
            obj.addToScene(scene);
            this.inScene.push(obj._uuid);
        });
    }
}