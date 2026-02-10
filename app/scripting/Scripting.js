import { useEffect, useRef, useState } from "react";
import Grid from "./Grid";
import { LineManager } from "./LineManager";
import { ROSInputUnit, ROSOutputUnit } from "./units/ROSUnit";
import Unit, { TestingUnit } from "./units/Unit";
import NumberUnit from "./units/math/Number";
import { AddMenu } from "./AddMenu";
import { ScriptManager } from "./ScriptManager";

export default function Scripting({ output, input}) {
    const [unitChildren, setUnitChildren] = useState([
        <ROSOutputUnit key="ros-output" input={input} />
    ]);

    const manager = useRef(new ScriptManager());

    const addUnit = (unitElement, inst) => {
        if (inst) manager.current.addUnit(new inst());
        setUnitChildren((prev) => [...prev, unitElement]);
    };

    const onConnectUnits = (from, to) => {
        console.log(from, to)
    };

    const onDeleteConnection = (from, to) => {
        console.log("Deleted connection from", from, "to", to);
    };
    
    const unitParentRef = useRef();

    useEffect(() => {
        const onDeleteUnit = (e) => {
            const unitIdToDelete = e.detail.uuid;
            const newUnitChildren = unitChildren.filter((unit) => {
                // get data-uuid from the dom element
                const unitUUID = unit.props['_uuid'];
                console.log("Checking unit UUID:", unitUUID, "against", unitIdToDelete);
                return unitUUID !== unitIdToDelete;
            });
            setUnitChildren(newUnitChildren);            
        }

        document.addEventListener('delete-unit', onDeleteUnit);

        return () => {
            document.removeEventListener('delete-unit', onDeleteUnit);
        }
    }, [unitChildren]);

    return (
        <div className="w-[100vw] h-[100vh] bg-[#292929]">
            <Grid />
            <LineManager units={unitChildren} notifyConnection={onConnectUnits} onDeleteConnection={onDeleteConnection} />
            <AddMenu onAddUnit={addUnit} />
            
            <div className="absolute top-4 left-4 text-white" ref={unitParentRef}>
                {unitChildren}
            </div>
        </div>
    );
}