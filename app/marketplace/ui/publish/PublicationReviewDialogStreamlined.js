'use client';

import { Button, DialogSurface, StatusMessage } from "../../../ui";
import { formatBytes, publishPhaseLabel } from "../presentation.js";
import styles from "../MarketplaceWorkspace.module.css";

const PRECOMMIT = new Set(["awaiting-confirmation"]);

export default function PublicationReviewDialogStreamlined({ plan, job, open, onOpenChange, onCommit, onCancel, onResume, onReplan, onOpenPublished, busy }) {
    if (!plan) return null;
    const current = job?.job ?? null;
    const committed = current && !PRECOMMIT.has(current.phase);
    const terminal = current && ["complete", "cancelled"].includes(current.phase);
    const attention = current && ["failed", "needs-attention"].includes(current.phase);
    const root = plan.entries.find((entry) => entry.draftId === plan.rootDraftId) ?? plan.entries.at(-1);
    const requestOpenChange = (next) => {
        if (!next && current?.phase === "awaiting-confirmation") {
            onCancel(current);
            return;
        }
        if (!committed || terminal || attention) onOpenChange(next);
    };
    return <DialogSurface
        open={open}
        onOpenChange={requestOpenChange}
        title={current?.phase === "complete" ? "Publication complete" : `Publish ${root.item.displayName}`}
        description="Exact bytes have been staged and verified. Publishing is the only action that writes to the registry."
        className={styles.publicationReviewDialog}
        footer={<>
            {current?.phase !== "awaiting-confirmation" && <Button disabled={committed && !terminal && !attention} onClick={() => onOpenChange(false)}>Close</Button>}
            {current?.phase === "awaiting-confirmation" && <><Button disabled={busy} onClick={() => onCancel(current)}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => onCommit(current)}>Publish</Button></>}
            {attention && <><Button disabled={busy} onClick={() => onReplan(current)}>Prepare again</Button><Button variant="primary" disabled={busy} onClick={() => onResume(current)}>Resume</Button></>}
            {current?.phase === "complete" && <Button variant="primary" onClick={() => onOpenPublished(plan, current)}>View listing</Button>}
        </>}
    >
        <div className={styles.publishReview}>
            <StatusMessage tone={current?.phase === "complete" ? "success" : attention ? "danger" : "warning"} title={current ? publishPhaseLabel(current.phase) : "Preparing publication"}>{current?.error?.message ?? current?.warning ?? `${root.item.displayName} · ${root.release.releaseVersion}`}</StatusMessage>
            <dl className={styles.metadata}><div><dt>Destination</dt><dd>{plan.source.name ?? plan.source.baseUrl}</dd></div><div><dt>Release</dt><dd>{root.release.releaseVersion}</dd></div><div><dt>Track</dt><dd>{root.track || "No track move"}</dd></div><div><dt>Contents</dt><dd>{plan.entries.length} {plan.entries.length === 1 ? "item" : "items"}</dd></div><div><dt>Size</dt><dd>{formatBytes(plan.totalBytes)}</dd></div><div><dt>Capabilities</dt><dd>{root.release.capabilities.length ? root.release.capabilities.join(", ") : "None"}</dd></div></dl>
            <ol className={styles.publishPlanEntries}>{plan.entries.map((entry, index) => <li key={entry.draftId}><header><span>{index + 1}</span><div><strong>{entry.item.displayName}</strong><small>{entry.release.releaseVersion} · {entry.contentKind}</small></div></header><p className={styles.muted}>{entry.release.dependencies.length ? `${entry.release.dependencies.length} exact dependencies` : "No Marketplace dependencies"}</p></li>)}</ol>
            <details className={styles.technicalDetails}><summary>Technical details</summary><dl className={styles.metadata}><div><dt>Registry</dt><dd>{plan.source.registryId}</dd></div><div><dt>Publisher</dt><dd>{plan.profile.publisherId}</dd></div><div><dt>Signing key</dt><dd>{plan.profile.keyId}</dd></div><div><dt>Plan hash</dt><dd>{plan.planHash}</dd></div>{plan.entries.map((entry) => <div key={entry.draftId}><dt>{entry.item.itemId}</dt><dd>{entry.release.artifact.sha256}</dd></div>)}</dl></details>
        </div>
    </DialogSurface>;
}
