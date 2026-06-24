import { isVector3 } from "../../../util/Checks";
import { keys } from "../../../util/Keys";
import { getDefaultTagId, resolveTagId } from "../ObjectTagRegistry";

import * as THREE from "three";

export class Object {
    constructor(position=true, rotation=true, scale=true) {
        if (position) this.position = new THREE.Vector3(0, 0, 0);
        if (rotation) this.rotation = new THREE.Vector3(0, 0, 0);
        if (scale) this.scale = new THREE.Vector3(1, 1, 1);

        this._color = 0xffffff;

        this._uuid = crypto.randomUUID();
        this._mesh = null;

        /** @type {string[]} Semantic labels such as building, sign, road. */
        this.tags = [];
        /** @type {number} Numeric tag id packed into GPU object textures. */
        this.tagId = getDefaultTagId();
    }

    /**
     * @param {string[]} tags
     * @returns {this}
     */
    setTags(tags = []) {
        this.tags = [...tags];
        this.tagId = tags.length > 0 ? resolveTagId(tags[0]) : getDefaultTagId();
        this._notifyTagChange?.();
        return this;
    }

    /**
     * @param {string} tag
     * @returns {this}
     */
    addTag(tag) {
        if (!tag) return this;
        if (!this.tags.includes(tag)) {
            this.tags.push(tag);
        }
        if (this.tags.length === 1) {
            this.tagId = resolveTagId(tag);
        }
        this._notifyTagChange?.();
        return this;
    }

    /**
     * @param {number} tagId
     * @returns {this}
     */
    setTagId(tagId) {
        this.tagId = tagId;
        this._notifyTagChange?.();
        return this;
    }
    
    color(color) {
        this._color = color;
        return this;
    }

    getColor() {
        return this._color;
    }
    
    setPosition(x, y=0, z=0) {
        if (this.position) {
            if (isVector3(x)) {
                this.position.copy(x);
                if (this._mesh) {
                    this._mesh.position.copy(x);
                }
                return;
            }

            this.position.set(x, y, z);
            if (this._mesh) {
                this._mesh.position.set(x, y, z);
            }
        }
    }

    setRotation(x, y=0, z=0) {
        if (this.rotation) {
            if (isVector3(x)) {
                this.rotation.copy(x);
                if (this._mesh) {
                    this._mesh.rotation.copy(x);
                }
                return;
            }

            this.rotation.set(x, y, z);
            if (this._mesh) {
                this._mesh.rotation.set(x, y, z);
            }
        }
    }

    setScale(x, y=1, z=1) {
        if (this.scale) {
            if (isVector3(x)) {
                this.scale.copy(x);
                if (this._mesh) {
                    this._mesh.scale.copy(x);
                }
                return;
            }

            this.scale.set(x, y, z);
            if (this._mesh) {
                this._mesh.scale.set(x, y, z);
            }
        }
    }

    /**
     * @param {Scene} scene
     */
    addToScene(scene) {
        // Override in subclass
    }
}

export class GLSLObject extends Object {
    static struct_vs() {
        return `vec3 position;\n`
            + `vec3 rotation;\n`
            + `vec3 scale;\n`
    }
    
    constructor(position=true, rotation=true, scale=true) {
        super(position, rotation, scale);

        this._notifyTexture = null;
    }

    setPosition(x, y=0, z=0) {
        super.setPosition(x, y, z);
        if (this._notifyTexture) this._notifyTexture(this);
    }

    setRotation(x, y=0, z=0) {
        super.setRotation(x, y, z);
        if (this._notifyTexture) this._notifyTexture(this);
    }

    setScale(x, y=1, z=1) {
        super.setScale(x, y, z);
        if (this._notifyTexture) this._notifyTexture(this);
    }

    getSDF() {
        return ``;
    }

    /**
     * 
     * @returns {Struct}
     */
    getStruct() {
        const s = new Struct("Object");
        if (keys(this).includes("position")) s.addField("vec3", "position");
        if (keys(this).includes("rotation")) s.addField("vec3", "rotation");
        if (keys(this).includes("scale")) s.addField("vec3", "scale");
        return s;
    }

    toUniforms() {
        const u = {};
        for (const key in this) {
            if (key.charAt(0) === "_") continue;
            u[key] = { value: this[key] };
        }

        return u;
    }

    setNotifyTexture(onNotify) {
        this._notifyTexture = onNotify;
        this._notifyTagChange = onNotify;
    }

    notifyTextureUpdate() {
        if (this._notifyTexture) {
            this._notifyTexture(this);
        }
    }
}

export class Struct {
    constructor(typedef) {
        this.name = typedef;
        this.fields = [];
    }

    /**
     * 
     * @param {String} type
     * @param {String} name
     * @returns {Struct}
     */
    addField(type, name) {
        this.fields.push({ type, name });
        return this;
    }

    /**
     * 
     * @param {String} newName 
     * @returns {Struct}
     */
    rename(newName) {
        this.name = newName;
        return this;
    }

    /**
     * 
     * @returns {String}
     */
    toString() {
        let structString = `struct ${this.name} {\n`;
        this.fields.forEach(field => {
            structString += `    ${field.type} ${field.name};\n`;
        });
        structString += "};";
        return structString;
    }
}