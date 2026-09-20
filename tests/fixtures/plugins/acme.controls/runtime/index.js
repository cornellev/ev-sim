const plugin = {
    register(api) {
        api.contributeSystem({
            id: "acme.controls.Driver",
            create: () => ({
                prepare() {},
                reset() {},
                onStep(context) {
                    context.submitReferenceCommand("ego", { speedMps: 1.5, steeringRadRep103: 0.2 });
                },
                getDeterministicState() { return {}; },
                hydrateDeterministicState() {},
                finalize() {},
                dispose() {},
            }),
        });
    },
};

export default plugin;
