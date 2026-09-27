'use client';

import { useCallback, useEffect, useState } from "react";

import { Button, DialogSurface } from "../ui";
import { fetchRevisionStatus } from "./RevisionClient";
import {
    DISMISS_STORAGE_KEY,
    displayedRevisionNotice,
    reduceRevisionNotice,
    shortCommit,
    shouldShowRevisionNotice,
} from "./revisionNotice";

const POLL_INTERVAL_MS = 60_000;

// Filename stays distinct from revisionNotice.js so both files exist on
// case-insensitive volumes.
export default function RevisionNotice() {
    const [notice, setNotice] = useState({ status: null, held: null });
    const [dismissedRemoteCommit, setDismissedRemoteCommit] = useState(null);

    const applyStatus = useCallback((next) => {
        setDismissedRemoteCommit(readDismissedRemoteCommit());
        setNotice((previous) => reduceRevisionNotice(previous, next));
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        let stopped = false;
        let timer = 0;
        let requestId = 0;

        const tick = async () => {
            if (stopped || document.visibilityState !== "visible") return;
            const id = ++requestId;
            try {
                const next = await fetchRevisionStatus(controller.signal);
                if (stopped || id !== requestId) return;
                applyStatus(next);
            } catch (error) {
                if (stopped || error?.name === "AbortError") return;
            }
        };

        const arm = () => {
            timer = window.setTimeout(() => {
                tick().finally(() => {
                    if (!stopped) arm();
                });
            }, POLL_INTERVAL_MS);
        };

        tick().finally(() => {
            if (!stopped) arm();
        });

        const onVisibility = () => {
            if (document.visibilityState === "visible") tick();
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            stopped = true;
            controller.abort();
            window.clearTimeout(timer);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [applyStatus]);

    const displayed = displayedRevisionNotice(notice);
    if (!shouldShowRevisionNotice(displayed, dismissedRemoteCommit)) return null;

    const copy = noticeCopy(displayed);
    const dismiss = () => {
        const remoteCommit = displayed.remoteCommit;
        try {
            sessionStorage.setItem(DISMISS_STORAGE_KEY, remoteCommit);
        } catch {
            // Private browsing can reject storage; the in-memory dismiss still closes this view.
        }
        setDismissedRemoteCommit(remoteCommit);
    };

    return (
        <DialogSurface
            open
            onOpenChange={(nextOpen) => {
                if (!nextOpen) dismiss();
            }}
            className="sf-revision-notice"
            title="Simulator is out of date"
            description={copy.description}
            footer={<Button variant="primary" onClick={dismiss}>Dismiss</Button>}
        >
            {copy.body}
        </DialogSurface>
    );
}

function readDismissedRemoteCommit() {
    try {
        return sessionStorage.getItem(DISMISS_STORAGE_KEY);
    } catch {
        return null;
    }
}

function noticeCopy(status) {
    const running = shortCommit(status.runningCommit);
    const remote = shortCommit(status.remoteCommit);
    const remoteRef = status.remoteRef || "the remote default branch";
    if (status.state === "diverged") {
        return {
            description: `${remoteRef} has commits this process does not contain.`,
            body: (
                <>
                    <p>Running {running} and {remoteRef} ({remote}) have diverged ({status.behind} behind, {status.ahead} ahead).</p>
                    <p>Pull the latest remote commit and restart the server with <code>npm run dev</code> or <code>npm run start</code>.</p>
                </>
            ),
        };
    }
    const count = Number(status.behind) || 0;
    const commits = count === 1 ? "commit" : "commits";
    return {
        description: `This process is behind the latest commit on ${remoteRef}.`,
        body: (
            <>
                <p>Running {running}. Latest on {remoteRef} is {remote}, {count} {commits} ahead of this process.</p>
                <p>Pull that commit and restart the server with <code>npm run dev</code> or <code>npm run start</code>.</p>
            </>
        ),
    };
}
