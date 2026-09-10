import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import {
    EXPERIMENT_ONE_PATHS,
    EXPERIMENT_ONE_VIEWPOINTS,
} from "../app/visual-lab/ExperimentOneCase.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = path.join(ROOT, "public", "visual-lab", "experiment-1", "browser");
const GENERATED_MODULE = path.join(ROOT, "app", "visual-lab", "ExperimentOneBrowserMediaManifest.js");
const WIDTH = 1280;
const HEIGHT = 720;
const full = process.argv.includes("--full");
const THREE_VERSION = JSON.parse(await fs.readFile(path.join(ROOT, "node_modules", "three", "package.json"), "utf8")).version;

const baseOutputs = (candidateId) => ["ordinary-environment", "directional-challenge"].flatMap((conditionId) => (
    ["base", "chair-translated", "chair-rotated", "light-moved"].map((editVariantId) => ({
        id: `${candidateId}-${conditionId}-${editVariantId}`,
        candidateId,
        conditionId,
        editVariantId,
        correction: "none",
        includePaths: full && editVariantId === "base",
    }))
));

const outputs = [
    ...baseOutputs("b0-browser"),
    ...baseOutputs("b1-browser"),
    ...["lighting", "shadows", "color"].map((correction) => ({
        id: `b4-browser-ordinary-environment-base-${correction}`,
        candidateId: "b4-browser",
        conditionId: "ordinary-environment",
        editVariantId: "base",
        correction,
        includePaths: false,
    })),
    ...["ordinary-environment", "directional-challenge"].flatMap((conditionId) => (
        ["base", "chair-translated", "chair-rotated", "light-moved"].map((editVariantId) => ({
            id: `b4-browser-${conditionId}-${editVariantId}-combined`,
            candidateId: "b4-browser",
            conditionId,
            editVariantId,
            correction: "combined",
            includePaths: full && editVariantId === "base",
        }))
    )),
];

const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/":"/node_modules/three/","@noble/hashes/":"/node_modules/@noble/hashes/"}}</script></head><body><canvas width="${WIDTH}" height="${HEIGHT}"></canvas><script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { AlignedCaptureProducts } from "/app/3d/environment/visual/AlignedCaptureProducts.js";
import { applyPbrRenderRecipeToScene } from "/app/3d/environment/visual/PbrRenderRecipeRuntime.js";
import { createOwnedCaptureScene, createVisualCameraCalibration, createVisualCaptureInput, createVisualCapturePassSet, VISUAL_CAPTURE_PASS_FAMILIES } from "/app/3d/environment/visual/VisualCapturePipeline.js";
import { normalizePbrRenderRecipe } from "/app/simulation/render/PbrRenderScene.js";
import { createExperimentOneScene } from "/app/visual-lab/ExperimentOneScene.js";

const width = ${WIDTH};
const height = ${HEIGHT};
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: false });
renderer.setSize(width, height, false);
renderer.setPixelRatio(1);
const camera = new THREE.PerspectiveCamera();
const calibration = createVisualCameraCalibration({ width, height, intrinsics: { fx: 910, fy: 910, cx: 639.5, cy: 359.5 }, near: 0.05, far: 50, distortionModel: "none", distortion: [] });
const outputCanvas = document.querySelector("canvas");
const outputContext = outputCanvas.getContext("2d", { alpha: false });
let active = null;
let generation = 0;

function profile(config) {
  const version = config.candidateId === "b4-browser" ? 2 : 1;
  const directional = config.conditionId === "directional-challenge";
  const lightsEnabled = version === 2 && ["lighting", "shadows", "combined"].includes(config.correction);
  const shadowsEnabled = version === 2 && ["shadows", "combined"].includes(config.correction);
  const colorEnabled = version === 2 && ["color", "combined"].includes(config.correction);
  const lighting = { ambient: { colorRgb: [1, 1, 1], intensity: directional ? 0.22 : 0.72 } };
  if (version === 2) {
    lighting.directional = lightsEnabled ? [{ id: "room-key", colorRgb: [1, 0.93, 0.82], intensity: directional ? 3.2 : 1.85, direction: directional ? [-0.78, -1, -0.14] : [-0.55, -1, -0.35], castShadow: shadowsEnabled }, { id: "room-fill", colorRgb: [0.72, 0.82, 1], intensity: directional ? 0.12 : 0.32, direction: [0.7, -0.65, 0.55], castShadow: false }] : [];
    lighting.point = lightsEnabled ? [{ id: "lamp-light", colorRgb: [1, 0.68, 0.42], intensity: 42, position: [-2.12, 1.72, 1.58], range: 6, decay: 2, castShadow: shadowsEnabled }] : [];
  }
  return normalizePbrRenderRecipe({
    kind: "cev-sim.pbr-render-recipe", version,
    background: { colorRgba: directional ? [0.025, 0.03, 0.04, 1] : [0.075, 0.085, 0.095, 1] },
    lighting,
    shadows: version === 2 ? { enabled: shadowsEnabled, algorithm: shadowsEnabled ? "pcf-soft" : "none", mapSize: 1024, bias: -0.0001, normalBias: 0.02, maxLights: 3 } : { enabled: false, algorithm: "none" },
    colorPipeline: { workingColorSpace: "linear-srgb", outputColorSpace: "srgb", toneMapping: colorEnabled ? "AgX" : "none", exposure: colorEnabled ? 1.08 : 1 },
  });
}

