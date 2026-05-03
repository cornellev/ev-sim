import { Client, registerMsgDefinitionFromFile, syncTypesFromServer } from "@/app/client/Client";


export class ClientManager {
    constructor(data) {
        this.data = data;

        this.client = null;

        this._initPromise = this._setupClient();

        this.callbacks = [];

        window.clientHandler = this; // for debugging
    }

    hasClient() {
        return this.client !== null;
    }

    async _setupClient() {
        try {
            const synced = await syncTypesFromServer({ apiBase: "http://localhost:8090" });
            console.log(`synced ${synced.count} message type(s) from server`);
        } catch (err) {
            console.warn("type sync skipped:", err.message);
        }

        try {
            await registerMsgDefinitionFromFile(
                "geometry_msgs/Point32",
                "/messages/geometry_msgs/msg/Point32.msg"
            );
        } catch (err) {
            console.warn("Point32 message definition load skipped:", err.message);
        }

        try {
            await registerMsgDefinitionFromFile(
                "sensor_fusion_msgs/LaneBounds",
                "/messages/sensor_fusion_msgs/msg/LaneBounds.msg"
            );
        } catch (err) {
            console.warn("lane bounds message definition load skipped:", err.message);
        }

        try {
            await registerMsgDefinitionFromFile(
                "sensor_fusion_msgs/Lanes",
                "/messages/sensor_fusion_msgs/msg/Lanes.msg"
            );
        } catch (err) {
            console.warn("lanes message definition load skipped:", err.message);
        }

        try {
            await registerMsgDefinitionFromFile(
                "sensor_fusion_msgs/StopSigns",
                "/messages/sensor_fusion_msgs/msg/StopSigns.msg"
            );
        } catch (err) {
            console.warn("stop signs message definition load skipped:", err.message);
        }

        try {
            await registerMsgDefinitionFromFile(
                "sensor_fusion_msgs/YieldBoundary",
                "/messages/sensor_fusion_msgs/msg/YieldBoundary.msg"
            );
        } catch (err) {
            console.warn("yield boundary message definition load skipped:", err.message);
        }

        try {
            await registerMsgDefinitionFromFile(
                "sensor_fusion_msgs/YieldBoundaries",
                "/messages/sensor_fusion_msgs/msg/YieldBoundaries.msg"
            );
        } catch (err) {
            console.warn("yield boundaries message definition load skipped:", err.message);
        }

        try {
            await registerMsgDefinitionFromFile(
                "sensor_fusion_msgs/Box",
                "/messages/sensor_fusion_msgs/msg/Box.msg"
            );
        } catch (err) {
            console.warn("box message definition load skipped:", err.message);
        }

        try {
            await registerMsgDefinitionFromFile(
                "sensor_fusion_msgs/Boxes",
                "/messages/sensor_fusion_msgs/msg/Boxes.msg"
            );
        } catch (err) {
            console.warn("boxes message definition load skipped:", err.message);
        }

        try {
            await registerMsgDefinitionFromFile(
                "sensor_fusion_msgs/imu",
                "/messages/sensor_fusion_msgs/msg/imu.msg"
            );
        } catch (err) {
            console.warn("imu message definition load skipped:", err.message);
        }

        try {
            await registerMsgDefinitionFromFile(
                "sensor_fusion_msgs/CarPosition",
                "/messages/sensor_fusion_msgs/msg/CarPosition.msg"
            );
        } catch (err) {
            console.warn("car position message definition load skipped:", err.message);
        }

        this.client = new Client({
            url: "ws://localhost:8080", // websocket to ROS bridge server
            onUpdate: this._onUpdate.bind(this),
            reconnect: false,
        });

        return this.client;
    }

    

    async setup() {
        await this._initPromise;
        if (!this.client) return;

        console.log("Starting client...");
        this.client.start();
        console.log("Client started");
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