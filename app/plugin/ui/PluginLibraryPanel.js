'use client';

import { useState } from "react";

import { AsyncState } from "../../ui";
import { PluginPackageDetail } from "./PluginPackageDetail.js";
import { PluginPackageList } from "./PluginPackageList.js";
import { selectLocalPackage } from "./pluginSelection.js";
import { usePluginLibrary } from "./usePluginLibrary.js";
import styles from "./PluginsPage.module.css";

export function PluginLibraryPanel() {
    const library = usePluginLibrary();
    const [preferredDirectory, setPreferredDirectory] = useState(null);
    const selectedDirectory = selectLocalPackage(library.packages, preferredDirectory);
    const entry = library.packages.find((item) => item.directory === selectedDirectory) ?? null;

    if (library.status === "loading" && library.packages.length === 0) {
        return <div className={styles.centerState}><AsyncState title="Loading plugins" /></div>;
    }
    if (library.status === "error" && library.packages.length === 0) {
        return (
            <div className={styles.centerState}>
                <AsyncState
                    status="error"
                    title="Could not load plugins"
                    detail={library.error || "The plugins folder is unavailable."}
                    onRetry={library.refresh}
                />
            </div>
        );
    }
    if (library.status === "ready" && library.packages.length === 0) {
        return <div className={styles.centerState}><AsyncState status="empty" title="No local plugins" detail="Add a package under the plugins folder." /></div>;
    }

    const detailStatus = entry?.error ? "error" : entry?.document ? "ready" : "error";
    return (
        <div className={styles.library}>
            <PluginPackageList
                packages={library.packages}
                selectedDirectory={selectedDirectory}
                onSelect={setPreferredDirectory}
            />
            {entry ? (
                <PluginPackageDetail
                    entry={entry}
                    document={entry.document}
                    status={detailStatus}
                    error={entry.error}
                    onRetry={library.refresh}
                />
            ) : (
                <div className={styles.centerState}><AsyncState title="Loading plugin" /></div>
            )}
        </div>
    );
}
