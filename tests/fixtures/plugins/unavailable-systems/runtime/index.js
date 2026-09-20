const plugin = {
    register(api) {
        api.contributeSystem({ id: "acme.systems.Tick" });
    },
};

export default plugin;
