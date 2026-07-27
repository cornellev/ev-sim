export function cx(...values) {
    return values.flat(Infinity).filter(Boolean).join(" ");
}
