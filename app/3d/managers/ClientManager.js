import { Client, registerMsgDefinitionFromFile, syncTypesFromServer, syncTypesToServer } from "@/app/client/Client";

const STANDARD_SENSOR_TYPES = {
    "builtin_interfaces/Time": "int32 sec\nuint32 nanosec\n",
    "std_msgs/Header": "builtin_interfaces/Time stamp\nstring frame_id\n",
    "sensor_msgs/Image": "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data\n",
    "sensor_msgs/CameraInfo": "std_msgs/Header header\nuint32 height\nuint32 width\nstring distortion_model\nfloat64[] d\nfloat64[9] k\nfloat64[9] r\nfloat64[12] p\nuint32 binning_x\nuint32 binning_y\n",
    "sensor_msgs/PointField": "uint8 INT8=1\nuint8 UINT8=2\nuint8 INT16=3\nuint8 UINT16=4\nuint8 INT32=5\nuint8 UINT32=6\nuint8 FLOAT32=7\nuint8 FLOAT64=8\nstring name\nuint32 offset\nuint8 datatype\nuint32 count\n",
    "sensor_msgs/PointCloud2": "std_msgs/Header header\nuint32 height\nuint32 width\nsensor_msgs/PointField[] fields\nbool is_bigendian\nuint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense\n",
    "rosgraph_msgs/Clock": "builtin_interfaces/Time clock\n",
};


export class ClientManager {
    constructor(data) {
        this.data = data;

        this.client = null;
        this.catalogHash = null;
        this._disposed = false;

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
            this.catalogHash = synced.catalogHash;
            console.log(`synced ${synced.count} message type(s) from server`);
        } catch (err) {
            console.warn("type sync skipped:", err.message);
        }

        // TODO: SYNC THESE FROM FOLDER!!!

        try {
            await registerMsgDefinitionFromFile(
                "geometry_msgs/Point32",
                "/messages/geometry_msgs/msg/Point32.msg"
            );
        } catch (err) {
            console.warn("Point32 message definition load skipped:", err.message);
        }

        const standardSensorDefinitions = [
            ["builtin_interfaces/Time", "/messages/builtin_interfaces/msg/Time.msg"],
            ["std_msgs/Header", "/messages/std_msgs/msg/Header.msg"],
            ["sensor_msgs/Image", "/messages/sensor_msgs/msg/Image.msg"],
            ["sensor_msgs/CameraInfo", "/messages/sensor_msgs/msg/CameraInfo.msg"],
            ["sensor_msgs/PointField", "/messages/sensor_msgs/msg/PointField.msg"],
            ["sensor_msgs/PointCloud2", "/messages/sensor_msgs/msg/PointCloud2.msg"],
            ["rosgraph_msgs/Clock", "/messages/rosgraph_msgs/msg/Clock.msg"],
        ];
        for (const [type, url] of standardSensorDefinitions) {
            try {
                await registerMsgDefinitionFromFile(type, url);
            } catch (err) {
                console.warn(`${type} message definition load skipped:`, err.message);
            }
        }
        try {
            const synced = await syncTypesToServer(STANDARD_SENSOR_TYPES, { apiBase: "http://localhost:8090" });
            this.catalogHash = synced.catalogHash || synced.hash || this.catalogHash;
        } catch (err) {
            console.warn("standard sensor type catalog sync skipped:", err.message);
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

        if (this._disposed) return null;
        this.client = new Client({
            url: "ws://localhost:8080", // websocket to ROS bridge server
            onUpdate: this._onUpdate.bind(this),
            reconnect: false,
        });

        return this.client;
    }

    

    async setup() {
        await this._initPromise;
        if (this._disposed || !this.client) return;

        console.log("Starting client...");
        this.client.start();
        console.log("Client started");
    }

    onUpdate(callback) {
        this.callbacks.push(callback);
        return () => {
            this.callbacks = this.callbacks.filter((registered) => registered !== callback);
        };
    }

    _onUpdate(info) {
        this.callbacks.forEach(callback => callback(info));
    }

    async dispose() {
        this._disposed = true;
        this.callbacks = [];
        try {
            await this._initPromise;
        } catch {
            // Setup already logs recoverable initialization failures.
        }
        return this.client?.stop?.();
    }

    /**
     * 
     * @returns {Client}
     */
    get() {
        return this.client;
    }
}
