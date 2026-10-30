import { CpuLidarWorkerService, lidarTransferables } from "../../simulation/sensors/CpuLidarWorkerService.js";

const service = new CpuLidarWorkerService();
self.onmessage = ({ data: { id, method, payload } }) => {
    try {
        const result = service.handle(method, payload);
        self.postMessage({ id, ok: true, result }, lidarTransferables(result));
    } catch (error) {
        self.postMessage({ id, ok: false, error: {
            name: error.name,
            message: error.message,
            code: error.code || "CPU_LIDAR_WORKER_REQUEST_FAILED",
        } });
    }
};
