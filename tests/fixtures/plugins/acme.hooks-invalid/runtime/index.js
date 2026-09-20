const plugin = {
    register(api) {
        api.contributeSystem({
            id: "acme.hooks-invalid.Tick",
            create: () => ({
                prepare() {},
                reset() {},
                onStep() {},
                getDeterministicState() { return { then() {} }; },
                hydrateDeterministicState() {},
                finalize() {},
                dispose() {},
            }),
        });
    },
};

export default plugin;
