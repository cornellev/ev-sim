'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import {
    IconCloudOff,
    IconDatabase,
    IconPlus,
    IconRefresh,
    IconSearch,
    IconSettings,
    IconTrash,
} from "@tabler/icons-react";

import {
    connectMarketplaceSource,
    cancelMarketplaceInstallJob,
    commitMarketplaceInstallJob,
    createMarketplaceInstallPlan,
    getMarketplaceItem,
    getMarketplaceLibrary,
    listMarketplaceInstalled,
    listMarketplaceAdvisories,
    getMarketplacePolicy,
    setMarketplacePublisherApproval,
    setMarketplaceOperatorOverrideForRelease,
    listMarketplaceInstallJobOperations,
    listMarketplaceSources,
    marketplaceApiErrorMessage,
    refreshMarketplaceSource,
    replanMarketplaceInstallJob,
    removeMarketplaceInstalled,
    removeMarketplaceSource,
    searchMarketplace,
    resumeMarketplaceInstallJob,
    startMarketplaceInstallJob,
    subscribeMarketplaceInstallJob,
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
import MarketplacePaneSplitter from "./MarketplacePaneSplitter.js";
import SafeMarketplaceMarkdown, { MARKETPLACE_ACTION_LABELS } from "./SafeMarketplaceMarkdown.js";
import PublishTab from "./publish/PublishTabStreamlined.js";
import {
    clampPanelLayout,
    discoverGridTemplate,
    resetPanel,
    resizePanel,
    splitterAria,
    stepPanelSize,
} from "./panelLayout.js";
import { useContainerSize, useMedia } from "./useContainerSize.js";
import { useMarketplacePanelLayout } from "./useMarketplacePanelLayout.js";
import {
    displayKind,
    formatBytes,
    formatCompatibilityIssue,
    healthTone,
    installPhaseLabel,
    releaseMatchesAdvisory,
    sortLabel,
    sourceHealthLabel,
} from "./presentation.js";
import styles from "./MarketplaceWorkspace.module.css";

const CONTENT_KINDS = ["plugin", "vehicle", "run-template", "run-package", "environment", "asset-pack", "collection"];
const DEFAULT_DISCOVER_QUERY = Object.freeze({
    q: "",
    track: "stable",
    contentKind: "",
    sourceId: "",
    publisherId: "",
    license: "",
    sort: "name",
    offset: 0,
    limit: 50,
});

function formatDate(value) {
    if (!value) return "Never";
    const date = new Date(value);
    return Number.isFinite(date.valueOf()) ? date.toLocaleString() : value;
}

function HealthBadge({ health, status, label, tone }) {
    const resolved = status ?? health?.status ?? "unavailable";
    return <span className={styles.health} data-tone={tone ?? healthTone(resolved)}>{label ?? sourceHealthLabel(resolved)}</span>;
}

function PreviewImage({ preview, alt, className = styles.preview }) {
    const [failedUrl, setFailedUrl] = useState(null);
    if (!preview?.url || failedUrl === preview.url) return null;
    // The local proxy already serves verified, bounded bytes; Next image optimization would add another proxy path.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={className} src={preview.url} alt={preview.alt || alt || "Marketplace preview"} onError={() => setFailedUrl(preview.url)} />;
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
                    ? eligibility.issues.map((issue) => formatCompatibilityIssue(issue)).join(" ")
                    : "All host compatibility requirements are satisfied."}
            </StatusMessage> : null}
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
            <MetadataField label="Disposition">{entry.disposition || "requested"}</MetadataField>
            <MetadataField label="Action">{entry.adapterPlan.installationAction === "reuse" ? "Reuse installed release" : entry.disposition === "artifact-only" ? "Verify and cache" : "Add installation"}</MetadataField>
            <MetadataField label="Compatibility">{entry.release.contentKind === "collection" ? "Not applicable" : entry.compatibility?.compatible === false ? `Blocked: ${entry.compatibility.issues.map((issue) => issue.code).join(", ")}` : "Compatible"}</MetadataField>
            <MetadataField label="Owners">{entry.owners?.length ? entry.owners.map((owner) => owner.kind === "direct"
                ? "Direct installation"
                : `Collection ${owner.collection.itemId}@${owner.collection.releaseVersion}`).join(", ") : "Artifact cache only"}</MetadataField>
            <MetadataField label="Operations">{entry.adapterPlan.operations?.length ?? 0}</MetadataField>
            <MetadataField label="Required rights">{entry.rights.length ? JSON.stringify(entry.rights) : "None"}</MetadataField>
            <MetadataField label="Conflicts">{entry.conflicts.length ? JSON.stringify(entry.conflicts) : "None"}</MetadataField>
            <MetadataField label="Local mappings">{entry.mappings.length ? JSON.stringify(entry.mappings) : "None"}</MetadataField>
        </MetadataList>
    );
}

