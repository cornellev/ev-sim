import { Database } from "./Database";
import { Box } from "./objects/Box";
import { GLSLObject, Object } from "./objects/Object";
import * as THREE from "three";
import { Sphere } from "./objects/Sphere";
import { Triangle } from "./objects/Triangle";
import Values from "@/app/util/Values";
import { lidarTwinFromGlslObject } from "../../simulation/lidar/LidarGeometry.js";
import { allocateLidarInstanceIds, stableInstanceIdFromSource } from "../../simulation/lidar/LidarInstanceIds.js";
import { compareUtf8 } from "../../simulation/world/WorldDescription.js";

const MAX_BOXES = 2000;
const MAX_TRIANGLES = 5000;
const MAX_SPHERES = 256;

export { MAX_BOXES, MAX_TRIANGLES, MAX_SPHERES };

let triangleCapacityWarned = false;
let sphereCapacityWarned = false;

function warnTriangleCapacity() {
    if (triangleCapacityWarned) return;
    triangleCapacityWarned = true;
    console.warn(`LiDAR triangle texture is full (${MAX_TRIANGLES}). Further triangles were skipped.`);
}

function warnSphereCapacity() {
    if (sphereCapacityWarned) return;
    sphereCapacityWarned = true;
    console.warn(`LiDAR sphere texture is full (${MAX_SPHERES}). Further spheres were skipped.`);
}

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
            _spherePosData: new Float32Array(4 * MAX_SPHERES),
            _sphereTagData: new Float32Array(4 * MAX_SPHERES),
        },
        textures: {
            _boxPosTexture: null,
            _boxScaleTexture: null,
            _boxTagTexture: null,
            _trianglePosTexture: null,
            _triangleTagTexture: null,
            _spherePosTexture: null,
            _sphereTagTexture: null,
        },
        counts: {
            boxCount: 0,
            triCount: 0,
            sphereCount: 0,
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
    obj.textures.textures._spherePosTexture = createObjectDataTexture(
        obj.textures.data._spherePosData,
        MAX_SPHERES
    );
    obj.textures.textures._sphereTagTexture = createObjectDataTexture(
        obj.textures.data._sphereTagData,
        MAX_SPHERES
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

/**
 * Center in xyz and radius in w. An empty slot keeps w at 0.
 * @param {ObjectDatabase} database
 * @param {Sphere} sphere
 * @param {number} index
 */
function writeSphereTextureSlot(database, sphere, index) {
    const dataIndex = index * 4;
    const twin = database.updateLidarTwin(sphere);
    database.textures.data._spherePosData[dataIndex + 0] = twin.center.x;
    database.textures.data._spherePosData[dataIndex + 1] = twin.center.y;
    database.textures.data._spherePosData[dataIndex + 2] = twin.center.z;
    database.textures.data._spherePosData[dataIndex + 3] = twin.radius;
    database.textures.data._sphereTagData[dataIndex + 0] = twin.semanticId;
    database.textures.data._sphereTagData[dataIndex + 1] = twin.instanceId;
    database.textures.data._sphereTagData[dataIndex + 2] = 0;
    database.textures.data._sphereTagData[dataIndex + 3] = 1;
    database.textures.textures._spherePosTexture.needsUpdate = true;
    database.textures.textures._sphereTagTexture.needsUpdate = true;
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
                if (index === -1 || index >= MAX_TRIANGLES) return;
                writeTriangleTextureSlot(this, triangle, index);
            },
            sphere: (sphere) => {
                const uuid = sphere._uuid;
                const index = this.spheres().findIndex((obj) => obj._uuid === uuid);
                if (index === -1 || index >= MAX_SPHERES) return;
                writeSphereTextureSlot(this, sphere, index);
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
            const shape = object instanceof Triangle ? "triangle" : object instanceof Sphere ? "sphere" : "box";
            const index = this.objects.filter((entry) => {
                const entrySource = entry.perceptionSourceId ?? entry.environmentSourceId
                    ?? entry._vehicleId ?? entry._buildingId ?? entry._roadId ?? entry._uuid;
                const entryShape = entry instanceof Triangle ? "triangle" : entry instanceof Sphere ? "sphere" : "box";
                return String(entrySource) === String(sourceId) && entryShape === shape;
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
            const index = this.triangles().length - 1;
            if (index >= MAX_TRIANGLES) {
                warnTriangleCapacity();
            } else {
                object.setNotifyTexture(this.notifiers.triangle);
                writeTriangleTextureSlot(this, object, index);
                this.textures.counts.triCount += 1;
            }
        } else if (object instanceof Sphere) {
            const index = this.spheres().length - 1;
            if (index >= MAX_SPHERES) {
                warnSphereCapacity();
            } else {
                object.setNotifyTexture(this.notifiers.sphere);
                writeSphereTextureSlot(this, object, index);
                this.textures.counts.sphereCount += 1;
            }
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
     * Pass `{ rebuild: false }` when a following replace will rebuild once.
     */
    replaceTriangles(predicate, triangles = [], { rebuild = true } = {}) {
        this.objects = this.objects.filter(
            (object) => !(object instanceof Triangle && predicate(object)),
        );
        const present = new Set(this.objects);
        const counts = new Map();
        let textureIndex = 0;
        for (const object of this.objects) {
            if (!(object instanceof Triangle)) continue;
            textureIndex += 1;
            const source = lidarSourceId(object);
            counts.set(source, (counts.get(source) ?? 0) + 1);
        }
        for (const triangle of triangles) {
            if (!(triangle instanceof Object) || present.has(triangle)) continue;
            // Preserve addObject behavior for callers passing another shape.
            if (!(triangle instanceof Triangle)) {
                this.addObject(triangle);
                present.add(triangle);
                continue;
            }
            const source = lidarSourceId(triangle);
            const index = counts.get(source) ?? 0;
            counts.set(source, index + 1);
            if (!triangle.lidarTwinId) {
                triangle.lidarTwinId = `${source}:triangle:${index}`;
                triangle.lidarTriangleIndex = index;
            }
            triangle.lidarInstanceId = this.lidarInstanceIdForSource(source);
            this.objects.push(triangle);
            present.add(triangle);
            if (!rebuild) {
                if (textureIndex >= MAX_TRIANGLES) warnTriangleCapacity();
                else {
                    triangle.setNotifyTexture(this.notifiers.triangle);
                    writeTriangleTextureSlot(this, triangle, textureIndex);
                    this.textures.counts.triCount += 1;
                }
            }
            textureIndex += 1;
        }
        if (rebuild) this.rebuildTextureData();
    }

    /**
     * Replace one sphere domain and rebuild the GPU buffers.
     * @param {(sphere: Sphere) => boolean} predicate
     * @param {Sphere[]} spheres
     * @param {{ rebuild?: boolean }} [options]
     */
    replaceSpheres(predicate, spheres = [], { rebuild = true } = {}) {
        this.objects = this.objects.filter(
            (object) => !(object instanceof Sphere && predicate(object)),
        );
        for (const sphere of spheres) this.addObject(sphere);
        if (rebuild) this.rebuildTextureData();
    }

    rebuildTextureData() {
        const textureData = this.textures.data;
        Values(textureData).forEach((array) => array.fill(0));
        this.lidarTwinRegistry.clear();
        this.rebuildLidarInstanceRegistry();
        this.textures.counts.boxCount = 0;
        this.textures.counts.triCount = 0;
        this.textures.counts.sphereCount = 0;

        this.boxes().forEach((box, index) => {
            box.setNotifyTexture(this.notifiers.box);
            writeBoxTextureSlot(this, box, index);
            this.textures.counts.boxCount += 1;
        });
        this.triangles().forEach((triangle, index) => {
            if (index >= MAX_TRIANGLES) {
                warnTriangleCapacity();
                return;
            }
            triangle.setNotifyTexture(this.notifiers.triangle);
            writeTriangleTextureSlot(this, triangle, index);
            this.textures.counts.triCount += 1;
        });
        this.spheres().forEach((sphere, index) => {
            if (index >= MAX_SPHERES) {
                warnSphereCapacity();
                return;
            }
            sphere.setNotifyTexture(this.notifiers.sphere);
            writeSphereTextureSlot(this, sphere, index);
            this.textures.counts.sphereCount += 1;
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

    spheres() {
        return this.objects.filter((obj) => obj instanceof Sphere);
    }

    t_spheres() {
        return {
            posTexture: this.textures.textures._spherePosTexture,
            tagTexture: this.textures.textures._sphereTagTexture,
            count: this.textures.counts.sphereCount,
        };
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
