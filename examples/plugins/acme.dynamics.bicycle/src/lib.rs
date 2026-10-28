#![allow(static_mut_refs)]

mod abi;

const VX_REST: f64 = 1.0e-3;
const FRICTION_CIRCLE: bool = true;

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

fn scale_longitudinal(fx: f64, fy: f64, fz: f64, mu: f64) -> f64 {
    let limit = (mu * fz).abs();
    let lateral = fy.abs().min(limit);
    let room = (limit * limit - lateral * lateral).max(0.0).sqrt();
    if fx.abs() <= room { fx } else { fx.signum() * room }
}

/// Axle forces in the car frame. The host integrates them.
/// In: velocity is vx, right-positive vy, yaw rate.
/// acceleration[0] is ax_cmd, [1] is 1 on the road, [2] is normal load.
/// rotation[0] and [2] are downhill pull, m/s², not angles.
/// Out: velocity[0..1] front force, acceleration[0..1] rear force.
pub fn step(state: &mut PlantState, params: &[f64], dt: f64) -> i32 {
    let wheelbase = parameter(params, 0, 1.5).max(1.0e-9);
    let maximum = parameter(params, 1, 0.6).min(std::f64::consts::PI * 0.49);
    let mass = parameter(params, 2, 1500.0).max(1.0e-9);
    let yaw_inertia = parameter(params, 3, 2250.0).max(1.0e-9);
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
    let (sin_delta, cos_delta) = delta.sin_cos();
    let front_speed = vy + half * yaw_rate;
    let front_slip = front_speed * cos_delta - vx * sin_delta;
    let rear_slip = vy - half * yaw_rate;
    let alpha_front = front_slip.atan2((vx * cos_delta + front_speed * sin_delta).abs().max(VX_REST));
    let alpha_rear = rear_slip.atan2(vx.abs().max(VX_REST));
    // Row sums of J M^-1 J^T bound the coupled lateral/yaw impulse.
    let coupling = (cos_delta / mass - half * half * cos_delta / yaw_inertia).abs();
    let front_inverse_mass = 1.0 / mass + (half * cos_delta).powi(2) / yaw_inertia + coupling;
    let rear_inverse_mass = 1.0 / mass + half * half / yaw_inertia + coupling;
    let front_limit = if dt > 0.0 { (mu * fzf).min(front_slip.abs() / (dt * front_inverse_mass)) } else { mu * fzf };
    let rear_limit = if dt > 0.0 { (mu * fzr).min(rear_slip.abs() / (dt * rear_inverse_mass)) } else { mu * fzr };
    let front_lateral = clip(-cf * alpha_front, front_limit);
    let rear_lateral = clip(-cr * alpha_rear, rear_limit);
    let drive = mass * state.acceleration[0];
    let rolling_capacity = crr * normal_load;
    let net = drive + mass * state.rotation[0];
    let rolling = if dt > 0.0 {
        (-net - mass * vx / dt).clamp(-rolling_capacity, rolling_capacity)
    } else if vx.abs() < VX_REST {
        if net.abs() <= rolling_capacity { -net } else { -js_sign(net) * rolling_capacity }
    } else {
        -vx.signum() * rolling_capacity
    };
    let fx_total = drive + rolling;
    let weight = fzf + fzr;
    let (mut front_long, mut rear_long) = (0.0, 0.0);
    if weight.abs() > 1.0e-12 {
        front_long = fx_total * (fzf / weight);
        rear_long = fx_total * (fzr / weight);
        if FRICTION_CIRCLE {
            front_long = scale_longitudinal(front_long, front_lateral, fzf, mu);
            rear_long = scale_longitudinal(rear_long, rear_lateral, fzr, mu);
        }
    }
    state.velocity[0] = front_long * cos_delta - front_lateral * sin_delta;
    state.velocity[1] = front_long * sin_delta + front_lateral * cos_delta;
    state.acceleration[0] = rear_long;
    state.acceleration[1] = rear_lateral;
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolling_impulse_does_not_reverse_a_small_velocity() {
        for dt in [0.0, 0.01, 1.0 / 60.0, 0.05, 0.1] {
            for vx in [-0.0011, 0.0011] {
                let mut state = PlantState {
                    position: [0.0; 3], rotation: [0.0; 3],
                    velocity: [vx, 0.0, 0.0],
                    acceleration: [0.01, 1.0, 1500.0 * 9.81], steering: 0.0,
                };
                assert_eq!(step(&mut state, &[], dt), 0);
                let force = state.velocity[0] + state.acceleration[0];
                assert!(force.is_finite());
                if dt > 0.0 {
                    let next = vx + force / 1500.0 * dt;
                    assert!(next * vx >= -1.0e-12, "{vx}, {dt}: {next}");
                    assert!(next.abs() <= vx.abs() + 1.0e-12);
                }
            }
        }
    }

    fn near(actual: f64, expected: f64) {
        let delta = (actual - expected).abs();
        assert!(delta <= 1.0e-6, "{actual} vs {expected} ({delta})");
    }

    fn grounded() -> PlantState {
        PlantState {
            position: [3.0, 4.0, 5.0],
            rotation: [0.0, 0.25, 0.1],
            velocity: [8.0, 0.0, 0.0],
            acceleration: [8.0, 1.0, 1500.0 * 9.81],
            steering: 0.4,
        }
    }

    #[test]
    fn airborne_force_is_zero_and_the_pose_stays() {
        let mut state = grounded();
        state.velocity[2] = 0.1;
        state.acceleration[1] = 0.0;
        state.acceleration[2] = 0.0;
        assert_eq!(step(&mut state, &[], 0.02), 0);
        assert_eq!(state.position, [3.0, 4.0, 5.0]);
        assert_eq!(state.rotation, [0.0, 0.25, 0.1]);
        assert_eq!(state.velocity, [0.0, 0.0, 0.1]);
        assert_eq!(state.acceleration[0], 0.0);
        assert_eq!(state.acceleration[1], 0.0);
    }

    #[test]
    fn saturated_axle_forces_match_javascript() {
        let mut state = grounded();
        assert_eq!(step(&mut state, &[], 0.01), 0);
        near(state.velocity[0], -2578.6309081823065);
        near(state.velocity[1], 6099.035637038604);
        near(state.acceleration[0], 5889.6375);
        near(state.acceleration[1], 0.0);
        assert_eq!(state.position, [3.0, 4.0, 5.0]);
    }
}