function CollectionPlanReview({ finalPlan }) {
    const collections = finalPlan.releases.filter((entry) => entry.disposition === "collection");
    if (!collections.length) return null;
    const groups = new Map();
    for (const collection of collections) {
        for (const member of collection.adapterPlan.collection?.members ?? []) {
            groups.set(`${collection.release.itemId}\u0000${member.release.itemId}\u0000${member.release.releaseVersion}\u0000${member.release.artifactSha256}`, member.group ?? "Ungrouped");
        }
    }
    const installed = finalPlan.releases.filter((entry) => entry.disposition !== "artifact-only"
        && !(entry.disposition === "collection" && entry.owners?.some((owner) => owner.kind === "direct")));
    const artifactOnly = finalPlan.releases.filter((entry) => entry.disposition === "artifact-only");
    const grouped = new Map();
    for (const entry of installed) {
        const owner = entry.owners?.find((candidate) => candidate.kind === "collection");
        const group = owner ? groups.get(`${owner.collection.itemId}\u0000${entry.release.itemId}\u0000${entry.release.releaseVersion}\u0000${entry.release.artifact.sha256}`) ?? "Ungrouped" : "Direct";
        const entries = grouped.get(group) ?? [];
        entries.push(entry);
        grouped.set(group, entries);
    }
    return <section className={styles.detailSection} aria-label="Collection installation plan">
        <h4>Collection members</h4>
        {[...grouped].map(([group, entries]) => <div key={group}><strong>{group}</strong><ul className={styles.plainList}>{entries.map((entry) => <li key={`${entry.release.itemId}:${entry.release.releaseVersion}`}>
            {entry.release.itemId}@{entry.release.releaseVersion} · {entry.adapterPlan.installationAction === "reuse" ? "reuse" : "add"}
        </li>)}</ul></div>)}
        <h4>Artifact-only dependencies</h4>
        {artifactOnly.length ? <ul className={styles.plainList}>{artifactOnly.map((entry) => <li key={`${entry.release.itemId}:${entry.release.releaseVersion}`}>
            {entry.release.itemId}@{entry.release.releaseVersion} · verified and cached, not installed
        </li>)}</ul> : <p className={styles.muted}>None.</p>}
    </section>;
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

function UpdateComparison({ value }) {
    if (!value) return null;
    return <section className={styles.detailSection} aria-label="Update comparison">
        <h4>Update comparison</h4>
        <MetadataList>
            <MetadataField label="Capabilities added">{value.capabilities.added.join(", ") || "None"}</MetadataField>
            <MetadataField label="Capabilities removed">{value.capabilities.removed.join(", ") || "None"}</MetadataField>
            <MetadataField label="Executables added / removed / changed">{value.executables.added.length} / {value.executables.removed.length} / {value.executables.changed.length}</MetadataField>
            <MetadataField label="Compatibility regression">{value.compatibility.regression ? "Yes" : "No"}</MetadataField>
            <MetadataField label="Denied candidate rights">{value.rights.denied.length || "None"}</MetadataField>
            <MetadataField label="Mapping changes">{value.mappings.installed.length} existing · {value.mappings.candidate.length} candidate</MetadataField>
        </MetadataList>
    </section>;
}

function InstallDialog({ target, onClose, onInstalled, onOpenEnvironment, onOpenRunConfig }) {
    const [plan, setPlan] = useState(null);
    const [view, setView] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [streamGeneration, setStreamGeneration] = useState(0);
    const [operations, setOperations] = useState([]);
    const jobId = view?.job.jobId ?? null;
    const phase = view?.job.phase ?? null;

    useEffect(() => {
        if (!target) return undefined;
        const controller = new AbortController();
        setPlan(null);
        setView(null);
        setOperations([]);
        setError(null);
        setBusy(true);
        createMarketplaceInstallPlan({
            sourceId: target.source.sourceId,
            itemId: target.item.itemId,
            releaseVersion: target.selectedRelease.releaseVersion,
            ...(target.updateIntent ? { intent: target.updateIntent } : {}),
            ...(target.allowYanked ? { allowYanked: true } : {}),
        }, { signal: controller.signal }).then(async (prepared) => {
            setPlan(prepared);
            const started = await startMarketplaceInstallJob(prepared.planHash, { signal: controller.signal });
            setView(started);
        }).catch((caught) => {
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

    useEffect(() => {
        if (!jobId || !["commit", "recover", "needs-attention", "complete"].includes(phase)) return;
        listMarketplaceInstallJobOperations(jobId, { limit: 500 })
            .then((result) => setOperations(result.entries))
            .catch(() => {});
    }, [jobId, phase, view?.job.revision]);

    if (!target) return null;
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
    const requestedCapabilities = [...new Set(finalPlan?.releases.flatMap((entry) => entry.release.capabilities) ?? [])];
    const destinations = [...new Set(finalPlan?.releases.filter((entry) => entry.disposition !== "artifact-only").map((entry) => ({
        "plugin@1": "Plugin Library",
        "environment@1": "Environment Library",
        "run-template@1": "Run Configuration",
        "asset-pack@1": "Asset Catalog",
        "collection@1": "Library",
    })[entry.adapterId] ?? "Local Library"))];
    const dependencyChanges = finalPlan?.releases.filter((entry) => entry.disposition === "artifact-only").length ?? 0;
    const conflicts = finalPlan?.releases.flatMap((entry) => entry.conflicts) ?? [];
    const completedPlugin = finalPlan?.releases.find((entry) => entry.adapterId === "plugin@1")?.adapterPlan?.plugin;
    const completedEnvironment = finalPlan?.releases.find((entry) => entry.adapterId === "environment@1")?.adapterPlan?.environment;
    const completedRunManifest = finalPlan?.releases
        .find((entry) => entry.adapterId === "run-template@1")
        ?.mappings?.find((mapping) => mapping.resourceKind === "run-manifest")?.localId;
    const progress = view?.job.progress;
    let footer;
    if (!view) footer = <Button onClick={onClose}>Cancel</Button>;
    else if (cancellable && phase !== "awaiting-confirmation") footer = <Button variant="danger" loading={busy} onClick={cancel}>Cancel installation</Button>;
    else if (phase === "awaiting-confirmation") footer = <><Button loading={busy} onClick={cancel}>Cancel</Button><Button variant="primary" loading={busy} disabled={!finalPlan?.committable} onClick={commit}>{target.updateIntent ? "Install update" : "Install"}</Button></>;
    else if (phase === "needs-attention") footer = <><Button loading={busy} onClick={onClose}>Close</Button><Button loading={busy} onClick={replan}>Replan</Button><Button variant="primary" loading={busy} onClick={resume}>Resume</Button></>;
    else if (phase === "complete" && completedEnvironment) footer = <><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={() => onOpenEnvironment?.(completedEnvironment.localEnvironmentId)}>Open in Environment Editor</Button></>;
    else if (phase === "complete" && completedRunManifest) footer = <><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={() => onOpenRunConfig?.(completedRunManifest)}>Open in Run Configuration</Button></>;
    else footer = <Button disabled={locked} onClick={onClose}>Close</Button>;
    return (
        <DialogSurface
            open
            onOpenChange={(open) => { if (!open && !locked) { if (view && cancellable) cancel(); else onClose(); } }}
            title={`${target.updateIntent ? "Update" : "Install"} ${target.item.displayName}`}
            description="Marketplace downloads and verifies content automatically. No local content changes occur until the final confirmation."
            className={styles.installDialog}
            footer={footer}
        >
            <div className={styles.srOnly} role="status" aria-live="polite">{phase ? installPhaseLabel(phase) : busy ? "Preparing" : "Installation metadata ready"}</div>
            {error && <StatusMessage tone="danger" title="Installation failed">{error}</StatusMessage>}
            {!plan ? <AsyncState status={error ? "error" : "loading"} title={error ? "Could not create preflight" : "Preparing verified metadata"} detail={error} /> : (
                <div className={styles.installFlow}>
                    <section><h3>Download</h3><MetadataList><MetadataField label="Content">{target.item.displayName}</MetadataField><MetadataField label="Version">{target.selectedRelease.releaseVersion}</MetadataField><MetadataField label="Download size">{formatBytes(plan.preflight.totalDownloadBytes)}</MetadataField></MetadataList><details className={styles.technicalDetails}><summary>Technical details</summary><MetadataList><MetadataField label="Plan hash">{plan.planHash}</MetadataField><MetadataField label="Registry">{plan.preflight.source.registryId}</MetadataField><MetadataField label="Snapshot">{plan.preflight.source.snapshotId}</MetadataField><MetadataField label="Host profile">{plan.preflight.hostProfileHash}</MetadataField></MetadataList></details></section>
                    {view && <section><h3>Verification</h3><p className={styles.muted}>{installPhaseLabel(phase)}</p><progress max={Math.max(1, progress.bytesTotal)} value={progress.bytesComplete} aria-label="Installation download progress" /><p className={styles.muted}>{progress.artifactsComplete}/{progress.artifactsTotal} artifacts · {formatBytes(progress.bytesComplete)} / {formatBytes(progress.bytesTotal)}</p>{(progress.totalOperations ?? progress.operationsTotal ?? 0) > 0 && <><progress max={progress.totalOperations ?? progress.operationsTotal} value={progress.completedOperations ?? progress.operationsComplete} aria-label="Installation operation progress" /><p className={styles.muted}>{progress.completedOperations ?? progress.operationsComplete}/{progress.totalOperations ?? progress.operationsTotal} durable operations</p></>}</section>}
                    {operations.length > 0 && <section><h3>Member operations</h3><ul className={styles.plainList}>{operations.map((operation) => <li key={operation.operationId}>{operation.itemId}@{operation.releaseVersion} · {operation.disposition} · {operation.status}{operation.collectionGroups?.filter(Boolean).length ? ` · ${operation.collectionGroups.filter(Boolean).join(", ")}` : ""}</li>)}</ul></section>}
                    {finalPlan && <section><h3>Review local changes</h3>{finalPlan.blockingIssues.length ? <StatusMessage tone="danger" title="Installation is blocked">{finalPlan.blockingIssues.join(" · ")}</StatusMessage> : <StatusMessage tone="success" title="Ready to install">No blocking rights or mapping conflicts were reported.</StatusMessage>}<MetadataList><MetadataField label="Destination">{destinations.join(", ") || "Verified artifact cache"}</MetadataField><MetadataField label="Requested capabilities">{requestedCapabilities.join(", ") || "None"}</MetadataField><MetadataField label="Dependency changes">{dependencyChanges ? `${dependencyChanges} dependencies will be verified and cached` : "No additional dependency changes"}</MetadataField><MetadataField label="Advisories and conflicts">{conflicts.length ? conflicts.join(", ") : finalPlan.blockingIssues.length ? finalPlan.blockingIssues.join(", ") : "None"}</MetadataField></MetadataList><UpdateComparison value={finalPlan.updateComparison} /><CollectionPlanReview finalPlan={finalPlan} /><details className={styles.technicalDetails}><summary>Mappings and exact operations</summary>{finalPlan.releases.map((entry) => <article className={styles.planRelease} key={`${entry.release.itemId}:${entry.release.releaseVersion}`}><strong>{entry.release.itemId}@{entry.release.releaseVersion}</strong>{entry.adapterId === "plugin@1" ? <PluginPlanReview entry={entry} /> : entry.adapterId === "asset-pack@1" ? <AssetPackagePlanReview entry={entry} /> : entry.adapterId === "environment@1" ? <EnvironmentPackagePlanReview entry={entry} /> : entry.adapterId === "run-template@1" ? <RunTemplatePlanReview entry={entry} /> : <GenericPlanReview entry={entry} />}</article>)}</details></section>}
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
    const [acknowledgeYank, setAcknowledgeYank] = useState(false);
    if (loading) return <div id="marketplace-release-detail" className={`${styles.centerState} ${styles.detailSlot}`}><AsyncState title="Loading release" /></div>;
    if (error) return <div id="marketplace-release-detail" className={`${styles.centerState} ${styles.detailSlot}`}><AsyncState status="error" title="Could not load release" detail={error} onRetry={onRetry} /></div>;
    if (!detail) return <div id="marketplace-release-detail" className={`${styles.centerState} ${styles.detailSlot}`}><AsyncState status="empty" title="Select an item" detail="Choose a verified catalog item to inspect its release." /></div>;
    const { item, selectedRelease: release, source, verification } = detail;
    const selectedSummary = detail.releases.find((entry) => entry.releaseVersion === release.releaseVersion);
    const preview = item.previews?.[0] ? {
        ...item.previews[0],
        url: `/api/marketplace/items/${encodeURIComponent(source.sourceId)}/${encodeURIComponent(item.itemId)}/previews/${item.previews[0].sha256}`,
    } : null;
    const isYanked = detail.yanks.some((entry) => entry.release.releaseVersion === release.releaseVersion
        && entry.release.artifactSha256 === release.artifact.sha256);
    const actionLabel = MARKETPLACE_ACTION_LABELS[item.contentKind] ?? "Install";
    const eligibilityIssue = detail.eligibility?.issues?.[0];
    const eligibilityLine = !detail.eligibility?.canInstall && eligibilityIssue
        ? formatCompatibilityIssue(eligibilityIssue)
        : "A verified check runs before anything is saved locally.";
    const trackLabel = Object.entries(detail.tracks).filter(([, version]) => version === release.releaseVersion).map(([track]) => track).join(", ") || "Untracked";
    return (
        <article id="marketplace-release-detail" className={styles.detail} aria-label="Marketplace release details">
            <div className={styles.detailScroll}>
                <PreviewImage preview={preview} alt={item.displayName} />
                <header className={styles.detailHeader}>
                    <div className={styles.eyebrow}>{displayKind(item.contentKind)} · {item.publisherId}</div>
                    <h2>{item.displayName}</h2>
                    <p>{item.summary}</p>
                    <p className={styles.muted}>{source.name}</p>
                    <div className={styles.badgeRow}>
                        {source.health.status !== "ready" && <HealthBadge health={source.health} />}
                        {!detail.fresh && <HealthBadge status="stale" label="Cached catalog" />}
                        {isYanked && <HealthBadge status="yanked" />}
                    </div>
                </header>
                <div className={styles.releaseChooser}>
                    <Field label="Release version">
                        <NativeSelect value={releaseVersion || release.releaseVersion} onChange={(event) => onReleaseVersion(event.target.value)}>
                            {detail.releases.map((entry) => <option key={entry.releaseVersion} value={entry.releaseVersion}>{entry.releaseVersion}</option>)}
                        </NativeSelect>
                    </Field>
                </div>
                {isYanked && <StatusMessage tone="danger" title="This exact release is yanked">{detail.yanks.find((entry) => entry.release.releaseVersion === release.releaseVersion)?.reason}</StatusMessage>}
                {detail.policy?.blocked && <StatusMessage tone="danger" title="Installation is blocked">{detail.advisories.map((entry) => entry.rationale).join(" · ")}</StatusMessage>}
                <MetadataList>
                    <MetadataField label="License">{release.licenseExpression}</MetadataField>
                    <MetadataField label="Track">{trackLabel}</MetadataField>
                    <MetadataField label="Size">{formatBytes(release.artifact.sizeBytes)}</MetadataField>
                </MetadataList>
                {detail.eligibility?.downloadable && <MetadataList>
                    <MetadataField label="Downloadable">{detail.eligibility.downloadable.status}</MetadataField>
                    <MetadataField label="Importable">{detail.eligibility.importable.status}</MetadataField>
                    <MetadataField label="Executable">{detail.eligibility.executable.status}</MetadataField>
                </MetadataList>}
                <TabsRoot defaultValue="overview" className={styles.detailTabs}>
                    <TabsList aria-label="Release sections">
                        <TabsTrigger value="overview">Overview</TabsTrigger>
                        <TabsTrigger value="compatibility">Compatibility</TabsTrigger>
                        <TabsTrigger value="notes">Release notes</TabsTrigger>
                    </TabsList>
                    <TabsContent value="overview">
                        {item.description ? <section className={styles.detailSection}><h3>Description</h3><SafeMarketplaceMarkdown className={styles.markdown}>{item.description}</SafeMarketplaceMarkdown></section> : <p className={styles.muted}>No description.</p>}
                        {item.contentKind === "collection" && <section className={styles.detailSection}><h3>Collection members</h3><p className={styles.muted}>Compatibility and lifecycle eligibility are checked together in one installation plan.</p><ul className={styles.plainList}>{detail.collectionMembers.map((member) => <li key={`${member.release.itemId}:${member.release.releaseVersion}`}><strong>{member.name}</strong> · {displayKind(member.contentKind)} · {member.release.releaseVersion}</li>)}</ul></section>}
                        {item.links?.length ? <section className={styles.detailSection}><h3>Links</h3><ul className={styles.plainList}>{item.links.map((link) => <li key={`${link.label}:${link.url}`}><a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a></li>)}</ul></section> : null}
                        <section className={styles.detailSection}>
                            <h3>Capabilities</h3>
                            {release.capabilities.length ? <ul className={styles.plainList}>{release.capabilities.map((value) => <li key={value}>{value}</li>)}</ul> : <p className={styles.muted}>None declared.</p>}
                        </section>
                    </TabsContent>
                    <TabsContent value="compatibility">
                        <Compatibility compatibility={release.compatibility} eligibility={detail.eligibility} />
                    </TabsContent>
                    <TabsContent value="notes">
                        {release.changelog ? <section className={styles.detailSection}><h3>Release notes</h3><SafeMarketplaceMarkdown className={styles.markdown}>{release.changelog}</SafeMarketplaceMarkdown></section> : <p className={styles.muted}>No release notes.</p>}
                    </TabsContent>
                </TabsRoot>
                <details className={styles.technicalDetails}>
                    <summary>Technical details</summary>
                    <MetadataList>
                        <MetadataField label="Declared publisher">{release.publisherId}</MetadataField>
                        <MetadataField label="Verified signer">{detail.publisher?.keyId ?? "Legacy unsigned state"}</MetadataField>
                        <MetadataField label="Signer status">{detail.publisher?.keyStatus ?? "Unavailable"}</MetadataField>
                        <MetadataField label="Artifact">{release.artifact.sha256}</MetadataField>
                        <MetadataField label="Release hash">{selectedSummary?.releaseHash || detail.selectedReleaseHash}</MetadataField>
                        <MetadataField label="Registry ID">{verification.registryId}</MetadataField>
                        <MetadataField label="Pinned root SHA-256">{verification.trustedRootFingerprint}</MetadataField>
                        <MetadataField label="Root version">{verification.rootVersion}</MetadataField>
                        <MetadataField label="TUF role">{verification.role}@{verification.roleVersion}</MetadataField>
                        <MetadataField label="Authorized key IDs">{verification.roleKeyIds.join(", ")}</MetadataField>
                        <MetadataField label="Role expiry">{formatDate(verification.roleExpiresAt)}</MetadataField>
                        <MetadataField label="Verified at">{formatDate(verification.verifiedAt)}</MetadataField>
                    </MetadataList>
                    <h3>Exact dependencies</h3>
                    {release.dependencies.length ? <ul className={styles.plainList}>{release.dependencies.map((entry) => <li key={`${entry.itemId}:${entry.releaseVersion}`}>{entry.itemId}@{entry.releaseVersion}<small>{entry.artifactSha256}</small></li>)}</ul> : <p className={styles.muted}>No dependencies.</p>}
                </details>
            </div>
            <div className={styles.detailAction}>
                {isYanked && <Switch label="I understand this exact release is yanked" checked={acknowledgeYank} onCheckedChange={setAcknowledgeYank} />}
                <Button disabled={!detail.eligibility?.canInstall || (isYanked && !acknowledgeYank)} aria-describedby="marketplace-install-disabled" onClick={() => onInstall({ ...detail, allowYanked: isYanked })}>{actionLabel}</Button>
                <p id="marketplace-install-disabled" className={styles.muted}>{eligibilityLine}</p>
            </div>
        </article>
    );
}

function ResultMark({ entry }) {
    const [failed, setFailed] = useState(false);
    if (entry.preview?.url && !failed) {
        // The local proxy already serves verified, bounded bytes; Next image optimization would add another proxy path.
        // eslint-disable-next-line @next/next/no-img-element
        return <img className={styles.resultThumb} src={entry.preview.url} alt="" onError={() => setFailed(true)} />;
    }
    const mark = displayKind(entry.item.contentKind).slice(0, 1) || "?";
    return <span className={styles.kindMark} aria-hidden="true">{mark}</span>;
}

function DiscoverTab({ onOpenEnvironment, onOpenRunConfig, onInstalled, onOpenSettings, openTarget, catalogEpoch = 0 }) {
    const narrowFilters = useMedia("(max-width: 1100px)");
    const narrowStack = useMedia("(max-width: 760px)");
    const splitMode = narrowStack ? "stacked" : narrowFilters ? "detail-only" : "wide";
    const discoverRef = useRef(null);
    const container = useContainerSize(discoverRef);
    const [panelLayout, updatePanelLayout] = useMarketplacePanelLayout();
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [query, setQuery] = useState(() => ({
        ...DEFAULT_DISCOVER_QUERY,
        q: openTarget?.itemId ?? "",
        track: openTarget?.track ?? "stable",
        sourceId: openTarget?.sourceId ?? "",
        license: "",
        offset: 0,
        limit: 50,
    }));
    const [result, setResult] = useState(null);
    const [status, setStatus] = useState("loading");
    const [error, setError] = useState(null);
    const [selected, setSelected] = useState(() => openTarget ? ({
        key: `${openTarget.sourceId}:${openTarget.itemId}:${openTarget.releaseVersion}`,
        source: { sourceId: openTarget.sourceId },
        item: { itemId: openTarget.itemId },
        release: { releaseVersion: openTarget.releaseVersion },
    }) : null);
    const [detail, setDetail] = useState(null);
    const [detailStatus, setDetailStatus] = useState("idle");
    const [detailError, setDetailError] = useState(null);
    const [installTarget, setInstallTarget] = useState(null);
    const [connectedSources, setConnectedSources] = useState(null);
    useEffect(() => {
        const controller = new AbortController();
        listMarketplaceSources({ signal: controller.signal }).then((payload) => {
            setConnectedSources(payload.sources ?? []);
        }).catch((caught) => {
            if (caught.name === "AbortError") return;
            setConnectedSources(null);
        });
        return () => controller.abort();
    }, [catalogEpoch]);
    const load = useCallback(() => {
        const controller = new AbortController();
        setStatus("loading");
        searchMarketplace(query, { signal: controller.signal }).then((payload) => {
            setResult(payload);
            setStatus("ready");
            setError(null);
            const requested = openTarget ? payload.entries.find((entry) => entry.item.itemId === openTarget.itemId
                && entry.release.releaseVersion === openTarget.releaseVersion) : null;
            setSelected((current) => requested ?? (openTarget ? current : (payload.entries.some((entry) => entry.key === current?.key) ? current : (payload.entries[0] ?? null))));
        }).catch((caught) => {
            if (caught.name === "AbortError") return;
            setStatus("error");
            setError(marketplaceApiErrorMessage(caught));
        });
        return controller;
    }, [catalogEpoch, openTarget, query]);

    useEffect(() => {
        const generation = catalogEpoch;
        let controller = null;
        const timer = setTimeout(() => { controller = load(); }, generation ? 0 : 120);
        return () => {
            clearTimeout(timer);
            controller?.abort();
        };
    }, [catalogEpoch, load]);

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
    }, [catalogEpoch, selected]);

    useEffect(() => {
        let controller = null;
        const timer = setTimeout(() => {
            if (catalogEpoch < 0) return;
            controller = loadDetail();
        }, 0);
        return () => {
            clearTimeout(timer);
            controller?.abort();
        };
    }, [catalogEpoch, loadDetail]);

    const updateFilter = (key, value) => setQuery((current) => ({ ...current, [key]: value, offset: 0 }));
    const selectRelease = (releaseVersion) => {
        setSelected((current) => current ? { ...current, release: { ...current.release, releaseVersion } } : current);
    };
    const viewResult = result ?? {
        sources: [],
        entries: [],
        facets: { publishers: [], licenses: [], contentKinds: [] },
        page: { offset: 0, limit: query.limit, total: 0 },
    };
    const sources = viewResult.sources;
    const entries = viewResult.entries;
    const kindCounts = new Map((viewResult.facets.contentKinds ?? []).map((facet) => [facet.value, facet.count]));
    const sourceName = sources.find((source) => source.sourceId === query.sourceId)?.name ?? "Source";
    const activeFilters = [
        query.track !== "stable" ? { key: "track", label: query.track === "beta" ? "Beta" : query.track } : null,
        query.sourceId ? { key: "sourceId", label: sourceName } : null,
        query.publisherId ? { key: "publisherId", label: query.publisherId } : null,
        query.license ? { key: "license", label: query.license } : null,
    ].filter(Boolean);
    const filtersDiffer = Boolean(query.q || query.contentKind || query.sort !== "name" || activeFilters.length);
    const clearFilters = () => setQuery({ ...DEFAULT_DISCOVER_QUERY });
    const template = splitMode === "stacked" ? null : discoverGridTemplate(panelLayout, splitMode);
    const resizeDiscover = (id, size) => updatePanelLayout((current) => resizePanel(current, "discover", id, size, container, splitMode));
    const stepDiscover = (id, direction, options) => updatePanelLayout((current) => stepPanelSize(current, "discover", id, direction, { ...options, container, mode: splitMode }));
    const resetDiscover = (id) => updatePanelLayout((current) => clampPanelLayout(resetPanel(current, "discover", id), "discover", container, splitMode));
    useEffect(() => {
        updatePanelLayout((current) => clampPanelLayout(current, "discover", container, splitMode));
    }, [container, splitMode, updatePanelLayout]);
    return (
        <div
            ref={discoverRef}
            className={styles.discover}
            data-split={splitMode === "stacked" ? undefined : splitMode}
            style={template ? { gridTemplateColumns: template.columns } : undefined}
        >
            {narrowFilters && <button type="button" className={styles.filtersToggle} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>Filters</button>}
            <aside id="marketplace-filters" className={styles.filters} aria-label="Marketplace filters" hidden={narrowFilters && !filtersOpen}>
                <div className={styles.searchBox}><IconSearch size={15} aria-hidden="true" /><input aria-label="Search Marketplace" value={query.q} onChange={(event) => updateFilter("q", event.target.value)} placeholder="Search verified catalog" /></div>
                <div className={styles.kindChips} role="group" aria-label="Content kind">
                    <button type="button" aria-pressed={query.contentKind === ""} onClick={() => updateFilter("contentKind", "")}>All</button>
                    {CONTENT_KINDS.map((kind) => <button type="button" key={kind} aria-pressed={query.contentKind === kind} onClick={() => updateFilter("contentKind", kind)}>{displayKind(kind)} <span>{kindCounts.get(kind) ?? 0}</span></button>)}
                </div>
                <Field label="Sort"><NativeSelect aria-label="Sort" value={query.sort} onChange={(event) => updateFilter("sort", event.target.value)}><option value="name">Name</option><option value="kind">Kind</option><option value="version">Release version</option></NativeSelect></Field>
                <details className={styles.technicalDetails}><summary>Advanced filters</summary><div className={styles.advancedFilters}><Field label="Track"><NativeSelect value={query.track} onChange={(event) => updateFilter("track", event.target.value)}><option value="stable">Stable</option><option value="beta">Beta</option></NativeSelect></Field><Field label="Source"><NativeSelect value={query.sourceId} onChange={(event) => updateFilter("sourceId", event.target.value)}><option value="">All sources</option>{sources.map((source) => <option key={source.sourceId} value={source.sourceId}>{source.name}</option>)}</NativeSelect></Field><Field label="Publisher"><NativeSelect value={query.publisherId} onChange={(event) => updateFilter("publisherId", event.target.value)}><option value="">All publishers</option>{viewResult.facets.publishers.map((facet) => <option key={facet.value} value={facet.value}>{facet.value} ({facet.count})</option>)}</NativeSelect></Field><Field label="License"><NativeSelect value={query.license} onChange={(event) => updateFilter("license", event.target.value)}><option value="">All licenses</option>{viewResult.facets.licenses.map((facet) => <option key={facet.value} value={facet.value}>{facet.value} ({facet.count})</option>)}</NativeSelect></Field></div></details>
                {filtersDiffer && <Button size="compact" onClick={clearFilters}>Clear filters</Button>}
            </aside>
            {splitMode === "wide" && <MarketplacePaneSplitter splitterId="discover-filters" label="Resize filters" axis="x" growDirection={1} aria={splitterAria(panelLayout, "discover", "filters")} controlsId="marketplace-filters" onResize={(size) => resizeDiscover("filters", size)} onStep={(direction, options) => stepDiscover("filters", direction, options)} onReset={() => resetDiscover("filters")} />}
            <section className={styles.results} aria-label="Marketplace results" aria-busy={status === "loading" || undefined}>
                <header><div><strong>{viewResult.page.total} verified items</strong><span role="status" aria-live="polite">Sort: {sortLabel(query.sort)}</span></div><Button size="compact" onClick={load} loading={status === "loading"}><IconRefresh size={14} aria-hidden="true" /> Refresh</Button></header>
                {activeFilters.length > 0 && <div className={styles.activeFilters}>{activeFilters.map((filter) => <button type="button" key={filter.key} onClick={() => updateFilter(filter.key, filter.key === "track" ? "stable" : "")}>Remove {filter.label} filter</button>)}</div>}
                {sources.some((source) => ["offline", "expired", "stale"].includes(source.health.status)) && <StatusMessage tone="warning" title="Some sources are not current">Cached verified catalog data remains available; review Marketplace Settings for details.</StatusMessage>}
                {connectedSources?.length === 0 ? <StatusMessage title="Add a marketplace source"><div className={styles.sourceNotice}><span>Connect a registry to search verified releases.</span><Button size="compact" onClick={onOpenSettings}>Add source</Button></div></StatusMessage> : status === "error" && !result ? <AsyncState status="error" title="Could not search Marketplace" detail={error} onRetry={load} /> : entries.length === 0 ? <AsyncState status="empty" title="No matching releases" detail="Change filters or refresh a source." /> : (
                    <ul className={styles.resultList}>{entries.map((entry) => <li key={entry.key}><button type="button" className={styles.resultButton} aria-current={selected?.key === entry.key ? "true" : undefined} onClick={() => setSelected(entry)}><ResultMark entry={entry} /><span className={styles.resultCopy}><span className={styles.resultTop}><strong>{entry.item.displayName}</strong>{entry.yanked && <HealthBadge status="yanked" />}{entry.source.health.status !== "ready" && <HealthBadge health={entry.source.health} />}</span><span>{entry.item.summary}</span><small>{displayKind(entry.item.contentKind)} · {entry.release.releaseVersion} · {entry.item.publisherId}</small></span></button></li>)}</ul>
                )}
                {viewResult.page.total > viewResult.page.limit && <footer className={styles.pagination}><Button size="compact" disabled={query.offset === 0} onClick={() => setQuery((current) => ({ ...current, offset: Math.max(0, current.offset - current.limit) }))}>Previous</Button><span>{query.offset + 1}–{Math.min(query.offset + query.limit, viewResult.page.total)}</span><Button size="compact" disabled={query.offset + query.limit >= viewResult.page.total} onClick={() => setQuery((current) => ({ ...current, offset: current.offset + current.limit }))}>Next</Button></footer>}
            </section>
            {splitMode !== "stacked" && <MarketplacePaneSplitter className={styles.detailSplitter} splitterId="discover-detail" label="Resize release details" axis="x" growDirection={-1} aria={splitterAria(panelLayout, "discover", "detail")} controlsId="marketplace-release-detail" onResize={(size) => resizeDiscover("detail", size)} onStep={(direction, options) => stepDiscover("detail", direction, options)} onReset={() => resetDiscover("detail")} />}
            <ReleaseDetail detail={detail} loading={detailStatus === "loading"} error={detailError} onRetry={() => loadDetail()} releaseVersion={selected?.release.releaseVersion} onReleaseVersion={selectRelease} onInstall={setInstallTarget} />
            <InstallDialog target={installTarget} onClose={() => setInstallTarget(null)} onInstalled={() => { setInstallTarget(null); onInstalled?.(); }} onOpenEnvironment={onOpenEnvironment} onOpenRunConfig={onOpenRunConfig} />
        </div>
    );
}


function StreamlinedSourceCard({ source, revision, busy, onRefresh, onRemove }) {
    return <article className={styles.sourceCard} aria-label={`${source.name} marketplace source`}>
        <header><div><h2>{source.name}</h2><p>{source.baseUrl}</p></div><HealthBadge health={source.health} /></header>
        <p className={styles.muted}>{source.health.lastSuccessAt ? `Last synced ${formatDate(source.health.lastSuccessAt)}` : "Waiting for the first successful sync."}</p>
        {source.health.lastErrorCode && <StatusMessage tone="warning" title="Sync needs attention">{source.health.lastErrorCode}</StatusMessage>}
        <details className={styles.technicalDetails}><summary>Technical details</summary><MetadataList><MetadataField label="Registry ID">{source.registryId}</MetadataField><MetadataField label="Pinned root">{source.trustedRootFingerprint}</MetadataField><MetadataField label="Catalog revision">{source.health.catalogRevision ?? "None"}</MetadataField><MetadataField label="Metadata expiry">{formatDate(source.health.earliestExpiryAt)}</MetadataField><MetadataField label="Credential">{source.credentialConfigured ? "Backend configured" : "Not configured"}</MetadataField></MetadataList></details>
        <div className={styles.sourceActions}><Button size="compact" loading={busy === "refresh"} onClick={() => onRefresh(source, revision)}><IconRefresh size={14} aria-hidden="true" /> Sync now</Button><Button size="compact" variant="danger" disabled={Boolean(busy)} onClick={() => onRemove(source)}><IconTrash size={14} aria-hidden="true" /> Remove</Button></div>
    </article>;
}

function StreamlinedSourcesTab({ showHeader = true, onCatalogChanged }) {
    const [snapshot, setSnapshot] = useState({ revision: 0, sources: [] });
    const [status, setStatus] = useState("loading");
    const [error, setError] = useState(null);
    const [addOpen, setAddOpen] = useState(false);
    const [removeTarget, setRemoveTarget] = useState(null);
    const [busy, setBusy] = useState({});
    const addButtonRef = useRef(null);
    const [baseUrl, setBaseUrl] = useState("");
    const [connecting, setConnecting] = useState(false);
    const [connectError, setConnectError] = useState(null);
    const load = useCallback(() => listMarketplaceSources().then((payload) => {
        setSnapshot(payload); setStatus("ready"); setError(null); return payload;
    }).catch((caught) => { setStatus("error"); setError(marketplaceApiErrorMessage(caught)); throw caught; }), []);
    useEffect(() => { load().catch(() => {}); }, [load]);
    const connect = async () => {
        setConnecting(true); setConnectError(null);
        try {
            const result = await connectMarketplaceSource(baseUrl.trim());
            await load();
            setAddOpen(false); setBaseUrl("");
            if (result.warnings?.length) setError(result.warnings.map((warning) => warning.message).join(" "));
        } catch (caught) { setConnectError(marketplaceApiErrorMessage(caught)); }
        finally { setConnecting(false); }
    };
    const refresh = async (source) => {
        setBusy((current) => ({ ...current, [source.sourceId]: "refresh" }));
        try { await refreshMarketplaceSource(source.sourceId, snapshot.revision); await load(); }
        catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
        finally {
            setBusy((current) => ({ ...current, [source.sourceId]: null }));
            onCatalogChanged?.();
        }
    };
    const remove = async () => {
        const target = removeTarget;
        setBusy((current) => ({ ...current, [target.sourceId]: "remove" }));
        try { await removeMarketplaceSource(target.sourceId, snapshot.revision); setRemoveTarget(null); await load(); }
        catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
        finally { setBusy((current) => ({ ...current, [target.sourceId]: null })); }
    };
    return <div className={styles.sources}>
        <header className={styles.sourcesHeader}>{showHeader ? <div><h2>Sources</h2><p>Connect registries already approved by the Marketplace operator.</p></div> : <p className={styles.muted}>Connect registries already approved by the Marketplace operator.</p>}<Button ref={addButtonRef} onClick={() => setAddOpen(true)}><IconPlus size={14} aria-hidden="true" /> Add source</Button></header>
        {error && <StatusMessage tone="warning" title="Source needs attention">{error}</StatusMessage>}
        {status === "loading" ? <AsyncState title="Loading sources" /> : status === "error" && !snapshot.sources.length ? <AsyncState status="error" title="Could not load sources" detail={error} onRetry={load} /> : snapshot.sources.length === 0 ? <div className={styles.emptyHero}><IconDatabase size={28} aria-hidden="true" /><h2>No sources connected</h2><p>Add the URL supplied by your Marketplace operator.</p></div> : <div className={styles.sourceGrid}>{snapshot.sources.map((source) => <StreamlinedSourceCard key={`${source.sourceId}:${snapshot.revision}`} source={source} revision={snapshot.revision} busy={busy[source.sourceId]} onRefresh={refresh} onRemove={setRemoveTarget} />)}</div>}
        <DialogSurface open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) { setConnectError(null); setBaseUrl(""); } }} onCloseAutoFocus={(event) => { event.preventDefault(); addButtonRef.current?.focus(); }} title="Add source" description="Paste the Marketplace URL. Trust, credentials, and publishing access are configured securely by the backend." footer={<><Button onClick={() => setAddOpen(false)}>Cancel</Button><Button variant="primary" loading={connecting} disabled={!baseUrl.trim()} onClick={connect}>Connect</Button></>}>
            {connectError && <StatusMessage tone="danger" title="Could not connect source">{connectError}</StatusMessage>}
            <Field label="Marketplace URL" required><TextInput type="url" autoFocus value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://marketplace.example" /></Field>
        </DialogSurface>
        <DialogSurface open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)} title="Remove source" description="This removes the local trust relationship and verified cache. Installed and authored content remains." footer={<><Button onClick={() => setRemoveTarget(null)}>Cancel</Button><Button variant="danger" loading={busy[removeTarget?.sourceId] === "remove"} onClick={remove}>Remove source</Button></>}><p>{removeTarget?.name}</p></DialogSurface>
    </div>;
}

function SecurityTab() {
    const [policy, setPolicy] = useState(null);
    const [advisories, setAdvisories] = useState(null);
    const [installed, setInstalled] = useState(null);
    const [overrideTarget, setOverrideTarget] = useState(null);
    const [overrideReason, setOverrideReason] = useState("");
    const [error, setError] = useState(null);
    const load = useCallback(async () => {
        try {
            const [nextPolicy, nextAdvisories, nextInstalled] = await Promise.all([
                getMarketplacePolicy(), listMarketplaceAdvisories(), listMarketplaceInstalled(),
            ]);
            setPolicy(nextPolicy); setAdvisories(nextAdvisories); setInstalled(nextInstalled); setError(null);
        } catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
    }, []);
    useEffect(() => {
        const timer = setTimeout(load, 0);
        return () => clearTimeout(timer);
    }, [load]);
    const approval = async (registryId, publisherId, approved) => {
        try {
            setPolicy(await setMarketplacePublisherApproval({ registryId, publisherId, approved, expectedRevision: policy.revision }));
        } catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
    };
    const allowPackage = async () => {
        try {
            const next = await setMarketplaceOperatorOverrideForRelease({
                registryId: overrideTarget.registryId,
                itemId: overrideTarget.release.itemId,
                releaseVersion: overrideTarget.release.releaseVersion,
                artifactSha256: overrideTarget.release.artifactSha256,
                reason: overrideReason,
                expectedRevision: policy.revision,
            });
            setPolicy(next);
            setOverrideTarget(null);
            setOverrideReason("");
        } catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
    };
    const affectedInstalled = (record) => {
        const registryPolicy = policy.registries.find((entry) => entry.registryId === record.registryId);
        return installed.installations.filter((installation) => {
            if (installation.registryId !== record.registryId) return false;
            const origin = registryPolicy?.releases.find((release) => release.itemId === installation.release.itemId
                && release.releaseVersion === installation.release.releaseVersion
                && release.artifactSha256 === installation.release.artifactSha256);
            return record.advisory.affected.some((subject) => (
                (subject.itemId === installation.release.itemId && subject.releaseVersion === installation.release.releaseVersion)
                || subject.artifactSha256 === installation.release.artifactSha256
                || (subject.packageHash && origin?.packageHashes.includes(subject.packageHash))
            ));
        });
    };
    return <div className={styles.sources}>
        <header className={styles.sourcesHeader}><div><h2>Security policy</h2></div><Button size="compact" onClick={load}><IconRefresh size={14} aria-hidden="true" /> Refresh</Button></header>
        {error && <StatusMessage tone="danger" title="Security policy operation failed">{error}</StatusMessage>}
        {!policy || !advisories || !installed ? <AsyncState title="Loading security policy" /> : <div className={styles.securityList}>
            {policy.registries.map((entry) => {
                const blockedPublishers = entry.publishers.filter((publisherId) => !entry.approvedPublishers?.includes(publisherId));
                return <article className={styles.sourceCard} key={entry.registryId}>
                    <header><div><h2>Publisher access</h2><p>{blockedPublishers.length ? "Approval is required before installing signed executable content." : "No publisher action is required."}</p></div>{blockedPublishers.length ? <span className={styles.health} data-tone="warning">{blockedPublishers.length} blocked</span> : null}</header>
                    {blockedPublishers.length ? <ul className={styles.plainList}>{blockedPublishers.map((publisherId) => <li key={publisherId}><span>{publisherId}</span><Button size="compact" onClick={() => approval(entry.registryId, publisherId, true)}>Approve publisher</Button></li>)}</ul> : <p className={styles.muted}>All retained publishers are approved.</p>}
                    <details className={styles.technicalDetails}><summary>Technical details</summary><MetadataList><MetadataField label="Registry ID">{entry.registryId}</MetadataField><MetadataField label="Timestamp floor">{entry.highestTimestampVersion}</MetadataField><MetadataField label="Snapshot floor">{entry.highestSnapshotSha256 || "None"}</MetadataField><MetadataField label="Retained sources">{entry.sourceIds.join(", ") || "None"}</MetadataField></MetadataList>{entry.approvedPublishers?.length ? <><h3>Approved publishers</h3><ul className={styles.plainList}>{entry.approvedPublishers.map((publisherId) => <li key={publisherId}><span>{publisherId}</span><Button size="compact" onClick={() => approval(entry.registryId, publisherId, false)}>Revoke approval</Button></li>)}</ul></> : null}</details>
                </article>;
            })}
            {advisories.map((record) => {
                const affected = affectedInstalled(record);
                return <article className={styles.sourceCard} key={`${record.registryId}:${record.advisory.advisoryId}`}><header><div><h2>{record.advisory.action === "block" ? "Blocked content" : "Security advisory"}</h2><p>{record.advisory.rationale}</p></div><span className={styles.health} data-tone={record.advisory.action === "block" ? "danger" : "warning"}>{record.advisory.severity}</span></header><MetadataList><MetadataField label="Issued">{formatDate(record.advisory.issuedAt)}</MetadataField><MetadataField label="Affected installed content">{affected.length ? affected.map((entry) => `${entry.release.itemId}@${entry.release.releaseVersion}`).join(", ") : "None"}</MetadataField></MetadataList>{record.advisory.action === "block" && affected.map((entry) => <Button size="compact" key={`${entry.sourceId}:${entry.release.itemId}`} onClick={() => setOverrideTarget(entry)}>Review local override for {entry.release.itemId}</Button>)}<details className={styles.technicalDetails}><summary>Technical details</summary><MetadataList><MetadataField label="Advisory ID">{record.advisory.advisoryId}</MetadataField><MetadataField label="Publisher ID">{record.advisory.publisherId}</MetadataField><MetadataField label="Registry ID">{record.registryId}</MetadataField><MetadataField label="Subjects">{record.advisory.affected.map((subject) => subject.packageHash ?? subject.artifactSha256 ?? `${subject.itemId}@${subject.releaseVersion}`).join(", ")}</MetadataField><MetadataField label="Record hash">{record.hash}</MetadataField></MetadataList></details></article>;
            })}
            <article className={styles.sourceCard} aria-label="Local operator overrides"><header><div><h2>Local overrides</h2><p>Allow decisions are local, reasoned, and nonsemantic.</p></div><span className={styles.health} data-tone="warning">{policy.overrides.length}</span></header>{policy.overrides.length ? <ul className={styles.plainList}>{policy.overrides.map((entry) => <li key={entry.packageHash}><span>{entry.reason}</span><small>{formatDate(entry.createdAt)}</small></li>)}</ul> : <p className={styles.muted}>No local package overrides.</p>}<details className={styles.technicalDetails}><summary>Technical details</summary><MetadataList>{policy.overrides.map((entry) => <MetadataField label={entry.reason} key={entry.packageHash}>{entry.packageHash}</MetadataField>)}</MetadataList></details></article>
        </div>}
        <DialogSurface open={Boolean(overrideTarget)} onOpenChange={(open) => !open && setOverrideTarget(null)} title="Allow blocked installed content" description="This local exception applies only to the executable package derived from the selected installed release." footer={<><Button onClick={() => setOverrideTarget(null)}>Cancel</Button><Button variant="danger" disabled={!overrideReason.trim()} onClick={allowPackage}>Confirm local override</Button></>}><p>{overrideTarget?.release.itemId}@{overrideTarget?.release.releaseVersion}</p><Field label="Reason" required><TextInput value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} /></Field></DialogSurface>
    </div>;
}

