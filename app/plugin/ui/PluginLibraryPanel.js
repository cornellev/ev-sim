'use client';

import { useState } from "react";

import { AsyncState } from "../../ui";
import { installLocalPlugin } from "../PluginClient.js";
import { PluginPackageDetail } from "./PluginPackageDetail.js";
import { PluginPackageList } from "./PluginPackageList.js";
import { localPackageInstallState, selectLocalPackage } from "./pluginSelection.js";
import { usePluginLibrary } from "./usePluginLibrary.js";
import styles from "./PluginsPage.module.css";

export function PluginLibraryPanel() {
    const library = usePluginLibrary();
    const [preferredDirectory, setPreferredDirectory] = useState(null);
    const [installingDirectory, setInstallingDirectory] = useState(null);
    const [installFailure, setInstallFailure] = useState(null);
    const selectedDirectory = selectLocalPackage(library.packages, preferredDirectory);
    const entry = library.packages.find((item) => item.directory === selectedDirectory) ?? null;
    const installState = localPackageInstallState(entry, library.installed);
    const installError = installFailure?.directory === selectedDirectory ? installFailure.message : null;

    const install = async () => {
        if (!entry || installState !== "detected" || installingDirectory) return;
        setInstallingDirectory(entry.directory);
        setInstallFailure(null);
        try {
            await installLocalPlugin(entry.directory);
            await library.refresh();
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : "Could not install the plugin.";
            setInstallFailure({ directory: entry.directory, message });
        } finally {
            setInstallingDirectory(null);
        }
    };

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
                installed={library.installed}
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
                    installState={installState}
                    installing={installingDirectory === entry.directory}
                    installError={installError}
                    onInstall={install}
                />
            ) : (
                <div className={styles.centerState}><AsyncState title="Loading plugin" /></div>
            )}
        </div>
    );
}
