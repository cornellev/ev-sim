import { AsyncState, Button } from "../../ui";
import styles from "./PluginsPage.module.css";

function Field({ label, value }) {
    return (
        <div>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}

function Block({ title, children }) {
    return (
        <section className={styles.block}>
            <h2>{title}</h2>
            {children}
        </section>
    );
}

function installLabel(installState) {
    if (installState === "installed") return "Installed";
    if (installState === "detected") return "Not installed";
    if (installState === "update-available") return "Update available";
    return null;
}

function showPackageAction(installState, imported) {
    if (installState === "unavailable") return false;
    return imported || installState === "detected" || installState === "update-available";
}

export function PluginPackageDetail({
    entry,
    document,
    status,
    error,
    onRetry,
    installState = "unavailable",
    installing = false,
    imported = false,
    installError = null,
    installMessage = null,
    onInstall,
}) {
    if (status === "loading") {
        return <div className={styles.centerState}><AsyncState title="Loading plugin" /></div>;
    }
    if (status === "error") {
        return (
            <div className={styles.centerState}>
                <AsyncState
                    status="error"
                    title="Could not load plugin"
                    detail={error || "plugin.json is unavailable."}
                    onRetry={onRetry}
                />
            </div>
        );
    }
    if (status !== "ready" || !document || !entry) return null;

    const capabilities = Array.isArray(document.capabilities) ? document.capabilities : [];
    const units = Array.isArray(document.units) ? document.units : [];
    const systems = Array.isArray(document.systems) ? document.systems : [];
    const sensorTypes = Array.isArray(document.sensorTypes) ? document.sensorTypes : [];
    const plants = Array.isArray(document.plants) ? document.plants : [];

    return (
        <section className={styles.detail} aria-label="Plugin details">
            <header className={styles.detailHeader}>
                <h1>{document.id}</h1>
                <p>{document.version}</p>
                {installLabel(installState) ? <p className={styles.packageStatus}>{installLabel(installState)}</p> : null}
                {showPackageAction(installState, imported) ? (
                    <div className={styles.detailActions}>
                        <Button size="compact" loading={installing} onClick={onInstall}>{imported ? "Reimport" : "Install"}</Button>
                    </div>
                ) : null}
                {installMessage ? <p className={styles.installMessage}>{installMessage}</p> : null}
                {installError ? <p className={styles.installError}>{installError}</p> : null}
            </header>
            <dl className={styles.meta}>
                <Field label="Engine" value={document.engines?.cevSim || "Unknown"} />
                <Field label="Runtime entry" value={document.entry?.runtime || "none"} />
                {document.entry?.ui ? <Field label="UI entry" value={document.entry.ui} /> : null}
            </dl>
            <Block title="Capabilities">
                {capabilities.length === 0 ? <p className={styles.muted}>None</p> : (
                    <ul className={styles.plainList}>
                        {capabilities.map((name) => <li key={name}>{name}</li>)}
                    </ul>
                )}
            </Block>
            {units.length > 0 && (
                <Block title="Units">
                    <ul className={styles.plainList}>
                        {units.map((unit) => (
                            <li key={unit.type}>
                                <span>{unit.catalog?.name || unit.type}</span>
                                <span className={styles.muted}>{unit.type}</span>
                                {unit.catalog?.category ? <span className={styles.muted}>{unit.catalog.category}</span> : null}
                            </li>
                        ))}
                    </ul>
                </Block>
            )}
            {systems.length > 0 && (
                <Block title="Systems">
                    <ul className={styles.plainList}>
                        {systems.map((system) => (
                            <li key={system.id}>
                                <span>{system.id}</span>
                                <span className={styles.muted}>priority {system.priority}</span>
                            </li>
                        ))}
                    </ul>
                </Block>
            )}
            {plants.length > 0 && (
                <Block title="Plants">
                    <ul className={styles.plainList}>
                        {plants.map((plant) => (
                            <li key={plant.id}>
                                <span>{plant.id}</span>
                                <span className={styles.muted}>{plant.module}</span>
                            </li>
                        ))}
                    </ul>
                </Block>
            )}
            {sensorTypes.length > 0 && (
                <Block title="Sensors">
                    <ul className={styles.plainList}>
                        {sensorTypes.map((sensor) => (
                            <li key={sensor.type}>
                                <span>{sensor.type}</span>
                                <span className={styles.muted}>{sensor.family}</span>
                            </li>
                        ))}
                    </ul>
                </Block>
            )}
        </section>
    );
}
