
export function where(array, predicate, a, b) {
    const result = [];
    for (let i = 0; i < array.length; i++) {
        if (predicate(array[i])) {
            result.push(a(array[i], i));
        } else {
            result.push(b(array[i], i));
        }
    }
    return result;
}