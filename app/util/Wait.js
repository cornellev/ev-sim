
export function waitFor(conditionFunc, timeout = 5000, interval = 100) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        function checkCondition() {
            if (conditionFunc()) {
                resolve();
            } else if (Date.now() - startTime >= timeout) {
                reject(new Error("Timeout waiting for condition"));
            } else {
                setTimeout(checkCondition, interval);
            }
        }

        checkCondition();
    });
}

export function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}