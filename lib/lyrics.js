'use strict';
// Lyrics lookup.
//
// Spotify's own lyrics are Musixmatch-licensed and only reachable through the same
// internal spclient endpoints that are blocked for Canvas, so they're out for the
// same reason. LRCLIB (lrclib.net) is a free, open, no-auth API built for exactly
// this, and it serves LRC - timestamped lines - so the widget can highlight in sync.
//
// A local .lrc in public/lyrics/<trackId>.lrc always wins, for tracks the database
// doesn't have or where you'd rather supply your own timing.

const fs = require('fs');
const path = require('path');

const LYRICS_DIR = path.join(__dirname, '..', 'public', 'lyrics');
const UA = 'spotify-obs-widget/1.0 (personal OBS now-playing widget)';

// [mm:ss.xx] or [mm:ss:xx], possibly several stamps on one line.
const STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
// [ar:...] [ti:...] [length:...] and friends.
const META = /^\[[a-z]+:/i;

function parseLrc(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    STAMP.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = STAMP.exec(line)) !== null) {
      const frac = m[3] ? Number('0.' + m[3]) : 0;
      stamps.push(Math.round((Number(m[1]) * 60 + Number(m[2]) + frac) * 1000));
    }
    if (!stamps.length) continue;

    const words = line.replace(STAMP, '').trim();
    if (!words || META.test(line.replace(STAMP, '').trim())) continue;
    for (const at of stamps) out.push({ at, text: words });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

class Lyrics {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.cache = new Map();      // key -> { lines, synced, source, at }
    this.inflight = new Map();
    this.lastError = null;
    this.enabled = true;
  }

  localFile(trackId) {
    if (!trackId) return null;
    const p = path.join(LYRICS_DIR, trackId + '.lrc');
    return fs.existsSync(p) ? p : null;
  }

  // track: { id, title, artist, album, durationMs }
  async get(track) {
    if (!this.enabled || !track || !track.title) return null;
    const key = track.id || (track.title + '|' + track.artist);

    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 12 * 3600e3) return hit;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = this._fetch(track, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async tryGet(params) {
    try {
      const r = await fetch('https://lrclib.net/api/get?' + new URLSearchParams(params), {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('lrclib HTTP ' + r.status);
      const j = await r.json();
      return j && j.syncedLyrics ? j : null;
    } catch (e) {
      this.lastError = e.message;
      return null;
    }
  }

  async trySearch(params, seconds) {
    try {
      const r = await fetch('https://lrclib.net/api/search?' + new URLSearchParams(params), {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!r.ok) return null;
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) return null;

      const synced = list.filter((x) => x && x.syncedLyrics);
      if (!synced.length) return null;
      if (!seconds) return synced[0];

      // Closest running time is the best guess at the same cut of the track.
      let best = synced[0];
      let bestDiff = Infinity;
      for (const cand of synced) {
        const diff = Math.abs((Number(cand.duration) || 0) - seconds);
        if (diff < bestDiff) { bestDiff = diff; best = cand; }
      }
      // More than 15s out is a different edit; wrong timings are worse than none.
      return bestDiff <= 15 ? best : null;
    } catch (e) {
      this.lastError = e.message;
      return null;
    }
  }

  async _fetch(track, key) {
    // Your own .lrc beats anything remote.
    const local = this.localFile(track.id);
    if (local) {
      try {
        const lines = parseLrc(fs.readFileSync(local, 'utf8'));
        const rec = { lines, synced: lines.length > 0, source: 'local', at: Date.now() };
        this.cache.set(key, rec);
        return rec;
      } catch (e) {
        this.lastError = 'reading local lrc: ' + e.message;
      }
    }

    try {
      const base = {
        artist_name: track.artist || '',
        track_name: track.title || '',
      };
      const seconds = track.durationMs ? Math.round(track.durationMs / 1000) : 0;

      // /api/get matches duration within about 2s and 404s otherwise, so a remaster
      // or an edit misses even when lyrics plainly exist. Try exact first, then
      // loosen, then fall back to search and pick the closest synced match.
      let hit = await this.tryGet({ ...base, ...(seconds ? { duration: String(seconds) } : {}) });
      if (!hit) hit = await this.tryGet(base);
      if (!hit) hit = await this.trySearch(base, seconds);

      let lines = [];
      let synced = false;
      if (hit && hit.syncedLyrics) {
        lines = parseLrc(hit.syncedLyrics);
        synced = lines.length > 0;
      }

      // Unsynced lyrics can't be highlighted in time, so they're no use to a
      // line-at-a-time display. Treat as "none" rather than dumping a wall of text.
      const rec = {
        lines,
        synced,
        instrumental: !!(hit && hit.instrumental),
        source: synced ? 'lrclib' : 'none',
        at: Date.now(),
      };
      this.lastError = null;
      this.cache.set(key, rec);
      return rec;
    } catch (e) {
      this.lastError = e.message;
      // Short negative cache so a network blip doesn't retry every poll.
      this.cache.set(key, { lines: [], synced: false, source: 'error', at: Date.now() - 12 * 3600e3 + 120e3 });
      return { lines: [], synced: false, source: 'error' };
    }
  }
}

module.exports = { Lyrics, parseLrc, LYRICS_DIR };
