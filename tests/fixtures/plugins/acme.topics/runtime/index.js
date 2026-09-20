const plugin = {
    register(api) {
        api.contributeSystem({
            id: "acme.topics.Bridge",
            create: () => ({
                last: null,
                seen: 0,
                prepare(context) {
                    context.subscribeTopic("plugin-in", (message) => {
                        this.last = message.value;
                        this.seen += 1;
                        context.publishTopic("plugin-out", { value: message.value, typeStr: "std_msgs/Float64" });
                    });
                },
                reset() {
                    this.last = null;
                    this.seen = 0;
                },
                onStep() {},
                getDeterministicState() { return { last: this.last, seen: this.seen }; },
                hydrateDeterministicState(state = {}) {
                    this.last = state.last ?? null;
                    this.seen = Number(state.seen) || 0;
                },
                finalize() {},
                dispose() {},
            }),
        });
    },
};

export default plugin;
