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
    getMarketplaceItem,
    listMarketplaceSources,
    MarketplaceApiError,
    marketplaceApiErrorMessage,
    previewMarketplaceSource,
    refreshMarketplaceSource,
    removeMarketplaceSource,
    searchMarketplace,
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

function Compatibility({ compatibility }) {
    const list = (values) => values?.length ? values.join(", ") : "Any";
    return (
        <section className={styles.detailSection} aria-labelledby="marketplace-compatibility-heading">
            <h3 id="marketplace-compatibility-heading">Declared requirements</h3>
            <p className={styles.muted}>These are publisher-declared constraints, not an installation eligibility verdict.</p>
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

function ReleaseDetail({ detail, loading, error, onRetry, releaseVersion, onReleaseVersion }) {
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
                <Button disabled aria-describedby="marketplace-install-disabled">{actionLabel}</Button>
            </div>
            <p id="marketplace-install-disabled" className={styles.muted}>Installation and import actions become available in MKT-07.</p>
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
            <Compatibility compatibility={release.compatibility} />
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

function DiscoverTab() {
    const [query, setQuery] = useState({ q: "", track: "stable", contentKind: "", sourceId: "", publisherId: "", license: "", offset: 0, limit: 50 });
    const [result, setResult] = useState(null);
    const [status, setStatus] = useState("loading");
    const [error, setError] = useState(null);
    const [selected, setSelected] = useState(null);
    const [detail, setDetail] = useState(null);
    const [detailStatus, setDetailStatus] = useState("idle");
    const [detailError, setDetailError] = useState(null);
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
            <ReleaseDetail detail={detail} loading={detailStatus === "loading"} error={detailError} onRetry={() => loadDetail()} releaseVersion={selected?.release.releaseVersion} onReleaseVersion={selectRelease} />
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

function InstalledTab() {
    return <div className={styles.emptyHero}><IconCloudOff size={30} aria-hidden="true" /><h2>No Marketplace installation ledger yet</h2><p>MKT-06 is read-only. Exact installed membership, receipts, dependency locks, mappings, and removal begin with the MKT-07 transaction coordinator.</p></div>;
}

export default function MarketplaceWorkspace({ onOpenWorkspace }) {
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
                <TabsContent value="discover" className={styles.tabContent}><DiscoverTab /></TabsContent>
                <TabsContent value="installed" className={styles.tabContent}><InstalledTab /></TabsContent>
                <TabsContent value="sources" className={styles.tabContent}><SourcesTab /></TabsContent>
            </WorkspaceFrame>
        </TabsRoot>
    );
}
