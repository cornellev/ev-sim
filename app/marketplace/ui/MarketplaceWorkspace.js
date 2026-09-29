'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import {
    IconCloudOff,
    IconDatabase,
    IconPlus,
    IconRefresh,
    IconSearch,
    IconShieldCheck,
    IconTrash,
} from "@tabler/icons-react";

import {
    addMarketplaceSource,
    cancelMarketplaceInstallJob,
    commitMarketplaceInstallJob,
    createMarketplaceInstallPlan,
    getMarketplaceItem,
    getMarketplaceReceipt,
    listMarketplaceInstalled,
    listMarketplaceSources,
    MarketplaceApiError,
    marketplaceApiErrorMessage,
    previewMarketplaceSource,
    refreshMarketplaceSource,
    replanMarketplaceInstallJob,
    removeMarketplaceInstalled,
    removeMarketplaceSource,
    searchMarketplace,
    resumeMarketplaceInstallJob,
    startMarketplaceInstallJob,
    subscribeMarketplaceInstallJob,
    updateMarketplaceSource,
} from "../MarketplaceClient.js";
import {
    AsyncState,
    Button,
    DialogSurface,
    Field,
    NativeSelect,
    StatusMessage,
    Switch,
    TabsContent,
    TabsList,
    TabsRoot,
    TabsTrigger,
    TextInput,
    WorkspaceFrame,
} from "../../ui";
import SafeMarketplaceMarkdown, { MARKETPLACE_ACTION_LABELS } from "./SafeMarketplaceMarkdown.js";
import styles from "./MarketplaceWorkspace.module.css";

const CONTENT_KINDS = ["plugin", "vehicle", "run-template", "run-package", "environment", "asset-pack", "collection"];

