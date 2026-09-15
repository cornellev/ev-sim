import Unit from "../Unit";

export function NopUnit({ _uuid }) {
    return (
        <Unit
            title="Nop"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[]}
            outputs={[{ label: "then", type: "unit" }]}
        />
    );
}

export function IgnoreUnit({ _uuid, portTypes = {} }) {
    const valueType = portTypes.inputs?.value || "generic";

    return (
        <Unit
            title="Ignore"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[{ label: "value", type: valueType }]}
            outputs={[{ label: "then", type: "unit" }]}
        />
    );
}

export function SequenceUnit({ _uuid }) {
    return (
        <Unit
            title="Sequence"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "first", type: "unit" },
                { label: "second", type: "unit" }
            ]}
            outputs={[{ label: "then", type: "unit" }]}
        />
    );
}

export function PassthroughUnit({ _uuid, portTypes = {} }) {
    const valueType = portTypes.inputs?.value || portTypes.outputs?.value || "generic";

    return (
        <Unit
            title="Passthrough"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "then", type: "unit" },
                { label: "value", type: valueType }
            ]}
            outputs={[{ label: "value", type: valueType }]}
        />
    );
}

export {
    IgnoreBlock,
    NopBlock,
    PassthroughBlock,
    SequenceBlock,
} from "./Unit.block.js";
