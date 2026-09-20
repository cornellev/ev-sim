const plugin = {
    register(api) {
        class AsyncBlock extends api.UnitBlock {
            register() { this.registerOutput("result", "float64"); }
            valid() { return true; }
            async execute() { return new api.BlockOutput().set("result", 1); }
        }
        api.contributeUnit({ type: "acme.async.AsyncBlock", blockClass: AsyncBlock });
    },
};

export default plugin;
