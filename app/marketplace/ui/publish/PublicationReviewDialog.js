'use client';

import { Button, DialogSurface, StatusMessage } from "../../../ui";
import styles from "../MarketplaceWorkspace.module.css";

const PRECOMMIT = new Set(["awaiting-confirmation"]);

export default function PublicationReviewDialog({ plan, job, open, onOpenChange, onStart, onCommit, onCancel, onResume, onReplan, onOpenPublished, busy }) {
    if (!plan) return null;
    const current = job?.job ?? null;
    const committed = current && !PRECOMMIT.has(current.phase);
    const terminal = current && ["complete", "cancelled"].includes(current.phase);
    const attention = current && ["failed", "needs-attention"].includes(current.phase);
    return <DialogSurface
        open={open}
        onOpenChange={(next) => { if (!committed || terminal || attention) onOpenChange(next); }}
        title="Review publication plan"
        description="The exact local bytes below are staged and inspected. No registry write occurs until Publish is confirmed."
        className={styles.publicationReviewDialog}
        footer={<>
            <Button disabled={committed && !terminal && !attention} onClick={() => onOpenChange(false)}>Close</Button>
            {!current && <Button variant="primary" disabled={busy} onClick={onStart}>Create publish job</Button>}
            {current?.phase === "awaiting-confirmation" && <><Button variant="danger" disabled={busy} onClick={() => onCancel(current)}>Cancel job</Button><Button variant="primary" disabled={busy} onClick={() => onCommit(current)}>Publish exact plan</Button></>}
            {attention && <><Button disabled={busy} onClick={() => onReplan(current)}>Replan</Button><Button variant="primary" disabled={busy} onClick={() => onResume(current)}>Resume idempotently</Button></>}
            {current?.phase === "complete" && <Button variant="primary" onClick={() => onOpenPublished(plan, current)}>Open in Discover</Button>}
        </>}
    >
        <div className={styles.publishReview}>
            <StatusMessage tone={current?.phase === "complete" ? "success" : attention ? "danger" : "warning"} title={current ? `Job: ${current.phase}` : "Awaiting job creation"}>
                {current?.error?.message ?? current?.warning ?? (current ? `${current.progress.operationsComplete} of ${current.progress.operationsTotal} immutable operations complete.` : "Review target, signer, hashes, and ordering before continuing.")}
            </StatusMessage>
            <dl className={styles.metadata}><div><dt>Registry</dt><dd>{plan.source.registryId}</dd></div><div><dt>Publisher</dt><dd>{plan.profile.publisherId}</dd></div><div><dt>Signing key</dt><dd>{plan.profile.keyId}</dd></div><div><dt>Plan hash</dt><dd>{plan.planHash}</dd></div><div><dt>Staged bytes</dt><dd>{plan.totalBytes.toLocaleString()}</dd></div></dl>
            <ol className={styles.publishPlanEntries}>{plan.entries.map((entry, index) => <li key={entry.draftId}><header><span>{index + 1}</span><div><strong>{entry.item.displayName}</strong><small>{entry.item.itemId}@{entry.release.releaseVersion} · {entry.contentKind}</small></div></header><dl className={styles.metadata}><div><dt>Artifact</dt><dd>{entry.release.artifact.sha256}</dd></div><div><dt>Size / media</dt><dd>{entry.release.artifact.sizeBytes.toLocaleString()} bytes · {entry.release.artifact.mediaType}</dd></div><div><dt>Contracts</dt><dd>{entry.release.compatibility.contracts.map((contract) => `${contract.kind}@${contract.versions.join(",")}`).join(" · ")}</dd></div><div><dt>Track</dt><dd>{entry.track || "None"}</dd></div><div><dt>Capabilities</dt><dd>{entry.release.capabilities.length ? entry.release.capabilities.join(", ") : "None"}</dd></div><div><dt>Executable</dt><dd>{entry.release.executable ? `${entry.release.executable.pluginId} · ${entry.release.executable.packageHash}` : "None"}</dd></div><div><dt>Embedded plugins</dt><dd>{entry.release.embeddedPlugins?.length ? entry.release.embeddedPlugins.map((plugin) => `${plugin.pluginId} · ${plugin.packageHash}`).join(", ") : "None"}</dd></div><div><dt>Dependencies</dt><dd>{entry.release.dependencies.length ? entry.release.dependencies.map((dependency) => `${dependency.itemId}@${dependency.releaseVersion}`).join(", ") : "None"}</dd></div></dl></li>)}</ol>
        </div>
    </DialogSurface>;
}
