export class Semaphore {
    constructor(max) {
        this.max = Math.max(0, max);
        this.active = 0;
        this.waiters = [];
    }

    async acquire() {
        if (this.active < this.max) {
            this.active += 1;
            return;
        }
        await new Promise((resolve) => this.waiters.push(resolve));
        this.active += 1;
    }

    release() {
        this.active = Math.max(0, this.active - 1);
        const next = this.waiters.shift();
        if (next) next();
    }

    async run(fn) {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}

export function createMutex() {
    let chain = Promise.resolve();
    return async (fn) => {
        const run = chain.then(fn, fn);
        chain = run.then(() => {}, () => {});
        return run;
    };
}
