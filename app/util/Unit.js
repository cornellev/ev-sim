
/**
 * Unit utility (Java -> JS conversion).
 * Represents a length value stored internally in meters and
 * provides conversions to/from common units.
 */
export default class Unit {
    /**
     * Create a Unit.
     * - If `type` is omitted the `value` is treated as meters.
     * - If `type` is provided `value` is interpreted in that unit.
     * @param {number} value value in meters or in the given type
     * @param {object} [type] one of Unit.Type entries
     */
    constructor(value = 0, type) {
        if (type === undefined) {
            this.inMeters = value;
        } else {
            this.inMeters = Unit.Type.convertToMeters(type, value);
        }
    }

    static zero() {
        return new Unit(0);
    }

    /**
     * Get the value in the given unit. If `type` is omitted returns meters.
     * @param {object} [type]
     * @returns {number}
     */
    getValue(type) {
        if (type === undefined) return this.inMeters;
        return Unit.Type.convertFromMeters(type, this.inMeters);
    }
}

// Define unit types and conversion helpers
Unit.Type = (() => {
    const types = {
        METER: { conversionToMeters: 1 },
        CENTIMETER: { conversionToMeters: 0.01 },
        MILLIMETER: { conversionToMeters: 0.001 },
        KILOMETER: { conversionToMeters: 1000 },
        INCH: { conversionToMeters: 0.0254 },
        FOOT: { conversionToMeters: 0.3048 },
        YARD: { conversionToMeters: 0.9144 },
        MILE: { conversionToMeters: 1609.34 }
    };

    types.convertToMeters = (type, value) => value * type.conversionToMeters;
    types.convertFromMeters = (type, value) => value / type.conversionToMeters;
    types.c = (type, value) => new Unit(value, type);

    // convenience: attach `c` to each type entry like the Java enum method
    Object.keys(types).forEach((k) => {
        const entry = types[k];
        if (entry && typeof entry === 'object' && entry.conversionToMeters !== undefined) {
            entry.c = (value) => new Unit(value, entry);
        }
    });

    return Object.freeze(types);
})();
