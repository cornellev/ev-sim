#![allow(static_mut_refs)]

mod abi;

pub struct PlantState {
    pub position: [f64; 3],
    pub rotation: [f64; 3],
    pub velocity: [f64; 3],
    pub acceleration: [f64; 3],
    pub steering: f64,
}

fn parameter(params: &[f64], index: usize, fallback: f64) -> f64 {
    params.get(index).copied().unwrap_or(fallback)
}

pub fn step(state: &mut PlantState, params: &[f64], dt: f64) -> i32 {
    let wheelbase = parameter(params, 0, 1.5).max(1.0e-9);
    let maximum = parameter(params, 1, 0.6).min(std::f64::consts::PI * 0.49);
    state.velocity[0] += state.acceleration[0] * dt;
    state.velocity[1] += state.acceleration[1] * dt;
    state.velocity[2] += state.acceleration[2] * dt;
    let speed = state.velocity[0];
    let steering = state.steering.clamp(-maximum, maximum);
    let yaw = state.rotation[1];
    state.position[0] += yaw.cos() * speed * dt;
    state.position[2] += -yaw.sin() * speed * dt;
    state.rotation[1] += (speed / wheelbase) * steering.tan() * dt;
    let _ = steering;
    0
}
