
export function fill(array, max_size, inst) {
    const filled = array.slice(0, max_size);
    while (filled.length < max_size) {
        filled.push(inst());
    }
    return filled;
}