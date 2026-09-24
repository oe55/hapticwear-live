/**
 * Music library.
 *
 * Built-in tracks: listed in assets/music/catalog.json, all original or CC0 / CC BY licensed, and
 * shipped with the site. Licences and credits are in CREDITS.md and shown with each track.
 *
 * My Library: files dropped in on the show machine. They are stored in IndexedDB in *that*
 * browser only. Nothing is uploaded anywhere, which is what makes it the right place for
 * commercial music the site itself is not allowed to host.
 */

const DB_NAME = 'hapticwear';
const STORE = 'tracks';
export const MY_LIBRARY_ID = 'my-library';

/** A track as the rest of the app sees it. */
function builtIn(t, category) {
  return {
    id: `${category.id}/${t.file}`,
    category: category.id,
    title: t.title,
    artist: t.artist,
    duration: t.duration || 0,
    licence: t.licence || '',
    url: `assets/music/${t.file}`,
    local: false,
  };
}

export class Library extends EventTarget {
  constructor() {
    super();
    this.categories = [];   // [{ id, title, blurb, tracks: [] }]
    this.db = null;
    this.session = [];      // files a private window will not store: they play until it closes
  }

  async load() {
    try {
      const res = await fetch('assets/music/catalog.json');
      const cat = await res.json();
      this.categories = cat.categories.map((c) => ({
        id: c.id, title: c.title, blurb: c.blurb || '',
        tracks: c.tracks.map((t) => builtIn(t, c)),
      }));
    } catch {
      this.categories = [];
    }
    this.categories.push({ id: MY_LIBRARY_ID, title: 'MY LIBRARY', blurb: 'Your own files. Stored only on this computer.', tracks: [] });
    await this._loadLocal();
  }

  get builtInTracks() {
    return this.categories.filter((c) => c.id !== MY_LIBRARY_ID).flatMap((c) => c.tracks);
  }

  category(id) { return this.categories.find((c) => c.id === id); }

  /** The track after `track` within its category, wrapping round. */
  next(track, step = 1) {
    const cat = this.category(track.category);
    if (!cat || !cat.tracks.length) return null;
    const i = cat.tracks.findIndex((t) => t.id === track.id);
    return cat.tracks[(i + step + cat.tracks.length) % cat.tracks.length];
  }

  // ---------- My Library (IndexedDB) ----------

  async _open() {
    if (this.db) return this.db;
    if (!('indexedDB' in window)) return null;
    this.db = await new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return this.db;
  }

  /** Run one transaction. Resolves the request's result, or null if anything fails. */
  _tx(mode, fn) {
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(STORE, mode);
        const out = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async _loadLocal() {
    const db = await this._open();
    const mine = this.category(MY_LIBRARY_ID);
    const stored = (db && (await this._tx('readonly', (s) => s.getAll()))) || [];
    const rows = [...stored, ...this.session];
    mine.sessionOnly = this.session.length > 0 || !db;
    rows.sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.added - b.added);
    mine.tracks = rows.map((r) => ({
      id: r.id, category: MY_LIBRARY_ID, group: r.group || '', title: r.title, artist: r.artist,
      duration: r.duration || 0, licence: '', blob: r.blob, local: true,
    }));
    this.dispatchEvent(new Event('change'));
  }

  /**
   * Add files. `entries` is [{ file, group }] where group is the folder they were dropped from,
   * so a folder called "K-Pop" becomes a K-POP group inside My Library.
   */
  async addFiles(entries) {
    const db = await this._open();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    let added = 0;
    for (const { file, group } of entries) {
      if (!isAudio(file)) continue;
      const { title, artist } = parseName(file.name);
      const row = {
        id: `local/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        group: (group || '').toUpperCase(), title, artist, blob: file, added: Date.now(),
      };
      const ok = db ? await this._tx('readwrite', (s) => s.put(row)) : null;
      if (ok === null) this.session.push(row);    // e.g. a private window refuses to store files
      added++;
    }
    await this._loadLocal();
    return added;
  }

  async remove(id) {
    this.session = this.session.filter((r) => r.id !== id);
    if (await this._open()) await this._tx('readwrite', (s) => s.delete(id));
    await this._loadLocal();
  }

  /** Remember a decoded duration so the list can show it next time. */
  async noteDuration(track, seconds) {
    track.duration = seconds;
    const row = this.session.find((r) => r.id === track.id);
    if (row) row.duration = seconds;
    if (!track.local || row || !(await this._open())) return;
    await this._tx('readwrite', (s) => {
      const req = s.get(track.id);
      req.onsuccess = () => { if (req.result) { req.result.duration = seconds; s.put(req.result); } };
      return req;
    });
  }
}

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|aif|aiff|flac|ogg|oga|opus|webm|caf)$/i;
function isAudio(file) {
  return (file.type && file.type.startsWith('audio/')) || AUDIO_EXT.test(file.name);
}

/** "Artist - Title.mp3" -> { artist, title }. Leading track numbers are dropped. */
export function parseName(name) {
  const base = name.replace(AUDIO_EXT, '').replace(/^\d{1,3}[\s._-]+/, '').replace(/_/g, ' ').trim();
  const m = base.split(/\s+[-–—]\s+/);
  if (m.length >= 2) return { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() };
  return { artist: '', title: base };
}

/**
 * Collect audio files from a drop, including whole folders (one level of grouping is kept:
 * dropping "Hip-Hop/" and "K-Pop/" gives two groups).
 */
export async function filesFromDrop(dataTransfer) {
  const out = [];
  const items = dataTransfer.items ? [...dataTransfer.items] : [];
  const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) {
    for (const file of dataTransfer.files || []) out.push({ file, group: '' });
    return out;
  }
  const readAll = (reader) => new Promise((resolve) => {
    const acc = [];
    const step = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(acc);
      acc.push(...batch); step();
    }, () => resolve(acc));
    step();
  });
  const walk = async (entry, group) => {
    if (entry.isFile) {
      const file = await new Promise((res) => entry.file(res, () => res(null)));
      if (file) out.push({ file, group });
    } else if (entry.isDirectory) {
      const children = await readAll(entry.createReader());
      for (const child of children) await walk(child, group || entry.name);
    }
  };
  for (const e of entries) await walk(e, e.isDirectory ? e.name : '');
  return out;
}
