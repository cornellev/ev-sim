/**
 * BakedRender loads Gaussian splat assets produced by the bake export pipeline.
 */
export class BakedRender {
    /**
     * @param {import("@sparkjsdev/spark").SparkRenderer|null} spark
     * @param {Object} [options]
     */
    constructor(spark, options = {}) {
        this.spark = spark;
        this.runId = options.runId ?? null;
        this.transformsUrl = options.transformsUrl ?? null;
        this.mesh = null;
        this.visible = false;
    }

    /**
     * @param {string} runId
     * @param {string} [host]
     */
    setRun(runId, host = "http://localhost:8000") {
        this.runId = runId;
        this.transformsUrl = `${host}/baked/${runId}/transforms.json`;
    }

    /**
     * Load transforms metadata for alignment/debug overlays.
     * @returns {Promise<Object|null>}
     */
    async loadTransforms() {
        if (!this.transformsUrl) return null;
        const response = await fetch(this.transformsUrl);
        if (!response.ok) return null;
        return response.json();
    }

    /**
     * Placeholder hook for Spark splat mesh loading once training output exists.
     * @param {string} assetUrl
     */
    async loadSplatAsset(assetUrl) {
        if (!this.spark || !assetUrl) return null;
        this.visible = true;
        return {
            assetUrl,
            runId: this.runId,
            mesh: this.mesh,
        };
    }

    dispose() {
        this.mesh = null;
        this.visible = false;
    }
}

export default BakedRender;
