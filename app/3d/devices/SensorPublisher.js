import { encodeTopicValue } from "../../client/Client.js";
import {
    SensorPublisher as SensorPublisherCore,
    normalizeCaptureResult,
} from "../../simulation/sensors/SensorPublisher.js";
import * as encodingPool from "./SensorEncodePool.js";

export { normalizeCaptureResult };

/** Browser adapter that supplies ROS encoding and the optional worker pool. */
export class SensorPublisher extends SensorPublisherCore {
    constructor(device, config, options = {}) {
        super(device, config, {
            ...options,
            encodeTopicValue: options.encodeTopicValue ?? encodeTopicValue,
            encodingPool: options.encodingPool ?? encodingPool,
        });
    }
}
