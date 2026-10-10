use crate::{step, PlantState};

const STATE_LEN: usize = 13;
const PARAM_CAP: usize = 32;

static mut PLANT_BUFFER: [f64; STATE_LEN + PARAM_CAP] = [0.0; STATE_LEN + PARAM_CAP];

#[no_mangle]
pub extern "C" fn cev_plant_abi() -> i32 {
    1
}

#[no_mangle]
pub extern "C" fn cev_plant_buffer() -> *mut f64 {
    unsafe { PLANT_BUFFER.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn cev_plant_step(params_len: i32, dt: f64) -> i32 {
    unsafe {
        let values = &mut PLANT_BUFFER;
        let mut state = PlantState {
            position: [values[0], values[1], values[2]],
            rotation: [values[3], values[4], values[5]],
            velocity: [values[6], values[7], values[8]],
            acceleration: [values[9], values[10], values[11]],
            steering: values[12],
        };
        let count = usize::try_from(params_len.max(0)).unwrap_or(0).min(PARAM_CAP);
        let code = step(&mut state, &values[STATE_LEN..STATE_LEN + count], dt);
        values[0] = state.position[0];
        values[1] = state.position[1];
        values[2] = state.position[2];
        values[3] = state.rotation[0];
        values[4] = state.rotation[1];
        values[5] = state.rotation[2];
        values[6] = state.velocity[0];
        values[7] = state.velocity[1];
        values[8] = state.velocity[2];
        values[9] = state.acceleration[0];
        values[10] = state.acceleration[1];
        values[11] = state.acceleration[2];
        values[12] = state.steering;
        code
    }
}
