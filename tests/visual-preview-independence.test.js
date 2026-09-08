import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    isSplatBakePath,
    loadSparkRenderer,
} from "../app/3d/environment/visualization/optionalSplatRuntime.js";

const root = new URL("../", import.meta.url);

async function read(relative) {
    return readFile(new URL(relative, root), "utf8");
}

test("normal startup does not statically import Spark, Google, or optional splat construction", async () => {
    const scene = await read("app/3d/Scene.js");
    assert.doesNotMatch(scene, /from ["']@sparkjsdev\/spark["']/);
    assert.doesNotMatch(scene, /from ["'].*SplatAccumulator["']/);
    assert.doesNotMatch(scene, /new SparkRenderer/);
    assert.doesNotMatch(scene, /new SplatAccumulator/);
    assert.match(scene, /ensureSplatAccumulator/);
    assert.match(scene, /environmentLoader\?\.dispose/);
    const loaderDispose = scene.indexOf("runtime?.environmentLoader?.dispose()");
    const rendererDispose = scene.indexOf("renderer.dispose()");
    assert.ok(loaderDispose >= 0 && loaderDispose < rendererDispose);

    const optional = await read("app/3d/environment/visualization/optionalSplatRuntime.js");
    assert.match(optional, /import\((?:\/\*[\s\S]*?\*\/\s*)*specifier\)/);
    assert.doesNotMatch(optional, /^import .* from ["']@sparkjsdev\/spark["']/m);

    const loader = await read("app/3d/environment/EnvironmentLoader.js");
    assert.match(loader, /async apply\(/);
    assert.match(loader, /_materializePreview/);
});

test("explicit splat requests fail locally when the Spark module is unavailable", async () => {
    assert.equal(isSplatBakePath({ enabled: true, renderMode: "projectedTexture" }), false);
    assert.equal(isSplatBakePath({ enabled: true, renderMode: "gaussian" }), true);
    await assert.rejects(
        () => loadSparkRenderer("cev-sim-missing-spark-runtime"),
        (error) => error.code === "SPLAT_RUNTIME_UNAVAILABLE",
    );
});

test("core preview paths do not probe Google tiles or a model server", async () => {
    const scene = await read("app/3d/Scene.js");
    const optional = await read("app/3d/environment/visualization/optionalSplatRuntime.js");
    const materializer = await read("app/3d/environment/visual/VisualLayerMaterializer.js");
    const catalog = await read("app/3d/environment/visual/BakeRunCatalog.js");
    const jobRunner = await read("app/3d/environment/visual/BakeJobRunner.js");
    const snapshot = await read("app/3d/environment/visual/BakeSnapshotBuilder.js");
    const writer = await read("app/3d/environment/visual/BakeArtifactWriter.js");
    const geometry = await read("app/3d/environment/visual/ProjectedCaptureGeometry.js");
    const media = await read("app/3d/environment/visual/BakeDeterministicMedia.js");
    for (const source of [scene, optional, materializer]) {
        assert.doesNotMatch(source, /maps\.googleapis\.com/);
        assert.doesNotMatch(source, /tiles\.googleapis\.com/);
        assert.doesNotMatch(source, /localhost:8000/);
    }
    for (const source of [catalog, jobRunner, snapshot, geometry, media]) {
        assert.doesNotMatch(source, /maps\.googleapis\.com/);
        assert.doesNotMatch(source, /tiles\.googleapis\.com/);
        assert.doesNotMatch(source, /\bfetch\s*\(/);
        assert.doesNotMatch(source, /@sparkjsdev\/spark/);
        assert.doesNotMatch(source, /checkBakeServerHealth/);
        assert.doesNotMatch(source, /clearBakeServer/);
        assert.doesNotMatch(source, /pollBakedImage/);
        assert.doesNotMatch(source, /uploadBakeBinary|uploadBakeFrame|uploadRunManifest/);
    }
    assert.doesNotMatch(writer, /\bfetch\s*\(/);
    assert.doesNotMatch(writer, /checkBakeServerHealth/);
    assert.doesNotMatch(writer, /@sparkjsdev\/spark/);
    assert.match(scene, /createPersistentBakeRunConfig/);
    assert.match(scene, /runPersistentPromotion/);
    assert.doesNotMatch(materializer, /pbr-mesh@1/);
});
