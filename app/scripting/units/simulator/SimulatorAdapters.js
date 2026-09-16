import Unit from "../Unit";
import { SIMULATOR_ADAPTER_PORTS } from "./SimulatorAdapters.block.js";

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

export const VehicleStateUnit = staticPortsUnit("Vehicle State", SIMULATOR_ADAPTER_PORTS.VehicleStateBlock);
export const DeviceStateUnit = staticPortsUnit("Device State", SIMULATOR_ADAPTER_PORTS.DeviceStateBlock);
export const SimulationClockUnit = staticPortsUnit("Simulation Clock", SIMULATOR_ADAPTER_PORTS.SimulationClockBlock);
export const ScenarioStatusUnit = staticPortsUnit("Scenario Status", SIMULATOR_ADAPTER_PORTS.ScenarioStatusBlock);

export {
    DeviceStateBlock,
    ScenarioStatusBlock,
    SimulationClockBlock,
    VehicleStateBlock,
} from "./SimulatorAdapters.block.js";
