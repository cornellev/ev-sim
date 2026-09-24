import { topicFromContract } from "../../app/autonomy/AutonomyContractCatalog.js";
import { resolveFixedStepSensorSchedule } from "../../app/simulation/sensors/FixedStepSensorSchedule.js";
import { createRunSensor } from "../../app/simulation/sensors/SensorTypeRegistry.js";
import { defaultCameraRenderSelection } from "../../app/simulation/render/RenderSceneProviderRegistry.js";
import { VISUAL_CAMERA_PRODUCT_PROFILE, VISUAL_RENDER_PROVIDERS } from "../../app/simulation/visual/VisualLayer.js";
import { POLICY_ACTION_TAPE_KIND, POLICY_ACTION_TAPE_VERSION, validatePolicyActionTape } from "./HeadlessRunner.js";

export const CLIP_DURATION_NS = 4_000_000_000;
export const CLIP_WIDTH = 1280;
export const CLIP_HEIGHT = 720;
export const COSMOS_STEP_NS = 11_111_111;
export const COSMOS_MAX_STEPS = 363;
export const COSMOS_FRAME_COUNT = 121;
export const COSMOS_RATE_HZ = 30;
export const MAX_CLIP_DURATION_NS = 120_000_000_000;
const VIEWPORT_CAMERA_ID = "viewport-camera";

const PBR_RENDER = Object.freeze({
    provider: Object.freeze({
        id: VISUAL_RENDER_PROVIDERS.pbrMesh.id,
        version: VISUAL_RENDER_PROVIDERS.pbrMesh.version,
    }),
    productProfile: Object.freeze({
        id: VISUAL_CAMERA_PRODUCT_PROFILE.id,
        version: VISUAL_CAMERA_PRODUCT_PROFILE.version,
    }),
});

const CLIP_PRODUCTS = Object.freeze({
    rgb: true,
    cameraInfo: true,
    depth: true,
    semantic: false,
    instance: false,
    detections2d: false,
    detections3d: false,
    lanes: false,
    trafficControls: false,
    diagnostics: false,
});

export class ClipRequestError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = "ClipRequestError";
        this.status = status;
    }
}

function renderSelection(renderer) {
    if (renderer === "pbr") {
        return {
            provider: { ...PBR_RENDER.provider },
            productProfile: { ...PBR_RENDER.productProfile },
        };
    }
    return defaultCameraRenderSelection();
}

export function scaleCameraCalibration(camera, width, height) {
    const calibration = structuredClone(camera.calibration || {});
    const authoredWidth = Math.max(1, Number(calibration.width) || 1);
    const authoredHeight = Math.max(1, Number(calibration.height) || 1);
    const sx = width / authoredWidth;
    const sy = height / authoredHeight;
    const intrinsics = calibration.intrinsics || {};
    return {
        ...camera,
        calibration: {
            ...calibration,
            width,
            height,
            verticalFovDeg: calibration.verticalFovDeg,
            intrinsics: {
                ...intrinsics,
                fx: Number(intrinsics.fx || 0) * sx,
                fy: Number(intrinsics.fy || 0) * sy,
                cx: Number(intrinsics.cx || 0) * sx,
                cy: Number(intrinsics.cy || 0) * sy,
            },
        },
    };
}

