/** One Chromium at a time. Clip launch fails immediately; experiment cases wait. */
export class GpuTurn {
    constructor() {
        this.holder = null;
    }

    tryAcquire(name) {
        if (this.holder) return false;
        this.holder = name;
        return true;
    }

    async acquire(name, shouldAbort = () => false) {
        while (!this.tryAcquire(name)) {
            if (shouldAbort()) return false;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return true;
    }

    release(name) {
        if (this.holder === name) this.holder = null;
    }
}
