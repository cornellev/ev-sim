export async function fetchRevisionStatus(signal) {
    const response = await fetch("/api/revision", {
        signal,
        cache: "no-store",
        headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Revision status failed (${response.status}).`);
    return response.json();
}
