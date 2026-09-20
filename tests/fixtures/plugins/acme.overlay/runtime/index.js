const plugin = {
    register(api) {
        api.contributeSystem({
            id: "acme.overlay.Spawner",
            create: () => ({
                prepare() {},
                reset(context) {
                    context.spawnOverlay({
                        assetId: "barrel",
                        pose: { position: { x: 2, y: 0, z: 1 }, rotation: { x: 0, y: 0, z: 0 } },
                    });
                },
                onStep(context) {
                    if (this.spawnDuringStep) {
                        context.spawnOverlay({ assetId: "barrel" });
                    }
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