async function loadRoom(candidateId) {
  if (candidateId === "b0-browser") {
    const fixture = createExperimentOneScene({ detail: "simple", materialProfile: "incumbent" });
    return { root: fixture.root, dispose: () => fixture.dispose() };
  }
  const gltf = await new GLTFLoader().loadAsync("/visual-lab/experiment-1/assets/experiment-1-room.glb");
  return { root: gltf.scene, dispose: () => gltf.scene.traverse((object) => { object.geometry?.dispose?.(); const materials = Array.isArray(object.material) ? object.material : [object.material]; materials.filter(Boolean).forEach((material) => { for (const value of Object.values(material)) value?.isTexture && value.dispose(); material.dispose?.(); }); }) };
}

function objectId(object) { return object.userData?.visualLabObjectId || object.userData?.cev_object_id || (object.name.includes(":") ? object.name.split(":")[0] : null); }

function applyEdit(root, editVariantId) {
  const chairPivot = new THREE.Vector3(-1.12, 0, -0.15);
  root.updateMatrixWorld(true);
  if (editVariantId === "chair-translated") {
    root.traverse((object) => { if (objectId(object) === "chair-a" && object.isMesh) object.position.add(new THREE.Vector3(0.32, 0, 0.2)); });
  }
  if (editVariantId === "chair-rotated") {
    const rotation = new THREE.Matrix4().makeRotationY(0.7);
    root.traverse((object) => {
      if (objectId(object) !== "chair-a" || !object.isMesh) return;
      object.position.sub(chairPivot).applyMatrix4(rotation).add(chairPivot);
      object.rotateY(0.7);
    });
  }
}

function captureBindings(scene) {
  const bindings = [];
  const renderables = new Map();
  let index = 0;
  scene.traverse((object) => {
    if (!object.isMesh) return;
    const renderableId = "renderable-" + String(index).padStart(4, "0");
    bindings.push({ renderableId, objectKey: "object-" + String(index).padStart(4, "0"), materialKeys: ["material-" + String(index).padStart(4, "0")], tags: [] });
    renderables.set(renderableId, object);
    index += 1;
  });
  return { bindings, renderables };
}

window.prepareExperimentOneCapture = async (config) => {
  active?.capture.dispose();
  active?.recipeState.dispose();
  active?.room.dispose();
  const room = await loadRoom(config.candidateId);
  const scene = new THREE.Scene();
  scene.add(room.root);
  applyEdit(room.root, config.editVariantId);
  const recipe = profile(config);
  scene.background = new THREE.Color(...recipe.background.colorRgba.slice(0, 3));
  const recipeState = applyPbrRenderRecipeToScene(scene, recipe);
  if (config.editVariantId === "light-moved") {
    const key = scene.getObjectByName("cev-sim.recipe-light:room-key");
    if (key) key.position.set(2.4, 2.5, -1.8);
  }
  scene.updateMatrixWorld(true);
  const handle = createOwnedCaptureScene({ role: "measured-appearance", scene, generation: ++generation, descriptionHash: config.id });
  const { bindings, renderables } = captureBindings(scene);
  const capture = new AlignedCaptureProducts({ renderer, camera, visualSceneHandle: handle, renderPolicy: recipeState.renderPolicy });
  active = { config, scene, room, recipe, recipeState, handle, bindings, renderables, capture };
  const movedKey = scene.getObjectByName("cev-sim.recipe-light:room-key");
  return {
    recipe,
    renderableCount: renderables.size,
    appliedLightOverrides: config.editVariantId === "light-moved" && movedKey
      ? [{ lightId: "room-key", position: movedKey.position.toArray(), target: movedKey.target.position.toArray() }]
      : [],
  };
};

