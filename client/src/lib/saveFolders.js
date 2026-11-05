// Save Prospecting downloads straight into chosen Desktop folders (owner, 5 Nov 2026: "whenever I add the
// Zoho list or the email, it goes directly into the Zoho List folder and the email HTML into ZOHO - HTML").
// Uses the browser's File System Access API (Chrome / Edge on a computer). The chosen folder handles are
// kept in IndexedDB on this browser; anywhere the API is missing, or the folder isn't set or permission is
// refused, the file downloads normally as before.

export const FOLDERS = {
  'zoho-list': { label: 'Zoho lists (.csv)', suggest: 'Zoho List' },
  'zoho-html': { label: 'Emails & SMS (.html, .txt)', suggest: 'ZOHO - HTML' },
};

export const folderSaveSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const DB = 'phe-save-folders', STORE = 'handles';
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const getHandle = kind => idb('readonly', s => s.get(kind)).catch(() => undefined);

// Folder names for the settings panel, e.g. { 'zoho-list': 'Zoho List', 'zoho-html': null }
export async function folderNames() {
  const out = {};
  for (const kind of Object.keys(FOLDERS)) out[kind] = folderSaveSupported() ? (await getHandle(kind))?.name || null : null;
  return out;
}

// Must run from a click. Returns the chosen folder's name, or null if the picker was cancelled.
export async function chooseFolder(kind) {
  try {
    const handle = await window.showDirectoryPicker({ id: kind, mode: 'readwrite', startIn: 'desktop' });
    await idb('readwrite', s => s.put(handle, kind));
    return handle.name;
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    throw e;
  }
}

export const forgetFolder = kind => idb('readwrite', s => s.delete(kind));

// Call at the START of a click handler (before any await on the network), because Chrome only shows
// its "allow" prompt while the click is fresh. Returns the folder handle when writing is allowed, else null.
export async function readyFolder(kind) {
  if (!folderSaveSupported()) return null;
  try {
    const handle = await getHandle(kind);
    if (!handle) return null;
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return handle;
    return (await handle.requestPermission(opts)) === 'granted' ? handle : null;
  } catch { return null; }
}

function browserDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// Writes into the folder (same name replaces the old file) or falls back to a normal download.
// Returns the folder name it saved into, or null when it downloaded instead.
export async function saveInto(handle, name, blob) {
  if (handle) {
    try {
      const file = await handle.getFileHandle(name, { create: true });
      const w = await file.createWritable();
      await w.write(blob);
      await w.close();
      return handle.name;
    } catch { /* folder moved, deleted or not writable: fall back to a normal download */ }
  }
  browserDownload(blob, name);
  return null;
}
