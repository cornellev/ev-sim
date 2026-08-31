export function resolveFixedStepSensorSchedule(config = {}, clock = {}, manifestStepNs = null) {
    const inferredStepNs = Number(clock.timeNs) / Math.max(1, Number(clock.step));
    const requestedStepNs = Number(manifestStepNs ?? inferredStepNs);
    const stepNs = Math.max(1, Math.round(Number.isFinite(requestedStepNs) ? requestedStepNs : 16_666_667));
    const periodNs = Math.max(1, Math.round(1e9 / Math.max(Number.EPSILON, Number(config.rateHz))));
    const periodSteps = Math.max(1, Math.round(periodNs / stepNs));
    const phaseSteps = Math.max(0, Math.round(Number(config.phaseNs || 0) / stepNs));
    return {
        stepNs,
        periodNs,
        periodSteps,
        phaseSteps,
        nextCaptureStep: phaseSteps > 0 ? phaseSteps : periodSteps,
    };
}

export function resolveSensorDelivery(config = {}, captureTimeNs, rng, stepNs = 16_666_667) {
    const jitterNs = Math.max(0, Number(config.latency?.jitterNs || 0));
    const signedJitterNs = jitterNs > 0 ? Math.round((rng.next() * 2 - 1) * jitterNs) : 0;
    const fixedLatencyNs = Math.max(0, Number(config.latency?.fixedNs || 0));
    const scheduledDeliveryTimeNs = captureTimeNs + fixedLatencyNs;
    const deliveryTimeNs = Math.max(captureTimeNs, scheduledDeliveryTimeNs + signedJitterNs);
    return {
        fixedLatencyNs,
        jitterNs,
        signedJitterNs,
        scheduledDeliveryTimeNs,
        deliveryTimeNs,
        captureStep: Math.round(captureTimeNs / stepNs),
        scheduledDeliveryStep: Math.round(scheduledDeliveryTimeNs / stepNs),
    };
}
