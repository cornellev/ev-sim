import { clamp } from "three/src/math/MathUtils.js";
import { Data } from "../3d/data/Data";

export class SimulationEngine {
    /**
     * @param {Data} data 
     */
    constructor(data, options={}) {
        this.data = data;

        this.fixedDt = options.fixedDt ?? 0.016; // default to 60fps
        this.maxFrameDt = options.maxFrameDt ?? 0.1; // cap delta time to avoid instability
        this.maxSubSteps = options.maxSubSteps ?? 10; // cap sub-steps to avoid spiral of death

        this.status = 'stopped'; // ['stopped', 'playing', 'paused']
        this.time = 0;
        this.steps = 0;
        this.frames = 0;
        this.speed = 1;
        
        this.realtime = true; // whether to run in real-time (vs. as fast as possible)

        this.deterministic = true; // whether to use fixed time steps (vs. variable time steps)

        this.modules = {
            physics: false,
            vehicles: true,
            sensors: true,
            controls: true,
            rendering: true,
            environment: true,
            scripting: true,
            baking: false,
        }

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;

        this.accumulator = 0; // for fixed time step simulation
        this.lastFrameMs = 0; // for calculating delta time
        this.rafId = null; // for canceling the animation frame
        this.looping = false; // to prevent multiple simultaneous loops

        this.listeners = new Set();
        this.resetHandlers = new Set();

        this._frame = this._frame.bind(this);
    }

    configure({ scene, camera, renderer, controls = null }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.controls = controls;
    }

    getSnapshot() {
        return {
            status: this.status,
            time: this.time,
            steps: this.steps,
            frames: this.frames,
            speed: this.speed,
            realtime: this.realtime,
            deterministic: this.deterministic,
            modules: { ...this.modules }
        }
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    _emit() {
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }

    onReset(handler) {
        this.resetHandlers.add(handler);
        return () => this.resetHandlers.delete(handler);
    }

    startLoop() {
        if (this.looping) return;
        this.looping = true;
        this.lastFrameMs = performance.now();
        this.rafId = requestAnimationFrame(this._frame);
    }

    dispose() {
        this.stop();
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }

        this.controls?.dispose();
        this.listeners.clear();
        this.resetHandlers.clear();
    }

    play() {
        this.startLoop();
        this.status = 'playing';
        this._emit();
    }

    pause() {
        this.status = 'paused';
        this._emit();
    }

    stop({ reset = true} = {}) {
        this.status = 'stopped';
        this.accumulator = 0;

        if (reset) {
            this.reset();
        }

        this.render();
        this._emit();
    }

    reset() {
        this.time = 0;
        this.steps = 0;
        this.frames = 0;
        
        for (const handler of this.resetHandlers) {
            handler();
        }
    }

    step(count = 1) {
        this.status = 'paused';

        for (let i = 0; i < count; i++) {
            this._fixedStep(this.fixedDt);
        }

        this.render();
        this._emit();
    }

    setSpeed(speed) {
        this.speed = Math.max(0, Number(speed) || 0);
        this._emit();
    }

    setRealtime(realtime) {
        this.realtime = Boolean(realtime);
        this._emit();
    }

    setDeterministic(deterministic) {
        this.deterministic = Boolean(deterministic);
        this._emit();
    }

    async setPhysicsEnabled(enabled) {
        this.modules.physics = Boolean(enabled);

        if (enabled) {
            await this.data.physics()?.start?.();
        } else {
            await this.data.physics()?.stop?.();
        }

        this._emit();
    }

    setModule(name, enabled) {
        if (!(name in this.modules)) return;

        this.modules[name] = Boolean(enabled);
        this._emit();
    }

    _frame(nowMs) {
        if (!this.looping) return;

        const rawFrameDt = (nowMs - this.lastFrameMs) / 1000;
        this.lastFrameMs = nowMs;

        const frameDt = clamp(rawFrameDt, 0, this.maxFrameDt);

        if (this.controls) {
            const cameraControlsEnabled = this.modules.controls && this.data.settings()?.cameraControlsEnabled !== false;
            this.controls.enabled = cameraControlsEnabled;

            if (cameraControlsEnabled) {
                this.controls.update();
            }
        }

        if (this.status === 'playing') {
            this._advanceSimulation(frameDt);
        }

        if (this.modules.rendering) {
            this.render();
        }

        this.rafId = requestAnimationFrame(this._frame);
    }

    _advanceSimulation(frameDt) {
        const scaledDt = frameDt * this.speed;

        if (!this.deterministic) {
            this._fixedStep(scaledDt);
            return;
        }

        this.accumulator += this.realtime ? scaledDt : this.fixedDt * this.speed;

        let subSteps = 0;

        while (this.accumulator >= this.fixedDt && subSteps < this.maxSubSteps) {
            this._fixedStep(this.fixedDt);
            this.accumulator -= this.fixedDt;
            subSteps++;
        }

        if (subSteps === this.maxSubSteps) {
            // prevent death spiral by dropping remaining time
            this.accumulator = 0;
        }
    }

    _fixedStep(dt) {
        this.data.keys()?.update?.(dt);

        if (this.modules.physics) {
            this.data.physics()?.step?.(dt);
        }

        if (this.modules.vehicles) {
            this.data.vehicles()?.update?.(dt);
        }

        if (this.modules.sensors) {
            this.data.devices()?.update?.(dt);
        }

        if (this.modules.baking) {
            this.data.baking()?.update?.(dt);
        }

        this.time += dt;
        this.steps += 1;
    }

    render() {
        if (!this.scene || !this.camera || !this.renderer) return;
        
        this.renderer.render(this.scene, this.camera);
        this.frames += 1;
    }
}