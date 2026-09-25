import { deepFreeze } from "../../util/cloneJson.js";

export const RANGE_IMAGE_LAYOUT_KIND = "cev-sim.range-image-layout";
export const RANGE_IMAGE_LAYOUT_VERSION = 1;
export const RANGE_IMAGE_MIN_NEAR_METERS = 1e-4;
export const DEFAULT_MAX_RANGE_IMAGE_RAYS = 16_777_216;

function object(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${path} must be an object.`);
    }
    return value;
}

function exactKeys(value, allowed, path) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) throw new TypeError(`${path} contains unknown field "${unknown}".`);
}

function finite(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${path} must be a finite number.`);
    }
    return value;
}

function angle(value, path, { minimum, maximum, maximumInclusive = false }) {
    const normalized = finite(value, path);
    if (normalized < minimum || (maximumInclusive ? normalized > maximum : normalized >= maximum)) {
        const right = maximumInclusive ? "]" : ")";
        throw new RangeError(`${path} must be in [${minimum}, ${maximum}${right}.`);
    }
    return normalized;
}

export function rangeImageDimensions(layout) {
    const channelCount = layout?.channels?.length ?? 0;
    const azimuthCount = layout?.azimuthsDeg?.length ?? 0;
    const rayCount = channelCount * azimuthCount;
    if (!Number.isSafeInteger(rayCount)) throw new RangeError("Range-image ray count exceeds safe integer arithmetic.");
    return Object.freeze({ channelCount, azimuthCount, rayCount });
}

export function checkedRangeImageBytes(layout, {
    strideFloats = 4,
    bytesPerValue = Float32Array.BYTES_PER_ELEMENT,
    maxBytes = Number.MAX_SAFE_INTEGER,
} = {}) {
    const { rayCount } = rangeImageDimensions(layout);
    if (!Number.isSafeInteger(strideFloats) || strideFloats < 1
        || !Number.isSafeInteger(bytesPerValue) || bytesPerValue < 1) {
        throw new TypeError("Range-image allocation stride must use positive safe integers.");
    }
    const values = rayCount * strideFloats;
    const bytes = values * bytesPerValue;
    if (!Number.isSafeInteger(values) || !Number.isSafeInteger(bytes) || bytes > maxBytes) {
        throw new RangeError(`Range-image allocation requires ${bytes} bytes, exceeding the ${maxBytes}-byte limit.`);
    }
    return bytes;
}

export function assertRangeImageLayout(value, {
    path = "scanLayout",
    maxRays = DEFAULT_MAX_RANGE_IMAGE_RAYS,
    maxBytes = Number.MAX_SAFE_INTEGER,
} = {}) {
    const source = object(value, path);
    exactKeys(source, ["kind", "version", "channels", "azimuthsDeg", "minRangeM", "maxRangeM"], path);
    if (source.kind !== RANGE_IMAGE_LAYOUT_KIND || source.version !== RANGE_IMAGE_LAYOUT_VERSION) {
        throw new TypeError(`${path} must be ${RANGE_IMAGE_LAYOUT_KIND} version ${RANGE_IMAGE_LAYOUT_VERSION}.`);
    }
    if (!Array.isArray(source.channels) || source.channels.length === 0) {
        throw new TypeError(`${path}.channels must be a non-empty array.`);
    }
    if (!Array.isArray(source.azimuthsDeg) || source.azimuthsDeg.length === 0) {
        throw new TypeError(`${path}.azimuthsDeg must be a non-empty array.`);
    }
    const channelIds = new Set();
    const channels = source.channels.map((entry, index) => {
        const channelPath = `${path}.channels.${index}`;
        const channel = object(entry, channelPath);
        exactKeys(channel, ["id", "elevationDeg", "azimuthOffsetDeg"], channelPath);
        if (!Number.isSafeInteger(channel.id) || channel.id < 0) {
            throw new TypeError(`${channelPath}.id must be a nonnegative safe integer.`);
        }
        if (channelIds.has(channel.id)) throw new TypeError(`${path}.channels contains duplicate id ${channel.id}.`);
        channelIds.add(channel.id);
        return {
            id: channel.id,
            elevationDeg: angle(channel.elevationDeg, `${channelPath}.elevationDeg`, {
                minimum: -90,
                maximum: 90,
                maximumInclusive: true,
            }),
            azimuthOffsetDeg: angle(channel.azimuthOffsetDeg, `${channelPath}.azimuthOffsetDeg`, {
                minimum: -180,
                maximum: 180,
            }),
        };
    });
    const azimuthsDeg = source.azimuthsDeg.map((entry, index) => angle(
        entry,
        `${path}.azimuthsDeg.${index}`,
        { minimum: -180, maximum: 180 },
    ));
    const minRangeM = finite(source.minRangeM, `${path}.minRangeM`);
    const maxRangeM = finite(source.maxRangeM, `${path}.maxRangeM`);
    if (minRangeM < RANGE_IMAGE_MIN_NEAR_METERS) {
        throw new RangeError(`${path}.minRangeM must be at least ${RANGE_IMAGE_MIN_NEAR_METERS}.`);
    }
    if (!(maxRangeM > minRangeM)) throw new RangeError(`${path}.maxRangeM must exceed minRangeM.`);
    const normalized = {
        kind: RANGE_IMAGE_LAYOUT_KIND,
        version: RANGE_IMAGE_LAYOUT_VERSION,
        channels,
        azimuthsDeg,
        minRangeM,
        maxRangeM,
    };
    const { rayCount } = rangeImageDimensions(normalized);
    if (!Number.isSafeInteger(maxRays) || maxRays < 1 || rayCount > maxRays) {
        throw new RangeError(`${path} contains ${rayCount} rays, exceeding the ${maxRays}-ray limit.`);
    }
    checkedRangeImageBytes(normalized, { maxBytes });
    return deepFreeze(normalized);
}

