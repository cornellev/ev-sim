export function isSplatBakePath(splatConfig = {}) {
    return splatConfig.enabled === true && splatConfig.renderMode !== "projectedTexture";
}

export async function loadSparkRenderer(specifier = "@sparkjsdev/spark") {
    try {
        return await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ specifier);
    } catch (error) {
        const unavailable = new Error("Gaussian splat runtime is unavailable.");
        unavailable.code = "SPLAT_RUNTIME_UNAVAILABLE";
        unavailable.cause = error;
        throw unavailable;
    }
}

export async function ensureSparkRenderer({ data, scene, renderer }) {
    if (data.spark) return data.spark;
    const { SparkRenderer } = await loadSparkRenderer();
    const spark = new SparkRenderer({ renderer });
    data.spark = spark;
    scene.add(spark);
    return spark;
}

export async function ensureSplatAccumulator({ data, scene, renderer, splatConfig }) {
    if (data.splats()) return data.splats();
    await ensureSparkRenderer({ data, scene, renderer });
    const { SplatAccumulator } = await import("./SplatAccumulator.js");
    const accumulator = new SplatAccumulator(scene, splatConfig);
    data.setSplatAccumulator(accumulator);
    return accumulator;
}
