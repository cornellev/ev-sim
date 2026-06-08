const DB_NAME = "sensor-fusion-visual-scripts";
const DB_VERSION = 1;
const SCRIPT_STORE = "scripts";
const SETTINGS_STORE = "settings";
const FALLBACK_KEY = "sensor-fusion-visual-scripts:fallback";

function hasIndexedDB() {
    return typeof indexedDB !== "undefined";
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        if (!hasIndexedDB()) {
            reject(new Error("IndexedDB is not available."));
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(SCRIPT_STORE)) {
                db.createObjectStore(SCRIPT_STORE, { keyPath: "id" });
            }
            if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
                db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not open script library."));
    });
}

function runTransaction(storeName, mode, operation) {
    return openDatabase().then((db) => new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = operation(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => {
            db.close();
            reject(transaction.error || new Error("IndexedDB transaction failed."));
        };
    }));
}

function readFallback() {
    if (typeof localStorage === "undefined") {
        return { scripts: [], settings: {} };
    }

    try {
        return JSON.parse(localStorage.getItem(FALLBACK_KEY)) || { scripts: [], settings: {} };
    } catch {
        return { scripts: [], settings: {} };
    }
}

function writeFallback(data) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(data));
}

async function withFallback(primary, fallback) {
    try {
        return await primary();
    } catch {
        return fallback();
    }
}

export async function listScriptDocuments() {
    return withFallback(
        () => runTransaction(SCRIPT_STORE, "readonly", (store) => store.getAll()),
        () => readFallback().scripts
    );
}

export async function getScriptDocument(id) {
    return withFallback(
        () => runTransaction(SCRIPT_STORE, "readonly", (store) => store.get(id)),
        () => readFallback().scripts.find((document) => document.id === id) || null
    );
}

export async function putScriptDocument(document) {
    return withFallback(
        () => runTransaction(SCRIPT_STORE, "readwrite", (store) => store.put(document)).then(() => document),
        () => {
            const data = readFallback();
            const nextScripts = data.scripts.filter((item) => item.id !== document.id);
            nextScripts.push(document);
            writeFallback({ ...data, scripts: nextScripts });
            return document;
        }
    );
}

export async function deleteScriptDocument(id) {
    return withFallback(
        () => runTransaction(SCRIPT_STORE, "readwrite", (store) => store.delete(id)).then(() => true),
        () => {
            const data = readFallback();
            writeFallback({
                ...data,
                scripts: data.scripts.filter((document) => document.id !== id)
            });
            return true;
        }
    );
}

export async function getScriptSetting(key) {
    return withFallback(
        () => runTransaction(SETTINGS_STORE, "readonly", (store) => store.get(key)).then((value) => value?.value ?? null),
        () => readFallback().settings[key] ?? null
    );
}

export async function putScriptSetting(key, value) {
    return withFallback(
        () => runTransaction(SETTINGS_STORE, "readwrite", (store) => store.put({ key, value })).then(() => value),
        () => {
            const data = readFallback();
            writeFallback({
                ...data,
                settings: {
                    ...data.settings,
                    [key]: value
                }
            });
            return value;
        }
    );
}

