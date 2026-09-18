import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { TEXTURE_ID_TYPE, normalizeOpaqueId } from "../../types/PortTypes.js";

export class TextureImportBlock extends UnitBlock {
    static blockType = "TextureImportBlock";

    register() {
        this.registerOutput("out", TEXTURE_ID_TYPE);
    }

    valid() {
        return this.hasOutput("out");
    }

    execute() {
        return new BlockOutput().set("out", normalizeOpaqueId(this.getStoredData()));
    }
}
