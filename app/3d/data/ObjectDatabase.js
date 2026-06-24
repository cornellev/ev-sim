import { Database } from "./Database";
import { Box } from "./objects/Box";
import { GLSLObject, Object } from "./objects/Object";
import * as THREE from "three";
import { Triangle } from "./objects/Triangle";
import { getDefaultTagId } from "./ObjectTagRegistry";

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
 * @param {Float32Array} data
 * @param {number} width
 * @returns {THREE.DataTexture}
 */
function createObjectDataTexture(data, width) {
    const texture = new THREE.DataTexture(
        data,
        width,
        1,
        THREE.RGBAFormat,
        THREE.FloatType
    );
    texture.needsUpdate = true;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
}

/**
 * @param {ObjectDatabase} obj
 * @returns
 */
function setupTextures(obj) {
    obj.textures = {
        data: {
            _boxPosData: new Float32Array(4 * MAX_BOXES),
            _boxScaleData: new Float32Array(4 * MAX_BOXES),
            _boxTagData: new Float32Array(4 * MAX_BOXES),
            _trianglePosData: new Float32Array(4 * MAX_TRIANGLES * 3),
            _triangleTagData: new Float32Array(4 * MAX_TRIANGLES),
        },
        textures: {
            _boxPosTexture: null,
            _boxScaleTexture: null,
            _boxTagTexture: null,
            _trianglePosTexture: null,
            _triangleTagTexture: null,
        },
        counts: {
            boxCount: 0,
            triCount: 0,
        },
    };

    obj.textures.textures._boxPosTexture = createObjectDataTexture(
        obj.textures.data._boxPosData,
        MAX_BOXES
    );
    obj.textures.textures._boxScaleTexture = createObjectDataTexture(
        obj.textures.data._boxScaleData,
        MAX_BOXES
    );
    obj.textures.textures._boxTagTexture = createObjectDataTexture(
        obj.textures.data._boxTagData,
        MAX_BOXES
    );
    obj.textures.textures._trianglePosTexture = createObjectDataTexture(
        obj.textures.data._trianglePosData,
        MAX_TRIANGLES * 3
    );
    obj.textures.textures._triangleTagTexture = createObjectDataTexture(
        obj.textures.data._triangleTagData,
        MAX_TRIANGLES
    );
}

/**
 * @param {Object} object
 * @returns {number}
 */
function getObjectTagId(object) {
    return object?.tagId ?? getDefaultTagId();
}

/**
 * @param {ObjectDatabase} database
 * @param {Box} box
 * @param {number} index
 */
function writeBoxTextureSlot(database, box, index) {
    const dataIndex = index * 4;

    database.textures.data._boxPosData[dataIndex + 0] = box.position.x;
    database.textures.data._boxPosData[dataIndex + 1] = box.position.y;
    database.textures.data._boxPosData[dataIndex + 2] = box.position.z;
    database.textures.data._boxPosData[dataIndex + 3] = 1.0;

    database.textures.data._boxScaleData[dataIndex + 0] = box.scale.x;
    database.textures.data._boxScaleData[dataIndex + 1] = box.scale.y;
    database.textures.data._boxScaleData[dataIndex + 2] = box.scale.z;
    database.textures.data._boxScaleData[dataIndex + 3] = 1.0;

    const tagId = getObjectTagId(box);
    database.textures.data._boxTagData[dataIndex + 0] = tagId;
    database.textures.data._boxTagData[dataIndex + 1] = 0.0;
    database.textures.data._boxTagData[dataIndex + 2] = 0.0;
    database.textures.data._boxTagData[dataIndex + 3] = 1.0;

    database.textures.textures._boxPosTexture.needsUpdate = true;
    database.textures.textures._boxScaleTexture.needsUpdate = true;
    database.textures.textures._boxTagTexture.needsUpdate = true;
}

/**
 * @param {ObjectDatabase} database
 * @param {Triangle} triangle
 * @param {number} index
 */
function writeTriangleTextureSlot(database, triangle, index) {
    const dataIndex = index * 12;
    const tagIndex = index * 4;

    database.textures.data._trianglePosData[dataIndex + 0] = triangle.a.x;
    database.textures.data._trianglePosData[dataIndex + 1] = triangle.a.y;
    database.textures.data._trianglePosData[dataIndex + 2] = triangle.a.z;
    database.textures.data._trianglePosData[dataIndex + 3] = 1.0;

    database.textures.data._trianglePosData[dataIndex + 4] = triangle.b.x;
    database.textures.data._trianglePosData[dataIndex + 5] = triangle.b.y;
    database.textures.data._trianglePosData[dataIndex + 6] = triangle.b.z;
    database.textures.data._trianglePosData[dataIndex + 7] = 1.0;

    database.textures.data._trianglePosData[dataIndex + 8] = triangle.c.x;
    database.textures.data._trianglePosData[dataIndex + 9] = triangle.c.y;
    database.textures.data._trianglePosData[dataIndex + 10] = triangle.c.z;
    database.textures.data._trianglePosData[dataIndex + 11] = 1.0;

    const tagId = getObjectTagId(triangle);
    database.textures.data._triangleTagData[tagIndex + 0] = tagId;
    database.textures.data._triangleTagData[tagIndex + 1] = 0.0;
    database.textures.data._triangleTagData[tagIndex + 2] = 0.0;
    database.textures.data._triangleTagData[tagIndex + 3] = 1.0;

    database.textures.textures._trianglePosTexture.needsUpdate = true;
    database.textures.textures._triangleTagTexture.needsUpdate = true;
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
                const index = this.boxes().findIndex((obj) => obj._uuid === uuid);
                if (index === -1) return;
                writeBoxTextureSlot(this, box, index);
            },
            triangle: (triangle) => {
                const uuid = triangle._uuid;
                const index = this.triangles().findIndex((obj) => obj._uuid === uuid);
                if (index === -1) return;
                writeTriangleTextureSlot(this, triangle, index);
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

        if (object instanceof Box) {
            object.setNotifyTexture(this.notifiers.box);
            const index = this.boxes().length - 1;
            writeBoxTextureSlot(this, object, index);
            this.textures.counts.boxCount += 1;
        } else if (object instanceof Triangle) {
            object.setNotifyTexture(this.notifiers.triangle);
            const index = this.triangles().length - 1;
            writeTriangleTextureSlot(this, object, index);
            this.textures.counts.triCount += 1;
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
        return this.objects.filter((obj) => obj instanceof Box);
    }

    t_boxes() {
        return {
            posTexture: this.textures.textures._boxPosTexture,
            scaleTexture: this.textures.textures._boxScaleTexture,
            tagTexture: this.textures.textures._boxTagTexture,
            count: this.textures.counts.boxCount,
        }
    }

    triangles() {
        return this.objects.filter((obj) => obj instanceof Triangle);
    }
    
    t_triangles() {
        return {
            posTexture: this.textures.textures._trianglePosTexture,
            tagTexture: this.textures.textures._triangleTagTexture,
            count: this.textures.counts.triCount,
        }
    }

    scene(scene) {
        console.log("Adding", this.objects.length, "objects to scene");
        this.objects.forEach((obj) => {
            if (this.inScene.includes(obj._uuid)) return;
            obj.addToScene(scene);
            this.inScene.push(obj._uuid);
        });
    }
}
