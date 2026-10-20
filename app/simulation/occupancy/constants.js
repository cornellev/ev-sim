/** Published world-XZ occupancy preset. Another size is another hashed profile. */
export const OCCUPANCY_RESOLUTION_M = 0.05;
export const OCCUPANCY_CELLS = 1000;
export const OCCUPANCY_TILE_CELLS = 64;
export const OCCUPANCY_WINDOW_M = OCCUPANCY_RESOLUTION_M * OCCUPANCY_CELLS;

export const SENSOR_OCCUPANCY_UNKNOWN = 0;
export const SENSOR_OCCUPANCY_FREE = 1;
export const SENSOR_OCCUPANCY_OCCUPIED = 2;
