/**
 * WebGL2 PIXEL_PACK helpers.
 *
 * Spark's SparkRenderer uses PBOs for splat sorting and can leave one bound.
 * A bound PIXEL_PACK buffer makes a CPU-side `gl.readPixels` throw
 * INVALID_OPERATION. Async reads bind our own PBO, then restore Spark's.
 */

/**
 * @param {import("three").WebGLRenderer | null | undefined} renderer
 * @returns {WebGL2RenderingContext | null}
 */
export function getWebGL2Context(renderer) {
    const gl = renderer?.getContext?.();
    if (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) {
        return null;
    }
    if (typeof gl.fenceSync !== "function" || typeof gl.clientWaitSync !== "function") {
        return null;
    }
    if (typeof gl.getBufferSubData !== "function") return null;
    return gl;
}

/**
 * @template T
 * @param {import("three").WebGLRenderer} renderer
 * @param {() => T} readback
 * @returns {T}
 */
export function withPixelPackBufferUnbound(renderer, readback) {
    const gl = renderer?.getContext?.();
    const isWebGL2 =
        typeof WebGL2RenderingContext !== "undefined" &&
        gl instanceof WebGL2RenderingContext;

    if (!isWebGL2) {
        return readback();
    }

    const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    if (previous) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }

    try {
        return readback();
    } finally {
        if (previous) {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
        }
    }
}

/**
 * One GPU pixel-pack buffer + fence. `begin` is non-blocking; `poll` copies
 * to CPU only after the GPU signals the fence (timeout 0 — never stalls).
 */
export class PixelPackSlot {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {number} byteLength
     */
    constructor(gl, byteLength) {
        this.gl = gl;
        this.byteLength = Math.max(1, byteLength);
        this.pbo = gl.createBuffer();
        const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, this.byteLength, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
        this.sync = null;
        this.pollAttempts = 0;
        this.begunAtMs = 0;
        this.maxPollAttempts = 240;
        this.maxAgeMs = 2000;
    }

    get pending() {
        return Boolean(this.sync);
    }

    isStale() {
        if (!this.sync) return false;
        if (this.pollAttempts >= this.maxPollAttempts) return true;
        if (this.begunAtMs > 0 && Date.now() - this.begunAtMs > this.maxAgeMs) return true;
        return false;
    }

    reset() {
        this._deleteSync();
        this.pollAttempts = 0;
        this.begunAtMs = 0;
    }

    /**
     * Issue `readPixels` into the PBO. The color framebuffer must already be bound
     * (Three.js `setRenderTarget`).
     */
    begin(x, y, width, height, format, type) {
        const gl = this.gl;
        this._deleteSync();
        this.pollAttempts = 0;
        this.begunAtMs = Date.now();
        const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        const previousAlignment = gl.getParameter(gl.PACK_ALIGNMENT);
        gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
        gl.readPixels(x, y, width, height, format, type, 0);
        gl.pixelStorei(gl.PACK_ALIGNMENT, previousAlignment);
        this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
    }

    /**
     * @param {ArrayBufferView} dest
     * @returns {boolean} true when `dest` has been filled
     */
    poll(dest) {
        if (!this.sync) return false;
        const gl = this.gl;
        this.pollAttempts += 1;
        const status = gl.clientWaitSync(this.sync, 0, 0);
        if (status === gl.TIMEOUT_EXPIRED) {
            if (this.isStale()) {
                this.reset();
            }
            return false;
        }
        this._deleteSync();
        this.pollAttempts = 0;
        this.begunAtMs = 0;
        if (status === gl.WAIT_FAILED) return false;
        const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dest);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
        return true;
    }

    dispose() {
        this.reset();
        if (this.pbo) {
            this.gl.deleteBuffer(this.pbo);
            this.pbo = null;
        }
        this.gl = null;
    }

    _deleteSync() {
        if (!this.sync || !this.gl) return;
        this.gl.deleteSync(this.sync);
        this.sync = null;
    }
}

/** Await one render-target read through a WebGL2 pixel-pack buffer and fence. */
export async function readRenderTargetPixelsWithFence(renderer, target, buffer, {
    signal = null,
    timeoutMs = 2000,
} = {}) {
    const gl = getWebGL2Context(renderer);
    if (!gl) throw new Error("Asynchronous PBR readback requires WebGL2 PBO/fence support.");
    const slot = new PixelPackSlot(gl, buffer.byteLength);
    const type = buffer instanceof Float32Array ? gl.FLOAT : gl.UNSIGNED_BYTE;
    const started = Date.now();
    try {
        signal?.throwIfAborted?.();
        slot.begin(0, 0, target.width, target.height, gl.RGBA, type);
        while (true) {
            signal?.throwIfAborted?.();
            if (gl.isContextLost?.()) throw new Error("WebGL2 context was lost during asynchronous readback.");
            if (slot.poll(buffer)) return buffer;
            if (Date.now() - started >= timeoutMs || !slot.pending) {
                throw new Error(`Asynchronous PBR readback exceeded ${timeoutMs} ms.`);
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        slot.dispose();
    }
}
