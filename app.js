/* Earmark: an offline MP3 player with +30s / -10s skips, custom speeds and bookmarks.
   Audio files, positions and bookmarks are stored on this device in IndexedDB. Nothing is uploaded. */
(() => {
  'use strict';

  const BACK_SECONDS = 10;
  const FORWARD_SECONDS = 30;
  const SPEED_MIN = 0.25;
  const SPEED_MAX = 4;
  const SLIDER_MIN = 0.5;
  const SLIDER_MAX = 3;
  const NUDGE = 0.05;
  const MAX_PRESETS = 10;
  const DEFAULT_PRESETS = [1, 1.15, 1.3, 1.5, 1.75, 2];
  const SAVE_EVERY_MS = 5000;

  const $ = (id) => document.getElementById(id);
  const audio = $('audio');
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  const ICONS = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.3v13.4a.9.9 0 0 0 1.37.77l10.9-6.7a.9.9 0 0 0 0-1.54L9.37 4.53A.9.9 0 0 0 8 5.3z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.2" fill="currentColor"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2" fill="currentColor"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.9" fill="currentColor"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/><circle cx="19" cy="12" r="1.9" fill="currentColor"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  };

  /* ---------- formatting ---------- */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad = (n) => String(n).padStart(2, '0');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const fmtSpeed = (s) => `${Number(s.toFixed(2))}×`;

  function fmt(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function fmtLength(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec} sec`;
    const minutes = Math.round(sec / 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h ${m}m` : `${m} min`;
  }

  function fmtBytes(b) {
    if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
    if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
    return `${Math.max(1, Math.round(b / 1e3))} KB`;
  }

  const makeId = () => (window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const prettyName = (name) => name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || name;
  const initial = (title) => (title.match(/[\p{L}\p{N}]/u) || ['♪'])[0].toUpperCase();

  function guessType(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const types = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac' };
    return types[ext] || 'audio/mpeg';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, className, action) {
    const b = el('button', className, label);
    b.type = 'button';
    if (action) b.dataset.action = action;
    return b;
  }

  /* ---------- settings (small values in localStorage) ---------- */

  const settings = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`earmark.${key}`);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`earmark.${key}`, JSON.stringify(value));
      } catch {
        // Storage full or blocked; settings are a convenience.
      }
    },
  };

  /* ---------- IndexedDB (audio, positions, bookmarks) ---------- */

  let dbPromise = null;
  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        let req;
        try {
          req = indexedDB.open('earmark', 1);
        } catch (err) {
          reject(err);
          return;
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('tracks', { keyPath: 'id' });
          db.createObjectStore('audio', { keyPath: 'id' });
          db.createObjectStore('art', { keyPath: 'id' });
          db.createObjectStore('marks', { keyPath: 'id' }).createIndex('trackId', 'trackId');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const txDone = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });

  const db = {
    async get(store, key) {
      const d = await openDB();
      return request(d.transaction(store).objectStore(store).get(key));
    },
    async all(store) {
      const d = await openDB();
      return request(d.transaction(store).objectStore(store).getAll());
    },
    async marksFor(trackId) {
      const d = await openDB();
      return request(d.transaction('marks').objectStore('marks').index('trackId').getAll(trackId));
    },
    async put(store, value) {
      const d = await openDB();
      const tx = d.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      return txDone(tx);
    },
    async remove(store, key) {
      const d = await openDB();
      const tx = d.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      return txDone(tx);
    },
    async removeTrack(id) {
      const d = await openDB();
      const tx = d.transaction(['tracks', 'audio', 'art', 'marks'], 'readwrite');
      tx.objectStore('tracks').delete(id);
      tx.objectStore('audio').delete(id);
      tx.objectStore('art').delete(id);
      tx.objectStore('marks').index('trackId').openCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      return txDone(tx);
    },
  };

  /* ---------- state ---------- */

  function loadPresets() {
    const saved = settings.get('presets', DEFAULT_PRESETS);
    if (!Array.isArray(saved)) return DEFAULT_PRESETS.slice();
    return saved.map(Number).filter((p) => Number.isFinite(p) && p >= SPEED_MIN && p <= SPEED_MAX).sort((a, b) => a - b);
  }

  const state = {
    tracks: [],
    markCounts: {},
    artUrls: new Map(),
    sessionAudio: new Map(), // files the browser refused to store; they play until the app closes
    sessionMarks: new Map(),
    current: null,
    marks: [],
    loaded: false, // the <audio> element holds the current track
    loading: null,
    audioUrl: null,
    pendingSeek: null, // where to jump once the audio is ready
    speed: clamp(Number(settings.get('speed', 1)) || 1, SPEED_MIN, SPEED_MAX),
    presets: loadPresets(),
    menuOpen: null,
    confirmDelete: null,
    editingMark: null,
    editingPresets: false,
    scrubbing: false,
    scrubValue: 0,
  };

  const sortTracks = () => state.tracks.sort((a, b) => collator.compare(a.name, b.name));
  const sortMarks = () => state.marks.sort((a, b) => a.time - b.time);

  /* ---------- reading MP3 tags (ID3v2.3 / 2.4) ---------- */

  const syncsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
  const uint32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

  function removeUnsync(bytes) {
    const out = new Uint8Array(bytes.length);
    let j = 0;
    for (let i = 0; i < bytes.length; i++) {
      out[j++] = bytes[i];
      if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
    }
    return out.subarray(0, j);
  }

  function decodeString(bytes, encoding) {
    let label = 'utf-8';
    if (encoding === 0) label = 'iso-8859-1';
    else if (encoding === 1) label = bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-16le';
    else if (encoding === 2) label = 'utf-16be';
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      return '';
    }
  }

  const decodeText = (data) => decodeString(data.subarray(1), data[0]).split('\0')[0].replace(/^﻿/, '').trim();

  function decodePicture(data) {
    const encoding = data[0];
    let p = 1;
    const mimeEnd = data.indexOf(0, p);
    if (mimeEnd < 0) return null;
    let mime = String.fromCharCode(...data.subarray(p, mimeEnd)).toLowerCase();
    if (mime === '-->') return null; // a link, not an image
    p = mimeEnd + 2; // skip the terminator and the picture-type byte
    if (encoding === 1 || encoding === 2) {
      while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2;
      p += 2;
    } else {
      while (p < data.length && data[p] !== 0) p++;
      p += 1;
    }
    if (p >= data.length) return null;
    if (!mime.includes('/')) mime = mime === 'png' ? 'image/png' : 'image/jpeg';
    if (mime === 'image/jpg') mime = 'image/jpeg';
    return new Blob([data.slice(p)], { type: mime });
  }

  async function readTags(file) {
    const tags = {};
    try {
      const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
      if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return tags; // "ID3"
      const version = head[3];
      if (version !== 3 && version !== 4) return tags;
      const flags = head[5];
      const size = syncsafe(head, 6);
      if (size <= 0 || size > 32 * 1024 * 1024) return tags;
      let buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
      if (version === 3 && (flags & 0x80)) buf = removeUnsync(buf);

      let p = 0;
      if (flags & 0x40) p = version === 4 ? syncsafe(buf, 0) : uint32(buf, 0) + 4; // extended header

      while (p + 10 <= buf.length) {
        const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const frameSize = version === 4 ? syncsafe(buf, p + 4) : uint32(buf, p + 4);
        const format = buf[p + 9];
        const start = p + 10;
        const end = start + frameSize;
        if (frameSize <= 0 || end > buf.length) break;
        p = end;

        let data = buf.subarray(start, end);
        if (version === 4) {
          if (format & 0x0c) continue; // compressed or encrypted
          let skip = 0;
          if (format & 0x40) skip += 1; // group id
          if (format & 0x01) skip += 4; // data length indicator
          data = data.subarray(skip);
          if (format & 0x02) data = removeUnsync(data);
        } else {
          if (format & 0xc0) continue; // compressed or encrypted
          if (format & 0x20) data = data.subarray(1); // group id
        }
        if (!data.length) continue;

        if (id === 'TIT2') tags.title = decodeText(data);
        else if (id === 'TPE1') tags.artist = decodeText(data);
        else if (id === 'TALB') tags.album = decodeText(data);
        else if (id === 'APIC' && !tags.art) tags.art = decodePicture(data);
      }
    } catch {
      // Tags are optional; fall back to the file name.
    }
    return tags;
  }

  async function shrinkArt(blob) {
    try {
      if (!('createImageBitmap' in window)) return blob;
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && blob.size < 300000) {
        if (bitmap.close) bitmap.close();
        return blob;
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      return await new Promise((resolve) => canvas.toBlob((b) => resolve(b || blob), 'image/jpeg', 0.85));
    } catch {
      return blob;
    }
  }

  function probeDuration(blob) {
    return new Promise((resolve) => {
      const probe = document.createElement('audio');
      const url = URL.createObjectURL(blob);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        probe.removeAttribute('src');
        probe.load();
        URL.revokeObjectURL(url);
        resolve(Number.isFinite(value) && value > 0 ? value : 0);
      };
      const timer = setTimeout(() => finish(0), 5000);
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => finish(probe.duration);
      probe.onerror = () => finish(0);
      probe.src = url;
    });
  }

  /* ---------- adding and removing files ---------- */

  function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch {
      // Not supported here.
    }
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && f.size > 0);
    if (!files.length) return;
    showToast(files.length === 1 ? `Adding ${files[0].name}…` : `Adding ${files.length} files…`, null, null, 120000);

    let added = 0;
    let duplicates = 0;
    let unsaved = 0;
    let outOfSpace = false;

    for (const file of files) {
      if (state.tracks.some((t) => t.name === file.name && t.size === file.size)) {
        duplicates++;
        continue;
      }
      const id = makeId();
      const blob = new Blob([file], { type: file.type || guessType(file.name) });
      const tags = await readTags(file);
      const duration = await probeDuration(blob);
      const track = {
        id,
        name: file.name,
        size: file.size,
        title: tags.title || prettyName(file.name),
        artist: tags.artist || '',
        album: tags.album || '',
        duration,
        position: 0,
        finished: false,
        addedAt: Date.now(),
        lastPlayedAt: 0,
      };

      try {
        await db.put('audio', { id, blob });
        await db.put('tracks', track);
      } catch (err) {
        if (err && err.name === 'QuotaExceededError') outOfSpace = true;
        db.remove('audio', id).catch(() => {});
        track.sessionOnly = true;
        state.sessionAudio.set(id, blob);
        unsaved++;
      }

      if (tags.art) {
        const art = await shrinkArt(tags.art);
        state.artUrls.set(id, URL.createObjectURL(art));
        if (!track.sessionOnly) db.put('art', { id, blob: art }).catch(() => {});
      }

      state.tracks.push(track);
      added++;
      sortTracks();
      renderLibrary();
    }

    updateStorageInfo();
    if (added > unsaved) requestPersistence();

    const parts = [];
    if (added) parts.push(`Added ${plural(added, 'file')}`);
    if (duplicates) parts.push(`${plural(duplicates, 'file')} already in your library`);
    if (unsaved) {
      parts.push(outOfSpace
        ? `Your phone is out of space, so ${plural(unsaved, 'file')} will only play until you close Earmark`
        : `${plural(unsaved, 'file')} couldn't be saved and will only play until you close Earmark`);
    }
    showToast(`${parts.join('. ')}.`, null, null, unsaved ? 8000 : 4000);
  }

  async function removeTrack(id) {
    const track = state.tracks.find((t) => t.id === id);
    if (!track) return;
    if (state.current === track) unloadCurrent();
    if (!track.sessionOnly) {
      try {
        await db.removeTrack(id);
      } catch {
        showToast("Couldn't delete that file. Try again.");
        return;
      }
    }
    state.tracks = state.tracks.filter((t) => t !== track);
    state.sessionAudio.delete(id);
    state.sessionMarks.delete(id);
    delete state.markCounts[id];
    const art = state.artUrls.get(id);
    if (art) URL.revokeObjectURL(art);
    state.artUrls.delete(id);
    state.menuOpen = null;
    state.confirmDelete = null;
    renderAll();
    updateStorageInfo();
    showToast(`Deleted ${track.title}`);
  }

  /* ---------- playback ---------- */

  // iOS only lets audio start from a tap. Playing a moment of silence on the first tap unlocks the
  // <audio> element, so later play() calls work after async work like reading a file from storage.
  let primed = false;
  function primeAudio() {
    if (primed) return;
    primed = true;
    if (audio.getAttribute('src')) return;
    const n = 800;
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const write = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    write(0, 'RIFF'); v.setUint32(4, 36 + n, true); write(8, 'WAVE'); write(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    write(36, 'data'); v.setUint32(40, n, true);
    new Uint8Array(buf, 44).fill(128);
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    audio.src = url;
    const stop = () => {
      if (audio.getAttribute('src') === url) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      URL.revokeObjectURL(url);
    };
    const attempt = audio.play();
    if (attempt && attempt.then) attempt.then(stop, stop);
    else stop();
  }

  function currentTime() {
    const t = state.current;
    if (!t) return 0;
    if (state.pendingSeek != null) return state.pendingSeek;
    if (state.loaded && audio.readyState >= 1) return audio.currentTime;
    return t.finished ? 0 : t.position || 0;
  }

  function currentDuration() {
    const d = state.loaded ? audio.duration : NaN;
    if (Number.isFinite(d) && d > 0) return d;
    return (state.current && state.current.duration) || 0;
  }

  async function loadCurrent() {
    const t = state.current;
    if (!t) return false;
    let blob = state.sessionAudio.get(t.id);
    if (!blob) {
      try {
        const rec = await db.get('audio', t.id);
        blob = rec && rec.blob;
      } catch {
        blob = null;
      }
    }
    if (state.current !== t) return false;
    if (!blob) {
      showToast("This file isn't saved on this device anymore. Delete it and add it again.", null, null, 7000);
      return false;
    }
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(blob);
    const start = t.finished ? 0 : t.position || 0;
    state.pendingSeek = start > 0.5 ? start : null;
    state.loaded = true;
    audio.src = state.audioUrl;
    applySpeed();
    return true;
  }

  function ensureLoaded() {
    if (state.loaded) return Promise.resolve(true);
    if (!state.loading) {
      const t = state.current;
      state.loading = loadCurrent().finally(() => {
        if (state.current === t) state.loading = null;
      });
    }
    return state.loading;
  }

  async function play() {
    const t = state.current;
    if (!t) return;
    if (!(await ensureLoaded()) || state.current !== t) return;
    t.finished = false;
    try {
      await audio.play();
    } catch (err) {
      if (err && err.name === 'NotAllowedError' && state.current === t) showToast('Tap play to start listening.');
      // Other failures also fire the audio "error" event, which explains them.
    }
  }

  function togglePlay() {
    if (!state.current) return;
    if (state.loaded && !audio.paused) audio.pause();
    else play();
  }

  async function openTrack(id, { autoplay = false } = {}) {
    const t = state.tracks.find((x) => x.id === id);
    if (!t) return;
    if (state.current === t) {
      if (autoplay && (!state.loaded || audio.paused)) play();
      return;
    }
    if (state.current) {
      savePosition();
      audio.pause();
    }
    state.current = t;
    state.loaded = false;
    state.loading = null;
    state.pendingSeek = null;
    state.editingMark = null;
    state.marks = [];
    settings.set('lastTrack', id);
    updateMediaMetadata();
    renderAll();
    if (autoplay) play();

    const marks = await loadMarks(t);
    if (state.current !== t) return;
    state.marks = marks;
    renderMarks();
    renderTicks();
  }

  function unloadCurrent() {
    audio.pause();
    state.loaded = false;
    state.loading = null;
    state.pendingSeek = null;
    audio.removeAttribute('src');
    audio.load();
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = null;
    state.current = null;
    state.marks = [];
    settings.set('lastTrack', null);
    settings.set('lastPos', null);
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.metadata = null; } catch { /* ignore */ }
    }
    closePlayer();
  }

  function seekTo(time) {
    const t = state.current;
    if (!t) return;
    const d = currentDuration();
    const target = d ? clamp(time, 0, Math.max(0, d - 0.1)) : Math.max(0, time);
    t.finished = false;
    if (state.loaded && audio.readyState >= 1) {
      state.pendingSeek = null;
      try {
        audio.currentTime = target;
      } catch {
        state.pendingSeek = target;
      }
    } else if (state.loaded) {
      state.pendingSeek = target;
    } else {
      t.position = target;
      t.lastPlayedAt = Date.now();
      persistTrack(t);
    }
    renderTime();
    updatePositionState();
  }

  const skip = (delta) => seekTo(currentTime() + delta);

  function applyPendingSeek() {
    if (state.pendingSeek == null || !state.loaded || audio.readyState < 1) return;
    if (Math.abs(audio.currentTime - state.pendingSeek) < 0.75) {
      state.pendingSeek = null;
      return;
    }
    try {
      audio.currentTime = state.pendingSeek;
    } catch {
      // Try again on the next media event.
    }
  }

  /* ---------- saving positions ---------- */

  const writeQueue = new Map();
  let draining = false;
  let lastSave = 0;

  function persistTrack(t) {
    if (t.sessionOnly) return;
    const { sessionOnly, ...record } = t;
    writeQueue.set(t.id, record);
    drainWrites();
  }

  async function drainWrites() {
    if (draining) return;
    draining = true;
    while (writeQueue.size) {
      const [id, record] = writeQueue.entries().next().value;
      writeQueue.delete(id);
      try {
        await db.put('tracks', record);
      } catch {
        // Keep playing; the next save will try again.
      }
    }
    draining = false;
  }

  function savePosition() {
    const t = state.current;
    if (!t || !state.loaded || state.pendingSeek != null || audio.readyState < 1 || t.finished) return;
    const pos = audio.currentTime;
    if (!Number.isFinite(pos)) return;
    t.position = pos;
    t.lastPlayedAt = Date.now();
    lastSave = t.lastPlayedAt;
    // A synchronous copy, in case the app is closed before the database write finishes.
    settings.set('lastPos', { id: t.id, pos, at: t.lastPlayedAt });
    persistTrack(t);
  }

  async function onEnded() {
    const t = state.current;
    if (!t || !state.loaded) return;
    t.finished = true;
    t.position = 0;
    t.lastPlayedAt = Date.now();
    settings.set('lastPos', null);
    persistTrack(t);
    const next = state.tracks[state.tracks.indexOf(t) + 1];
    if (next) {
      await openTrack(next.id, { autoplay: true });
      showToast(`Playing next: ${next.title}`);
    } else {
      renderAll();
    }
  }

  /* ---------- speed ---------- */

  function applySpeed() {
    try {
      audio.defaultPlaybackRate = state.speed;
      audio.playbackRate = state.speed;
    } catch {
      showToast(`This device can't play at ${fmtSpeed(state.speed)}.`);
    }
    if ('preservesPitch' in audio) audio.preservesPitch = true;
    else if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;
    updatePositionState();
  }

  function setSpeed(value) {
    const v = Math.round(clamp(Number(value), SPEED_MIN, SPEED_MAX) * 100) / 100;
    if (!Number.isFinite(v)) return;
    state.speed = v;
    settings.set('speed', v);
    applySpeed();
    renderSpeed();
  }

  const hasPreset = (s) => state.presets.some((p) => Math.abs(p - s) < 0.001);

  /* ---------- bookmarks ---------- */

  async function loadMarks(t) {
    if (t.sessionOnly) {
      if (!state.sessionMarks.has(t.id)) state.sessionMarks.set(t.id, []);
      return state.sessionMarks.get(t.id);
    }
    try {
      return (await db.marksFor(t.id)).sort((a, b) => a.time - b.time);
    } catch {
      return [];
    }
  }

  function addMark() {
    const t = state.current;
    if (!t) return;
    const mark = { id: makeId(), trackId: t.id, time: currentTime(), note: '', createdAt: Date.now() };
    state.marks.push(mark);
    sortMarks();
    state.markCounts[t.id] = (state.markCounts[t.id] || 0) + 1;
    renderMarks();
    renderTicks();
    showToast(`Bookmarked ${fmt(mark.time)}`, 'Add note', () => {
      if (state.current !== t) return;
      openPlayer();
      editMark(mark.id);
    });
    if (!t.sessionOnly) db.put('marks', mark).catch(() => showToast("Couldn't save that bookmark on this device."));
  }

  function editMark(id) {
    state.editingMark = id;
    renderMarks();
    const input = $('markInput');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function finishEditing(save) {
    const id = state.editingMark;
    if (!id) return;
    const input = $('markInput');
    const mark = state.marks.find((m) => m.id === id);
    state.editingMark = null;
    if (save && mark && input) {
      const note = input.value.trim().slice(0, 200);
      if (note !== mark.note) {
        mark.note = note;
        if (!state.current.sessionOnly) db.put('marks', { ...mark }).catch(() => showToast("Couldn't save that note."));
      }
    }
    renderMarks();
  }

  function deleteMark(id) {
    const t = state.current;
    const i = state.marks.findIndex((m) => m.id === id);
    if (!t || i < 0) return;
    const [mark] = state.marks.splice(i, 1);
    state.markCounts[t.id] = Math.max(0, (state.markCounts[t.id] || 1) - 1);
    renderMarks();
    renderTicks();
    if (!t.sessionOnly) db.remove('marks', id).catch(() => {});
    showToast(`Deleted bookmark at ${fmt(mark.time)}`, 'Undo', () => {
      state.markCounts[t.id] = (state.markCounts[t.id] || 0) + 1;
      if (!t.sessionOnly) db.put('marks', mark).catch(() => {});
      if (state.current === t) {
        state.marks.push(mark);
        sortMarks();
        renderMarks();
        renderTicks();
      } else if (t.sessionOnly) {
        state.sessionMarks.get(t.id).push(mark);
      }
    });
  }

  function jumpToMark(id) {
    const mark = state.marks.find((m) => m.id === id);
    if (!mark) return;
    seekTo(mark.time);
    if (!state.loaded || audio.paused) play();
  }

  /* ---------- lock screen controls ---------- */

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // This browser doesn't support that action.
      }
    };
    set('play', () => play());
    set('pause', () => audio.pause());
    set('seekbackward', () => skip(-BACK_SECONDS));
    set('seekforward', () => skip(FORWARD_SECONDS));
    set('seekto', (details) => {
      if (details && Number.isFinite(details.seekTime)) seekTo(details.seekTime);
    });
  }

  function updateMediaMetadata() {
    const t = state.current;
    if (!t || !('mediaSession' in navigator) || !window.MediaMetadata) return;
    const art = state.artUrls.get(t.id);
    const artwork = art
      ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }]
      : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || 'Earmark', album: t.album || '', artwork });
    } catch {
      // Lock screen info is optional.
    }
  }

  function updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || !state.loaded) return;
    const d = audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: clamp(audio.currentTime, 0, d) });
    } catch {
      // Ignore invalid states during loading.
    }
  }

  /* ---------- toast ---------- */

  let toastTimer = null;
  function showToast(text, actionLabel, onAction, ms = 4000) {
    $('toastText').textContent = text;
    const action = $('toastAction');
    if (actionLabel) {
      action.textContent = actionLabel;
      action.hidden = false;
      action.onclick = () => {
        hideToast();
        onAction();
      };
    } else {
      action.hidden = true;
      action.onclick = null;
    }
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, actionLabel ? Math.max(ms, 6000) : ms);
  }

  function hideToast() {
    $('toast').hidden = true;
  }

  /* ---------- rendering ---------- */

  function trackStatus(t) {
    if (t.sessionOnly) return 'Not saved on this device';
    if (t.finished) return 'Finished';
    if (!t.position) return t.duration ? fmtLength(t.duration) : 'Not started';
    if (t.duration) return `${fmtLength(t.duration - t.position)} left`;
    return `Stopped at ${fmt(t.position)}`;
  }

  function trackRow(t) {
    const li = el('li', 'track');
    li.dataset.id = t.id;
    if (state.current === t) li.classList.add('is-current');
    if (t.finished) li.classList.add('is-finished');

    const main = button(null, 'track-main', 'open');
    main.setAttribute('aria-label', `Play ${t.title}`);
    const art = el('span', 'track-art');
    const artUrl = state.artUrls.get(t.id);
    if (artUrl) {
      const img = el('img');
      img.src = artUrl;
      img.alt = '';
      art.append(img);
    } else {
      art.textContent = initial(t.title);
    }

    const text = el('span', 'track-text');
    text.append(el('span', 'track-title', t.title));
    text.append(el('span', 'track-sub', [t.artist, trackStatus(t)].filter(Boolean).join(' · ')));
    const bar = el('span', 'track-bar');
    const fill = el('span');
    const progress = t.finished ? 1 : t.duration ? clamp((t.position || 0) / t.duration, 0, 1) : 0;
    fill.style.width = `${progress * 100}%`;
    bar.append(fill);
    text.append(bar);
    main.append(art, text);

    const count = state.markCounts[t.id] || 0;
    if (count) {
      const badge = el('span', 'mark-badge', String(count));
      badge.title = plural(count, 'bookmark');
      main.append(badge);
    }

    const more = button(null, 'icon-btn track-more', 'more');
    more.setAttribute('aria-label', `Options for ${t.title}`);
    more.setAttribute('aria-expanded', String(state.menuOpen === t.id));
    more.innerHTML = ICONS.more;
    li.append(main, more);

    if (state.menuOpen === t.id) {
      const menu = el('div', 'track-menu');
      if (state.confirmDelete === t.id) {
        const n = state.markCounts[t.id] || 0;
        menu.append(el('span', 'track-menu-q', n ? `Delete this file and its ${plural(n, 'bookmark')}?` : 'Delete this file from Earmark?'));
        menu.append(button('Cancel', 'btn btn-soft btn-small', 'cancel-delete'), button('Delete', 'btn btn-danger btn-small', 'confirm-delete'));
      } else {
        if (t.position || t.finished) menu.append(button('Start over', 'btn btn-soft btn-small', 'restart'));
        menu.append(button('Delete', 'btn btn-ghost btn-small btn-danger-text', 'delete'));
      }
      li.append(menu);
    }
    return li;
  }

  function renderLibrary() {
    const list = $('trackList');
    list.replaceChildren(...state.tracks.map(trackRow));
    $('emptyState').hidden = state.tracks.length > 0;
    updateStorageInfo();
  }

  function updateStorageInfo() {
    const bytes = state.tracks.reduce((sum, t) => sum + (t.sessionOnly ? 0 : t.size || 0), 0);
    $('libCount').textContent = state.tracks.length ? `${plural(state.tracks.length, 'file')} · ${fmtBytes(bytes)}` : '';
  }

  function renderPlayState() {
    const playing = state.loaded && !audio.paused;
    for (const b of [$('playBtn'), $('miniPlay')]) {
      b.innerHTML = playing ? ICONS.pause : ICONS.play;
      b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
    if ('mediaSession' in navigator && state.current) {
      try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch { /* ignore */ }
    }
  }

  function renderTime() {
    if (!state.current) return;
    const d = currentDuration();
    const now = state.scrubbing ? state.scrubValue : currentTime();
    const pct = `${(d ? clamp(now / d, 0, 1) : 0) * 100}%`;
    $('scrubFill').style.width = pct;
    $('scrubThumb').style.left = pct;
    $('miniFill').style.width = pct;
    $('tElapsed').textContent = fmt(now);
    $('tRemain').textContent = d ? `−${fmt(d - now)}` : '';
    $('miniTime').textContent = d ? `${fmt(now)} · ${fmtLength(d - now)} left` : fmt(now);
    const scrub = $('scrub');
    scrub.setAttribute('aria-valuemax', String(Math.round(d)));
    scrub.setAttribute('aria-valuenow', String(Math.round(now)));
    scrub.setAttribute('aria-valuetext', d ? `${fmt(now)} of ${fmt(d)}` : fmt(now));
  }

  function renderTicks() {
    const box = $('scrubTicks');
    box.replaceChildren();
    const d = currentDuration();
    if (!d) return;
    for (const m of state.marks) {
      const tick = el('span', 'tick');
      tick.style.left = `${clamp(m.time / d, 0, 1) * 100}%`;
      box.append(tick);
    }
  }

  function renderMarks() {
    const list = $('markList');
    const n = state.marks.length;
    $('markCount').textContent = n ? String(n) : '';
    $('marksEmpty').hidden = n > 0;
    list.replaceChildren(...state.marks.map((m) => {
      const li = el('li', 'mark');
      li.dataset.id = m.id;
      const time = button(fmt(m.time), 'mark-time', 'jump');
      time.setAttribute('aria-label', `Jump to ${fmt(m.time)}`);
      let body;
      if (state.editingMark === m.id) {
        body = el('input', 'mark-input');
        body.id = 'markInput';
        body.type = 'text';
        body.value = m.note || '';
        body.maxLength = 200;
        body.placeholder = 'Add a note';
        body.setAttribute('enterkeyhint', 'done');
        body.setAttribute('aria-label', `Note for bookmark at ${fmt(m.time)}`);
        body.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finishEditing(true); }
          else if (e.key === 'Escape') { e.preventDefault(); finishEditing(false); }
        });
        body.addEventListener('blur', () => finishEditing(true));
      } else {
        body = button(m.note || 'Add a note', `mark-note${m.note ? '' : ' is-empty'}`, 'edit');
      }
      const del = button(null, 'icon-btn mark-del', 'delete');
      del.setAttribute('aria-label', `Delete bookmark at ${fmt(m.time)}`);
      del.innerHTML = ICONS.close;
      li.append(time, body, del);
      return li;
    }));
  }

  function renderPlayer() {
    const t = state.current;
    if (!t) return;
    $('pTitle').textContent = t.title;
    const sub = [t.artist, t.album].filter(Boolean).join(' · ');
    $('pArtist').textContent = sub;
    $('pArtist').hidden = !sub;
    $('sessionNote').hidden = !t.sessionOnly;
    const art = state.artUrls.get(t.id);
    const img = $('coverImg');
    if (art) {
      img.src = art;
      img.hidden = false;
      $('coverFallback').hidden = true;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
      $('coverFallback').hidden = false;
      $('coverFallback').textContent = initial(t.title);
    }
    renderMarks();
    renderTicks();
    renderTime();
  }

  function renderMini() {
    const show = !!state.current && $('player').hidden;
    $('mini').hidden = !show;
    document.body.classList.toggle('has-mini', show);
    if (state.current) $('miniTitle').textContent = state.current.title;
  }

  function renderSpeed() {
    const s = state.speed;
    $('speedLabel').textContent = fmtSpeed(s);
    $('speedValue').textContent = fmtSpeed(s);
    const range = $('speedRange');
    const sv = clamp(s, SLIDER_MIN, SLIDER_MAX);
    range.value = String(sv);
    range.style.setProperty('--fill', `${((sv - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100}%`);
    const exact = $('speedInput');
    if (document.activeElement !== exact) exact.value = s.toFixed(2);
    $('speedMinus').disabled = s <= SPEED_MIN;
    $('speedPlus').disabled = s >= SPEED_MAX;

    $('presetList').replaceChildren(...state.presets.map((p) => {
      const editing = state.editingPresets;
      const b = el('button', `preset${!editing && Math.abs(p - s) < 0.001 ? ' is-active' : ''}${editing ? ' is-editing' : ''}`);
      b.type = 'button';
      b.dataset.speed = String(p);
      b.setAttribute('aria-label', editing ? `Remove the ${fmtSpeed(p)} preset` : `Play at ${fmtSpeed(p)}`);
      b.append(el('span', null, fmtSpeed(p)));
      if (editing) {
        const x = el('span', 'preset-x');
        x.innerHTML = ICONS.close;
        b.append(x);
      }
      return b;
    }));
    $('presetsEmpty').hidden = state.presets.length > 0;
    $('presetEdit').hidden = !state.presets.length && !state.editingPresets;
    $('presetEdit').textContent = state.editingPresets ? 'Done' : 'Edit';
    const save = $('presetSave');
    save.hidden = state.editingPresets;
    save.disabled = hasPreset(s) || state.presets.length >= MAX_PRESETS;
    save.textContent = hasPreset(s) ? `${fmtSpeed(s)} is a preset` : `Save ${fmtSpeed(s)} as a preset`;
  }

  function renderAll() {
    renderLibrary();
    renderMini();
    if (!$('player').hidden) renderPlayer();
    renderTime();
    renderPlayState();
  }

  /* ---------- sheets ---------- */

  function openPlayer() {
    if (!state.current) return;
    $('player').hidden = false;
    document.body.classList.add('player-open');
    renderPlayer();
    renderMini();
    renderPlayState();
  }

  function closePlayer() {
    finishEditing(true);
    $('player').hidden = true;
    document.body.classList.remove('player-open');
    renderLibrary();
    renderMini();
    renderTime();
  }

  function openSpeed() {
    $('speedSheet').hidden = false;
    renderSpeed();
    $('speedDone').focus({ preventScroll: true });
  }

  function closeSpeed() {
    state.editingPresets = false;
    $('speedSheet').hidden = true;
    renderSpeed();
  }

  /* ---------- wiring ---------- */

  function wireLibrary() {
    const pick = () => $('fileInput').click();
    $('addBtn').addEventListener('click', pick);
    $('emptyAdd').addEventListener('click', pick);
    $('fileInput').addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      importFiles(files);
    });

    $('trackList').addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      const row = e.target.closest('.track');
      if (!target || !row) return;
      const id = row.dataset.id;
      const t = state.tracks.find((x) => x.id === id);
      if (!t) return;
      switch (target.dataset.action) {
        case 'open':
          state.menuOpen = null;
          openTrack(id, { autoplay: true });
          openPlayer();
          break;
        case 'more':
          state.menuOpen = state.menuOpen === id ? null : id;
          state.confirmDelete = null;
          renderLibrary();
          break;
        case 'restart':
          state.menuOpen = null;
          if (state.current === t) {
            seekTo(0);
          } else {
            t.position = 0;
            t.finished = false;
            persistTrack(t);
          }
          renderLibrary();
          break;
        case 'delete':
          state.confirmDelete = id;
          renderLibrary();
          break;
        case 'cancel-delete':
          state.confirmDelete = null;
          state.menuOpen = null;
          renderLibrary();
          break;
        case 'confirm-delete':
          removeTrack(id);
          break;
        default:
      }
    });

    $('hintDismiss').addEventListener('click', () => {
      settings.set('hintDismissed', true);
      $('installHint').hidden = true;
    });

    document.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
    });
    document.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      importFiles(Array.from(e.dataTransfer.files));
    });
  }

  function wirePlayer() {
    $('playBtn').addEventListener('click', togglePlay);
    $('miniPlay').addEventListener('click', togglePlay);
    $('back10').addEventListener('click', () => skip(-BACK_SECONDS));
    $('miniBack').addEventListener('click', () => skip(-BACK_SECONDS));
    $('fwd30').addEventListener('click', () => skip(FORWARD_SECONDS));
    $('miniOpen').addEventListener('click', openPlayer);
    $('playerClose').addEventListener('click', closePlayer);
    $('speedBtn').addEventListener('click', openSpeed);
    $('markBtn').addEventListener('click', addMark);

    $('markList').addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      const row = e.target.closest('.mark');
      if (!target || !row) return;
      const id = row.dataset.id;
      if (target.dataset.action === 'jump') jumpToMark(id);
      else if (target.dataset.action === 'edit') editMark(id);
      else if (target.dataset.action === 'delete') deleteMark(id);
    });

    const scrub = $('scrub');
    const timeAt = (e) => {
      const r = $('scrubTrack').getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1) * currentDuration();
    };
    const endScrub = (commit) => {
      if (!state.scrubbing) return;
      state.scrubbing = false;
      scrub.classList.remove('is-dragging');
      if (commit) seekTo(state.scrubValue);
      renderTime();
    };
    scrub.addEventListener('pointerdown', (e) => {
      if (!state.current || !currentDuration()) return;
      state.scrubbing = true;
      state.scrubValue = timeAt(e);
      scrub.classList.add('is-dragging');
      try { scrub.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      renderTime();
    });
    scrub.addEventListener('pointermove', (e) => {
      if (!state.scrubbing) return;
      state.scrubValue = timeAt(e);
      renderTime();
    });
    scrub.addEventListener('pointerup', () => endScrub(true));
    scrub.addEventListener('pointercancel', () => endScrub(false));
    scrub.addEventListener('keydown', (e) => {
      const steps = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -30, PageUp: 30 };
      if (e.key in steps) seekTo(currentTime() + steps[e.key]);
      else if (e.key === 'Home') seekTo(0);
      else if (e.key === 'End') seekTo(currentDuration());
      else return;
      e.preventDefault();
    });
  }

  function wireSpeed() {
    $('speedDone').addEventListener('click', closeSpeed);
    $('speedSheet').addEventListener('click', (e) => {
      if (e.target === $('speedSheet')) closeSpeed();
    });
    $('speedRange').addEventListener('input', (e) => setSpeed(e.target.value));
    $('speedMinus').addEventListener('click', () => setSpeed(state.speed - NUDGE));
    $('speedPlus').addEventListener('click', () => setSpeed(state.speed + NUDGE));

    const exact = $('speedInput');
    const applyExact = () => {
      const v = parseFloat(String(exact.value).replace(',', '.'));
      if (Number.isFinite(v)) {
        if (v < SPEED_MIN || v > SPEED_MAX) showToast(`Speeds go from ${fmtSpeed(SPEED_MIN)} to ${fmtSpeed(SPEED_MAX)}.`);
        setSpeed(v);
      }
      exact.value = state.speed.toFixed(2);
    };
    exact.addEventListener('change', applyExact);
    exact.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      applyExact();
      exact.blur();
    });

    $('presetList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-speed]');
      if (!b) return;
      const v = Number(b.dataset.speed);
      if (state.editingPresets) {
        state.presets = state.presets.filter((p) => p !== v);
        settings.set('presets', state.presets);
        if (!state.presets.length) state.editingPresets = false;
        renderSpeed();
      } else {
        setSpeed(v);
      }
    });
    $('presetEdit').addEventListener('click', () => {
      state.editingPresets = !state.editingPresets;
      renderSpeed();
    });
    $('presetSave').addEventListener('click', () => {
      const s = state.speed;
      if (hasPreset(s) || state.presets.length >= MAX_PRESETS) return;
      state.presets = [...state.presets, s].sort((a, b) => a - b);
      settings.set('presets', state.presets);
      renderSpeed();
    });
  }

  function wireAudio() {
    audio.addEventListener('loadedmetadata', () => {
      if (!state.loaded) return;
      applySpeed();
      applyPendingSeek();
      const t = state.current;
      const d = audio.duration;
      if (t && Number.isFinite(d) && d > 0 && Math.abs((t.duration || 0) - d) > 0.5) {
        t.duration = d;
        persistTrack(t);
      }
      renderTime();
      renderTicks();
      updatePositionState();
    });
    audio.addEventListener('canplay', applyPendingSeek);
    audio.addEventListener('playing', applyPendingSeek);
    audio.addEventListener('timeupdate', () => {
      if (!state.loaded) return;
      if (state.pendingSeek != null) applyPendingSeek();
      renderTime();
      if (Date.now() - lastSave > SAVE_EVERY_MS && !audio.paused) savePosition();
    });
    audio.addEventListener('seeked', () => {
      if (!state.loaded) return;
      renderTime();
      updatePositionState();
      savePosition();
    });
    audio.addEventListener('play', renderPlayState);
    audio.addEventListener('pause', () => {
      renderPlayState();
      if (state.loaded) savePosition();
    });
    audio.addEventListener('ratechange', updatePositionState);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', () => {
      if (!state.loaded || !audio.error) return;
      showToast("This file can't be played on this device. Try converting it to MP3.", null, null, 7000);
    });
  }

  function wireGlobal() {
    // Capture phase, so the unlock runs before the button's own click handler.
    document.addEventListener('touchend', primeAudio, { capture: true, passive: true });
    document.addEventListener('click', primeAudio, true);
    document.addEventListener('keydown', primeAudio, true);

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable || e.target === $('scrub')) return;
      if (e.key === 'Escape') {
        if (!$('speedSheet').hidden) closeSpeed();
        else if (!$('player').hidden) closePlayer();
        return;
      }
      if (!state.current || !$('speedSheet').hidden) return;
      if (e.key === ' ' && tag !== 'BUTTON') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        skip(-BACK_SECONDS);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        skip(FORWARD_SECONDS);
      } else if (e.key === 'b' || e.key === 'B') {
        addMark();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') savePosition();
    });
    window.addEventListener('pagehide', savePosition);
  }

  function showInstallHint() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const android = /Android/.test(ua);
    if (standalone || (!ios && !android) || settings.get('hintDismissed', false)) return;
    $('hintText').textContent = ios
      ? 'In Safari, tap Share, then Add to Home Screen. Open Earmark from the new icon and add your MP3s there. Safari and the Home Screen app keep separate libraries.'
      : 'In your browser menu, tap Install app or Add to Home screen, then open Earmark from the new icon and add your MP3s there.';
    $('installHint').hidden = false;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      showToast('Earmark was updated.', 'Reload', () => {
        savePosition();
        location.reload();
      }, 15000);
    });
  }

  async function init() {
    wireLibrary();
    wirePlayer();
    wireSpeed();
    wireAudio();
    wireGlobal();
    setupMediaSession();
    registerServiceWorker();
    showInstallHint();
    applySpeed();
    renderSpeed();

    try {
      const [tracks, marks, art] = await Promise.all([db.all('tracks'), db.all('marks'), db.all('art')]);
      state.tracks = tracks;
      for (const m of marks) state.markCounts[m.trackId] = (state.markCounts[m.trackId] || 0) + 1;
      for (const a of art) {
        if (a && a.blob) state.artUrls.set(a.id, URL.createObjectURL(a.blob));
      }
    } catch {
      showToast("This browser won't let Earmark save files. MP3s you add will play until you close the app.", null, null, 9000);
    }

    // The quick copy written on close wins if the database write didn't finish.
    const lastPos = settings.get('lastPos', null);
    if (lastPos && Number.isFinite(lastPos.pos)) {
      const t = state.tracks.find((x) => x.id === lastPos.id);
      if (t && !t.finished && lastPos.at >= (t.lastPlayedAt || 0)) {
        t.position = lastPos.pos;
        t.lastPlayedAt = lastPos.at;
      }
    }
    sortTracks();

    const lastId = settings.get('lastTrack', null);
    const last = lastId && state.tracks.find((t) => t.id === lastId);
    if (last) {
      state.current = last;
      state.marks = await loadMarks(last);
      updateMediaMetadata();
    }
    renderAll();
  }

  init();
})();
