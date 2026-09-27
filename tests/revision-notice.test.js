import assert from "node:assert/strict";
import test from "node:test";

import { REVISION_STATUS_KIND as SERVER_KIND } from "../server/revision/revisionStatus.js";
import {
    DISMISS_STORAGE_KEY,
    displayedRevisionNotice,
    REVISION_STATUS_KIND,
    reduceRevisionNotice,
    shortCommit,
    shouldShowRevisionNotice,
} from "../app/revision/revisionNotice.js";

const RUNNING = "a".repeat(40);
const REMOTE = "b".repeat(40);
const NEWER = "c".repeat(40);

test("revision notice kind matches the server document", () => {
    assert.equal(REVISION_STATUS_KIND, SERVER_KIND);
    assert.equal(DISMISS_STORAGE_KEY, "cev-sim.revision-notice");
    assert.equal(shortCommit(RUNNING), "a".repeat(12));
});

test("the notice opens only when the running commit is missing the remote tip", () => {
    assert.equal(shouldShowRevisionNotice(status("behind"), null), true);
    assert.equal(shouldShowRevisionNotice(status("diverged", { ahead: 2, behind: 3 }), null), true);
    assert.equal(shouldShowRevisionNotice(status("ahead", { ahead: 1, behind: 0 }), null), false);
    assert.equal(shouldShowRevisionNotice(status("current", { ahead: 0, behind: 0, remoteCommit: RUNNING }), null), false);
    assert.equal(shouldShowRevisionNotice(status("unknown"), null), false);
    assert.equal(shouldShowRevisionNotice(status("disabled"), null), false);
    assert.equal(shouldShowRevisionNotice(status("behind", { runningCommit: null }), null), false);
    assert.equal(shouldShowRevisionNotice(status("behind", { remoteCommit: null }), null), false);
    assert.equal(shouldShowRevisionNotice({ ...status("behind"), kind: "other" }, null), false);
    assert.equal(shouldShowRevisionNotice({ ...status("behind"), version: 2 }, null), false);
    assert.equal(shouldShowRevisionNotice(null, null), false);
    assert.equal(shouldShowRevisionNotice(status("behind"), REMOTE), false);
    assert.equal(shouldShowRevisionNotice(status("behind", { remoteCommit: NEWER }), REMOTE), true);
});

test("an unknown poll keeps a visible notice until the running commit contains the tip", () => {
    const behind = reduceRevisionNotice(null, status("behind"));
    const unknown = reduceRevisionNotice(behind, status("unknown", { remoteCommit: null }));
    assert.equal(shouldShowRevisionNotice(displayedRevisionNotice(unknown), null), true);
    assert.equal(displayedRevisionNotice(unknown).remoteCommit, REMOTE);

    const current = reduceRevisionNotice(unknown, status("current", { ahead: 0, behind: 0, remoteCommit: RUNNING }));
    assert.equal(displayedRevisionNotice(current), null);
    assert.equal(shouldShowRevisionNotice(displayedRevisionNotice(current), null), false);
});

function status(state, overrides = {}) {
    return {
        kind: REVISION_STATUS_KIND,
        version: 1,
        state,
        runningCommit: RUNNING,
        remoteCommit: REMOTE,
        remoteName: "origin",
        remoteBranch: "main",
        remoteRef: "origin/main",
        ahead: 0,
        behind: 2,
        checkedAt: "2026-09-27T00:00:00.000Z",
        detail: null,
        ...overrides,
    };
}
