import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";

import { VisualLabFixtureAdapter } from "./VisualLabFixtureAdapter.js";
import {
    VISUAL_LAB_LEGACY_PROFILE,
    addVisualLabLights,
    applyVisualLabCamera,
    configureVisualLabRenderer,
} from "./VisualLabRenderProfile.js";
import {
    applyPbrBeautyRendererPolicy,
    applyPbrRenderRecipeToScene,
} from "../3d/environment/visual/PbrRenderRecipeRuntime.js";

export class VisualLabSceneStudio {
    constructor(container, {
        detail = "detailed",
        caseDocument,
        candidate,
        output = candidate?.outputs?.[0] ?? null,
        arrangement = { transforms: [] },
        onSelect = () => {},
        onTransform = () => {},
        onViewMode = () => {},
    } = {}) {
        this.container = container;
        this.detail = detail;
        this.caseDocument = caseDocument;
        this.candidate = candidate;
        this.output = output;
        this.fixtureAdapter = new VisualLabFixtureAdapter();
        this.arrangement = arrangement;
        this.onSelect = onSelect;
        this.onTransform = onTransform;
        this.onViewMode = onViewMode;
        this.viewMode = "locked";
        this.lockedPose = null;
        this.calibration = caseDocument.calibrations[0];
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(VISUAL_LAB_LEGACY_PROFILE.background);
        this.camera = new THREE.PerspectiveCamera(48, 1, 0.05, 100);
        this.camera.position.set(-2.5, 2.1, -2.1);
        this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: true });
        configureVisualLabRenderer(this.renderer);
        this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
        container.appendChild(this.renderer.domElement);

        this.composer = new EffectComposer(this.renderer);
        this.renderPass = new RenderPass(this.scene, this.camera);
        this.outlinePass = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.camera);
        this.outlinePass.visibleEdgeColor.set(0xf0a94f);
        this.outlinePass.hiddenEdgeColor.set(0x6d421c);
        this.outlinePass.edgeStrength = 5;
        this.outlinePass.edgeGlow = 0.2;
        this.outlinePass.edgeThickness = 1.25;
        this.outlinePass.pulsePeriod = 0;
        this.outputPass = new OutputPass();
        this.composer.addPass(this.renderPass);
        this.composer.addPass(this.outlinePass);
        this.composer.addPass(this.outputPass);

        this.lights = addVisualLabLights(this.scene);
        this.recipeSceneState = null;
        this.grid = new THREE.GridHelper(8, 32, 0x6f7881, 0x30363c);
        this.grid.position.y = 0.003;
        this.grid.material.transparent = true;
        this.grid.material.opacity = 0.45;
        this.scene.add(this.grid);

        this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
        this.orbit.target.set(0, 1, 0);
        this.orbit.enableDamping = true;
        this.orbit.dampingFactor = 0.08;
        this.orbit.minDistance = 0.3;
        this.orbit.maxDistance = 15;
        this.orbit.enabled = false;
        this.orbit.addEventListener("start", this._markExploratory);

        this.transform = new TransformControls(this.camera, this.renderer.domElement);
        this.transform.setSize(0.75);
        this.transform.addEventListener("dragging-changed", (event) => {
            this.orbit.enabled = this.viewMode === "exploratory" && !event.value;
        });
        this.transform.addEventListener("objectChange", () => {
            if (this.renderer.shadowMap) this.renderer.shadowMap.needsUpdate = true;
        });
        this.transform.addEventListener("mouseUp", () => this._emitTransform());
        this.transformHelper = this.transform.getHelper();
        this.scene.add(this.transformHelper);

        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this.pointerStart = null;
        this.onPointerDown = (event) => {
            this.pointerStart = { x: event.clientX, y: event.clientY };
        };
        this.onPointerUp = (event) => {
            const start = this.pointerStart;
            this.pointerStart = null;
            if (!start || this.transform.dragging || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
            this._pick(event);
        };
        this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
        this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);

        this._replaceFixture();
        this._applyRenderRecipe();
        this.setViewMode("locked");
        this.resizeObserver = new ResizeObserver(() => this._resize());
        this.resizeObserver.observe(container);
        this._resize();
        this.disposed = false;
        this._animate();
    }

    _replaceFixture() {
        const selectionId = this.selectionId;
        this.outlinePass.selectedObjects = [];
        this.transform.detach();
        this.fixture?.dispose();
        this.fixture = this.fixtureAdapter.openBuiltIn({
            caseDocument: this.caseDocument,
            candidate: this.candidate,
            arrangement: this.arrangement,
        });
        this.scene.add(this.fixture.root);
        if (selectionId && this.fixture.objects.has(selectionId)) this.select(selectionId);
        else {
            this.selectionId = null;
            if (selectionId) this.onSelect(null);
        }
    }

    _applyRenderRecipe() {
        this.recipeSceneState?.dispose?.();
        this.recipeSceneState = null;
        const recipe = this.output?.provenance?.rendererSettings;
        const measuredRecipe = recipe?.kind === "cev-sim.pbr-render-recipe" ? recipe : null;
        for (const light of this.lights) light.visible = !measuredRecipe;
        if (!measuredRecipe) {
            configureVisualLabRenderer(this.renderer);
            this.scene.background = new THREE.Color(VISUAL_LAB_LEGACY_PROFILE.background);
            return;
        }
        this.recipeSceneState = applyPbrRenderRecipeToScene(this.scene, measuredRecipe);
        applyPbrBeautyRendererPolicy(this.renderer, this.recipeSceneState.renderPolicy);
        if (this.renderer.shadowMap) {
            this.renderer.shadowMap.autoUpdate = false;
            this.renderer.shadowMap.needsUpdate = true;
        }
        const background = measuredRecipe.background.colorRgba;
        this.scene.background = new THREE.Color(background[0], background[1], background[2]);
        this.fixture?.root?.traverse((object) => {
            if (!object.isMesh) return;
            object.castShadow = measuredRecipe.shadows.enabled;
            object.receiveShadow = measuredRecipe.shadows.enabled;
        });
    }

    setScene({ detail = this.detail, candidate = this.candidate, output = this.output, arrangement = this.arrangement } = {}) {
        this.detail = detail;
        this.candidate = candidate;
        this.output = output;
        this.arrangement = arrangement;
        this._replaceFixture();
        this._applyRenderRecipe();
    }

    setView(pose) {
        if (!pose) return;
        this.lockedPose = pose;
        if (this.viewMode === "locked") {
            applyVisualLabCamera(this.camera, this.calibration, pose);
        } else {
            this.camera.position.set(...pose.position);
            this.camera.lookAt(...pose.target);
        }
        this.orbit.target.set(...pose.target);
        this.orbit.update();
    }

    setViewMode(mode, { pose = this.lockedPose, calibration = this.calibration } = {}) {
        if (!["locked", "exploratory"].includes(mode)) {
            throw new Error(`Unsupported Visual Lab view mode "${mode}".`);
        }
        this.viewMode = mode;
        this.calibration = calibration;
        this.orbit.enabled = mode === "exploratory" && !this.transform.dragging;
        this.grid.visible = mode === "exploratory";
        this.transformHelper.visible = mode === "exploratory";
        this.outlinePass.enabled = mode === "exploratory";
        if (mode === "locked" && pose) this.setView(pose);
        this.container.dataset.viewMode = mode;
        this._resize();
        this.onViewMode(mode);
    }

    _markExploratory = () => {
        if (this.viewMode !== "exploratory") this.setViewMode("exploratory");
    };

    setMode(mode) {
        this.transform.setMode(mode);
    }

    setSnap({ translation = 0, rotationDegrees = 0, scale = 0 } = {}) {
        this.transform.setTranslationSnap(translation || null);
        this.transform.setRotationSnap(rotationDegrees ? THREE.MathUtils.degToRad(rotationDegrees) : null);
        this.transform.setScaleSnap(scale || null);
    }

    select(objectId) {
        const object = this.fixture.objects.get(objectId) ?? null;
        this.selectionId = objectId ?? null;
        this.outlinePass.selectedObjects = object ? [object] : [];
        if (object) this.container.dataset.outlineObject = objectId;
        else delete this.container.dataset.outlineObject;
        if (object?.userData.visualLabEditable) this.transform.attach(object);
        else this.transform.detach();
        this.onSelect(objectId ? {
            objectId,
            sourceObjectId: object?.userData.visualLabSourceObjectId ?? objectId,
            editable: Boolean(object?.userData.visualLabEditable),
        } : null);
    }

    _pick(event) {
        const bounds = this.renderer.domElement.getBoundingClientRect();
        this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
        this.pointer.y = -(((event.clientY - bounds.top) / bounds.height) * 2 - 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hit = this.raycaster.intersectObject(this.fixture.root, true)
            .find((entry) => entry.object.userData.visualLabObjectId);
        this.select(hit?.object?.userData?.visualLabObjectId ?? null);
    }

    _emitTransform() {
        const object = this.transform.object;
        if (!object?.userData.visualLabEditable) return;
        this.onTransform({
            objectId: object.userData.visualLabObjectId,
            sourceObjectId: object.userData.visualLabSourceObjectId,
            position: object.position.toArray().map(round),
            rotationRadians: [object.rotation.x, object.rotation.y, object.rotation.z].map(round),
            uniformScale: round(object.scale.x),
        });
    }

    _resize() {
        const containerWidth = Math.max(1, this.container.clientWidth);
        const containerHeight = Math.max(1, this.container.clientHeight);
        const calibrationAspect = this.calibration.image.width / this.calibration.image.height;
        const locked = this.viewMode === "locked";
        const width = locked
            ? Math.min(containerWidth, containerHeight * calibrationAspect)
            : containerWidth;
        const height = locked
            ? Math.min(containerHeight, containerWidth / calibrationAspect)
            : containerHeight;
        if (this.viewMode === "locked" && this.lockedPose) {
            applyVisualLabCamera(this.camera, this.calibration, this.lockedPose);
        } else {
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
        }
        Object.assign(this.renderer.domElement.style, locked ? {
            width: `${width}px`,
            height: `${height}px`,
            position: "absolute",
            left: `${(containerWidth - width) / 2}px`,
            top: `${(containerHeight - height) / 2}px`,
        } : {
            width: "100%",
            height: "100%",
            position: "absolute",
            left: "0",
            top: "0",
        });
        this.renderer.setSize(width, height, false);
        this.composer.setSize(width, height);
    }

    _animate = () => {
        if (this.disposed) return;
        this.frame = requestAnimationFrame(this._animate);
        this.orbit.update();
        this.composer.render();
    };

    dispose() {
        this.disposed = true;
        cancelAnimationFrame(this.frame);
        this.resizeObserver.disconnect();
        this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
        this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
        this.transform.detach();
        this.transform.dispose();
        this.orbit.removeEventListener("start", this._markExploratory);
        this.orbit.dispose();
        this.recipeSceneState?.dispose?.();
        this.fixture.dispose();
        this.outlinePass.selectedObjects = [];
        delete this.container.dataset.outlineObject;
        delete this.container.dataset.viewMode;
        this.outlinePass.dispose();
        this.outputPass.dispose();
        this.renderPass.dispose();
        this.composer.dispose();
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }
}

function round(value) {
    return Math.round(value * 1e6) / 1e6;
}
