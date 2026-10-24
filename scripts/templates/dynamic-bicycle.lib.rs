#![allow(static_mut_refs)]

mod abi;

const GRAVITY: f64 = 9.81;
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

fn scale_longitudinal(fx: f64, fy: f64, fz: f64, mu: f64) -> f64 {
    let limit = (mu * fz).abs();
    let lateral = fy.abs().min(limit);
    let room = (limit * limit - lateral * lateral).max(0.0).sqrt();
    if fx.abs() <= room { fx } else { fx.signum() * room }
}

/// Full dynamic bicycle. `velocity[1]` is right-positive vy and `velocity[2]` is yaw rate.
/// `acceleration[0]` arrives as `ax_cmd` and leaves as body ax.
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
    let lf = half.max(0.0);
    let lr = half.max(0.0);
    let length = (lf + lr).max(1.0e-9);
    let vx = state.velocity[0];
    let vy = state.velocity[1];
    let r = state.velocity[2];
    let yaw = state.rotation[1];
    let delta = state.steering.clamp(-maximum, maximum);
    let pitch = state.rotation[2];
    let dt = dt.max(0.0);
    let ax_command = state.acceleration[0];
    let cos_pitch = pitch.cos();
    let sin_pitch = pitch.sin();
    let mg_cos = mass * GRAVITY * cos_pitch;
    let fzf = mg_cos * (lr / length);
    let fzr = mg_cos * (lf / length);
    let mut fyf = 0.0;
    let mut fyr = 0.0;
    if vx.abs() >= VX_REST {
        let alpha_front = ((vy + lf * r) / vx).atan() - delta;
        let alpha_rear = ((vy - lr * r) / vx).atan();
        fyf = clip(-cf * alpha_front, mu * fzf);
        fyr = clip(-cr * alpha_rear, mu * fzr);
    }
    let drive = mass * ax_command;
    let rolling_capacity = crr * mass * GRAVITY * cos_pitch.max(0.0);
    let net = drive - mass * GRAVITY * sin_pitch;
    let rolling = if vx.abs() < VX_REST {
        if net.abs() <= rolling_capacity { -net } else { -js_sign(net) * rolling_capacity }
    } else {
        -vx.signum() * rolling_capacity
    };
    let fx_total = drive + rolling;
    let weight = fzf + fzr;
    let mut fxf = 0.0;
    let mut fxr = 0.0;
    if weight.abs() > 1.0e-12 {
        fxf = scale_longitudinal(fx_total * (fzf / weight), fyf, fzf, mu);
        fxr = scale_longitudinal(fx_total * (fzr / weight), fyr, fzr, mu);
    }
    let cos_delta = delta.cos();
    let sin_delta = delta.sin();
    let sum_fx = fxf * cos_delta - fyf * sin_delta + fxr;
    let sum_fy = fxf * sin_delta + fyf * cos_delta + fyr;
    let ax = sum_fx / mass - GRAVITY * sin_pitch + r * vy;
    let ay = sum_fy / mass - r * vx;
    let yaw_accel = (lf * (fxf * sin_delta + fyf * cos_delta) - lr * fyr) / yaw_inertia;
    let mut next_vx = vx + ax * dt;
    let next_vy = vy + ay * dt;
    let next_r = r + yaw_accel * dt;
    if vx.abs() < VX_REST && net.abs() <= rolling_capacity {
        next_vx = 0.0;
    } else if ax_command == 0.0 && vx != 0.0 && vx * next_vx < 0.0 {
        next_vx = 0.0;
    }
    let cos_yaw = yaw.cos();
    let sin_yaw = yaw.sin();
    state.position[0] += (next_vx * cos_yaw - next_vy * sin_yaw) * dt;
    state.position[2] += (-next_vx * sin_yaw - next_vy * cos_yaw) * dt;
    state.rotation[1] = yaw + next_r * dt;
    state.velocity[0] = next_vx;
    state.velocity[1] = next_vy;
    state.velocity[2] = next_r;
    state.acceleration[0] = ax;
    state.acceleration[1] = ay;
    state.acceleration[2] = 0.0;
    0
}

#[cfg(test)]
mod oracle {
    use super::*;

    enum Value {
        Number(f64),
        String(String),
        Array(Vec<Value>),
        Object(Vec<(String, Value)>),
    }

