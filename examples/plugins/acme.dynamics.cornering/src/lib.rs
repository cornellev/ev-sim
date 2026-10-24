#![allow(static_mut_refs)]

mod abi;

const VX_REST: f64 = 1.0e-3;

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

fn clip(value: f64, limit: f64) -> f64 {
    let bound = limit.abs();
    value.clamp(-bound, bound)
}

fn js_sign(net: f64) -> f64 {
    if net == 0.0 { 1.0 } else { net.signum() }
}

/// Same axle forces as the bicycle crate, without the friction circle.
/// The host integrates them. See `acme.dynamics.bicycle` for the buffer overlay.
pub fn step(state: &mut PlantState, params: &[f64], _dt: f64) -> i32 {
    let wheelbase = parameter(params, 0, 1.5).max(1.0e-9);
    let maximum = parameter(params, 1, 0.6).min(std::f64::consts::PI * 0.49);
    let mass = parameter(params, 2, 1500.0).max(1.0e-9);
    let _yaw_inertia = parameter(params, 3, 2250.0).max(1.0e-9);
    let cf = parameter(params, 4, 80000.0).max(0.0);
    let cr = parameter(params, 5, 80000.0).max(0.0);
    let mu = parameter(params, 6, 0.9).max(0.0);
    let crr = parameter(params, 7, 0.015).max(0.0);
    // shortcut: lf/lr are half the wheelbase, upgrade when a parameter can see axle x.
    let half = wheelbase / 2.0;
    let length = (half + half).max(1.0e-9);
    let normal_load = state.acceleration[2].max(0.0);
    let yaw_rate = state.velocity[2];
    if state.acceleration[1] == 0.0 || normal_load <= 1.0e-12 {
        state.velocity = [0.0, 0.0, yaw_rate];
        state.acceleration[0] = 0.0;
        state.acceleration[1] = 0.0;
        return 0;
    }
    let vx = state.velocity[0];
    let vy = state.velocity[1];
    let delta = state.steering.clamp(-maximum, maximum);
    let fzf = normal_load * (half / length);
    let fzr = normal_load * (half / length);
    let mut front_lateral = 0.0;
    let mut rear_lateral = 0.0;
    if vx.abs() >= VX_REST {
        front_lateral = clip(-cf * (((vy + half * yaw_rate) / vx).atan() - delta), mu * fzf);
        rear_lateral = clip(-cr * ((vy - half * yaw_rate) / vx).atan(), mu * fzr);
    }
    let drive = mass * state.acceleration[0];
    let rolling_capacity = crr * normal_load;
    let net = drive + mass * state.rotation[0];
    let rolling = if vx.abs() < VX_REST {
        if net.abs() <= rolling_capacity { -net } else { -js_sign(net) * rolling_capacity }
    } else {
        -vx.signum() * rolling_capacity
    };
    let fx_total = drive + rolling;
    let weight = fzf + fzr;
    let (front_long, rear_long) = if weight.abs() > 1.0e-12 {
        (fx_total * (fzf / weight), fx_total * (fzr / weight))
    } else {
        (0.0, 0.0)
    };
    let (sin_delta, cos_delta) = delta.sin_cos();
    state.velocity[0] = front_long * cos_delta - front_lateral * sin_delta;
    state.velocity[1] = front_long * sin_delta + front_lateral * cos_delta;
    state.acceleration[0] = rear_long;
    state.acceleration[1] = rear_lateral;
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(actual: f64, expected: f64) {
        let delta = (actual - expected).abs();
        assert!(delta <= 1.0e-6, "{actual} vs {expected} ({delta})");
    }

    #[test]
    fn uncoupled_axle_forces_match_javascript() {
        let mut state = PlantState {
            position: [3.0, 4.0, 5.0],
            rotation: [0.0, 0.25, 0.1],
            velocity: [8.0, 0.0, 0.0],
            acceleration: [8.0, 1.0, 1500.0 * 9.81],
            steering: 0.4,
        };
        assert_eq!(step(&mut state, &[], 0.01), 0);
        near(state.velocity[0], 2846.0844618843603);
        near(state.velocity[1], 8392.568509087469);
        near(state.acceleration[0], 5889.6375);
        near(state.acceleration[1], 0.0);
        assert_eq!(state.position, [3.0, 4.0, 5.0]);
    }
}
