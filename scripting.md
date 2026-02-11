
# Scripting

## Creating Units

"Units" are the building blocks of scripts. They represent individual operations, such as mathematical functions, logic statements, or data transformations. To create a new unit, you need to define both its visual representation and its behavior.

### Visual Representation

This extends the `Unit` component, which provides a standardized layout for all units. You can customize the title, inputs, outputs, and options of the unit.

```javascript
export function MyUnit({ _uuid }) {
    // It's very important to pass the _uuid prop to the Unit component, as it is used for internal management of the unit's state and connections.
    return (
        <Unit title="My Unit" hasOptions={true} _uuid={_uuid}
            inputs={[
                {label: "input1", type: "float64"},
                {label: "input2", type: "float64"}
            ]}
            outputs={[
                {label: "output", type: "float64"}
            ]}
        >
            {/* Optional options UI. Disable this extra display with hasOptions={false} */}
        </Unit>
    );
}
```

Nice!

Now, you need a behavior for your unit.

### Behavior

This is defined in a class that extends `UnitBlock`. The `register` method is where you define the inputs and outputs of the unit, and the `valid` method is where you implement the validity of the block's connections and data (just that it has connections, for example). The actual execution logic of the block is defined in the `execute` method, which is called when the block is executed in a script.

```javascript
export class MyBlock extends UnitBlock {
    register() {
        this.registerInput("input1", "float64"); // make sure the type matches the one defined in the Unit component, otherwise the connections won't work
        this.registerInput("input2", "float64"); // same for this one
        this.registerOutput("output", "float64"); // same for this one

        // make sure not to forget to register all inputs and outputs, otherwise the block won't work and you might get errors in the console about missing connections or undefined values
    }
    
    valid() {
        // Check if the block has valid connections and data
        return this.hasInput("input1") && this.hasInput("input2");
    }

    execute() {
        const input1 = this.getInput("input1"); // this gets the value of the input, which is passed from connected blocks
        const input2 = this.getInput("input2"); // same for this one

        // Perform some operation on the inputs
        const result = input1 + input2; // Example operation

        // Set the output value
        return new BlockOutput()
            .set("output", result); // This sets the value of the output, which can be used by connected blocks
            // it's very important that the output label matches the one defined in the register method, otherwise the connections won't work
    }
}
```

### Adding it to the Add Menu

To make your unit available in the add menu, you need to register it in the `AddMenu.js` file. There exists the `units` object, where you can add your unit with a unique key, and specify the component and block classes that define its visual representation and behavior.

```javascript
const units = {
    mysection: [
        {
            name: "My Unit", // the display name
            obj: () => { // the function that returns the unit component, make sure to pass a unique _uuid prop to the component, which can be generated with the genUUID function from the ScriptManager
                return <MyUnit key={Math.random()} _uuid={genUUID()} />
            },
            class: MyBlock // the block class that defines the behavior of the unit
        }
    ]
}
```

### What if I want to have dynamic input and output types?

You can achieve this by adding a dropdown in the unit's options to select the desired type, and then using that selection to register the inputs and outputs with the correct types in the `register` method of the block. Such as:
```js
import { BlockOutput, reregister, UnitBlock } from "../../ScriptManager";

// ... in your unit component
export function MyUnit({ _uuid}) {
    //...
    
    reregister(_uuid); // call reregister to update the block's inputs and outputs when the type selection changes
    // this will trigger the register method of the block to be called again, allowing you to update the inputs and outputs based on the new type selection

    //...
}
```

### I want to add more types. How do I do that?

Honestly, there's nothing stopping you from adding more types. You just change the type string and make sure to handle it correctly in the execution logic of your block. The type system is currently just a convention to help with connections and data management, but you can extend it as needed for your specific use case.

To color it, though, go to `Constants.js` and add your new type to the `TYPES` object with a corresponding color.

You can also specify sub-colors with brackets, for example `array[float64]` for an array of float64 values, and then handle that in your block's logic as well.

### What if I want to store data?

You can use the `storeData` method to store data that can be accessed later by the block backend. This is useful for large data that you don't want to pass through weird HTML workarounds in the unit component, or for data that needs to persist across executions of the block.

For example:

```javascript
import { BlockOutput, storeData, UnitBlock } from "../../ScriptManager";

// ...

export function MyUnit({ _uuid }) {
    //...

    const handleStoreData = () => {
        const dataToStore = { /* some large data */ };
        storeData(_uuid, dataToStore); // this stores the data with the block's uuid as the key
    };

    //...
}
```

Then, in your block's `execute` method, you can retrieve that data with the `getStoredData` method:

```javascript
export class MyBlock extends UnitBlock {
    //...

    execute() {
        const storedData = this.manager.getStoredData(this.uuid); // this retrieves the stored data using the block's uuid
        // you can now use storedData in your execution logic
    }
}
```

For simple things, you can key your unit with the uuid and store data that way as well, but the `storeData` method is a cleaner and more robust way to handle larger or more complex data.

Additionally, if the data needs to persist but is only local to the block (not needed in the unit component), you can also store it as a property of the block instance itself, such as `this.myData = ...`, and it will persist across executions as long as the block exists. This is recommended if the data is only relevant to the block's logic and doesn't need to be accessed by the unit component or other blocks.

Example:
```javascript
export class MyBlock extends UnitBlock {
    constructor(uuid) {
        super(uuid);
        this.myData = null;
    }

    register() {
        // alternatively, you could set this.myData here, your preference, but just make sure to set it before trying to access it in the execute method
    }

    execute() {
        // third alternative:
        if (!this.myData) {
            this.myData = { /* some data */ }; // set the data if it hasn't been set yet
        }
        // you can now use this.myData in your execution logic
    }
}
```

Let me know if you have any questions or need further clarification on any of these points!

Note: At time of writing, deletion is still work in progress. Please reload the page instead of deleting blocks/connections for now.