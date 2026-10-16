/**
 * Deterministic ABI-1 plant modules for fixtures and tests.
 * The bicycle module matches KinematicVehiclePlant's explicit Euler step.
 * sin/cos are Taylor series after a few 2π reductions, which stays inside the
 * 1e-9 trajectory tolerance for vehicle-scale angles.
 */

const F64 = 0x7c;
const I32 = 0x7f;
const OPCODE = {
    if: 0x04,
    else: 0x05,
    end: 0x0b,
    call: 0x10,
    localGet: 0x20,
    localSet: 0x21,
    localTee: 0x22,
    f64Load: 0x2b,
    f64Store: 0x39,
    i32Const: 0x41,
    i32GtS: 0x4a,
    f64Const: 0x44,
    f64Eq: 0x61,
    f64Lt: 0x63,
    f64Gt: 0x64,
    f64Abs: 0x99,
    f64Neg: 0x9a,
    f64Add: 0xa0,
    f64Sub: 0xa1,
    f64Mul: 0xa2,
    f64Div: 0xa3,
    f64Min: 0xa4,
    f64Max: 0xa5,
};

function uleb(value) {
    const bytes = [];
    let remaining = value >>> 0;
    do {
        let byte = remaining & 0x7f;
        remaining >>>= 7;
        if (remaining) byte |= 0x80;
        bytes.push(byte);
    } while (remaining);
    return bytes;
}

function bytesOf(parts) {
    return parts.flat(Infinity);
}

function section(id, body) {
    const content = bytesOf(body);
    return [id, ...uleb(content.length), ...content];
}

function vector(items) {
    return [uleb(items.length), ...bytesOf(items)];
}

function f64Const(value) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [OPCODE.f64Const, ...new Uint8Array(view.buffer)];
}

function i32Const(value) {
    return [OPCODE.i32Const, ...uleb(value)];
}

function localGet(index) {
    return [OPCODE.localGet, ...uleb(index)];
}

function localSet(index) {
    return [OPCODE.localSet, ...uleb(index)];
}

function localTee(index) {
    return [OPCODE.localTee, ...uleb(index)];
}

function loadF64(offset) {
    return [i32Const(0), OPCODE.f64Load, ...uleb(3), ...uleb(offset)];
}

function storeF64(offset, valueOps) {
    return [i32Const(0), ...bytesOf(valueOps), OPCODE.f64Store, ...uleb(3), ...uleb(offset)];
}

function ifThen(type, thenOps, elseOps = null) {
    return [
        OPCODE.if,
        type,
        ...bytesOf(thenOps),
        ...(elseOps ? [OPCODE.else, ...bytesOf(elseOps)] : []),
        OPCODE.end,
    ];
}

function fnBody(extraLocalCount, extraType, code) {
    const locals = extraLocalCount
        ? [0x01, ...uleb(extraLocalCount), extraType]
        : [0x00];
    const body = [...locals, ...bytesOf(code), OPCODE.end];
    return [...uleb(body.length), ...body];
}

function when(condition, body) {
    return [...bytesOf(condition), ...ifThen(0x40, body)];
}

function reduceLocal(index) {
    const steps = [];
    for (let count = 0; count < 6; count += 1) {
        steps.push(when(
            [localGet(index), f64Const(Math.PI), OPCODE.f64Gt],
            [localGet(index), f64Const(Math.PI * 2), OPCODE.f64Sub, localSet(index)],
        ));
        steps.push(when(
            [localGet(index), f64Const(-Math.PI), OPCODE.f64Lt],
            [localGet(index), f64Const(Math.PI * 2), OPCODE.f64Add, localSet(index)],
        ));
    }
    return steps;
}

function taylorSin(xLocal, x2, term, sum) {
    const code = [
        ...reduceLocal(xLocal),
        localGet(xLocal), localGet(xLocal), OPCODE.f64Mul, localSet(x2),
        localGet(xLocal), localTee(term), localSet(sum),
    ];
    for (let n = 1; n <= 10; n += 1) {
        const denom = (2 * n) * (2 * n + 1);
        code.push(
            localGet(term), localGet(x2), OPCODE.f64Mul, OPCODE.f64Neg,
            f64Const(denom), OPCODE.f64Div, localTee(term),
            localGet(sum), OPCODE.f64Add, localSet(sum),
        );
    }
    code.push(localGet(sum));
    return code;
}

function taylorCos(xLocal, x2, term, sum) {
    const code = [
        ...reduceLocal(xLocal),
        localGet(xLocal), localGet(xLocal), OPCODE.f64Mul, localSet(x2),
        f64Const(1), localTee(term), localSet(sum),
    ];
    for (let n = 1; n <= 10; n += 1) {
        const denom = (2 * n - 1) * (2 * n);
        code.push(
            localGet(term), localGet(x2), OPCODE.f64Mul, OPCODE.f64Neg,
            f64Const(denom), OPCODE.f64Div, localTee(term),
            localGet(sum), OPCODE.f64Add, localSet(sum),
        );
    }
    code.push(localGet(sum));
    return code;
}