function LibraryTab({ onOpenEnvironment, onOpenRunConfig, onOpenDiscover }) {
    const [library, setLibrary] = useState(null);
    const [libraryQuery, setLibraryQuery] = useState("");
    const [libraryKind, setLibraryKind] = useState("");
    const [error, setError] = useState(null);
    const [removing, setRemoving] = useState(null);
    const [installTarget, setInstallTarget] = useState(null);
    const load = useCallback(() => getMarketplaceLibrary().then((value) => {
        setLibrary(value); setError(null);
    }).catch((caught) => setError(marketplaceApiErrorMessage(caught))), []);
    useEffect(() => { const timer = setTimeout(load, 0); return () => clearTimeout(timer); }, [load]);
    const reviewUpdate = async (entry) => {
        try {
            const update = entry.update;
            const detail = await getMarketplaceItem(update.identity.sourceId, update.identity.itemId, { releaseVersion: update.candidate.release.releaseVersion });
            setInstallTarget({
                ...detail,
                updateIntent: {
                    kind: "update",
                    track: update.track,
                    from: { sourceId: update.identity.sourceId, registryId: update.identity.registryId, release: update.from.release },
                },
            });
        } catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
    };
    const remove = async () => {
        try {
            await removeMarketplaceInstalled({
                sourceId: removing.sourceId,
                itemId: removing.itemId,
                releaseVersion: removing.releaseVersion,
                artifactSha256: removing.artifactSha256,
            }, library.revision);
            setRemoving(null);
            await load();
        } catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
    };
    if (!library && !error) return <AsyncState title="Loading library" />;
    if (!library) return <AsyncState status="error" title="Could not load library" detail={error} onRetry={load} />;
    const updateCount = library.entries.filter((entry) => entry.update).length;
    const needle = libraryQuery.trim().toLocaleLowerCase("en-US");
    const visible = library.entries.filter((entry) => {
        const haystack = `${entry.displayName}\n${entry.itemId}\n${entry.contentKind ?? ""}`.toLocaleLowerCase("en-US");
        return (!needle || haystack.includes(needle)) && (!libraryKind || entry.contentKind === libraryKind);
    }).sort((left, right) => Number(Boolean(right.update)) - Number(Boolean(left.update))
        || left.displayName.localeCompare(right.displayName));
    return <div className={styles.sources}>
        <header className={styles.sourcesHeader}><div><h2>Library</h2><p>{updateCount ? `${updateCount} ${updateCount === 1 ? "update" : "updates"}` : "Installed content and verified updates."}</p></div><Button size="compact" onClick={load}><IconRefresh size={14} aria-hidden="true" /> Refresh</Button></header>
        <div className={styles.libraryToolbar}>
            <div className={styles.searchBox}><IconSearch size={15} aria-hidden="true" /><input aria-label="Search library" value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search installed content" /></div>
            <NativeSelect aria-label="Library kind" value={libraryKind} onChange={(event) => setLibraryKind(event.target.value)}><option value="">All kinds</option>{CONTENT_KINDS.map((kind) => <option key={kind} value={kind}>{displayKind(kind)}</option>)}</NativeSelect>
        </div>
        {error && <StatusMessage tone="danger" title="Library operation failed">{error}</StatusMessage>}
        {library.entries.length === 0 ? <div className={styles.emptyHero}><IconCloudOff size={30} aria-hidden="true" /><h2>Your library is empty</h2><p>Content appears here after you install it from Discover.</p><Button onClick={onOpenDiscover}>Browse Discover</Button></div> : visible.length === 0 ? <AsyncState status="empty" title="No matching installed content" detail="Change the library search or kind filter." /> : <ul className={styles.libraryList}>{visible.map((entry) => {
            const environment = entry.mappings.find((mapping) => mapping.resourceKind === "environment");
            const run = entry.mappings.find((mapping) => mapping.resourceKind === "run-manifest");
            const direct = entry.owners.some((owner) => owner.kind === "direct");
            const advisory = (library.advisories ?? []).find((record) => releaseMatchesAdvisory(entry, record));
            return <li key={`${entry.sourceId}:${entry.itemId}:${entry.releaseVersion}:${entry.artifactSha256}`}><article className={styles.libraryRow}>
                <span className={styles.kindMark} aria-hidden="true">{displayKind(entry.contentKind).slice(0, 1) || "?"}</span>
                <div>
                    <header><div><h2>{entry.displayName}</h2><p>Version {entry.releaseVersion}</p></div><div className={styles.badgeRow}>{entry.update ? <span className={styles.health} data-tone="warning">Update available</span> : null}{advisory ? <HealthBadge status="blocked" label="Security advisory" /> : null}{!entry.update && entry.status !== "installed" ? <span className={styles.health} data-tone="warning">{sourceHealthLabel(entry.status)}</span> : null}</div></header>
                    {entry.summary ? <p>{entry.summary}</p> : null}
                    <p className={styles.muted}>{displayKind(entry.contentKind) || "Installed"} · {entry.installedAt ? `Installed ${formatDate(entry.installedAt)}` : "Installed locally"}</p>
                    <div className={styles.sourceActions}>{entry.update && <Button size="compact" variant="primary" onClick={() => reviewUpdate(entry)}>Review update</Button>}{environment && <Button size="compact" onClick={() => onOpenEnvironment?.(environment.localId)}>Open environment</Button>}{run && <Button size="compact" onClick={() => onOpenRunConfig?.(run.localId)}>Open run configuration</Button>}{direct ? <Button size="compact" variant="danger" onClick={() => setRemoving(entry)}>{entry.collection ? "Remove collection" : "Remove"}</Button> : <span className={styles.muted}>Retained by collection ownership.</span>}</div>
                    <details className={styles.technicalDetails}><summary>Technical details</summary><MetadataList><MetadataField label="Item ID">{entry.itemId}</MetadataField><MetadataField label="Source ID">{entry.sourceId}</MetadataField><MetadataField label="Registry ID">{entry.registryId}</MetadataField><MetadataField label="Artifact SHA-256">{entry.artifactSha256}</MetadataField><MetadataField label="Receipt">{entry.receiptHash ?? "Unavailable"}</MetadataField><MetadataField label="Owners">{entry.owners.length ? entry.owners.map((owner) => owner.kind).join(", ") : "Unavailable"}</MetadataField><MetadataField label="Dependency lock">{entry.dependencyLock.length ? entry.dependencyLock.map((dependency) => `${dependency.itemId}@${dependency.releaseVersion}`).join(", ") : "None"}</MetadataField></MetadataList></details>
                </div>
            </article></li>;
        })}</ul>}
        <InstallDialog target={installTarget} onClose={() => setInstallTarget(null)} onInstalled={() => { setInstallTarget(null); load(); }} onOpenEnvironment={onOpenEnvironment} onOpenRunConfig={onOpenRunConfig} />
        <DialogSurface open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)} title={removing?.collection ? "Remove collection" : "Remove installation"} description="This removes the direct owner only. Collection and authored content are preserved while another owner remains." footer={<><Button onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" onClick={remove}>Remove</Button></>}>
            <StatusMessage tone="warning" title={removing ? `${removing.itemId}@${removing.releaseVersion}` : "Exact release"}>Other direct or collection owners keep a member installed. Last-owner removal updates Marketplace visibility but retains immutable receipts, cached artifacts, CAS bytes, visual roots, and authored content.</StatusMessage>
        </DialogSurface>
    </div>;
}


