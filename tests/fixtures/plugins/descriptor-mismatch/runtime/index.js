const plugin = {
    register(api) {
        class MismatchBlock extends api.UnitBlock {
            register() { this.registerOutput("other", "float64"); }
            valid() { return true; }
            execute() { return new api.BlockOutput().set("other", 1); }
        }
        api.contributeUnit({ type: "acme.mismatch.Block", blockClass: MismatchBlock });
    },
};

export default plugin;
