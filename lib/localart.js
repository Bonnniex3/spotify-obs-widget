'use strict';
// Cover art for local files.
//
// Spotify's Web API returns no artwork for a local file - album.images is empty -
// so the widget would otherwise show a blank tile. Windows does have the image:
// Spotify publishes a thumbnail to the system media session, read from the file's
// own tags. tools/smtc_art.py fetches it; this caches the result per track.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '.artcache');
const SCRIPT = path.join(__dirname, '..', 'tools', 'smtc_art.py');
const MAX_ENTRIES = 60;

class LocalArt {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.cache = new Map();      // key -> { file } or { file: null } for a known miss
    this.inflight = new Map();
    this.lastError = null;
    this.pythonBin = null;       // null = unchecked, '' = unavailable
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* created on demand */ }
  }

  fileFor(key) {
    const hash = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 16);
    return path.join(CACHE_DIR, hash + '.img');
  }

  async python() {
    if (this.pythonBin !== null) return this.pythonBin;
    const configured = this.getConfig().pythonPath;
    for (const bin of [configured, 'python', 'python3', 'py'].filter(Boolean)) {
      const ok = await new Promise((resolve) => {
        let p;
        try {
          p = spawn(bin, ['-c', 'import winsdk; print(1)'], { windowsHide: true });
        } catch { return resolve(false); }
        let out = '';
        p.stdout.on('data', (b) => { out += b.toString(); });
        p.on('error', () => resolve(false));
        p.on('close', () => resolve(out.trim() === '1'));
      });
      if (ok) { this.pythonBin = bin; return bin; }
    }
    this.pythonBin = '';
    this.lastError = 'winsdk not available (pip install winsdk)';
    return '';
  }

  // key: stable per-track key. title: what we expect to still be playing.
  // Returns a served URL, or null when there's no art to be had.
  async get(key, title) {
    if (!key) return null;

    const hit = this.cache.get(key);
    if (hit) return hit.file ? '/api/localart?k=' + encodeURIComponent(key) : null;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = this._fetch(key, title).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async _fetch(key, title) {
    const py = await this.python();
    if (!py) { this.cache.set(key, { file: null }); return null; }

    const file = this.fileFor(key);
    const args = [SCRIPT, file];
    // Guard against the track changing between our poll and this call - the
    // media session always describes what's playing now, not what we asked for.
    if (title) args.push(title);

    const result = await new Promise((resolve) => {
      let p;
      try {
        p = spawn(py, args, { windowsHide: true });
      } catch (e) { return resolve({ ok: false, reason: e.message }); }
      let out = '';
      p.stdout.on('data', (b) => { out += b.toString(); });
      p.on('error', (e) => resolve({ ok: false, reason: e.message }));
      p.on('close', () => {
        try { resolve(JSON.parse(out.trim().split(/\r?\n/).pop() || '{}')); }
        catch { resolve({ ok: false, reason: 'bad output from smtc_art.py' }); }
      });
    });

    if (!result.ok || !fs.existsSync(file)) {
      // "track changed" is transient - don't cache it, we'll get it next poll.
      if (result.reason !== 'track changed') this.cache.set(key, { file: null });
      this.lastError = result.reason || 'unknown';
      return null;
    }

    this.lastError = null;
    this.cache.set(key, { file });
    this.prune();
    return '/api/localart?k=' + encodeURIComponent(key);
  }

  // Long sessions shouldn't leave hundreds of covers on disk.
  prune() {
    if (this.cache.size <= MAX_ENTRIES) return;
    const excess = this.cache.size - MAX_ENTRIES;
    let n = 0;
    for (const [k, v] of this.cache) {
      if (n++ >= excess) break;
      if (v.file) { try { fs.rmSync(v.file, { force: true }); } catch { /* already gone */ } }
      this.cache.delete(k);
    }
  }

  // Path on disk for a cached key, for the HTTP route to serve.
  pathFor(key) {
    const hit = this.cache.get(key);
    return hit && hit.file && fs.existsSync(hit.file) ? hit.file : null;
  }
}

module.exports = { LocalArt, CACHE_DIR };