function displayKind(value) {
    return String(value || "").split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

function formatBytes(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    if (number < 1024) return `${number} B`;
    if (number < 1024 ** 2) return `${(number / 1024).toFixed(1)} KiB`;
    if (number < 1024 ** 3) return `${(number / 1024 ** 2).toFixed(1)} MiB`;
    return `${(number / 1024 ** 3).toFixed(2)} GiB`;
}

function formatDate(value) {
    if (!value) return "Never";
    const date = new Date(value);
    return Number.isFinite(date.valueOf()) ? date.toLocaleString() : value;
}

function healthTone(status) {
    if (status === "ready") return "success";
    if (["offline", "stale", "expired"].includes(status)) return "warning";
    if (["untrusted"].includes(status)) return "danger";
    return "neutral";
}

function HealthBadge({ health }) {
    const status = health?.status ?? "unavailable";
    return <span className={styles.health} data-tone={healthTone(status)}>{status}</span>;
}

function PreviewImage({ preview, alt }) {
    const [failedUrl, setFailedUrl] = useState(null);
    if (!preview || failedUrl === preview.url) {
        return <div className={styles.previewFallback} role="img" aria-label={alt || "Preview unavailable"}>Preview unavailable</div>;
    }
    // The local proxy already serves verified, bounded bytes; Next image optimization would add another proxy path.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={styles.preview} src={preview.url} alt={preview.alt || alt || "Marketplace preview"} onError={() => setFailedUrl(preview.url)} />;
}

function MetadataList({ children }) {
    return <dl className={styles.metadata}>{children}</dl>;
}

function MetadataField({ label, children }) {
    return <div><dt>{label}</dt><dd>{children ?? "—"}</dd></div>;
}

function Compatibility({ compatibility, eligibility }) {
    const list = (values) => values?.length ? values.join(", ") : "Any";
    return (
        <section className={styles.detailSection} aria-labelledby="marketplace-compatibility-heading">
            <h3 id="marketplace-compatibility-heading">Declared requirements</h3>
            {eligibility ? <StatusMessage
                tone={eligibility.canInstall ? "success" : "warning"}
                title={eligibility.canInstall ? "Eligible on this host" : "Not currently installable"}
            >
                {eligibility.issues.length
                    ? eligibility.issues.map((issue) => `${issue.code}: ${issue.path}`).join(" · ")
                    : "All host compatibility requirements are satisfied."}
            </StatusMessage> : null}
            {eligibility?.downloadable && <MetadataList>
                <MetadataField label="Downloadable">{eligibility.downloadable.status}</MetadataField>
                <MetadataField label="Importable">{eligibility.importable.status}</MetadataField>
                <MetadataField label="Executable">{eligibility.executable.status}</MetadataField>
            </MetadataList>}
            <MetadataList>
                <MetadataField label="cev-sim">{compatibility?.cevSim}</MetadataField>
                <MetadataField label="Platforms">{list(compatibility?.platforms)}</MetadataField>
                <MetadataField label="Architectures">{list(compatibility?.architectures)}</MetadataField>
                <MetadataField label="Runtimes">{list(compatibility?.runtimes)}</MetadataField>
                <MetadataField label="Features">{list(compatibility?.features)}</MetadataField>
            </MetadataList>
            {compatibility?.contracts?.length ? (
                <ul className={styles.plainList}>{compatibility.contracts.map((entry) => <li key={entry.kind}>{entry.kind}@{entry.versions.join(",")}</li>)}</ul>
            ) : null}
            {compatibility?.backends?.length ? (
                <ul className={styles.plainList}>{compatibility.backends.map((entry) => <li key={`${entry.kind}:${entry.id}:${entry.version}`}>{entry.kind}: {entry.id}@{entry.version}</li>)}</ul>
            ) : null}
        </section>
    );
}

const PRECOMMIT_PHASES = new Set(["queued", "download", "verify", "plan", "awaiting-confirmation"]);

function lifecycleMilestone(contentKind) {
    if (contentKind === "plugin") return "MKT-08 owns plugin installation.";
    if (["vehicle", "run-template", "run-package"].includes(contentKind)) return "MKT-11 owns this content lifecycle.";
    if (contentKind === "environment") return "MKT-10 owns portable environment installation.";
    return "A production lifecycle adapter has not been assigned for this content kind.";
}

function PluginPlanReview({ entry }) {
    const adapterPlan = entry.adapterPlan;
    const plugin = adapterPlan?.plugin;
    if (entry.adapterId !== "plugin@1" || !plugin) return null;
    const coexisting = adapterPlan.coexistingPackages?.length
        ? adapterPlan.coexistingPackages.map((candidate) => `${candidate.version} · ${candidate.packageHash}`).join(", ")
        : "None";
    const required = adapterPlan.capabilityChange?.required?.length
        ? adapterPlan.capabilityChange.required.join(", ")
        : "None";
    return (
        <MetadataList>
            <MetadataField label="Plugin">{plugin.pluginId}@{plugin.version}</MetadataField>
            <MetadataField label="Package hash">{plugin.packageHash}</MetadataField>
            <MetadataField label="Runtime hash">{plugin.runtimeHash}</MetadataField>
            <MetadataField label="UI hash">{plugin.uiHash || "None"}</MetadataField>
            <MetadataField label="CAS action">{adapterPlan.changes.cas}</MetadataField>
            <MetadataField label="Library action">{adapterPlan.changes.libraryMembership}</MetadataField>
            <MetadataField label="Owner action">{adapterPlan.changes.marketplaceOwner}</MetadataField>
            <MetadataField label="Coexisting packages">{coexisting}</MetadataField>
            <MetadataField label="Required capabilities">{required}</MetadataField>
            <MetadataField label="Runtime grants added">{adapterPlan.capabilityChange?.grantsAdded?.length
                ? adapterPlan.capabilityChange.grantsAdded.join(", ")
                : "None"}</MetadataField>
            <MetadataField label="Conflicts">{entry.conflicts.length ? entry.conflicts.join(", ") : "None"}</MetadataField>
        </MetadataList>
    );
}

function GenericPlanReview({ entry }) {
    return (
        <MetadataList>
            <MetadataField label="Adapter">{entry.adapterId}</MetadataField>
            <MetadataField label="Required rights">{entry.rights.length ? JSON.stringify(entry.rights) : "None"}</MetadataField>
            <MetadataField label="Conflicts">{entry.conflicts.length ? JSON.stringify(entry.conflicts) : "None"}</MetadataField>
            <MetadataField label="Local mappings">{entry.mappings.length ? JSON.stringify(entry.mappings) : "None"}</MetadataField>
        </MetadataList>
    );
}

function AssetPackagePlanReview({ entry }) {
    const plan = entry.adapterPlan;
    return <>
        <MetadataList>
            <MetadataField label="Roots">{plan.package.roots.map((root) => `${root.assetId}@${root.revision}`).join(", ")}</MetadataField>
            <MetadataField label="Closure">{plan.package.assetCount} assets · {plan.package.revisionCount} revisions · {plan.package.useCount} uses · {plan.package.blobCount} blobs</MetadataField>
            <MetadataField label="Preparation hash">{plan.preparationHash}</MetadataField>
            <MetadataField label="Operations">{plan.operations.length}</MetadataField>
            <MetadataField label="Required rights">{entry.rights.length
                ? entry.rights.map((right) => `${right.sourceId}:${right.right} (${right.allowed ? "allowed" : "denied"})`).join(", ")
                : "None"}</MetadataField>
            <MetadataField label="Conflicts">{entry.conflicts.length ? entry.conflicts.join(", ") : "None"}</MetadataField>
        </MetadataList>
        <ul className={styles.plainList}>{plan.revisionMappings.map((mapping) => <li key={`${mapping.sourceAssetId}:${mapping.sourceRevision}`}>
            {mapping.sourceAssetId}@{mapping.sourceRevision} → {mapping.localAssetId}@{mapping.localRevision}
        </li>)}</ul>
    </>;
}

function EnvironmentPackagePlanReview({ entry }) {
    const plan = entry.adapterPlan;
    const environment = plan.environment;
    return <>
        <MetadataList>
            <MetadataField label="Environment">{environment.sourceEnvironmentId}@{environment.sourceRevision} → {environment.localEnvironmentId}</MetadataField>
            <MetadataField label="Asset mappings">{plan.revisionMappings.length}</MetadataField>
            <MetadataField label="World identity">{environment.sourceWorldHash === environment.localWorldHash ? "Preserved" : `${environment.sourceWorldHash} → ${environment.localWorldHash}`}</MetadataField>
            <MetadataField label="Visual identity">{environment.sourceDescriptorHash === environment.localDescriptorHash ? (environment.localDescriptorHash || "None") : `${environment.sourceDescriptorHash || "None"} → ${environment.localDescriptorHash || "None"}`}</MetadataField>
            <MetadataField label="Operations">{plan.operations.length}</MetadataField>
            <MetadataField label="Required rights">{entry.rights.length
                ? entry.rights.map((right) => `${right.sourceId}:${right.right} (${right.allowed ? "allowed" : "denied"})`).join(", ")
                : "None"}</MetadataField>
            <MetadataField label="Conflicts">{entry.conflicts.length ? entry.conflicts.join(", ") : "None"}</MetadataField>
        </MetadataList>
    </>;
}

function RunTemplatePlanReview({ entry }) {
    const plan = entry.adapterPlan;
    const counts = (kind) => plan.operations.filter((operation) => operation.kind === kind).length;
    const destinations = entry.mappings
        .filter((mapping) => ["vehicle", "visual-script", "scenario", "run-manifest"].includes(mapping.resourceKind))
        .map((mapping) => `${mapping.resourceKind}: ${mapping.sourceId} → ${mapping.localId}`)
        .join(" · ");
    return <MetadataList>
        <MetadataField label="Run configuration">{plan.package.manifestId} → {plan.destination.manifestId}</MetadataField>
        <MetadataField label="Destination IDs">{destinations || "Run configuration only"}</MetadataField>
        <MetadataField label="Authoring records">{plan.destination.reusedRecords} reused · {plan.destination.newRecords} new</MetadataField>
        <MetadataField label="Embedded plugin CAS prerequisites">{counts("publish-run-template-plugin-package")}</MetadataField>
        <MetadataField label="Vehicles / scripts / scenarios">{counts("publish-vehicle")} / {counts("publish-script")} / {counts("publish-scenario")}</MetadataField>
        <MetadataField label="Frozen bindings">{plan.destination.bindingCount}</MetadataField>
        <MetadataField label="Final publication">Run manifest is operation {plan.operations.length} of {plan.operations.length}</MetadataField>
        <MetadataField label="Required rights">{entry.rights.length ? JSON.stringify(entry.rights) : "None"}</MetadataField>
        <MetadataField label="Conflicts">{entry.conflicts.length ? JSON.stringify(entry.conflicts) : "None"}</MetadataField>
    </MetadataList>;
}

function InstallDialog({ target, onClose, onInstalled, onOpenEnvironment, onOpenRunConfig }) {
    const [plan, setPlan] = useState(null);
    const [view, setView] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [streamGeneration, setStreamGeneration] = useState(0);
    const jobId = view?.job.jobId ?? null;
    const phase = view?.job.phase ?? null;

    useEffect(() => {
        if (!target) return undefined;
        const controller = new AbortController();
        setPlan(null);
        setView(null);
        setError(null);
        setBusy(true);
        createMarketplaceInstallPlan({
            sourceId: target.source.sourceId,
            itemId: target.item.itemId,
            releaseVersion: target.selectedRelease.releaseVersion,
        }, { signal: controller.signal }).then(setPlan).catch((caught) => {
            if (caught.name !== "AbortError") setError(marketplaceApiErrorMessage(caught));
        }).finally(() => setBusy(false));
        return () => controller.abort();
    }, [target]);

    useEffect(() => {
        if (!jobId) return undefined;
        return subscribeMarketplaceInstallJob(jobId, {
            onJob: (next) => {
                setView(next);
                if (next.job.phase === "complete") onInstalled?.();
            },
            onError: () => {},
        });
    }, [jobId, onInstalled, streamGeneration]);

    if (!target) return null;
    const start = async () => {
        setBusy(true); setError(null);
        try { setView(await startMarketplaceInstallJob(plan.planHash)); }
        catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
        finally { setBusy(false); }
    };
    const cancel = async () => {
        const recoverBeforeCommit = view?.job.phase === "recover" && view?.job.finalPlanHash === null;
        if (!view || (!PRECOMMIT_PHASES.has(view.job.phase) && !recoverBeforeCommit)) { onClose(); return; }
        setBusy(true); setError(null);
        try {
            setView(await cancelMarketplaceInstallJob(view.job.jobId, view.job.revision));
            onClose();
        } catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
        finally { setBusy(false); }
    };
    const commit = async () => {
        setBusy(true); setError(null);
        try {
            setView(await commitMarketplaceInstallJob(view.job.jobId, view.job.revision, view.job.finalPlanHash));
        } catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
        finally { setBusy(false); }
    };
    const resume = async () => {
        setBusy(true); setError(null);
        try {
            setView(await resumeMarketplaceInstallJob(view.job.jobId, view.job.revision));
            setStreamGeneration((generation) => generation + 1);
        }
        catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
        finally { setBusy(false); }
    };
    const replan = async () => {
        setBusy(true); setError(null);
        try {
            setView(await replanMarketplaceInstallJob(view.job.jobId, view.job.revision));
            setStreamGeneration((generation) => generation + 1);
        }
        catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
        finally { setBusy(false); }
    };
    const precommitRecovery = phase === "recover" && view?.job.finalPlanHash === null;
    const cancellable = PRECOMMIT_PHASES.has(phase) || precommitRecovery;
    const locked = phase === "commit" || (phase === "recover" && !precommitRecovery);
    const finalPlan = view?.finalPlan;
    const completedPlugin = finalPlan?.releases.find((entry) => entry.adapterId === "plugin@1")?.adapterPlan?.plugin;
    const completedEnvironment = finalPlan?.releases.find((entry) => entry.adapterId === "environment@1")?.adapterPlan?.environment;
    const completedRunManifest = finalPlan?.releases
        .find((entry) => entry.adapterId === "run-template@1")
        ?.mappings?.find((mapping) => mapping.resourceKind === "run-manifest")?.localId;
    const progress = view?.job.progress;
    let footer;
    if (!view) footer = <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!plan} onClick={start}>Download and inspect</Button></>;
    else if (cancellable && phase !== "awaiting-confirmation") footer = <Button variant="danger" loading={busy} onClick={cancel}>Cancel installation</Button>;
    else if (phase === "awaiting-confirmation") footer = <><Button loading={busy} onClick={cancel}>Cancel</Button><Button variant="primary" loading={busy} disabled={!finalPlan?.committable} onClick={commit}>Commit installation</Button></>;
    else if (phase === "needs-attention") footer = <><Button loading={busy} onClick={onClose}>Close</Button><Button loading={busy} onClick={replan}>Replan</Button><Button variant="primary" loading={busy} onClick={resume}>Resume</Button></>;
    else if (phase === "complete" && completedEnvironment) footer = <><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={() => onOpenEnvironment?.(completedEnvironment.localEnvironmentId)}>Open in Environment Editor</Button></>;
    else if (phase === "complete" && completedRunManifest) footer = <><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={() => onOpenRunConfig?.(completedRunManifest)}>Open in Run Configuration</Button></>;
    else footer = <Button disabled={locked} onClick={onClose}>Close</Button>;
    return (
        <DialogSurface
            open
            onOpenChange={(open) => { if (!open && !locked) { if (view && cancellable) cancel(); else onClose(); } }}
            title={`Install ${target.item.displayName}`}
            description="Review verified metadata first. No local content changes occur until the explicit commit step."
            className={styles.installDialog}
            footer={footer}
        >
            <div className={styles.srOnly} role="status" aria-live="polite">{phase ? `Installation phase ${phase}` : busy ? "Preparing installation metadata" : "Installation metadata ready"}</div>
            {error && <StatusMessage tone="danger" title="Installation failed">{error}</StatusMessage>}
            {!plan ? <AsyncState status={error ? "error" : "loading"} title={error ? "Could not create preflight" : "Preparing verified metadata"} detail={error} /> : (
                <div className={styles.installFlow}>
                    <section><h3>1. Verified metadata</h3><MetadataList><MetadataField label="Plan hash">{plan.planHash}</MetadataField><MetadataField label="Registry">{plan.preflight.source.registryId}</MetadataField><MetadataField label="Snapshot">{plan.preflight.source.snapshotId}</MetadataField><MetadataField label="Download">{formatBytes(plan.preflight.totalDownloadBytes)}</MetadataField><MetadataField label="Host profile">{plan.preflight.hostProfileHash}</MetadataField></MetadataList><ul className={styles.plainList}>{plan.preflight.releases.map((entry) => <li key={`${entry.release.itemId}:${entry.release.releaseVersion}`}>{entry.release.itemId}@{entry.release.releaseVersion}<small>{entry.release.artifact.sha256}</small></li>)}</ul></section>
                    {view && <section><h3>2. Download and inspection</h3><p className={styles.muted}>{phase}</p><progress max={Math.max(1, progress.bytesTotal)} value={progress.bytesComplete} aria-label="Installation download progress" /><p className={styles.muted}>{progress.artifactsComplete}/{progress.artifactsTotal} artifacts · {formatBytes(progress.bytesComplete)} / {formatBytes(progress.bytesTotal)}</p>{(progress.totalOperations ?? progress.operationsTotal ?? 0) > 0 && <><progress max={progress.totalOperations ?? progress.operationsTotal} value={progress.completedOperations ?? progress.operationsComplete} aria-label="Installation operation progress" /><p className={styles.muted}>{progress.completedOperations ?? progress.operationsComplete}/{progress.totalOperations ?? progress.operationsTotal} durable operations</p></>}</section>}
                    {finalPlan && <section><h3>3. Review local changes</h3>{finalPlan.blockingIssues.length ? <StatusMessage tone="danger" title="Commit is blocked">{finalPlan.blockingIssues.join(" · ")}</StatusMessage> : <StatusMessage tone="success" title="Ready for explicit commit">No blocking rights or mapping conflicts were reported.</StatusMessage>}{finalPlan.releases.map((entry) => <article className={styles.planRelease} key={`${entry.release.itemId}:${entry.release.releaseVersion}`}><strong>{entry.release.itemId}@{entry.release.releaseVersion}</strong>{entry.adapterId === "plugin@1" ? <PluginPlanReview entry={entry} /> : entry.adapterId === "asset-pack@1" ? <AssetPackagePlanReview entry={entry} /> : entry.adapterId === "environment@1" ? <EnvironmentPackagePlanReview entry={entry} /> : entry.adapterId === "run-template@1" ? <RunTemplatePlanReview entry={entry} /> : <GenericPlanReview entry={entry} />}</article>)}</section>}
                    {phase === "complete" && <StatusMessage tone="success" title="Installation complete">{completedPlugin
                        ? `${completedPlugin.pluginId}@${completedPlugin.version} (${completedPlugin.packageHash}) was added to the Plugin Library.`
                        : "Installed membership and immutable receipts are now visible."}</StatusMessage>}
                    {phase === "recover" && <StatusMessage tone="warning" title={precommitRecovery ? "Resuming installation" : "Recovering durable commit"}>{precommitRecovery ? "Verified cached artifacts will be reused; cancellation remains available." : "The commit journal is being rolled forward. Closing is disabled."}</StatusMessage>}
                    {phase === "needs-attention" && <StatusMessage tone="warning" title="Import needs attention">Completed authoring operations remain rooted. Resume verifies them and continues; replan is required after a conflicting local edit.</StatusMessage>}
                    {phase === "failed" && <StatusMessage tone="danger" title={view.job.error?.code}>{view.job.error?.message}</StatusMessage>}
                </div>
            )}
        </DialogSurface>
    );
}

