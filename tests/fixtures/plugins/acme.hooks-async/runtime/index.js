const plugin = {
    register(api) {
        api.contributeSystem({
            id: "acme.hooks-async.Tick",
            create: () => ({
                prepare() {},
                reset() {},
                onStep() { return Promise.resolve(); },
                getDeterministicState() { return {}; },
                hydrateDeterministicState() {},
                finalize() {},
                dispose() {},
            }),
        });
    },
};

export default plugin;
