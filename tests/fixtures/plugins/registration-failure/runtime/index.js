const plugin = {
    register(api) {
        class Undeclared extends api.UnitBlock {
            register() { this.registerOutput("result", "float64"); }
            valid() { return true; }
            execute() { return new api.BlockOutput().set("result", 1); }
        }
        api.contributeUnit({ type: "acme.registration.Undeclared", blockClass: Undeclared });
    },
};

export default plugin;
