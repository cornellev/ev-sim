import styles from "./PluginsPage.module.css";

export function PluginPackageList({ packages, selectedDirectory, onSelect }) {
    return (
        <nav className={styles.list} aria-label="Local plugins">
            <header className={styles.listHeader}>
                <p className={styles.listTitle}>Plugins</p>
            </header>
            <ul className={styles.packageList}>
                {packages.map((entry) => {
                    const selected = entry.directory === selectedDirectory;
                    return (
                        <li key={entry.directory}>
                            <button
                                type="button"
                                className={styles.packageButton}
                                aria-current={selected ? "true" : undefined}
                                onClick={() => onSelect(entry.directory)}
                            >
                                <span className={styles.packageId}>{entry.id}</span>
                                {entry.version ? <span className={styles.packageVersion}>{entry.version}</span> : null}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
