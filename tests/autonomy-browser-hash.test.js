import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { catalogHash } from '../app/autonomy/AutonomyContractCatalog.js';
import { calibrationBundleHash } from '../app/autonomy/CalibrationBundle.js';
import { canonicalStringify } from '../app/simulation/canonicalJson.js';

test('browser-safe SHA-256 preserves the v6 autonomy catalog contract', () => {
    assert.equal(catalogHash(), 'f7ff2af732f9ebd1500cafb4762ca2786fb850fc89905b12fa5c58bc96f4d136');
});

test('browser-safe calibration hashing matches Node hashing byte for byte', () => {
    const sample = { version: 1, frames: [{ x: -0.1, yaw: 0.5 }], label: 'LiDAR' };
    const reference = createHash('sha256').update(canonicalStringify(sample)).digest('hex');
    assert.equal(calibrationBundleHash({ ...sample, hash: 'excluded' }), reference);
});
