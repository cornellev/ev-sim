import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import {
    SharedTensorArena,
    validateSharedTensorReference,
} from "../server/headless/SharedTensorArena.js";
import {
    externalizeTensorMap,
    materializeTensorMap,
} from "../server/headless/SharedTensorTransport.js";

test("shared tensor arena round-trips data and rejects stale generations, specs, and tokens", async () => {
    const arena = await SharedTensorArena.create({ environmentToken: "test", sizeBytes: 12 * 1024 });
    const region = arena.regionName;
    const spec = { dtype: 4, shape: [4], byteOrder: 1 };
    try {
        const first = await arena.publishTensor(Uint8Array.of(1, 2, 3, 4), spec, {
            generation: 1,
            sequence: 1,
        });
        const token = region.split(/[\\/]/).at(-1);
        assert.deepEqual(
            [...await validateSharedTensorReference(first, { environmentToken: token, spec })],
            [1, 2, 3, 4],
        );
        await assert.rejects(
            () => validateSharedTensorReference(first, { environmentToken: "wrong", spec }),
            /environment token/,
        );
        await assert.rejects(
            () => validateSharedTensorReference(first, {
                environmentToken: token,
                spec: { ...spec, shape: [2, 2] },
            }),
            /specification hash/,
        );
        await assert.rejects(
            () => validateSharedTensorReference({ ...first, offsetBytes: "1" }, { environmentToken: token, spec }),
            /bounds/,
        );
        await assert.rejects(
            () => validateSharedTensorReference({ ...first, sequence: "2" }, { environmentToken: token, spec }),
            /generation, sequence, or length/,
        );
        const latest = await arena.publishTensor(Uint8Array.of(5, 6, 7, 8), spec, {
            generation: 4,
            sequence: 4,
        });
        await assert.rejects(
            () => validateSharedTensorReference(first, { environmentToken: token, spec }),
            /generation, sequence, or length/,
        );
        const file = await fs.open(region, "r+");
        try {
            await file.write(Uint8Array.of(0), 0, 1, Number(latest.offsetBytes) - 192);
        } finally {
            await file.close();
        }
        await assert.rejects(
            () => validateSharedTensorReference(latest, { environmentToken: token, spec }),
            /magic/,
        );
        await fs.truncate(region, 128);
        await assert.rejects(
            () => validateSharedTensorReference(latest, { environmentToken: token, spec }),
            /region or bounds/,
        );
    } finally {
        await arena.close();
    }
    await assert.rejects(() => fs.stat(region), { code: "ENOENT" });
});

test("mixed tensor maps externalize only payloads of at least 64 KiB", async () => {
    const arena = await SharedTensorArena.create({ environmentToken: "mixed", sizeBytes: 512 * 1024 });
    try {
        const map = {
            entries: [
                {
                    name: "large",
                    tensor: {
                        spec: { dtype: 4, shape: [65536], byteOrder: 1 },
                        payload: { packedData: new Uint8Array(65536).fill(7) },
                    },
                },
                {
                    name: "small",
                    tensor: {
                        spec: { dtype: 4, shape: [3], byteOrder: 1 },
                        payload: { packedData: Uint8Array.of(1, 2, 3) },
                    },
                },
            ],
        };
        await externalizeTensorMap(map, arena, { generation: 1, sequence: 1 });
        assert.ok(map.entries[0].tensor.payload.sharedMemory);
        assert.deepEqual([...map.entries[1].tensor.payload.packedData], [1, 2, 3]);
        await materializeTensorMap(map, arena);
        assert.equal(map.entries[0].tensor.payload.sharedMemory, undefined);
        assert.equal(map.entries[0].tensor.payload.packedData.byteLength, 65536);
    } finally {
        await arena.close();
    }
});

test("retained queue handles survive response generations and concurrent writes use distinct slots", async () => {
    const arena = await SharedTensorArena.create({ environmentToken: "retained", sizeBytes: 256 * 1024 });
    const spec = { dtype: 4, shape: [8192], byteOrder: 1 };
    try {
        const retained = await arena.publishTensor(new Uint8Array(8192).fill(9), spec, {
            generation: 1,
            sequence: 1,
            retained: true,
        });
        const concurrent = await Promise.all(Array.from({ length: 4 }, (_, index) => arena.publishTensor(
            new Uint8Array(8192).fill(index + 1),
            spec,
            { generation: 2, sequence: 2 },
        )));
        assert.equal(new Set(concurrent.map((entry) => entry.offsetBytes)).size, concurrent.length);
        for (let generation = 3; generation <= 8; generation += 1) {
            await arena.publishTensor(new Uint8Array(8192).fill(generation), spec, {
                generation,
                sequence: generation,
            });
        }
        const token = arena.regionName.split(/[\\/]/).at(-1);
        const value = await validateSharedTensorReference(retained, { environmentToken: token, spec });
        assert.equal(value[0], 9);
        assert.equal(await arena.retain(retained), true);
        assert.equal(await arena.release(retained), true);
        assert.equal((await validateSharedTensorReference(retained, { environmentToken: token, spec }))[0], 9);
        assert.equal(await arena.release(retained), true);
        await assert.rejects(
            () => validateSharedTensorReference(retained, { environmentToken: token, spec }),
            /magic/,
        );
    } finally {
        await arena.close();
    }
});
