
export function keys(obj) {
    return Object.keys(obj);    
}

export function keyText(key) {
    // Convert camelCase or snake_case to Title Case for display
    const result = key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ');
    return result.charAt(0).toUpperCase() + result.slice(1);
}