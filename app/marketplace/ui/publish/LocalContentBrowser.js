'use client';

import { IconChevronLeft, IconChevronRight, IconPlus, IconSearch } from "@tabler/icons-react";

import { Button, NativeSelect, TextInput } from "../../../ui";
import styles from "../MarketplaceWorkspace.module.css";

function kindLabel(value) {
    return String(value).split("-").map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(" ");
}

export default function LocalContentBrowser({ inventory, query, onQueryChange, onCreate, assetPackDraft, onAddToAssetPack, disabled }) {
    const page = inventory?.page ?? { offset: 0, limit: 50, total: 0 };
    return <section className={styles.publishColumn} aria-labelledby="publisher-local-heading">
        <header className={styles.publishColumnHeader}><div><h2 id="publisher-local-heading">Local catalog</h2><p>{page.total} authored entries</p></div></header>
        <div className={styles.publishFilters}>
            <div className={styles.publishFilterRow}>
                <div className={styles.searchField}><IconSearch size={14} aria-hidden="true" /><TextInput aria-label="Search" value={query.q} onChange={(event) => onQueryChange({ ...query, q: event.target.value, offset: 0 })} /></div>
                <NativeSelect aria-label="Content kind" value={query.contentKind} onChange={(event) => onQueryChange({ ...query, contentKind: event.target.value, offset: 0 })}><option value="">All content</option><option value="plugin">Plugins</option><option value="vehicle">Vehicles</option><option value="run-template">Run configurations</option><option value="environment">Environments</option><option value="asset-pack">Asset packs</option></NativeSelect>
                <NativeSelect aria-label="Publication status" value={query.status} onChange={(event) => onQueryChange({ ...query, status: event.target.value, offset: 0 })}><option value="all">Any status</option><option value="unpublished">Unpublished</option><option value="drafted">Has draft</option><option value="published">Published here</option><option value="publishable">Publishable</option><option value="unavailable">Unavailable</option></NativeSelect>
                <NativeSelect aria-label="Sort publications" value={`${query.sort}:${query.direction}`} onChange={(event) => {
                    const [sort, direction] = event.target.value.split(":");
                    onQueryChange({ ...query, sort, direction, offset: 0 });
                }}><option value="name:asc">Name</option><option value="name:desc">Name descending</option><option value="updated:desc">Updated</option><option value="kind:asc">Kind</option></NativeSelect>
            </div>
        </div>
        <div className={styles.publishList} tabIndex={0} aria-label="Authored entries">
            {inventory?.entries.map((entry) => <article className={styles.publishListItem} key={entry.key} data-disabled={!entry.publishable || undefined}>
                <div><span className={styles.kindLabel}>{kindLabel(entry.contentKind)} · {entry.publicationStatus}</span><h3>{entry.name}</h3><p>{entry.summary}</p>{entry.unavailableReason && <small className={styles.publishWarning}>{entry.unavailableReason}</small>}</div>
                <div className={styles.publishItemActions}>
                    {entry.contentKind === "asset-pack" && assetPackDraft ? <Button size="compact" aria-label={`Add ${entry.name} to pack`} disabled={disabled || !entry.publishable || assetPackDraft.localSelection.roots.some((root) => root.assetId === entry.localSelection.roots[0].assetId)} onClick={() => onAddToAssetPack(assetPackDraft, entry)}><IconPlus size={14} aria-hidden="true" /> Add to pack</Button> : null}
                    <Button variant="primary" size="compact" aria-label={`${entry.publicationStatus === "published" ? "Update" : "Publish"} ${entry.name}`} disabled={disabled || !entry.publishable} onClick={() => onCreate(entry)}><IconPlus size={14} aria-hidden="true" /> {entry.publicationStatus === "published" ? "Update" : "Publish"}</Button>
                </div>
            </article>)}
            {inventory && inventory.entries.length === 0 ? <p className={styles.publishEmpty}>No local content matches these filters.</p> : null}
        </div>
        <footer className={styles.publishPager}>
            <Button size="compact" disabled={page.offset === 0} onClick={() => onQueryChange({ ...query, offset: Math.max(0, page.offset - page.limit) })}><IconChevronLeft size={14} aria-hidden="true" /> Previous</Button>
            <span>{page.total ? `${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)} of ${page.total}` : "0 entries"}</span>
            <Button size="compact" disabled={page.offset + page.limit >= page.total} onClick={() => onQueryChange({ ...query, offset: page.offset + page.limit })}>Next <IconChevronRight size={14} aria-hidden="true" /></Button>
        </footer>
    </section>;
}