function ReleaseDetail({ detail, loading, error, onRetry, releaseVersion, onReleaseVersion, onInstall }) {
    if (loading) return <div className={styles.centerState}><AsyncState title="Loading release" /></div>;
    if (error) return <div className={styles.centerState}><AsyncState status="error" title="Could not load release" detail={error} onRetry={onRetry} /></div>;
    if (!detail) return <div className={styles.centerState}><AsyncState status="empty" title="Select an item" detail="Choose a verified catalog item to inspect its release." /></div>;
    const { item, selectedRelease: release, source, verification } = detail;
    const selectedSummary = detail.releases.find((entry) => entry.releaseVersion === release.releaseVersion);
    const preview = item.previews?.[0] ? {
        ...item.previews[0],
        url: `/api/marketplace/items/${encodeURIComponent(source.sourceId)}/${encodeURIComponent(item.itemId)}/previews/${item.previews[0].sha256}`,
    } : null;
    const isYanked = detail.yanks.some((entry) => entry.release.releaseVersion === release.releaseVersion
        && entry.release.artifactSha256 === release.artifact.sha256);
    const actionLabel = MARKETPLACE_ACTION_LABELS[item.contentKind] ?? "Install";
    return (
        <article className={styles.detail} aria-label="Marketplace release details">
            <PreviewImage preview={preview} alt={item.displayName} />
            <header className={styles.detailHeader}>
                <div className={styles.eyebrow}>{displayKind(item.contentKind)} · {source.name}</div>
                <h2>{item.displayName}</h2>
                <p>{item.summary}</p>
                <div className={styles.badgeRow}>
                    <HealthBadge health={source.health} />
                    {!detail.fresh && <span className={styles.health} data-tone="warning">cached metadata</span>}
                    {isYanked && <span className={styles.health} data-tone="danger">yanked</span>}
                </div>
            </header>
            <div className={styles.releaseChooser}>
                <Field label="Release version">
                    <NativeSelect value={releaseVersion || release.releaseVersion} onChange={(event) => onReleaseVersion(event.target.value)}>
                        {detail.releases.map((entry) => <option key={entry.releaseVersion} value={entry.releaseVersion}>{entry.releaseVersion}</option>)}
                    </NativeSelect>
                </Field>
                <Button disabled={!detail.eligibility?.canInstall} aria-describedby="marketplace-install-disabled" onClick={() => onInstall(detail)}>{actionLabel}</Button>
            </div>
            <p id="marketplace-install-disabled" className={styles.muted}>{detail.eligibility?.lifecycleAvailable
                ? detail.eligibility.canInstall ? "A verified preflight is required before download." : "This release is not eligible for the requested lifecycle."
                : lifecycleMilestone(item.contentKind)}</p>
            {isYanked && <StatusMessage tone="danger" title="This exact release is yanked">{detail.yanks.find((entry) => entry.release.releaseVersion === release.releaseVersion)?.reason}</StatusMessage>}
            <MetadataList>
                <MetadataField label="Declared publisher">{release.publisherId}</MetadataField>
                <MetadataField label="License">{release.licenseExpression}</MetadataField>
                <MetadataField label="Track">{Object.entries(detail.tracks).filter(([, version]) => version === release.releaseVersion).map(([track]) => track).join(", ") || "Untracked"}</MetadataField>
                <MetadataField label="Artifact">{release.artifact.sha256}</MetadataField>
                <MetadataField label="Size">{formatBytes(release.artifact.sizeBytes)}</MetadataField>
                <MetadataField label="Release hash">{selectedSummary?.releaseHash || detail.selectedReleaseHash}</MetadataField>
            </MetadataList>
            {item.description && <section className={styles.detailSection}><h3>Description</h3><SafeMarketplaceMarkdown className={styles.markdown}>{item.description}</SafeMarketplaceMarkdown></section>}
            {release.changelog && <section className={styles.detailSection}><h3>Release notes</h3><SafeMarketplaceMarkdown className={styles.markdown}>{release.changelog}</SafeMarketplaceMarkdown></section>}
            {item.links?.length ? <section className={styles.detailSection}><h3>Links</h3><ul className={styles.plainList}>{item.links.map((link) => <li key={`${link.label}:${link.url}`}><a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a></li>)}</ul></section> : null}
            <Compatibility compatibility={release.compatibility} eligibility={detail.eligibility} />
            <section className={styles.detailSection}>
                <h3>Capabilities</h3>
                {release.capabilities.length ? <ul className={styles.plainList}>{release.capabilities.map((value) => <li key={value}>{value}</li>)}</ul> : <p className={styles.muted}>None declared.</p>}
            </section>
            <section className={styles.detailSection}>
                <h3>Exact dependencies</h3>
                {release.dependencies.length ? <ul className={styles.plainList}>{release.dependencies.map((entry) => <li key={`${entry.itemId}:${entry.releaseVersion}`}>{entry.itemId}@{entry.releaseVersion}<small>{entry.artifactSha256}</small></li>)}</ul> : <p className={styles.muted}>No dependencies.</p>}
            </section>
            <section className={styles.detailSection}>
                <h3>Verified distribution</h3>
                <p className={styles.muted}>The registry TUF role authenticated these bytes. Publisher DSSE is not part of MKT-06.</p>
                <MetadataList>
                    <MetadataField label="Registry ID">{verification.registryId}</MetadataField>
                    <MetadataField label="Pinned root SHA-256">{verification.trustedRootFingerprint}</MetadataField>
                    <MetadataField label="Root version">{verification.rootVersion}</MetadataField>
                    <MetadataField label="TUF role">{verification.role}@{verification.roleVersion}</MetadataField>
                    <MetadataField label="Authorized key IDs">{verification.roleKeyIds.join(", ")}</MetadataField>
                    <MetadataField label="Role expiry">{formatDate(verification.roleExpiresAt)}</MetadataField>
                    <MetadataField label="Verified at">{formatDate(verification.verifiedAt)}</MetadataField>
                </MetadataList>
            </section>
        </article>
    );
}

