export class AssetPreviewRenderer {
    constructor({ THREE = null, renderer = null, size = 256 } = {}) {
        this.THREE = THREE;
        this.renderer = renderer;
        this.size = size;
        this.queue = Promise.resolve();
    }

    render(lease, options = {}) {
        const request = this.queue.catch(() => {}).then(() => this._render(lease, options));
        this.queue = request;
        return request;
    }

    async _render(lease, { signal } = {}) {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Preview cancelled.", "AbortError");
        const THREE = this.THREE ?? await import("three");
        this.THREE = THREE;
        if (!this.renderer) {
            const canvas = document.createElement("canvas");
            canvas.width = this.size;
            canvas.height = this.size;
            this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
        }
        this.renderer.setSize(this.size, this.size, false);
        this.renderer.setPixelRatio(1);
        this.renderer.setClearColor(0x151719, 1);
        const scene = new THREE.Scene();
        const root = lease.root.clone(true);
        scene.add(root);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 1.6));
        const key = new THREE.DirectionalLight(0xffffff, 2.2);
        key.position.set(4, 6, 5);
        scene.add(key);
        const bounds = new THREE.Box3().setFromObject(root);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const radius = Math.max(size.length() * 0.5, 0.1);
        const camera = new THREE.PerspectiveCamera(32, 1, Math.max(0.01, radius / 100), radius * 20);
        camera.position.copy(center).add(new THREE.Vector3(1.5, 1.15, 1.5).normalize().multiplyScalar(radius * 3.2));
        camera.lookAt(center);
        this.renderer.render(scene, camera);
        const canvas = this.renderer.domElement;
        return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Preview PNG encoding failed."))), "image/png"));
    }

    dispose() {
        this.renderer?.dispose?.();
        this.renderer = null;
    }
}
