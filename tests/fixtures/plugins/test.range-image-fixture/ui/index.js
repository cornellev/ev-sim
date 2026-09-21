const pluginUi = {
    registerUi(uiApi) {
        const { React } = uiApi;
        function MeasurementScaleView(props) {
            const root = props.context?.kind === "vehicle" ? "config" : "calibration";
            const value = props.sensor?.[root]?.parameters?.measurementScale ?? 1;
            return React.createElement(
                "label",
                { className: "block text-[11px] text-zinc-300", "data-plugin-sensor-view": "test.range-image-fixture" },
                "measurementScale",
                React.createElement("input", {
                    "aria-label": "measurementScale",
                    type: "number",
                    step: "0.1",
                    value,
                    onChange: (event) => props.onChange({
                        path: `${root}.parameters.measurementScale`,
                        value: Number(event.target.value),
                    }),
                }),
            );
        }
        uiApi.contributeSensorView({
            type: "test.range-image-fixture.synthetic-3x4",
            Component: MeasurementScaleView,
        });
    },
};

export default pluginUi;
