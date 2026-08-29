use wasm_bindgen::prelude::*;

fn lidar_direction_rep103(theta: f32, phi: f32) -> (f32, f32, f32) {
    let cos_phi = phi.cos();
    (cos_phi * theta.cos(), cos_phi * theta.sin(), phi.sin())
}

fn is_legacy(encoding: &str) -> bool {
    encoding == "legacy-normalized"
}

/// Pack standard xyz+intensity PointCloud2 (16 bytes/point).
/// Returns little-endian packed bytes. Width = data.len() / 16.
#[wasm_bindgen]
pub fn pack_pointcloud2(
    buffer: &[f32],
    range: f32,
    az_start: f32,
    az_end: f32,
    az_step: f32,
    el_start: f32,
    el_end: f32,
    el_step: f32,
    encoding: &str,
) -> Vec<u8> {
    let legacy = is_legacy(encoding);
    let azimuth_count = ((az_end - az_start) / az_step).ceil() as usize;
    let max_points = buffer.len() / 4;
    let mut out = Vec::with_capacity(max_points * 16);

    let mut offset = 0usize;
    while offset + 3 < buffer.len() {
        let hit = if legacy {
            buffer[offset + 3] > 0.5
        } else {
            buffer[offset + 3] > 0.0 && buffer[offset] > 0.0
        };
        if !hit {
            offset += 4;
            continue;
        }
        let index = offset / 4;
        let azimuth_index = index % azimuth_count.max(1);
        let elevation_index = index / azimuth_count.max(1);
        let theta_deg = az_start + (azimuth_index as f32) * az_step;
        let phi_deg = el_start + (elevation_index as f32) * el_step;
        if theta_deg > az_end || phi_deg > el_end {
            offset += 4;
            continue;
        }
        let theta = theta_deg.to_radians();
        let phi = phi_deg.to_radians();
        let raw_distance = if legacy {
            (1.0 - buffer[offset]) * range
        } else {
            buffer[offset]
        };
        let measured = raw_distance.clamp(0.0, range);
        let (dx, dy, dz) = lidar_direction_rep103(theta, phi);
        let intensity = if legacy {
            buffer[offset].clamp(0.0, 1.0)
        } else {
            buffer[offset + 1].clamp(0.0, 1.0)
        };
        out.extend_from_slice(&(measured * dx).to_le_bytes());
        out.extend_from_slice(&(measured * dy).to_le_bytes());
        out.extend_from_slice(&(measured * dz).to_le_bytes());
        out.extend_from_slice(&intensity.to_le_bytes());
        offset += 4;
    }
    out
}

/// Pack semantic PointCloud2 (28 bytes/point).
/// Returns little-endian packed bytes. Width = data.len() / 28.
#[wasm_bindgen]
pub fn pack_semantic_pointcloud2(
    buffer: &[f32],
    range: f32,
    az_start: f32,
    az_end: f32,
    az_step: f32,
    el_start: f32,
    el_end: f32,
    el_step: f32,
    encoding: &str,
) -> Vec<u8> {
    let legacy = is_legacy(encoding);
    let azimuth_count = ((az_end - az_start) / az_step).ceil() as usize;
    let max_points = buffer.len() / 4;
    let mut out = Vec::with_capacity(max_points * 28);

    let mut offset = 0usize;
    while offset + 3 < buffer.len() {
        let hit = if legacy {
            buffer[offset + 3] > 0.5
        } else {
            buffer[offset + 3] > 0.0 && buffer[offset] > 0.0
        };
        if !hit {
            offset += 4;
            continue;
        }
        let index = offset / 4;
        let azimuth_index = index % azimuth_count.max(1);
        let elevation_index = index / azimuth_count.max(1);
        let theta_deg = az_start + (azimuth_index as f32) * az_step;
        let phi_deg = el_start + (elevation_index as f32) * el_step;
        if theta_deg > az_end || phi_deg > el_end {
            offset += 4;
            continue;
        }
        let theta = theta_deg.to_radians();
        let phi = phi_deg.to_radians();
        let raw_distance = if legacy {
            (1.0 - buffer[offset]) * range
        } else {
            buffer[offset]
        };
        let (dx, dy, dz) = lidar_direction_rep103(theta, phi);
        let cos_incidence = if legacy {
            1.0_f32
        } else {
            buffer[offset + 1].clamp(0.0, 1.0)
        };
        let semantic_id = if legacy {
            (buffer[offset + 1] * 255.0).round().max(0.0) as u16
        } else {
            buffer[offset + 2].round().max(0.0) as u16
        };
        let instance_id = if legacy {
            1u32
        } else {
            buffer[offset + 3].round().max(0.0) as u32
        };
        out.extend_from_slice(&(raw_distance * dx).to_le_bytes());
        out.extend_from_slice(&(raw_distance * dy).to_le_bytes());
        out.extend_from_slice(&(raw_distance * dz).to_le_bytes());
        out.extend_from_slice(&cos_incidence.to_le_bytes());
        out.extend_from_slice(&instance_id.to_le_bytes());
        out.extend_from_slice(&semantic_id.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(index as u32).to_le_bytes());
        offset += 4;
    }
    out
}