window.captureExperimentOneFrame = async ({ pose, captureTimeNs }) => {
  const poseCamera = new THREE.PerspectiveCamera();
  poseCamera.position.fromArray(pose.position);
  poseCamera.lookAt(...pose.target);
  poseCamera.updateMatrixWorld(true);
  const captureInput = createVisualCaptureInput({ calibration, pose: { matrixWorld: poseCamera.matrixWorld.elements }, sceneHandle: active.handle, captureTimeNs });
  const passSet = createVisualCapturePassSet({ family: VISUAL_CAPTURE_PASS_FAMILIES.visual, captureInput, products: ["beauty", "validity"], bindings: active.bindings });
  const result = await active.capture.capture({ visualPassSet: passSet, visualRenderables: active.renderables, signal: new AbortController().signal });
  outputContext.putImageData(new ImageData(new Uint8ClampedArray(result.visual.products.beauty), width, height), 0, 0);
  const blob = await new Promise((resolve) => outputCanvas.toBlob(resolve, "image/png"));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};
window.experimentOneCaptureReady = true;
</script></body></html>`;

const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
        if (pathname === "/") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(pageHtml);
            return;
        }
        const filePath = pathname.startsWith("/visual-lab/")
            ? path.resolve(ROOT, "public", `.${pathname}`)
            : path.resolve(ROOT, `.${pathname}`);
        if (!filePath.startsWith(`${ROOT}${path.sep}`)) throw new Error("Path escapes repository root.");
        const bytes = await fs.readFile(filePath);
        response.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-store" });
        response.end(bytes);
    } catch (error) {
        response.writeHead(error.code === "ENOENT" ? 404 : 400, { "Content-Type": "text/plain" });
        response.end(error.message);
    }
});

const totalSamples = countPlannedSamples(outputs);

await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
const browser = await chromium.launch({ headless: true });
const hashes = {};
const outputRecords = [];
const captureStartedAtMs = Date.now();
try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    page.on("console", (message) => process.stderr.write(`browser:${message.type()}: ${message.text()}\n`));
    page.on("pageerror", (error) => process.stderr.write(`browser:error: ${error.stack || error.message}\n`));
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(() => window.experimentOneCaptureReady === true);
    const progress = createProgressTracker(totalSamples);
    progress.write({ newline: true });
    for (const output of outputs) {
        const outputStartedAtMs = Date.now();
        const settings = await page.evaluate((config) => window.prepareExperimentOneCapture(config), output);
        const record = {
            ...output,
            stage: "measured-camera-capture",
            rendererId: output.candidateId === "b4-browser" ? "pbr-mesh@2" : "pbr-mesh@1",
            rendererSettings: settings.recipe,
            lightingSettings: {
                lighting: settings.recipe.lighting,
                shadows: settings.recipe.shadows,
                appliedLightOverrides: settings.appliedLightOverrides,
            },
            files: {},
        };
        for (const viewpoint of EXPERIMENT_ONE_VIEWPOINTS) {
            await capture(page, output, "stills", viewpoint.id, viewpoint.pose, 0, record.files, progress);
        }
        if (output.includePaths) {
            for (const pathDocument of EXPERIMENT_ONE_PATHS) {
                for (const sample of pathDocument.samples) {
                    await capture(
                        page,
                        output,
                        pathDocument.id,
                        String(sample.sampleIndex).padStart(4, "0"),
                        sample.pose,
                        sample.captureTimeNs,
                        record.files,
                        progress,
                    );
                }
            }
        }
        const wallClockDurationMs = Date.now() - outputStartedAtMs;
        const sampleCount = Object.keys(record.files).length;
        record.capturePerformance = {
            wallClockDurationMs,
            sampleCount,
            samplesPerSecond: sampleCount / (wallClockDurationMs / 1000),
        };
        Object.assign(hashes, record.files);
        outputRecords.push(record);
        process.stderr.write(`${output.id}: ${Object.keys(record.files).length} PNGs\n`);
    }
    progress.finish();
} finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
}

const manifest = {
    kind: "cev-sim.visual-lab-browser-capture-manifest",
    version: 1,
    caseId: "experiment-1-room",
    renderer: {
        library: "three",
        version: THREE_VERSION,
        backend: "WebGLRenderer",
        captureContract: "AlignedCaptureProducts@1",
        antialias: false,
        pixelRatio: 1,
    },
    completeMotionSchedules: full,
    image: { width: WIDTH, height: HEIGHT, mediaType: "image/png" },
    capturePerformance: {
        wallClockDurationMs: Date.now() - captureStartedAtMs,
        sampleCount: Object.keys(hashes).length,
        samplesPerSecond: Object.keys(hashes).length / ((Date.now() - captureStartedAtMs) / 1000),
    },
    outputs: outputRecords,
    files: Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))),
};
await atomicWrite(path.join(OUTPUT_ROOT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await atomicWrite(GENERATED_MODULE, `// Generated by scripts/generate-experiment-one-browser.mjs.\nexport const EXPERIMENT_ONE_BROWSER_MEDIA_MANIFEST = Object.freeze(${JSON.stringify(manifest, null, 4)});\n`);
console.log(`Recorded ${Object.keys(hashes).length} measured Experiment 1 browser PNGs.`);

