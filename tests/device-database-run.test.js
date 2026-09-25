import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

function stubDevice({ telemetryId, enabled, vehicleOwned = false, manifestManaged = false }) {
    return {
        telemetryId,
        enabled,
        vehicleOwned,
        manifestManaged,
        enabledCalls: [],
        dispose() {},
        setEnabled(value) {
            this.enabled = Boolean(value);
            this.enabledCalls.push(this.enabled);
        },
    };
}

test("configureFromManifest disables vehicle-owned sensors and disposeRun restores them", async () => {
    // VehicleDatabase loads Data before Database finishes initializing.
    // Importing DeviceDatabase first hits that cycle.
    await import("../app/3d/data/VehicleDatabase.js");
    const { DeviceDatabase } = await import("../app/3d/data/DeviceDatabase.js");
    const database = new DeviceDatabase({
        vehicles: () => ({ vehicles: [] }),
        bindings: () => null,
        scene: null,
    });
    const enabledSensor = stubDevice({ telemetryId: "roof-lidar", enabled: true, vehicleOwned: true });
    const disabledSensor = stubDevice({ telemetryId: "front-stereo", enabled: false, vehicleOwned: true });
    const runSensor = stubDevice({ telemetryId: "rig-lidar", enabled: true, manifestManaged: true });
    database.addDevice(enabledSensor);
    database.addDevice(disabledSensor);
    database.addDevice(runSensor);

    database.configureFromManifest({});

    assert.equal(enabledSensor.enabled, false);
    assert.equal(enabledSensor._legacyEnabledBeforeRun, true);
    assert.deepEqual(enabledSensor.enabledCalls, [false]);
    assert.equal(disabledSensor.enabled, false);
    assert.equal(disabledSensor._legacyEnabledBeforeRun, false);
    assert.deepEqual(disabledSensor.enabledCalls, [false]);
    assert.equal(database.devices.includes(runSensor), false);
    assert.equal(runSensor._legacyEnabledBeforeRun, undefined);
    assert.equal(database.devices.includes(enabledSensor), true);
    assert.equal(database.devices.includes(disabledSensor), true);

    enabledSensor.enabled = true;
    database.configureFromManifest({});
    assert.equal(enabledSensor._legacyEnabledBeforeRun, true);
    assert.equal(enabledSensor.enabled, false);
    assert.equal(disabledSensor._legacyEnabledBeforeRun, false);

    database.disposeRun();

    assert.equal(enabledSensor.enabled, true);
    assert.equal(enabledSensor._legacyEnabledBeforeRun, undefined);
    assert.deepEqual(enabledSensor.enabledCalls, [false, false, true]);
    assert.equal(disabledSensor.enabled, false);
    assert.equal(disabledSensor._legacyEnabledBeforeRun, undefined);
    assert.deepEqual(disabledSensor.enabledCalls, [false, false, false]);
});
