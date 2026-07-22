import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import {
    createProgramInputState,
    hasDuplicateOutputLabels,
    normalizeOutputNodeState,
    normalizeProgramInputState,
    parseValueByType,
} from "./ProgramTypes.js";

export class ProgramInputBlock extends UnitBlock {
    static programNodeRole = "input";

    register() {
        const data = this.getStoredData() || this.state || createProgramInputState();
        this.state = normalizeProgramInputState(data, 0, this.uuid);

        this.registerOutput("input", this.state.type);
    }

    getProgramPortDefinition() {
        return {
            role: "input",
            uuid: this.uuid,
            portId: "input",
            label: this.state.label,
            type: this.state.type,
        };
    }

    valid() {
        return this.hasOutput("input");
    }

    execute() {
        const fallbackValue = parseValueByType(this.state.defaultValue, this.state.type);
        const value = this.manager.resolveExternalInput(this.state.label, fallbackValue);
        return new BlockOutput().set("input", parseValueByType(value, this.state.type));
    }
}

export class OutputNodeBlock extends UnitBlock {
    static programNodeRole = "output";

    register() {
        const data = this.getStoredData() || this.state || normalizeOutputNodeState();
        const state = normalizeOutputNodeState(data);

        this.state = state;

        this.state.outputs.forEach((output) => {
            this.registerInput(output.id, output.type);
        });
    }

    resolveInputLabel(label) {
        const outputs = this.state.outputs || [];
        const idMatch = outputs.find((output) => output.id === label);
        if (idMatch) return idMatch.id;

        const labelMatch = outputs.find((output) => output.label === label);
        return labelMatch?.id || label;
    }

    getProgramPortDefinition() {
        return this.state.outputs.map((output) => ({
            role: "output",
            uuid: this.uuid,
            portId: output.id,
            label: output.label,
            type: output.type,
        }));
    }

    valid() {
        const outputs = this.state.outputs || [];

        return outputs.length > 0
            && !hasDuplicateOutputLabels(outputs)
            && outputs.every((output) => this.hasInput(output.id));
    }

    execute() {
        this.state.outputs.forEach((output) => {
            const value = this.getInput(output.id);
            this.manager.setExternalOutput(output.label, value);
        });

        return new BlockOutput();
    }
}
