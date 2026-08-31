import { Database } from "./Database";
import { Box } from "./objects/Box";
import { GLSLObject, Object } from "./objects/Object";
import * as THREE from "three";
import { Triangle } from "./objects/Triangle";
import Values from "@/app/util/Values";
import { lidarTwinFromGlslObject } from "../../simulation/lidar/LidarGeometry.js";
import { allocateLidarInstanceIds, stableInstanceIdFromSource } from "../../simulation/lidar/LidarInstanceIds.js";
import { compareUtf8 } from "../../simulation/world/WorldDescription.js";

const MAX_BOXES = 2000;
const MAX_TRIANGLES = 5000;

export { MAX_BOXES, MAX_TRIANGLES };

function lidarSourceId(object) {
    return String(object.perceptionSourceId ?? object.environmentSourceId
        ?? object._vehicleId ?? object._buildingId ?? object._roadId ?? object._uuid);
}

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
 * @param {ObjectDatabase} database
 * @param {Box} box
 * @param {number} index
 */
function writeBoxTextureSlot(database, box, index) {
    const dataIndex = index * 4;
    const twin = database.updateLidarTwin(box);

    database.textures.data._boxPosData[dataIndex + 0] = twin.center.x;
    database.textures.data._boxPosData[dataIndex + 1] = twin.center.y;
    database.textures.data._boxPosData[dataIndex + 2] = twin.center.z;
    database.textures.data._boxPosData[dataIndex + 3] = 1.0;

    database.textures.data._boxScaleData[dataIndex + 0] = twin.size.x;
    database.textures.data._boxScaleData[dataIndex + 1] = twin.size.y;
    database.textures.data._boxScaleData[dataIndex + 2] = twin.size.z;
    database.textures.data._boxScaleData[dataIndex + 3] = 1.0;

    database.textures.data._boxTagData[dataIndex + 0] = twin.semanticId;
    database.textures.data._boxTagData[dataIndex + 1] = twin.instanceId;
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
    const twin = database.updateLidarTwin(triangle);

    database.textures.data._trianglePosData[dataIndex + 0] = twin.vertices[0].x;
    database.textures.data._trianglePosData[dataIndex + 1] = twin.vertices[0].y;
    database.textures.data._trianglePosData[dataIndex + 2] = twin.vertices[0].z;
    database.textures.data._trianglePosData[dataIndex + 3] = 1.0;

    database.textures.data._trianglePosData[dataIndex + 4] = twin.vertices[1].x;
    database.textures.data._trianglePosData[dataIndex + 5] = twin.vertices[1].y;
    database.textures.data._trianglePosData[dataIndex + 6] = twin.vertices[1].z;
    database.textures.data._trianglePosData[dataIndex + 7] = 1.0;

    database.textures.data._trianglePosData[dataIndex + 8] = twin.vertices[2].x;
    database.textures.data._trianglePosData[dataIndex + 9] = twin.vertices[2].y;
    database.textures.data._trianglePosData[dataIndex + 10] = twin.vertices[2].z;
    database.textures.data._trianglePosData[dataIndex + 11] = 1.0;

    database.textures.data._triangleTagData[tagIndex + 0] = twin.semanticId;
    database.textures.data._triangleTagData[tagIndex + 1] = twin.instanceId;
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
        this.lidarTwinRegistry = new Map();
        this.lidarInstanceBySource = new Map();
        this.lidarSourceByInstance = new Map();

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

    updateLidarTwin(object) {
        object.lidarInstanceId ??= this.lidarInstanceIdForSource(lidarSourceId(object));
        const twin = lidarTwinFromGlslObject(object);
        this.lidarTwinRegistry.set(object._uuid, twin);
        return twin;
    }

    lidarTwins() {
        return this.objects.map((object) => (
            this.lidarTwinRegistry.get(object._uuid) ?? this.updateLidarTwin(object)
        ));
    }

    lidarInstanceIdForSource(sourceId) {
        const source = String(sourceId);
        const existing = this.lidarInstanceBySource.get(source);
        if (existing) return existing;
        let salt = 0;
        let instanceId = stableInstanceIdFromSource(source);
        while (this.lidarSourceByInstance.has(instanceId)
            && this.lidarSourceByInstance.get(instanceId) !== source) {
            salt += 1;
            instanceId = stableInstanceIdFromSource(`${source}#${salt}`);
        }
        this.lidarInstanceBySource.set(source, instanceId);
        this.lidarSourceByInstance.set(instanceId, source);
        return instanceId;
    }

    rebuildLidarInstanceRegistry() {
        const allocations = allocateLidarInstanceIds(this.objects.map(lidarSourceId), compareUtf8);
        this.lidarInstanceBySource = allocations;
        this.lidarSourceByInstance = new Map([...allocations].map(([sourceId, instanceId]) => [instanceId, sourceId]));
        for (const object of this.objects) object.lidarInstanceId = allocations.get(lidarSourceId(object));
    }

    /**
     * @param {Object} object
     */
    addObject(object) {
        if (!object) return;
        if (this.objects.includes(object)) return;
        if (!(object instanceof Object)) return;
        if (!object.lidarTwinId) {
            const sourceId = lidarSourceId(object);
            const shape = object instanceof Triangle ? "triangle" : "box";
            const index = this.objects.filter((entry) => {
                const entrySource = entry.perceptionSourceId ?? entry.environmentSourceId
                    ?? entry._vehicleId ?? entry._buildingId ?? entry._roadId ?? entry._uuid;
                return String(entrySource) === String(sourceId)
                    && (entry instanceof Triangle ? "triangle" : "box") === shape;
            }).length;
            object.lidarTwinId = `${sourceId}:${shape}:${index}`;
            if (shape === "triangle") object.lidarTriangleIndex = index;
        }
        object.lidarInstanceId = this.lidarInstanceIdForSource(lidarSourceId(object));
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
     * Replace one authored triangle domain (roads or one building) in place and
     * rebuild the existing GPU texture buffers without swapping texture objects.
     */
    replaceTriangles(predicate, triangles = []) {
        this.objects = this.objects.filter(
            (object) => !(object instanceof Triangle && predicate(object)),
        );
        for (const triangle of triangles) {
            this.addObject(triangle);
        }
        this.rebuildTextureData();
    }

    rebuildTextureData() {
        const textureData = this.textures.data;
        Values(textureData).forEach((array) => array.fill(0));
        this.lidarTwinRegistry.clear();
        this.rebuildLidarInstanceRegistry();
        this.textures.counts.boxCount = 0;
        this.textures.counts.triCount = 0;

        this.boxes().forEach((box, index) => {
            box.setNotifyTexture(this.notifiers.box);
            writeBoxTextureSlot(this, box, index);
            this.textures.counts.boxCount += 1;
        });
        this.triangles().forEach((triangle, index) => {
            triangle.setNotifyTexture(this.notifiers.triangle);
            writeTriangleTextureSlot(this, triangle, index);
            this.textures.counts.triCount += 1;
        });
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
