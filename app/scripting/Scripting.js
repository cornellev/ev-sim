import { useEffect, useRef, useState } from "react";
import Grid from "./Grid";
import { LineManager } from "./LineManager";
import { ROSInputUnit, ROSOutputBlock, ROSOutputUnit } from "./units/ROSUnit";
import Unit, { TestingUnit } from "./units/Unit";
import NumberUnit from "./units/math/Number";
import { AddMenu } from "./AddMenu";
import { ScriptManager } from "./ScriptManager";
import { FaCheckCircle } from "react-icons/fa";
import { FaCircleXmark } from "react-icons/fa6";

export default function Scripting({ output, input}) {
    const headUUID = useRef("head-uuid");
    const [valid, setValid] = useState(false);

    const [unitChildren, setUnitChildren] = useState([
        <ROSOutputUnit key="ros-output" input={input} _uuid={headUUID.current} />
    ]);

    useEffect(() => {
        // add head unit to manager
        const headUnit = new ROSOutputBlock(headUUID.current);
        manager.current.addUnit(headUnit);
        manager.current.setHead(headUUID.current);
    }, []);

    const manager = useRef(new ScriptManager());

    useEffect(() => {
        if (!manager.current) return;

        const onData = (e) => {
            const { uuid, data } = e.detail;
            manager.current.storeData(uuid, data);
        }

        const onReregister = (e) => {
            const { uuid } = e.detail;
            const block = manager.current.units.find(u => u.uuid === uuid);
            if (block) {
                block.reregister();
                setValid(manager.current.checkValidity());
            }
        }

        document.addEventListener('data-stored', onData);
        document.addEventListener('reregister-unit', onReregister);

        return () => {
            document.removeEventListener('data-stored', onData);
            document.removeEventListener('reregister-unit', onReregister);
        }
    }, [manager])

    const addUnit = (unitElement, inst, uuid) => {
        if (inst) manager.current.addUnit(new inst(uuid));
        setUnitChildren((prev) => [...prev, unitElement]);
    };

    const onConnectUnits = (from, to) => {
        const outputUUID = to.uuid;
        const outputLabel = to.label;
        const inputUUID = from.uuid;
        const inputLabel = from.label;
        manager.current.connectUnits(outputUUID, outputLabel, inputUUID, inputLabel);

        setValid(manager.current.checkValidity());
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

    useEffect(() => {
        if (!manager.current) return;

        setValid(manager.current.checkValidity());
    }, [unitChildren, manager]);

    const attemptExecute = () => {
        try {
            const output = manager.current.execute();
            console.log("Execution output:", output);
        } catch (err) {
            console.error("Error during execution:", err);
        }
    }

    return (
        <>
        <div className="fixed top-2 left-2 z-100 bg-black/60 rounded px-2 py-1 flex items-center gap-2 text-xs text-gray-400" style={{pointerEvents: 'none', minWidth: '120px'}}>
            { valid ? (
                <span className="flex items-center gap-2">
                    <FaCheckCircle className="text-gray-400" size={12} />
                    <span>Program is valid</span>
                </span>
            ) : (
                <span className="flex items-center gap-2">
                    <FaCircleXmark className="text-gray-400" size={12} />
                    <span>Program is invalid</span>
                </span>
            )}
        </div>
        <div className="fixed top-10 left-5 z-100">
            <button onClick={attemptExecute} className="rounded-sm bg-blue-500 text-white px-3 py-1 cursor-pointer">Execute</button>
        </div>
        <div className="w-[100vw] h-[100vh] bg-[#292929]">
            <Grid />
            <LineManager units={unitChildren} notifyConnection={onConnectUnits} onDeleteConnection={onDeleteConnection} />
            <AddMenu onAddUnit={addUnit} />
            
            <div className="absolute top-4 left-4 text-white" ref={unitParentRef}>
                {unitChildren}
            </div>
        </div>
        </>
    );
}