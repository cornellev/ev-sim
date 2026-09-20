import { scale } from "../shared/math.js";

const plugin = {
    register(api) {
        class ScaleBlock extends api.UnitBlock {
            register() { this.registerInput("value", "float64"); this.registerOutput("result", "float64"); }
            valid() { return this.hasInput("value"); }
            execute() { return new api.BlockOutput().set("result", scale(this.getInput("value"), this.state.factor)); }
        }
        api.contributeUnit({ type: "acme.example.ScaleBlock", blockClass: ScaleBlock });
    },
};

export default plugin;