function DiscoverTab({ onOpenEnvironment, onOpenRunConfig }) {
    const [query, setQuery] = useState({ q: "", track: "stable", contentKind: "", sourceId: "", publisherId: "", license: "", offset: 0, limit: 50 });
    const [result, setResult] = useState(null);
    const [status, setStatus] = useState("loading");
    const [error, setError] = useState(null);
    const [selected, setSelected] = useState(null);
    const [detail, setDetail] = useState(null);
    const [detailStatus, setDetailStatus] = useState("idle");
    const [detailError, setDetailError] = useState(null);
    const [installTarget, setInstallTarget] = useState(null);
    const load = useCallback(() => {
        const controller = new AbortController();
        setStatus("loading");
        searchMarketplace(query, { signal: controller.signal }).then((payload) => {
            setResult(payload);
            setStatus("ready");
            setError(null);
            setSelected((current) => payload.entries.some((entry) => entry.key === current?.key) ? current : (payload.entries[0] ?? null));
        }).catch((caught) => {
            if (caught.name === "AbortError") return;
            setStatus("error");
            setError(marketplaceApiErrorMessage(caught));
        });
        return controller;
    }, [query]);

    useEffect(() => {
        let controller = null;
        const timer = setTimeout(() => { controller = load(); }, 120);
        return () => {
            clearTimeout(timer);
            controller?.abort();
        };
    }, [load]);

    const loadDetail = useCallback((entry = selected) => {
        if (!entry) { setDetail(null); return null; }
        const controller = new AbortController();
        setDetailStatus("loading");
        getMarketplaceItem(entry.source.sourceId, entry.item.itemId, {
            releaseVersion: entry.release.releaseVersion,
            signal: controller.signal,
        }).then((payload) => {
            setDetail(payload);
            setDetailStatus("ready");
            setDetailError(null);
        }).catch((caught) => {
            if (caught.name === "AbortError") return;
            setDetailStatus("error");
            setDetailError(marketplaceApiErrorMessage(caught));
        });
        return controller;
    }, [selected]);

    useEffect(() => {
        let controller = null;
        const timer = setTimeout(() => { controller = loadDetail(); }, 0);
        return () => {
            clearTimeout(timer);
            controller?.abort();
        };
    }, [loadDetail]);

    const updateFilter = (key, value) => setQuery((current) => ({ ...current, [key]: value, offset: 0 }));
    const selectRelease = (releaseVersion) => {
        setSelected((current) => current ? { ...current, release: { ...current.release, releaseVersion } } : current);
    };
    const viewResult = result ?? {
        sources: [],
        entries: [],
        facets: { publishers: [], licenses: [] },
        page: { offset: 0, limit: query.limit, total: 0 },
    };
    const sources = viewResult.sources;
    const entries = viewResult.entries;
    return (
        <div className={styles.discover}>
            <aside className={styles.filters} aria-label="Marketplace filters">
                <div className={styles.searchBox}><IconSearch size={15} aria-hidden="true" /><input aria-label="Search Marketplace" value={query.q} onChange={(event) => updateFilter("q", event.target.value)} placeholder="Search verified catalog" /></div>
                <Field label="Track"><NativeSelect value={query.track} onChange={(event) => updateFilter("track", event.target.value)}><option value="stable">Stable</option><option value="beta">Beta</option></NativeSelect></Field>
                <Field label="Content kind"><NativeSelect value={query.contentKind} onChange={(event) => updateFilter("contentKind", event.target.value)}><option value="">All kinds</option>{CONTENT_KINDS.map((kind) => <option key={kind} value={kind}>{displayKind(kind)}</option>)}</NativeSelect></Field>
                <Field label="Source"><NativeSelect value={query.sourceId} onChange={(event) => updateFilter("sourceId", event.target.value)}><option value="">All sources</option>{sources.map((source) => <option key={source.sourceId} value={source.sourceId}>{source.name}</option>)}</NativeSelect></Field>
                <Field label="Declared publisher"><NativeSelect value={query.publisherId} onChange={(event) => updateFilter("publisherId", event.target.value)}><option value="">All publishers</option>{viewResult.facets.publishers.map((facet) => <option key={facet.value} value={facet.value}>{facet.value} ({facet.count})</option>)}</NativeSelect></Field>
                <Field label="License"><NativeSelect value={query.license} onChange={(event) => updateFilter("license", event.target.value)}><option value="">All licenses</option>{viewResult.facets.licenses.map((facet) => <option key={facet.value} value={facet.value}>{facet.value} ({facet.count})</option>)}</NativeSelect></Field>
                <p className={styles.muted}>Compatibility is shown as declared requirements. Eligibility evaluation begins in MKT-07.</p>
                <Button size="compact" onClick={() => setQuery({ q: "", track: "stable", contentKind: "", sourceId: "", publisherId: "", license: "", offset: 0, limit: 50 })}>Clear filters</Button>
            </aside>
            <section className={styles.results} aria-label="Marketplace results" aria-busy={status === "loading" || undefined}>
                <header><div><strong>Discover</strong><span role="status" aria-live="polite">{viewResult.page.total} verified items</span></div><Button size="compact" onClick={load} loading={status === "loading"}><IconRefresh size={14} aria-hidden="true" /> Reload cache</Button></header>
                {sources.some((source) => ["offline", "expired", "stale"].includes(source.health.status)) && <StatusMessage tone="warning" title="Some sources are not current">Cached verified catalog data remains available; review Sources for details.</StatusMessage>}
                {status === "error" && !result ? <AsyncState status="error" title="Could not search Marketplace" detail={error} onRetry={load} /> : entries.length === 0 ? <AsyncState status="empty" title="No matching releases" detail={sources.length ? "Change filters or refresh a source." : "Add and refresh a source to populate Discover."} /> : (
                    <ul className={styles.resultList}>{entries.map((entry) => <li key={entry.key}><button type="button" className={styles.resultButton} aria-current={selected?.key === entry.key ? "true" : undefined} onClick={() => setSelected(entry)}><span className={styles.resultTop}><strong>{entry.item.displayName}</strong><HealthBadge health={entry.source.health} /></span><span>{entry.item.summary}</span><small>{displayKind(entry.item.contentKind)} · {entry.release.releaseVersion} · {entry.source.name}</small></button></li>)}</ul>
                )}
                {viewResult.page.total > viewResult.page.limit && <footer className={styles.pagination}><Button size="compact" disabled={query.offset === 0} onClick={() => setQuery((current) => ({ ...current, offset: Math.max(0, current.offset - current.limit) }))}>Previous</Button><span>{query.offset + 1}–{Math.min(query.offset + query.limit, viewResult.page.total)}</span><Button size="compact" disabled={query.offset + query.limit >= viewResult.page.total} onClick={() => setQuery((current) => ({ ...current, offset: current.offset + current.limit }))}>Next</Button></footer>}
            </section>
            <ReleaseDetail detail={detail} loading={detailStatus === "loading"} error={detailError} onRetry={() => loadDetail()} releaseVersion={selected?.release.releaseVersion} onReleaseVersion={selectRelease} onInstall={setInstallTarget} />
            <InstallDialog target={installTarget} onClose={() => setInstallTarget(null)} onOpenEnvironment={onOpenEnvironment} onOpenRunConfig={onOpenRunConfig} />
        </div>
    );
}