async function capture(page, output, group, sampleId, pose, captureTimeNs, fileHashes, progressTracker) {
    const outputPath = path.join(OUTPUT_ROOT, output.candidateId, output.id, group, `${sampleId}.png`);
    const label = `${output.id}/${group}/${sampleId}`;
    const startedAtMs = Date.now();
    const encoded = await page.evaluate((input) => window.captureExperimentOneFrame(input), { pose, captureTimeNs });
    const bytes = Buffer.from(encoded, "base64");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, bytes);
    const url = `/${path.relative(path.join(ROOT, "public"), outputPath).split(path.sep).join("/")}`;
    fileHashes[url] = createHash("sha256").update(bytes).digest("hex");
    progressTracker.record("render", (Date.now() - startedAtMs) / 1000, label);
}

function countPlannedSamples(plannedOutputs) {
    let total = 0;
    for (const output of plannedOutputs) {
        total += EXPERIMENT_ONE_VIEWPOINTS.length;
        if (output.includePaths) {
            for (const pathDocument of EXPERIMENT_ONE_PATHS) total += pathDocument.samples.length;
        }
    }
    return total;
}

function createProgressTracker(total) {
    const startedAtMs = Date.now();
    let done = 0;
    let renderedCount = 0;
    let skippedCount = 0;
    let remainingRenders = total;
    let renderSecondsTotal = 0;
    let lastIntegerPercent = -1;
    let lastLabel = "starting";
    let progressPrinted = false;

    const write = ({ newline = false } = {}) => {
        const percent = total > 0 ? (100 * done) / total : 100;
        const integerPercent = Math.floor(percent);
        const elapsedSeconds = (Date.now() - startedAtMs) / 1000;
        const meanRenderSeconds = renderedCount > 0 ? renderSecondsTotal / renderedCount : null;
        const remainingText = meanRenderSeconds == null
            ? "calculating…"
            : `~${formatDuration(remainingRenders * meanRenderSeconds)}`;
        const meanText = meanRenderSeconds == null ? "n/a" : `${meanRenderSeconds.toFixed(1)}s/frame`;
        const line = [
            `${percent.toFixed(1)}%`,
            `(${done}/${total})`,
            `rendered ${renderedCount}`,
            `skipped ${skippedCount}`,
            meanText,
            `elapsed ${formatDuration(elapsedSeconds)}`,
            `remaining ${remainingText}`,
            lastLabel,
        ].join("  ");
        if (process.stdout.isTTY) {
            process.stdout.write(newline ? `${line}\n` : `\r${line}\x1b[K`);
        } else if (newline) {
            process.stdout.write(`${line}\n`);
        }
        progressPrinted = true;
        lastIntegerPercent = integerPercent;
    };

    return {
        write,
        record(kind, seconds, label) {
            done += 1;
            lastLabel = label;
            if (kind === "render") {
                renderedCount += 1;
                renderSecondsTotal += Number.isFinite(seconds) ? seconds : 0;
                remainingRenders = Math.max(0, remainingRenders - 1);
            } else if (kind === "skip") {
                skippedCount += 1;
            }
            const integerPercent = Math.floor(total > 0 ? (100 * done) / total : 100);
            write({ newline: integerPercent !== lastIntegerPercent || done >= total });
        },
        finish() {
            if (progressPrinted && process.stdout.isTTY) process.stdout.write("\n");
        },
    };
}

function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    if (minutes > 0) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
    return `${remainder}s`;
}

async function atomicWrite(filePath, contents) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, contents);
    await fs.rename(temporary, filePath);
}

function contentType(filePath) {
    if (/\.m?js$/.test(filePath)) return "text/javascript; charset=utf-8";
    if (filePath.endsWith(".json")) return "application/json";
    if (filePath.endsWith(".glb")) return "model/gltf-binary";
    if (filePath.endsWith(".png")) return "image/png";
    return "application/octet-stream";
}