function paramOr(index, fallback) {
    const offset = (13 + index) * 8;
    return [
        localGet(0), i32Const(index), OPCODE.i32GtS,
        ...ifThen(F64, loadF64(offset), f64Const(fallback)),
    ];
}

function bicycleStep() {
    const maximum = 2;
    const speed = 3;
    const steer = 4;
    const wheelbase = 5;
    const yawOffset = 4 * 8;
    const vx = 6 * 8;
    const vy = 7 * 8;
    const vz = 8 * 8;
    const ax = 9 * 8;
    const ay = 10 * 8;
    const az = 11 * 8;
    const steerOffset = 12 * 8;
    return [
        storeF64(vx, [loadF64(vx), loadF64(ax), localGet(1), OPCODE.f64Mul, OPCODE.f64Add]),
        storeF64(vy, [loadF64(vy), loadF64(ay), localGet(1), OPCODE.f64Mul, OPCODE.f64Add]),
        storeF64(vz, [loadF64(vz), loadF64(az), localGet(1), OPCODE.f64Mul, OPCODE.f64Add]),
        loadF64(vx), localSet(speed),
        ...paramOr(1, 0.6), f64Const(Math.PI * 0.49), OPCODE.f64Min, localSet(maximum),
        loadF64(steerOffset),
        localGet(maximum), OPCODE.f64Neg, OPCODE.f64Max,
        localGet(maximum), OPCODE.f64Min,
        localSet(steer),
        ...paramOr(0, 1.5), f64Const(1e-9), OPCODE.f64Max, localSet(wheelbase),
        storeF64(0, [
            loadF64(0),
            loadF64(yawOffset), OPCODE.call, ...uleb(3),
            localGet(speed), OPCODE.f64Mul,
            localGet(1), OPCODE.f64Mul,
            OPCODE.f64Add,
        ]),
        storeF64(16, [
            loadF64(16),
            loadF64(yawOffset), OPCODE.call, ...uleb(2),
            localGet(speed), OPCODE.f64Mul,
            localGet(1), OPCODE.f64Mul,
            OPCODE.f64Neg,
            OPCODE.f64Add,
        ]),
        storeF64(yawOffset, [
            loadF64(yawOffset),
            localGet(speed), localGet(wheelbase), OPCODE.f64Div,
            localGet(steer), OPCODE.call, ...uleb(2),
            localGet(steer), OPCODE.call, ...uleb(3),
            OPCODE.f64Div,
            OPCODE.f64Mul,
            localGet(1), OPCODE.f64Mul,
            OPCODE.f64Add,
        ]),
        i32Const(0),
    ];
}

function assemble(functions) {
    const types = vector([
        [0x60, 0x00, 0x01, I32],
        [0x60, 0x02, I32, F64, 0x01, I32],
        [0x60, 0x01, F64, 0x01, F64],
    ]);
    const typeIndexes = functions.map((fn) => fn.type);
    const codes = functions.map((fn) => fn.body);
    const exports = vector([
        [uleb("memory".length), ..."memory".split("").map((char) => char.charCodeAt(0)), 0x02, 0x00],
        ...functions.filter((fn) => fn.exportName).map((fn) => [
            uleb(fn.exportName.length),
            ...fn.exportName.split("").map((char) => char.charCodeAt(0)),
            0x00,
            ...uleb(fn.index),
        ]),
    ]);
    return Uint8Array.from(bytesOf([
        [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
        section(1, types),
        section(3, vector(typeIndexes.map((type) => [type]))),
        section(5, vector([[0x00, 0x01]])),
        section(7, exports),
        section(10, vector(codes)),
    ]));
}

function exportedModule(stepBody, extraLocals) {
    const sin = fnBody(3, F64, taylorSin(0, 1, 2, 3));
    const cos = fnBody(3, F64, taylorCos(0, 1, 2, 3));
    const functions = [
        { type: 0, index: 0, exportName: "cev_plant_abi", body: fnBody(0, 0, [i32Const(1)]) },
        { type: 0, index: 1, exportName: "cev_plant_buffer", body: fnBody(0, 0, [i32Const(0)]) },
        { type: 2, index: 2, exportName: null, body: sin },
        { type: 2, index: 3, exportName: null, body: cos },
        { type: 1, index: 4, exportName: "cev_plant_step", body: fnBody(extraLocals, F64, stepBody) },
    ];
    return assemble(functions);
}

export function encodeBicyclePlantModule() {
    return exportedModule(bicycleStep(), 4);
}

export function encodeNonFinitePlantModule() {
    const nan = f64Const(Number.NaN);
    return exportedModule([
        storeF64(0, [nan]),
        i32Const(0),
    ], 0);
}

export function encodeFailingPlantModule() {
    return exportedModule([i32Const(7)], 0);
}

/** Hidden counter past the public buffer. A fresh instance starts at zero. */
export function encodeCountingPlantModule() {
    const counter = 400;
    return exportedModule([
        storeF64(counter, [loadF64(counter), f64Const(1), OPCODE.f64Add]),
        storeF64(0, [loadF64(0), loadF64(counter), OPCODE.f64Add]),
        i32Const(0),
    ], 0);
}
