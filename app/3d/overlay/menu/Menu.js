
export default function Menu({
    onScene,
    onConfig,
    onScripting
}) {
    return (
        <div className="fixed w-[100%] h-[100%] z-[100]" style={{
            backgroundColor: "rgba(0,0,0,0.5)",
            fontWeight: "bold"
        }}>
            <div className="text-[100px] px-10 py-5" style={{
                animationDuration: "0.2s",
                animation: "ease-in-out"
            }}>
                <p className="text-[100px] hover:text-[120px] pointer" onClick={onScene}>Scene</p>
                <p className="text-[100px] hover:text-[120px] pointer" onClick={onConfig}>Config</p>
                <p className="text-[100px] hover:text-[120px] pointer" onClick={onScripting}>Scripting</p>
            </div>
        </div>
    );
}