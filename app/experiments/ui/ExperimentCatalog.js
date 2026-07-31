'use client';

import { IconFlask2, IconPlus, IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";

import { Button } from "../../ui";
import styles from "./ExperimentWorkspace.module.css";

export default function ExperimentCatalog({ suites, selectedId, onSelect, onCreate }) {
    const [query, setQuery] = useState("");
    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return suites;
        return suites.filter((suite) => `${suite.name} ${suite.description || ""}`.toLowerCase().includes(needle));
    }, [query, suites]);

    return (
        <div className={styles.catalog}>
            <header>
                <div><span className={styles.eyebrow}>Library</span><strong>{suites.length} suite{suites.length === 1 ? "" : "s"}</strong></div>
                <Button size="compact" variant="primary" onClick={onCreate}><IconPlus size={14} stroke={1.75} /> New</Button>
            </header>
            <label className={styles.search}>
                <IconSearch size={14} stroke={1.75} aria-hidden="true" />
                <span className={styles.srOnly}>Search suites</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search experiment suites" />
            </label>
            <nav className={styles.suiteList} aria-label="Experiment suites">
                {filtered.map((suite, index) => (
                    <button type="button" key={suite.id} data-selected={suite.id === selectedId || undefined} aria-current={suite.id === selectedId ? "page" : undefined} onClick={() => onSelect(suite.id)}>
                        <span className={styles.suiteOrdinal}>{String(index + 1).padStart(2, "0")}</span>
                        <span><strong>{suite.name || suite.id}</strong><small>{suite.description || `${suite.scenarioIds?.length || 0} scenarios · ${suite.manifestIds?.length || 0} manifests`}</small></span>
                        <IconFlask2 size={15} stroke={1.55} aria-hidden="true" />
                    </button>
                ))}
                {filtered.length === 0 && <div className={styles.catalogEmpty}><IconFlask2 size={22} stroke={1.45} /><strong>{query ? "No matching suites" : "No experiment suites"}</strong><p>{query ? "Try another search." : "Create a suite to compare deterministic scenario runs."}</p></div>}
            </nav>
        </div>
    );
}
