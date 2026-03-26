import { Client } from "@/app/client/Client";


export class ClientManager {
    constructor(data) {
        this.data = data;

        this.client = new Client({
            url: "ws://localhost:8080", // WebSocket server URL for networked multiplayer; can be set to null or undefined to disable networking
            onUpdate: this._onUpdate.bind(this),
            reconnect: false
        }); // for networked multiplayer, can be set to an instance of Client

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