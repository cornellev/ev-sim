import Unit from "./Unit.js";
import PluginSettingsForm from "./PluginSettingsForm.js";
import { PluginViewBoundary } from "../../plugin/browser/PluginUiHost.js";

function catalogPortMap(entry, side) {
    if (entry?.ports?.[side]) return entry.ports[side];
    const list = entry?.[side];
    if (Array.isArray(list)) return Object.fromEntries(list.map((port) => [port.name, port.type]));
    return {};
}

function portList(types = {}, fallback = {}) {
    const source = Object.keys(types || {}).length ? types : fallback;
    return Object.entries(source || {}).map(([label, type]) => ({ label, type }));
}

export default function PluginUnitView({
    node,
    catalogEntry = null,
    portTypes = { inputs: {}, outputs: {} },
    View = null,
    diagnostic = null,
}) {
    const title = catalogEntry?.name || node.type;
    const inputs = portList(portTypes.inputs, node.ports?.inputs || catalogPortMap(catalogEntry, "inputs"));
    const outputs = portList(portTypes.outputs, node.ports?.outputs || catalogPortMap(catalogEntry, "outputs"));
    const settings = catalogEntry?.settings || [];
    const fallback = (
        <PluginSettingsForm
            uuid={node.uuid}
            settings={settings}
            state={node.state || {}}
            diagnostic={diagnostic}
        />
    );
    const inner = View
        ? (
            <PluginViewBoundary fallback={fallback}>
                <View
                    uuid={node.uuid}
                    state={node.state || {}}
                    settings={settings}
                    ports={{ inputs, outputs }}
                />
            </PluginViewBoundary>
        )
        : fallback;

    return (
        <Unit
            title={title}
            hasOptions={Boolean(settings.length || diagnostic || View)}
            inputs={inputs}
            outputs={outputs}
            _uuid={node.uuid}
        >
            {inner}
        </Unit>
    );
}

export function UnresolvedPluginUnitView({ node, diagnostic = "Plugin package is missing." }) {
    const inputs = portList({}, node.ports?.inputs);
    const outputs = portList({}, node.ports?.outputs);
    return (
        <Unit
            title={`Unresolved: ${node.type}`}
            hasOptions={true}
            inputs={inputs}
            outputs={outputs}
            _uuid={node.uuid}
        >
            <p className="text-[11px] text-amber-200">{diagnostic}</p>
        </Unit>
    );
}