export function createViewportCamera(snapshot, {
    width = CLIP_WIDTH,
    height = CLIP_HEIGHT,
    rateHz = COSMOS_RATE_HZ,
    renderer = "pbr",
} = {}) {
    if (!snapshot || snapshot.kind !== "viewport") {
        throw new ClipRequestError("A viewport camera snapshot is required.");
    }
    const map = snapshot.attachment === "map";
    if (!map && snapshot.attachment !== "vehicle") {
        throw new ClipRequestError('Viewport attachment must be "map" or "vehicle".');
    }
    if (!map && !snapshot.parentId) {
        throw new ClipRequestError("A vehicle viewport camera requires parentId.");
    }
    const verticalFovDeg = Number(snapshot.projection?.verticalFovDeg);
    const near = Number(snapshot.projection?.near);
    const far = Number(snapshot.projection?.far);
    if (!(verticalFovDeg > 0) || !(near > 0) || !(far > near)) {
        throw new ClipRequestError("Viewport projection requires a positive field of view and near < far.");
    }
    return createRunSensor("camera", {
        id: VIEWPORT_CAMERA_ID,
        ...(map ? { poseReference: "map" } : { parentId: snapshot.parentId }),
        pose: snapshot.mountPose,
        rateHz,
        render: renderSelection(renderer),
        calibration: {
            width,
            height,
            verticalFovDeg,
            near,
            far,
            distortionModel: "none",
            distortion: [0, 0, 0, 0, 0],
            products: { ...CLIP_PRODUCTS },
        },
        outputs: {
            imageTopicId: `${VIEWPORT_CAMERA_ID}-image`,
            cameraInfoTopicId: `${VIEWPORT_CAMERA_ID}-info`,
            depthTopicId: `${VIEWPORT_CAMERA_ID}-depth`,
        },
        noise: {
            model: "none",
            standardDeviation: 0,
            bias: 0,
            dropoutProbability: 0,
            pointDropoutProbability: 0,
        },
    });
}

function captureCount(camera, clock) {
    const schedule = resolveFixedStepSensorSchedule(camera, {
        timeNs: clock.stepNs * clock.maxSteps,
        step: clock.maxSteps,
    }, clock.stepNs);
    if (schedule.nextCaptureStep > clock.maxSteps) return 0;
    return Math.floor((clock.maxSteps - schedule.nextCaptureStep) / schedule.periodSteps) + 1;
}

function ensureTopic(manifest, contractId, id) {
    if ((manifest.topics || []).some((topic) => topic.id === id)) return;
    manifest.topics.push(topicFromContract(contractId, {
        id,
        name: `/${String(id).replaceAll("-", "_")}`,
    }));
}

function applyClipCamera(camera, { width, height, renderer, cosmos }) {
    const scaled = scaleCameraCalibration(camera, width, height);
    scaled.enabled = true;
    scaled.render = renderSelection(renderer);
    scaled.calibration = {
        ...scaled.calibration,
        products: { ...CLIP_PRODUCTS },
        ...(cosmos ? { distortionModel: "none", distortion: [] } : {}),
    };
    if (cosmos) {
        scaled.rateHz = COSMOS_RATE_HZ;
        scaled.phaseNs = 0;
        scaled.noise = {
            model: "none",
            standardDeviation: 0,
            bias: 0,
            dropoutProbability: 0,
            pointDropoutProbability: 0,
        };
    }
    const imageTopicId = scaled.outputs?.imageTopicId || `${scaled.id}-image`;
    const cameraInfoTopicId = scaled.outputs?.cameraInfoTopicId || `${scaled.id}-info`;
    const depthTopicId = scaled.outputs?.depthTopicId || `${scaled.id}-depth`;
    scaled.outputs = { imageTopicId, cameraInfoTopicId, depthTopicId };
    return scaled;
}

function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ClipRequestError(`${label} must be a positive integer.`);
    }
    return value;
}

export class ClipBundleResolver {
    constructor({ storage, assertRenderer = async () => {} } = {}) {
        if (!storage) throw new Error("ClipBundleResolver requires storage.");
        this.storage = storage;
        this.assertRenderer = assertRenderer;
    }

    async preflight(request) {
        try {
            const derived = await this.resolve(request);
            return { ok: true, status: 200, issues: [], resolution: derived.summary };
        } catch (error) {
            return {
                ok: false,
                status: error.status || 400,
                issues: [error.message],
                resolution: null,
            };
        }
    }

