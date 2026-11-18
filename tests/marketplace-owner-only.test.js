import assert from "node:assert/strict";
import test from "node:test";

import { isRenameCollision } from "../server/marketplace/PackagePreparation.js";
import {
    aclIsOwnerOnly,
    aclReportIsOwnerOnly,
    assertOwnerOnly,
    protectOwnerOnly,
    unixModeIsOwnerOnly,
} from "../server/marketplace/registry/OwnerOnly.js";

const USER = "S-1-5-21-100";
const EVERYONE = "S-1-1-0";

function allow(sid, rights, propagation = 0) {
    return { sid, type: 0, rights, propagation };
}

test("owner-only ACL admits only the current user", () => {
    assert.equal(aclIsOwnerOnly([allow(USER, 2032127)], USER), true);
    assert.equal(aclIsOwnerOnly([allow(USER.toLowerCase(), 1), allow(USER, 2)], USER), true);
    assert.equal(aclIsOwnerOnly([allow(USER, 0x80000000)], USER), true);
    assert.equal(aclIsOwnerOnly([allow(EVERYONE, 2032127, 2), allow(USER, 1)], USER), true);
    assert.equal(aclIsOwnerOnly([allow(USER, 2032127), allow(USER, 2032127, 2)], USER), true);
    assert.equal(aclIsOwnerOnly([allow(USER, 2032127, 2)], USER), false);
    assert.equal(aclIsOwnerOnly([allow(USER, 2032127), allow(EVERYONE, 1)], USER), false);
    assert.equal(aclIsOwnerOnly([allow(USER, 1), { sid: USER, type: 1, rights: 1, propagation: 0 }], USER), false);
    assert.equal(aclIsOwnerOnly([allow(USER, 2)], USER), false);
    assert.equal(aclIsOwnerOnly([], USER), false);
    assert.equal(aclReportIsOwnerOnly({ sid: USER, aces: allow(USER, 2032127) }), true);
    assert.equal(aclReportIsOwnerOnly({ Sid: USER, aces: null }), false);
});

test("Unix owner-only mode ignores file type bits and rejects group or other access", async () => {
    assert.equal(unixModeIsOwnerOnly(0o600), true);
    assert.equal(unixModeIsOwnerOnly(0o700), true);
    assert.equal(unixModeIsOwnerOnly(0o100600), true);
    assert.equal(unixModeIsOwnerOnly(0o40700), true);
    assert.equal(unixModeIsOwnerOnly(0o644), false);
    assert.equal(unixModeIsOwnerOnly(0o100644), false);
    const file = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mode: 0o644 };
    await assert.rejects(assertOwnerOnly("secret", file, {
        platform: "linux",
        fail: () => new Error("loose file"),
    }), /loose file/);
    file.mode = 0o100600;
    await assertOwnerOnly("secret", file, { platform: "linux", fail: () => new Error("loose file") });
    const directory = { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40755 };
    await assert.rejects(assertOwnerOnly("bundle", directory, {
        directory: true,
        platform: "linux",
        fail: () => new Error("loose directory"),
    }), /loose directory/);
    directory.mode = 0o40700;
    await assertOwnerOnly("bundle", directory, { directory: true, platform: "linux", fail: () => new Error("loose directory") });
});

test("Windows owner-only check reads the ACL and does not follow a symlink", async () => {
    const file = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mode: 0o666 };
    await assert.rejects(assertOwnerOnly("secret", file, {
        platform: "win32",
        queryAcl: async () => ({ sid: USER, aces: [allow(USER, 2032127), allow(EVERYONE, 1)] }),
        fail: (cause) => Object.assign(new Error("shared"), { cause }),
    }), /shared/);
    await assertOwnerOnly("secret", file, {
        platform: "win32",
        queryAcl: async () => ({ sid: USER, aces: [allow(USER, 2032127)] }),
        fail: () => new Error("shared"),
    });
    let queried = false;
    await assert.rejects(assertOwnerOnly("secret", {
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true,
        mode: 0o600,
    }, {
        platform: "win32",
        queryAcl: async () => { queried = true; return { sid: USER, aces: [] }; },
        fail: (cause) => Object.assign(new Error("link"), { cause: cause ?? null }),
    }), /link/);
    assert.equal(queried, false);
    const probe = new Error("acl unavailable");
    await assert.rejects(assertOwnerOnly("secret", file, {
        platform: "win32",
        queryAcl: async () => { throw probe; },
        fail: (cause) => Object.assign(new Error("probe"), { cause }),
    }), (error) => error.cause === probe);
});

test("Windows rename EPERM is a collision only when the destination exists", () => {
    const denied = { code: "EPERM" };
    assert.equal(isRenameCollision({ code: "EEXIST" }, false), true);
    assert.equal(isRenameCollision({ code: "ENOTEMPTY" }, false), true);
    assert.equal(isRenameCollision(denied, true), true);
    assert.equal(isRenameCollision(denied, false), false);
    assert.equal(isRenameCollision({ code: "EACCES" }, true), false);
});

test("Windows protect is applied once per path", async () => {
    let calls = 0;
    const nodePath = "C:\\cev-sim\\owner-only-cache";
    const options = {
        directory: true,
        platform: "win32",
        restrictAcl: async () => { calls += 1; },
    };
    await protectOwnerOnly(nodePath, options);
    await protectOwnerOnly(nodePath, options);
    assert.equal(calls, 1);
});
