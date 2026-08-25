/** Hard ceiling for a single HTTP log batch body (Express + LogService). */
export const MAX_LOG_BATCH_BYTES = 8 * 1024 * 1024;

/** Soft flush target so batches stay well under the transport ceiling. */
export const TARGET_LOG_BATCH_BYTES = 256 * 1024;

/**
 * Leave headroom under the hard limit so framing overhead cannot still 413.
 * Flush before crossing this estimate.
 */
export const SAFE_LOG_BATCH_BYTES = MAX_LOG_BATCH_BYTES - (512 * 1024);