function SourceCard({ source, revision, busy, onChanged, onRemove, refreshRef = null }) {
    const [name, setName] = useState(source.name);
    const [priority, setPriority] = useState(String(source.priority));
    const [enabled, setEnabled] = useState(source.enabled);
    const [token, setToken] = useState("");
    const save = async () => {
        const saved = await onChanged("update", source, {
        expectedRevision: revision,
        name,
        enabled,
        priority: Number(priority),
        ...(token ? { credential: { type: "bearer", token } } : {}),
        });
        if (saved) setToken("");
    };
    return (
        <article className={styles.sourceCard} aria-label={`${source.name} marketplace source`}>
            <header><div><h2>{source.name}</h2><p>{source.baseUrl}</p></div><HealthBadge health={source.health} /></header>
            <MetadataList>
                <MetadataField label="Registry ID">{source.registryId}</MetadataField>
                <MetadataField label="Pinned root SHA-256">{source.trustedRootFingerprint}</MetadataField>
                <MetadataField label="Catalog revision">{source.health.catalogRevision ?? "None"}</MetadataField>
                <MetadataField label="Offline use">{source.health.usableOffline ? "Verified catalog available" : "No cached catalog"}</MetadataField>
                <MetadataField label="Metadata expiry">{formatDate(source.health.earliestExpiryAt)}</MetadataField>
                <MetadataField label="Last refresh attempt">{formatDate(source.health.lastAttemptAt)}</MetadataField>
                <MetadataField label="Last successful refresh">{formatDate(source.health.lastSuccessAt)}</MetadataField>
                <MetadataField label="Last error">{source.health.lastErrorCode ?? "None"}</MetadataField>
                <MetadataField label="Credential">{source.credentialConfigured ? "Configured" : "Not configured"}</MetadataField>
            </MetadataList>
            <div className={styles.sourceForm}>
                <Field label="Source name"><TextInput value={name} maxLength={256} onChange={(event) => setName(event.target.value)} /></Field>
                <Field label="Priority"><TextInput type="number" min="0" step="1" value={priority} onChange={(event) => setPriority(event.target.value)} /></Field>
                <Field label="Replace bearer token" hint="Leave blank to preserve the current credential."><TextInput type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></Field>
                <Switch label="Enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <div className={styles.sourceActions}>
                <Button ref={refreshRef} size="compact" loading={busy === "refresh"} disabled={!source.enabled} onClick={() => onChanged("refresh", source)}><IconRefresh size={14} aria-hidden="true" /> Refresh</Button>
                <Button size="compact" loading={busy === "update"} onClick={save}>Save changes</Button>
                {source.credentialConfigured && <Button size="compact" disabled={Boolean(busy)} onClick={() => onChanged("clear", source)}>Clear credential</Button>}
                <Button size="compact" variant="danger" disabled={Boolean(busy)} onClick={() => onRemove(source)}><IconTrash size={14} aria-hidden="true" /> Remove</Button>
            </div>
        </article>
    );
}

