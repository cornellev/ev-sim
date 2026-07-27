export function downsampleMinMax(samples, maxPoints = 2000) {
    const limit = Math.max(2, Math.floor(Number(maxPoints) || 2));
    if (!Array.isArray(samples) || samples.length <= limit) return samples || [];

    const firstTime = Number(samples[0]?.timeUs || 0);
    const lastTime = Number(samples.at(-1)?.timeUs || firstTime);
    if (lastTime <= firstTime) {
        const stride = Math.ceil(samples.length / limit);
        const result = samples.filter((_sample, index) => index % stride === 0).slice(0, limit - 1);
        result.push(samples.at(-1));
        return result;
    }

    const bucketCount = Math.max(1, Math.floor((limit - 2) / 2));
    const bucketDuration = (lastTime - firstTime) / bucketCount;
    const result = [samples[0]];
    let index = 1;

    for (let bucket = 0; bucket < bucketCount && index < samples.length - 1; bucket += 1) {
        const bucketEnd = bucket === bucketCount - 1
            ? lastTime
            : firstTime + (bucket + 1) * bucketDuration;
        let minimum = null;
        let maximum = null;
        while (index < samples.length - 1 && Number(samples[index].timeUs || 0) <= bucketEnd) {
            const sample = samples[index++];
            if (typeof sample.value !== "number" || !Number.isFinite(sample.value)) continue;
            if (!minimum || sample.value < minimum.value) minimum = sample;
            if (!maximum || sample.value > maximum.value) maximum = sample;
        }
        if (minimum && maximum) {
            if (minimum === maximum) result.push(minimum);
            else if (Number(minimum.timeUs || 0) <= Number(maximum.timeUs || 0)) result.push(minimum, maximum);
            else result.push(maximum, minimum);
        }
    }

    if (result.at(-1) !== samples.at(-1)) result.push(samples.at(-1));
    return result.slice(0, limit);
}
