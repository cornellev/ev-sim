const plugin = {
    register(api) {
        api.contributeSystem({
            id: "acme.systems-b.Mid",
            create: () => ({
                count: 0,
                prepare() {},
                reset() { this.count = 0; },
                onStep() { this.count += 1; },
                getDeterministicState() { return { name: "mid", count: this.count }; },
                hydrateDeterministicState(state = {}) { this.count = Number(state.count) || 0; },
                finalize() {},
                dispose() {},
            }),
        });
    },
};

export default plugin;