function SourcesTab() {
    const [snapshot, setSnapshot] = useState({ revision: 0, sources: [] });
    const [status, setStatus] = useState("loading");
    const [error, setError] = useState(null);
    const [announcement, setAnnouncement] = useState("");
    const [addOpen, setAddOpen] = useState(false);
    const [removeTarget, setRemoveTarget] = useState(null);
    const [busy, setBusy] = useState({});
    const [form, setForm] = useState({ baseUrl: "", name: "", token: "", fingerprint: "", priority: "0" });
    const [preview, setPreview] = useState(null);
    const [dialogError, setDialogError] = useState(null);
    const [previewing, setPreviewing] = useState(false);
    const [adding, setAdding] = useState(false);
    const addedFocusRef = useRef(null);
    const addButtonRef = useRef(null);
    const addWasOpenRef = useRef(false);
    const [addedSourceId, setAddedSourceId] = useState(null);

    const load = useCallback(() => listMarketplaceSources().then((payload) => {
        setSnapshot(payload);
        setStatus("ready");
        setError(null);
        return payload;
    }).catch((caught) => { setStatus("error"); setError(marketplaceApiErrorMessage(caught)); throw caught; }), []);
    useEffect(() => { load().catch(() => {}); }, [load]);
    useEffect(() => {
        if (!addedSourceId || !addedFocusRef.current) return;
        addedFocusRef.current.focus();
        setAddedSourceId(null);
    }, [addedSourceId, snapshot]);
    useEffect(() => {
        if (addOpen) {
            addWasOpenRef.current = true;
        } else if (addWasOpenRef.current) {
            addWasOpenRef.current = false;
            addButtonRef.current?.focus();
        }
    }, [addOpen]);

    const resetDialog = () => {
        setPreview(null);
        setDialogError(null);
        setForm({ baseUrl: "", name: "", token: "", fingerprint: "", priority: String(snapshot.sources.length ? Math.max(...snapshot.sources.map((source) => source.priority)) + 10 : 0) });
    };
    const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));
    const previewTrust = async () => {
        setPreviewing(true); setDialogError(null);
        try {
            const value = await previewMarketplaceSource({ baseUrl: form.baseUrl, ...(form.token ? { credential: { type: "bearer", token: form.token } } : {}) });
            setPreview(value);
            if (!form.name) setField("name", new URL(form.baseUrl).hostname);
        } catch (caught) { setDialogError(marketplaceApiErrorMessage(caught)); setPreview(null); }
        finally { setPreviewing(false); }
    };
    const add = async () => {
        setAdding(true); setDialogError(null);
        try {
            const created = await addMarketplaceSource({
                expectedRevision: snapshot.revision,
                name: form.name,
                baseUrl: form.baseUrl,
                registryId: preview.registryId,
                trustedRootFingerprint: preview.trustedRootFingerprint,
                enabled: true,
                priority: Number(form.priority),
                ...(form.token ? { credential: { type: "bearer", token: form.token } } : {}),
            });
            setForm((current) => ({ ...current, token: "", fingerprint: "" }));
            setAddOpen(false);
            setAddedSourceId(created.source.sourceId);
            await load();
            setAnnouncement("Source trusted. Refresh it explicitly to load its catalog.");
        } catch (caught) {
            if (caught instanceof MarketplaceApiError && caught.code === "CONFLICT") await load().catch(() => {});
            setDialogError(marketplaceApiErrorMessage(caught));
        } finally { setAdding(false); }
    };
    const changed = async (operation, source, body = null) => {
        setBusy((current) => ({ ...current, [source.sourceId]: operation }));
        setError(null);
        try {
            if (operation === "refresh") await refreshMarketplaceSource(source.sourceId, snapshot.revision);
            else if (operation === "clear") await updateMarketplaceSource(source.sourceId, { expectedRevision: snapshot.revision, credential: null });
            else await updateMarketplaceSource(source.sourceId, body);
            await load();
            setAnnouncement(operation === "refresh" ? `${source.name} refreshed.` : `${source.name} updated.`);
            return true;
        } catch (caught) {
            if (caught instanceof MarketplaceApiError && caught.code === "CONFLICT") await load().catch(() => {});
            setError(marketplaceApiErrorMessage(caught));
            return false;
        } finally { setBusy((current) => ({ ...current, [source.sourceId]: null })); }
    };
    const remove = async () => {
        const target = removeTarget;
        setBusy((current) => ({ ...current, [target.sourceId]: "remove" }));
        try {
            await removeMarketplaceSource(target.sourceId, snapshot.revision);
            setRemoveTarget(null);
            await load();
            setAnnouncement(`${target.name} removed.`);
        } catch (caught) { if (caught.code === "CONFLICT") await load().catch(() => {}); setError(marketplaceApiErrorMessage(caught)); }
        finally { setBusy((current) => ({ ...current, [target.sourceId]: null })); }
    };
    return (
        <div className={styles.sources}>
            <header className={styles.sourcesHeader}><div><h2>Trusted sources</h2><p>Sources are revisioned trust relationships. Catalog refresh is always explicit.</p></div><Button ref={addButtonRef} onClick={() => { resetDialog(); setAddOpen(true); }}><IconPlus size={14} aria-hidden="true" /> Add source</Button></header>
            <div className={styles.srOnly} role="status" aria-live="polite">{announcement}</div>
            {error && <StatusMessage tone="danger" title="Marketplace source operation failed">{error}</StatusMessage>}
            {status === "loading" ? <AsyncState title="Loading sources" /> : status === "error" && !snapshot.sources.length ? <AsyncState status="error" title="Could not load sources" detail={error} onRetry={load} /> : snapshot.sources.length === 0 ? <div className={styles.emptyHero}><IconDatabase size={28} aria-hidden="true" /><h2>No trusted sources</h2><p>Add a registry, verify its TUF root fingerprint out of band, then refresh it explicitly.</p></div> : <div className={styles.sourceGrid}>{snapshot.sources.map((source) => <SourceCard key={`${source.sourceId}:${snapshot.revision}`} source={source} revision={snapshot.revision} busy={busy[source.sourceId]} onChanged={changed} onRemove={setRemoveTarget} refreshRef={source.sourceId === addedSourceId ? addedFocusRef : null} />)}</div>}
            <DialogSurface open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) resetDialog(); }} title="Add Marketplace source" description="Preview registry trust metadata, then type the exact TUF root fingerprint you verified." className={styles.trustDialog} footer={<><Button onClick={() => setAddOpen(false)}>Cancel</Button>{preview ? <Button variant="primary" loading={adding} disabled={form.fingerprint !== preview.trustedRootFingerprint || !form.name || !Number.isSafeInteger(Number(form.priority))} onClick={add}>Trust source</Button> : <Button variant="primary" loading={previewing} disabled={!form.baseUrl} onClick={previewTrust}>Preview trust</Button>}</>}>
                {dialogError && <StatusMessage tone="danger" title="Trust flow failed">{dialogError}</StatusMessage>}
                <div className={styles.dialogFields}>
                    <Field label="Registry origin" hint="Canonical HTTP(S) origin with a trailing slash." required><TextInput type="url" value={form.baseUrl} onChange={(event) => { setField("baseUrl", event.target.value); setPreview(null); setField("fingerprint", ""); }} placeholder="https://registry.example/" /></Field>
                    <Field label="Source name" required><TextInput value={form.name} maxLength={256} onChange={(event) => setField("name", event.target.value)} /></Field>
                    <Field label="Read token" hint="Write-only. The token is cleared when this dialog closes."><TextInput type="password" autoComplete="off" value={form.token} onChange={(event) => { setField("token", event.target.value); setPreview(null); setField("fingerprint", ""); }} /></Field>
                    <Field label="Priority"><TextInput type="number" min="0" step="1" value={form.priority} onChange={(event) => setField("priority", event.target.value)} /></Field>
                </div>
                {preview && <section className={styles.trustPreview} aria-label="Registry trust preview"><IconShieldCheck size={20} aria-hidden="true" /><h3>Verified bootstrap root</h3><MetadataList><MetadataField label="Registry ID">{preview.registryId}</MetadataField><MetadataField label="Root version">{preview.rootVersion}</MetadataField><MetadataField label="Root expiry">{formatDate(preview.rootExpiresAt)}</MetadataField><MetadataField label="Fingerprint">{preview.trustedRootFingerprint}</MetadataField><MetadataField label="Authentication">{preview.authentication.required ? preview.authentication.schemes.join(", ") : "Not required"}</MetadataField><MetadataField label="JSON limit">{formatBytes(preview.limits.jsonBytes)}</MetadataField><MetadataField label="Catalog limit">{formatBytes(preview.limits.catalogBytes)}</MetadataField><MetadataField label="JSON depth">{preview.limits.jsonDepth}</MetadataField><MetadataField label="Artifact limit">{formatBytes(preview.limits.artifactBytes)}</MetadataField><MetadataField label="Preview limit">{formatBytes(preview.limits.previewBytes)}</MetadataField><MetadataField label="Range limit">{formatBytes(preview.limits.maxRangeBytes)}</MetadataField></MetadataList><Field label="Type the verified fingerprint" required><TextInput value={form.fingerprint} autoComplete="off" spellCheck="false" onChange={(event) => setField("fingerprint", event.target.value.trim().toLowerCase())} /></Field></section>}
            </DialogSurface>
            <DialogSurface open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)} title="Remove Marketplace source" description="This removes the local trust relationship, credentials, health, and verified cache. It does not remove authored content." footer={<><Button onClick={() => setRemoveTarget(null)}>Cancel</Button><Button variant="danger" loading={busy[removeTarget?.sourceId] === "remove"} onClick={remove}>Remove source</Button></>}>
                <StatusMessage tone="warning" title={removeTarget?.name}>The registry must be trusted again before it can be browsed.</StatusMessage>
            </DialogSurface>
        </div>
    );
}

