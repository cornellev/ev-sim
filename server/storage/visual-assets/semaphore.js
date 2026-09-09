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
    }

    release() {
        const next = this.waiters.shift();
        // Transfer the occupied permit directly to the queued waiter. Making
        // it briefly free lets a new acquire race the waiter's continuation
        // and exceed the configured concurrency ceiling.
        if (next) next();
        else this.active = Math.max(0, this.active - 1);
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
