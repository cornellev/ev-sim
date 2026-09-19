import assert from "node:assert/strict";
import test from "node:test";

import {
    assertTrustedHttpRequest,
    resolveHttpSecurityConfig,
} from "../server/security/RequestSecurity.js";

function request(host, origin = undefined) {
    return { protocol: "http", headers: { host, ...(origin === undefined ? {} : { origin }) } };
}

test("authoring HTTP security defaults to loopback and permits non-browser clients", () => {
    const config = resolveHttpSecurityConfig({});
    assert.equal(config.bindHost, "127.0.0.1");
    assert.doesNotThrow(() => assertTrustedHttpRequest(request("localhost:3000"), config));
    assert.doesNotThrow(() => assertTrustedHttpRequest(
        request("127.0.0.1:3000", "http://127.0.0.1:3000"),
        config,
    ));
});

test("authoring HTTP security rejects rebinding and cross-origin browser requests", () => {
    const config = resolveHttpSecurityConfig({});
    assert.throws(() => assertTrustedHttpRequest(request("evil.example:3000"), config), /Host/);
    assert.throws(
        () => assertTrustedHttpRequest(request("localhost:3000", "http://evil.example"), config),
        /Cross-origin/,
    );
    assert.throws(
        () => assertTrustedHttpRequest(request("localhost:3000", "null"), config),
        /Opaque/,
    );
});

test("remote authoring requires both opt-in and explicit hosts", () => {
    assert.throws(() => resolveHttpSecurityConfig({ CEV_SIM_HOST: "0.0.0.0" }), /ALLOW_REMOTE/);
    assert.throws(
        () => resolveHttpSecurityConfig({ CEV_SIM_HOST: "0.0.0.0", CEV_SIM_ALLOW_REMOTE_HTTP: "1" }),
        /ALLOWED_HOSTS/,
    );
    const config = resolveHttpSecurityConfig({
        CEV_SIM_HOST: "0.0.0.0",
        CEV_SIM_ALLOW_REMOTE_HTTP: "1",
        CEV_SIM_ALLOWED_HOSTS: "sim.lan",
        CEV_SIM_ALLOWED_ORIGINS: "https://console.lan",
    });
    assert.doesNotThrow(() => assertTrustedHttpRequest(request("sim.lan:3000"), config));
    assert.doesNotThrow(() => assertTrustedHttpRequest(
        request("sim.lan:3000", "https://console.lan"),
        config,
    ));
});