function InstalledTab({ onOpenEnvironment, onOpenRunConfig }) {
    const [snapshot, setSnapshot] = useState(null);
    const [receipts, setReceipts] = useState({});
    const [error, setError] = useState(null);
    const [removing, setRemoving] = useState(null);
    const load = useCallback(async () => {
        try {
            const installed = await listMarketplaceInstalled();
            const hashes = [...new Set(installed.installations.flatMap((entry) => entry.receiptHashes))];
            const documents = await Promise.all(hashes.map(async (hash) => [hash, await getMarketplaceReceipt(hash)]));
            setSnapshot(installed);
            setReceipts(Object.fromEntries(documents));
            setError(null);
        } catch (caught) {
            setError(marketplaceApiErrorMessage(caught));
        }
    }, []);
    useEffect(() => {
        const timer = setTimeout(() => { load(); }, 0);
        return () => clearTimeout(timer);
    }, [load]);
    const remove = async () => {
        const target = removing;
        try {
            await removeMarketplaceInstalled({ sourceId: target.sourceId, ...target.release }, snapshot.revision);
            setRemoving(null);
            await load();
        } catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
    };
    if (!snapshot && !error) return <AsyncState title="Loading installed releases" />;
    if (!snapshot) return <AsyncState status="error" title="Could not load installed releases" detail={error} onRetry={load} />;
    if (!snapshot.installations.length) return <div className={styles.emptyHero}><IconCloudOff size={30} aria-hidden="true" /><h2>No installed Marketplace releases</h2><p>Verified artifacts may be downloaded only through an eligible lifecycle adapter. Installed membership appears here after explicit commit.</p></div>;
    return (
        <div className={styles.sources}>
            <header className={styles.sourcesHeader}><div><h2>Installed releases</h2><p>Ledger revision {snapshot.revision}. Removal unpins membership without deleting local content or receipts.</p></div><Button size="compact" onClick={load}><IconRefresh size={14} aria-hidden="true" /> Refresh</Button></header>
            {error && <StatusMessage tone="danger" title="Installed ledger operation failed">{error}</StatusMessage>}
            <div className={styles.sourceGrid}>{snapshot.installations.map((installation) => {
                const latestHash = installation.receiptHashes.at(-1);
                const receipt = receipts[latestHash];
                const pluginMapping = receipt?.mappings.find((mapping) => mapping.resourceKind === "plugin-package");
                const environmentMapping = receipt?.mappings.find((mapping) => mapping.resourceKind === "environment");
                const runManifestMapping = receipt?.mappings.find((mapping) => mapping.resourceKind === "run-manifest");
                return <article className={styles.sourceCard} key={`${installation.sourceId}:${installation.release.itemId}:${installation.release.releaseVersion}:${installation.release.artifactSha256}`}><header><div><h2>{installation.release.itemId}@{installation.release.releaseVersion}</h2><p>{installation.release.artifactSha256}</p></div><span className={styles.health} data-tone={installation.status === "installed" ? "success" : "warning"}>{installation.status}</span></header><MetadataList><MetadataField label="Source ID">{installation.sourceId}</MetadataField><MetadataField label="Registry ID">{installation.registryId}</MetadataField><MetadataField label="Dependency lock">{receipt?.dependencyLock.length ? receipt.dependencyLock.map((entry) => `${entry.itemId}@${entry.releaseVersion}`).join(", ") : "None"}</MetadataField>{pluginMapping ? <><MetadataField label="Plugin ID">{pluginMapping.sourceId}</MetadataField><MetadataField label="Local plugin ID">{pluginMapping.localId}</MetadataField><MetadataField label="Package hash">{pluginMapping.hashes.packageHash}</MetadataField><MetadataField label="Runtime hash">{pluginMapping.hashes.runtimeHash}</MetadataField><MetadataField label="UI hash">{pluginMapping.hashes.uiHash || "None"}</MetadataField></> : <MetadataField label="Local mappings">{receipt?.mappings.length ? JSON.stringify(receipt.mappings) : "None"}</MetadataField>}<MetadataField label="Receipt history">{installation.receiptHashes.join(", ")}</MetadataField><MetadataField label="Installed at">{formatDate(receipt?.installedAt)}</MetadataField></MetadataList><div className={styles.sourceActions}>{environmentMapping && <Button size="compact" onClick={() => onOpenEnvironment?.(environmentMapping.localId)}>Open in Environment Editor</Button>}{runManifestMapping && <Button size="compact" onClick={() => onOpenRunConfig?.(runManifestMapping.localId)}>Open in Run Configuration</Button>}<Button variant="danger" size="compact" onClick={() => setRemoving(installation)}>Remove membership</Button></div></article>;
            })}</div>
            <DialogSurface open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)} title="Remove Marketplace membership" description="This removes only the exact Marketplace owner recorded by this installation receipt." footer={<><Button onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" onClick={remove}>Remove membership</Button></>}>
                <StatusMessage tone="warning" title={removing ? `${removing.release.itemId}@${removing.release.releaseVersion}` : "Exact release"}>Manual ownership or another Marketplace owner keeps this plugin visible. Last-owner removal hides it from the Plugin Library but retains immutable plugin CAS and runtime bytes. Dependencies are not removed recursively.</StatusMessage>
            </DialogSurface>
        </div>
    );
}

