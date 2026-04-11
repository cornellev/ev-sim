import { Client, registerMsgDefinitionFromFile, syncTypesFromServer } from "@/app/client/Client";


export class ClientManager {
    constructor(data) {
        this.data = data;

        this.client = null;

        const setupClient = async () => {
            try {
                const synced = await syncTypesFromServer({ apiBase: "http://localhost:8090" });
                console.log(`synced ${synced.count} message type(s) from server`);
            } catch (err) {
                console.warn("type sync skipped:", err.message);
            }

            // insert any custom types here...

            this.client = new Client({
                url: "ws://localhost:8080", // websocket to ROS bridge server
                onUpdate: this._onUpdate.bind(this),
                reconnect: false
            });
        };

        setupClient();

        this.callbacks = [];
    }

    

    async setup() {
        if (this.client) {
            console.log("Starting client...");
            this.client.start();
            console.log("Client started");
            await this.client.subscribe();
        }
    }

    onUpdate(callback) {
        this.callbacks.push(callback);
    }

    _onUpdate(info) {
        this.callbacks.forEach(callback => callback(info));
    }

    /**
     * 
     * @returns {Client}
     */
    get() {
        return this.client;
    }
}