    async resolve(request) {
        if (!request || typeof request !== "object") {
            throw new ClipRequestError("A clip request is required.");
        }
        if (request.profile !== "environment" && request.profile !== "cosmos-nano") {
            throw new ClipRequestError('Clip profile must be "environment" or "cosmos-nano".');
        }
        const cosmos = request.profile === "cosmos-nano";
        const manifestId = String(request.manifestId || "").trim();
        if (!manifestId) throw new ClipRequestError("manifestId is required.");
        const stored = await this.storage.getRunManifest(manifestId);
        if (!stored) throw new ClipRequestError(`Run manifest "${manifestId}" does not exist.`, 404);
        if (request.expectedManifestRevision != null
            && Number(stored.revision) !== Number(request.expectedManifestRevision)) {
            throw new ClipRequestError(
                `Run manifest "${manifestId}" revision is ${stored.revision}, not ${request.expectedManifestRevision}.`,
                409,
            );
        }
        const renderer = request.renderer ?? (cosmos ? "analytic" : "pbr");
        if (renderer !== "analytic" && renderer !== "pbr") {
            throw new ClipRequestError('Renderer must be "analytic" or "pbr".');
        }
        const width = request.width == null ? CLIP_WIDTH : positiveInteger(Number(request.width), "width");
        const height = request.height == null ? CLIP_HEIGHT : positiveInteger(Number(request.height), "height");
        if (width > 4096 || height > 4096) throw new ClipRequestError("Clip dimensions cannot exceed 4096.");
        if (cosmos && (width !== CLIP_WIDTH || height !== CLIP_HEIGHT)) {
            throw new ClipRequestError("cosmos-nano clips are fixed at 1280×720.");
        }
        const durationNs = request.durationNs == null
            ? (cosmos ? COSMOS_STEP_NS * COSMOS_MAX_STEPS : CLIP_DURATION_NS)
            : positiveInteger(Number(request.durationNs), "durationNs");
        if (durationNs > MAX_CLIP_DURATION_NS) {
            throw new ClipRequestError("Clip duration exceeds 120 seconds.");
        }
        if (cosmos && durationNs !== COSMOS_STEP_NS * COSMOS_MAX_STEPS) {
            throw new ClipRequestError("cosmos-nano clips use the fixed 363-step timing contract.");
        }

        const manifest = structuredClone(stored);
        const cameraRequest = request.camera;
        if (!cameraRequest || (cameraRequest.kind !== "manifest" && cameraRequest.kind !== "viewport")) {
            throw new ClipRequestError('Camera kind must be "manifest" or "viewport".');
        }
        if (cameraRequest.kind === "viewport" && cameraRequest.environmentId !== manifest.environment?.id) {
            throw new ClipRequestError(
                `Viewport environment "${cameraRequest.environmentId}" does not match manifest environment "${manifest.environment?.id}".`,
            );
        }
        const vehicles = new Set((manifest.initialState?.vehicles || []).map((entry) => entry.id));
        if (cameraRequest.kind === "viewport" && cameraRequest.attachment === "vehicle" && !vehicles.has(cameraRequest.parentId)) {
            throw new ClipRequestError(`Viewport follow target "${cameraRequest.parentId}" is not a run vehicle.`);
        }

        let clipCamera = cameraRequest.kind === "viewport"
            ? createViewportCamera(cameraRequest, { width, height, renderer })
            : (manifest.sensorRig.sensors || []).find((sensor) => sensor.id === cameraRequest.cameraId && sensor.type === "camera");
        if (!clipCamera) {
            throw new ClipRequestError(`Run manifest "${manifestId}" has no camera "${cameraRequest.cameraId}".`);
        }
        if ((manifest.sensorRig.sensors || []).some((sensor) => sensor.id === VIEWPORT_CAMERA_ID) && cameraRequest.kind === "viewport") {
            throw new ClipRequestError(`Run manifest already contains camera "${VIEWPORT_CAMERA_ID}".`);
        }
        clipCamera = applyClipCamera(clipCamera, { width, height, renderer, cosmos });
        manifest.sensorRig.sensors = (manifest.sensorRig.sensors || [])
            .filter((sensor) => sensor.id !== clipCamera.id)
            .map((sensor) => (sensor.type === "camera" ? { ...sensor, enabled: false } : sensor));
        manifest.sensorRig.sensors.push(clipCamera);
        ensureTopic(manifest, "front-camera-image", clipCamera.outputs.imageTopicId);
        ensureTopic(manifest, "front-camera-info", clipCamera.outputs.cameraInfoTopicId);
        ensureTopic(manifest, "front-camera-depth", clipCamera.outputs.depthTopicId);
        const syncGroup = (manifest.sensorRig.syncGroups || []).find((group) => group.id === clipCamera.syncGroupId);
        if (syncGroup) {
            for (const topicId of Object.values(clipCamera.outputs)) {
                if (!syncGroup.topicIds.includes(topicId)) syncGroup.topicIds.push(topicId);
            }
        }
        const stepNs = cosmos ? COSMOS_STEP_NS : Math.max(1, Number(manifest.clock?.stepNs) || 16_666_667);
        const maxSteps = cosmos ? COSMOS_MAX_STEPS : Math.ceil(durationNs / stepNs);
        manifest.clock = {
            ...manifest.clock,
            stepNs,
            pacing: "unbounded",
            maxSteps,
        };
        manifest.logging = { policy: "required", profileId: "simulation-run-full-sensors" };

        const authority = manifest.controls?.authority === "reference" ? "reference" : "candidate";
        const tape = request.actionTape ?? null;
        if (authority === "reference" && tape != null) {
            throw new ClipRequestError("Reference clips follow the scenario controller and reject an action tape.");
        }
        let actionTape = null;
        if (authority === "candidate") {
            if (tape == null) {
                throw new ClipRequestError("Candidate clips require a cev-sim.headless.policy-action-tape@1 action tape.");
            }
            if (Object.hasOwn(tape, "episodeSpec")) {
                throw new ClipRequestError("Candidate action tapes may not override episodeSpec.");
            }
            let validated;
            try {
                validated = validatePolicyActionTape(tape);
            } catch (error) {
                throw new ClipRequestError(error.message || `Expected ${POLICY_ACTION_TAPE_KIND} version ${POLICY_ACTION_TAPE_VERSION}.`);
            }
            if (validated.actions.length !== maxSteps) {
                throw new ClipRequestError(`Candidate action tape must contain exactly ${maxSteps} actions.`);
            }
            actionTape = validated;
        }

        let resolved;
        try {
            resolved = await this.storage.resolveRunManifest(manifestId, { manifest });
        } catch (error) {
            throw new ClipRequestError(error.message || "The clip manifest could not be resolved.");
        }
        const resolvedEnvironmentId = resolved.environment?.manifest?.environmentId || resolved.manifest.environment.id;
        if (cameraRequest.kind === "viewport" && cameraRequest.environmentId !== resolvedEnvironmentId) {
            throw new ClipRequestError(
                `Viewport environment "${cameraRequest.environmentId}" does not match resolved environment "${resolvedEnvironmentId}".`,
            );
        }
        if (renderer === "pbr") {
            const provider = resolved.renderScene?.description?.provider;
            if (provider?.id !== "pbr-mesh" || provider.version !== 1) {
                throw new ClipRequestError("PBR clips require pbr-mesh@1 and do not fall back to analytic rendering.");
            }
            if (!resolved.visualLayer?.description) {
                throw new ClipRequestError("PBR clips require a resolved visual layer.");
            }
        }
        try {
            await this.assertRenderer(renderer, resolved);
        } catch (error) {
            if (error instanceof ClipRequestError) throw error;
            throw new ClipRequestError(error.message || "The requested renderer is unavailable.", error.status || 400);
        }
        const resolvedCamera = resolved.manifest.sensorRig.sensors.find((sensor) => sensor.id === clipCamera.id);
        const frames = captureCount(resolvedCamera, resolved.manifest.clock);
        if (cosmos && frames !== COSMOS_FRAME_COUNT) {
            throw new ClipRequestError(`cosmos-nano clips must capture ${COSMOS_FRAME_COUNT} frames.`);
        }
        if (frames < 1) throw new ClipRequestError("The clip duration does not include a camera capture.");
        const summary = {
            profile: request.profile,
            manifestId,
            manifestRevision: stored.revision,
            environmentId: resolvedEnvironmentId,
            cameraSource: cameraRequest.kind,
            cameraId: clipCamera.id,
            attachment: cameraRequest.kind === "viewport" ? cameraRequest.attachment : "manifest",
            renderer,
            frameCount: frames,
            width,
            height,
            rateHz: resolvedCamera.rateHz,
            durationNs,
            requestedDurationNs: durationNs,
            maxSteps,
            stepNs,
            authority,
        };
        return {
            summary,
            resolved,
            authority,
            renderer,
            actionTape,
            episodeSpec: authority === "candidate" ? {
                actionRepeat: 1,
                maxEpisodeSteps: String(maxSteps),
            } : null,
        };
    }
}