function MarketplaceSettings({ open, onOpenChange, onCatalogChanged }) {
    const [section, setSection] = useState("sources");
    return <DialogSurface open={open} onOpenChange={onOpenChange} title="Marketplace settings" description="" className={styles.settingsDialog} footer={<Button onClick={() => onOpenChange(false)}>Done</Button>}>
        <TabsRoot value={section} onValueChange={setSection}>
            <TabsList aria-label="Marketplace settings sections"><TabsTrigger value="sources">Sources</TabsTrigger><TabsTrigger value="security">Security</TabsTrigger></TabsList>
            <TabsContent value="sources"><StreamlinedSourcesTab showHeader={false} onCatalogChanged={onCatalogChanged} /></TabsContent>
            <TabsContent value="security"><SecurityTab /></TabsContent>
        </TabsRoot>
    </DialogSurface>;
}

export default function MarketplaceWorkspace({ onOpenWorkspace, onOpenEnvironment, onOpenRunConfig }) {
    const [tab, setTab] = useState("discover");
    const [discoverTarget, setDiscoverTarget] = useState(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [catalogEpoch, setCatalogEpoch] = useState(0);
    const openPublished = (plan) => {
        const entry = plan.entries.find((candidate) => candidate.draftId === plan.rootDraftId) ?? plan.entries.at(-1);
        setDiscoverTarget({
            sourceId: plan.source.sourceId,
            itemId: entry.item.itemId,
            releaseVersion: entry.release.releaseVersion,
            track: entry.track,
            requestId: Date.now(),
        });
        setTab("discover");
    };
    return (
        <TabsRoot value={tab} onValueChange={setTab} className={styles.root}>
            <WorkspaceFrame
                title="Marketplace"
                subtitle="Verified catalogs"
                onOpenWorkspace={onOpenWorkspace}
                className={styles.workspace}
                contentClassName={styles.workspaceContent}
                actions={<div className={styles.workspaceActions}><TabsList aria-label="Marketplace sections"><TabsTrigger value="discover">Discover</TabsTrigger><TabsTrigger value="library">Library</TabsTrigger><TabsTrigger value="publish">Publish</TabsTrigger></TabsList><Button size="compact" onClick={() => setSettingsOpen(true)}><IconSettings size={14} aria-hidden="true" /> Settings</Button></div>}
            >
                <h1 className={styles.srOnly}>Marketplace</h1>
                <TabsContent value="discover" className={styles.tabContent}><DiscoverTab key={discoverTarget?.requestId ?? "discover"} catalogEpoch={catalogEpoch} onOpenEnvironment={onOpenEnvironment} onOpenRunConfig={onOpenRunConfig} onInstalled={() => setTab("library")} onOpenSettings={() => setSettingsOpen(true)} openTarget={discoverTarget} /></TabsContent>
                <TabsContent value="publish" className={styles.tabContent}><PublishTab onOpenPublished={openPublished} /></TabsContent>
                <TabsContent value="library" className={styles.tabContent}><LibraryTab onOpenEnvironment={onOpenEnvironment} onOpenRunConfig={onOpenRunConfig} onOpenDiscover={() => setTab("discover")} /></TabsContent>
            </WorkspaceFrame>
            <MarketplaceSettings open={settingsOpen} onCatalogChanged={() => setCatalogEpoch((epoch) => epoch + 1)} onOpenChange={(open) => { setSettingsOpen(open); if (!open) setCatalogEpoch((epoch) => epoch + 1); }} />
        </TabsRoot>
    );
}
