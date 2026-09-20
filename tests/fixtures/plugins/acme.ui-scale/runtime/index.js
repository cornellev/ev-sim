const plugin = {
    register(api) {
        class ScaleBlock extends api.UnitBlock {
            register() {
                this.registerInput("value", "float64");
                this.registerOutput("result", "float64");
            }

            valid() {
                return this.hasInput("value");
            }

            execute() {
                return new api.BlockOutput().set("result", this.getInput("value") * this.state.factor);
            }
        }

        api.contributeUnit({ type: "acme.ui-scale.ScaleBlock", blockClass: ScaleBlock });
    },
};

export default plugin;
