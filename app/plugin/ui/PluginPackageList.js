import { localPackageInstallState } from "./pluginSelection.js";
import styles from "./PluginsPage.module.css";

function statusLabel(state) {
    if (state === "installed") return "Installed";
    if (state === "detected") return "Not installed";
    return null;
}

export function PluginPackageList({ packages, installed, selectedDirectory, onSelect }) {
    return (
        <nav className={styles.list} aria-label="Local plugins">
            <header className={styles.listHeader}>
                <p className={styles.listTitle}>Plugins</p>
            </header>
            <ul className={styles.packageList}>
                {packages.map((entry) => {
                    const selected = entry.directory === selectedDirectory;
                    const label = statusLabel(localPackageInstallState(entry, installed));
                    const name = entry.version ? `${entry.id} ${entry.version}` : entry.id;
                    return (
                        <li key={entry.directory}>
                            <button
                                type="button"
                                className={styles.packageButton}
                                aria-label={name}
                                aria-current={selected ? "true" : undefined}
                                onClick={() => onSelect(entry.directory)}
                            >
                                <span className={styles.packageId}>{entry.id}</span>
                                {entry.version ? <span className={styles.packageVersion}>{entry.version}</span> : null}
                                {label ? <span className={styles.packageStatus}>{label}</span> : null}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
