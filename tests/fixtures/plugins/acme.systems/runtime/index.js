function createCounter(name) {
    return {
        count: 0,
        prepare() {},
        reset() { this.count = 0; },
        onStep() { this.count += 1; },
        getDeterministicState() { return { name, count: this.count }; },
        hydrateDeterministicState(state = {}) { this.count = Number(state.count) || 0; },
        finalize() {},
        dispose() {},
    };
}

const plugin = {
    register(api) {
        api.contributeSystem({ id: "acme.systems.Late", create: () => createCounter("late") });
        api.contributeSystem({ id: "acme.systems.Early", create: () => createCounter("early") });
    },
};

export default plugin;
