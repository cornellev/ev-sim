import Unit from "../Unit";
import { TEMPORAL_BLOCK_PORTS } from "./TemporalBlocks.block.js";

function staticPortsUnit(title, ports) {
    function StaticUnit({ _uuid }) {
        return (
            <Unit
                title={title}
                hasOptions={false}
                _uuid={_uuid}
                inputs={[...ports.inputs]}
                outputs={[...ports.outputs]}
            />
        );
    }
    StaticUnit.displayName = `${title.replace(/\s+/g, "")}Unit`;
    return StaticUnit;
}

function genericMemoryUnit(title, ports) {
    function GenericMemoryUnit({ _uuid, portTypes = {} }) {
        const inputs = ports.inputs.map((port) => ({
            ...port,
            type: portTypes.inputs?.[port.label] || port.type,
        }));
        const outputs = ports.outputs.map((port) => ({
            ...port,
            type: portTypes.outputs?.[port.label] || port.type,
        }));
        return (
            <Unit
                title={title}
                hasOptions={false}
                _uuid={_uuid}
                inputs={inputs}
                outputs={outputs}
            />
        );
    }
    GenericMemoryUnit.displayName = `${title.replace(/\s+/g, "")}Unit`;
    return GenericMemoryUnit;
}

function genericValueUnit(title, ports) {
    function GenericValueUnit({ _uuid, portTypes = {} }) {
        const inputs = ports.inputs.map((port) => ({
            ...port,
            type: portTypes.inputs?.[port.label] || port.type,
        }));
        return (
            <Unit
                title={title}
                hasOptions={false}
                _uuid={_uuid}
                inputs={inputs}
                outputs={[...ports.outputs]}
            />
        );
    }
    GenericValueUnit.displayName = `${title.replace(/\s+/g, "")}Unit`;
    return GenericValueUnit;
}

export const PreviousUnit = genericMemoryUnit("Previous", TEMPORAL_BLOCK_PORTS.PreviousBlock);
export const ValueChangedUnit = genericValueUnit("Value Changed", TEMPORAL_BLOCK_PORTS.ValueChangedBlock);
export const RisingEdgeUnit = staticPortsUnit("Rising Edge", TEMPORAL_BLOCK_PORTS.RisingEdgeBlock);
export const FallingEdgeUnit = staticPortsUnit("Falling Edge", TEMPORAL_BLOCK_PORTS.FallingEdgeBlock);
export const DebounceUnit = staticPortsUnit("Debounce", TEMPORAL_BLOCK_PORTS.DebounceBlock);
export const HysteresisUnit = staticPortsUnit("Hysteresis", TEMPORAL_BLOCK_PORTS.HysteresisBlock);
export const PulseUnit = staticPortsUnit("Pulse", TEMPORAL_BLOCK_PORTS.PulseBlock);
export const StopwatchUnit = staticPortsUnit("Stopwatch", TEMPORAL_BLOCK_PORTS.StopwatchBlock);
export const MovingAverageUnit = staticPortsUnit("Moving Average", TEMPORAL_BLOCK_PORTS.MovingAverageBlock);
export const MedianFilterUnit = staticPortsUnit("Median Filter", TEMPORAL_BLOCK_PORTS.MedianFilterBlock);
export const SlewRateUnit = staticPortsUnit("Slew Rate", TEMPORAL_BLOCK_PORTS.SlewRateBlock);
export const IntegratorUnit = staticPortsUnit("Integrator", TEMPORAL_BLOCK_PORTS.IntegratorBlock);
export const DerivativeUnit = staticPortsUnit("Derivative", TEMPORAL_BLOCK_PORTS.DerivativeBlock);

export {
    DebounceBlock,
    DerivativeBlock,
    FallingEdgeBlock,
    HysteresisBlock,
    IntegratorBlock,
    MedianFilterBlock,
    MovingAverageBlock,
    PreviousBlock,
    PulseBlock,
    RisingEdgeBlock,
    SlewRateBlock,
    StopwatchBlock,
    ValueChangedBlock,
} from "./TemporalBlocks.block.js";