    struct Parser<'a> {
        bytes: &'a [u8],
        index: usize,
    }

    impl<'a> Parser<'a> {
        fn skip(&mut self) {
            while self.index < self.bytes.len() && self.bytes[self.index].is_ascii_whitespace() {
                self.index += 1;
            }
        }

        fn peek(&mut self) -> u8 {
            self.skip();
            self.bytes[self.index]
        }

        fn eat(&mut self, expected: u8) {
            let found = self.peek();
            assert_eq!(found, expected, "expected {expected} at {}", self.index);
            self.index += 1;
        }

        fn string(&mut self) -> String {
            self.eat(b'"');
            let start = self.index;
            while self.bytes[self.index] != b'"' {
                self.index += 1;
            }
            let text = std::str::from_utf8(&self.bytes[start..self.index]).unwrap().to_string();
            self.index += 1;
            text
        }

        fn number(&mut self) -> f64 {
            self.skip();
            let start = self.index;
            while self.index < self.bytes.len() {
                let byte = self.bytes[self.index];
                if byte.is_ascii_digit() || matches!(byte, b'-' | b'+' | b'.' | b'e' | b'E') {
                    self.index += 1;
                } else {
                    break;
                }
            }
            std::str::from_utf8(&self.bytes[start..self.index]).unwrap().parse().unwrap()
        }

        fn value(&mut self) -> Value {
            match self.peek() {
                b'{' => self.object(),
                b'[' => self.array(),
                b'"' => Value::String(self.string()),
                _ => Value::Number(self.number()),
            }
        }

        fn object(&mut self) -> Value {
            self.eat(b'{');
            let mut entries = Vec::new();
            if self.peek() != b'}' {
                loop {
                    let key = self.string();
                    self.eat(b':');
                    entries.push((key, self.value()));
                    if self.peek() == b'}' {
                        break;
                    }
                    self.eat(b',');
                }
            }
            self.eat(b'}');
            Value::Object(entries)
        }

        fn array(&mut self) -> Value {
            self.eat(b'[');
            let mut entries = Vec::new();
            if self.peek() != b']' {
                loop {
                    entries.push(self.value());
                    if self.peek() == b']' {
                        break;
                    }
                    self.eat(b',');
                }
            }
            self.eat(b']');
            Value::Array(entries)
        }
    }

    fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
        match value {
            Value::Object(entries) => entries.iter().find(|(entry, _)| entry == key).map(|(_, child)| child).unwrap(),
            _ => panic!("{key} is not on an object"),
        }
    }

    fn num(value: &Value) -> f64 {
        match value {
            Value::Number(number) => *number,
            _ => panic!("expected a number"),
        }
    }

    fn claims(row: &Value, kind: &str) -> bool {
        match get(row, "match") {
            Value::Array(items) => items.iter().any(|item| matches!(item, Value::String(text) if text == kind)),
            _ => false,
        }
    }

    fn load() -> Value {
        let mut dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let text = loop {
            let candidate = dir.join("tests/fixtures/plugins/dynamic-bicycle-steps.json");
            if candidate.is_file() {
                break std::fs::read_to_string(candidate).unwrap();
            }
            assert!(dir.pop(), "dynamic bicycle oracle is not in a parent directory");
        };
        Parser { bytes: text.as_bytes(), index: 0 }.value()
    }

    fn near(actual: f64, expected: f64, label: &str) {
        let delta = (actual - expected).abs();
        assert!(delta <= 1.0e-9, "{label}: {actual} vs {expected} (delta {delta})");
    }

    fn params(input: &Value) -> Vec<f64> {
        vec![
            num(get(input, "wheelbase")),
            num(get(input, "maxSteeringAngle")),
            num(get(input, "mass")),
            num(get(input, "yawInertia")),
            num(get(input, "corneringStiffnessFront")),
            num(get(input, "corneringStiffnessRear")),
            num(get(input, "frictionMu")),
            num(get(input, "rollingResistance")),
        ]
    }

    #[test]
    fn matches_claimed_rows() {
        let document = load();
        let rows = match get(&document, "rows") {
            Value::Array(rows) => rows,
            _ => panic!("rows"),
        };
        let mut seen = 0;
        for row in rows {
            if !claims(row, "bicycle") {
                continue;
            }
            seen += 1;
            let input = get(row, "input");
            let expect = get(row, "expect");
            let id = match get(row, "id") {
                Value::String(id) => id.clone(),
                _ => panic!("id"),
            };
            let mut state = PlantState {
                position: [num(get(input, "x")), 0.0, num(get(input, "z"))],
                rotation: [0.0, num(get(input, "yaw")), num(get(input, "pitch"))],
                velocity: [num(get(input, "vx")), num(get(input, "vy")), num(get(input, "r"))],
                acceleration: [num(get(input, "axCommand")), 0.0, 0.0],
                steering: num(get(input, "delta")),
            };
            assert_eq!(step(&mut state, &params(input), num(get(input, "dt"))), 0);
            near(state.position[0], num(get(expect, "x")), &format!("{id} x"));
            near(state.position[2], num(get(expect, "z")), &format!("{id} z"));
            near(state.rotation[1], num(get(expect, "yaw")), &format!("{id} yaw"));
            near(state.velocity[0], num(get(expect, "vx")), &format!("{id} vx"));
            near(state.velocity[1], num(get(expect, "vy")), &format!("{id} vy"));
            near(state.velocity[2], num(get(expect, "r")), &format!("{id} r"));
            near(state.acceleration[0], num(get(expect, "ax")), &format!("{id} ax"));
            near(state.acceleration[1], num(get(expect, "ay")), &format!("{id} ay"));
        }
        assert!(seen > 0, "bicycle claimed no oracle rows");
    }
}
