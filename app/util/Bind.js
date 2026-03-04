

/**
 * Create a "binding" that allows onChange to be called whenever a property changes. This is useful for things like the UI, where we want to update the UI whenever a property changes.
 * @param {*} context The object to bind to. Can be a nested property, e.g. data.settings().
 * @param {Function} onChange The function to call whenever a property changes. Receives the new value as an argument.
 * @param {Number} interval The interval (in ms) at which to check for changes. Default is 1ms, but can be increased for better performance if the context is not expected to change rapidly.
 */
export function bind(context, onChange=(n_value)=>{}, interval=1) {
    let lastValue = context;
    return setInterval(() => {
        if (context !== lastValue) {
            lastValue = context;
            onChange(lastValue);
        }
    }, interval); // check every interval ms
}