export default function MarketplaceWorkspace({ onOpenWorkspace, onOpenEnvironment, onOpenRunConfig }) {
    const [tab, setTab] = useState("discover");
    return (
        <TabsRoot value={tab} onValueChange={setTab} className={styles.root}>
            <WorkspaceFrame
                title="Marketplace"
                subtitle="Verified catalogs"
                onOpenWorkspace={onOpenWorkspace}
                className={styles.workspace}
                contentClassName={styles.workspaceContent}
                actions={<TabsList aria-label="Marketplace sections"><TabsTrigger value="discover">Discover</TabsTrigger><TabsTrigger value="installed">Installed</TabsTrigger><TabsTrigger value="sources">Sources</TabsTrigger></TabsList>}
            >
                <h1 className={styles.srOnly}>Marketplace</h1>
                <TabsContent value="discover" className={styles.tabContent}><DiscoverTab onOpenEnvironment={onOpenEnvironment} onOpenRunConfig={onOpenRunConfig} /></TabsContent>
                <TabsContent value="installed" className={styles.tabContent}><InstalledTab onOpenEnvironment={onOpenEnvironment} onOpenRunConfig={onOpenRunConfig} /></TabsContent>
                <TabsContent value="sources" className={styles.tabContent}><SourcesTab /></TabsContent>
            </WorkspaceFrame>
        </TabsRoot>
    );
}
