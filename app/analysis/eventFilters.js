export function eventTypeKey(event = {}) {
    return JSON.stringify([
        String(event.category || "system"),
        String(event.name || "event"),
    ]);
}

export function eventTypeLabel(event = {}) {
    return `${event.category || "system"} · ${event.name || "event"}`;
}

export function eventTypeLabelFromKey(key) {
    try {
        const [category, name] = JSON.parse(key);
        return `${category} · ${name}`;
    } catch {
        return String(key);
    }
}

export function filterEvents(events = [], query = "", excludedTypes = []) {
    const normalizedQuery = query.trim().toLowerCase();
    const excluded = new Set(excludedTypes);
    return events.filter((event) => {
        if (excluded.has(eventTypeKey(event))) return false;
        if (!normalizedQuery) return true;
        return `${event.category || ""} ${event.name || ""} ${event.severity || ""}`
            .toLowerCase()
            .includes(normalizedQuery);
    });
}
