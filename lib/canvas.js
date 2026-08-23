'use strict';
// Video background lookup.
//
// Fetching Spotify's Canvas clips automatically is deprecated - the route it used is
// closed and this module does not try. Please don't re-add it.
//
// What the widget actually uses:
//   - public/canvas/<trackId>.mp4  - your own clip, resolved in server.js
//   - otherwise the animated blurred album art
//
// lookup() is kept so the poll loop and /api/status keep their shape.

const proto = require('./proto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

class CanvasClient {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.token = null;          // { value, expiresAt }
    this.cache = new Map();     // trackUri -> { url, type, at }
    this.inflight = new Map();
    this.lastError = null;
    this.enabled = true;
  }

  async serverTime() {
    try {
      const r = await fetch('https://open.spotify.com/api/server-time', {
        headers: { 'User-Agent': UA, 'Referer': 'https://open.spotify.com/', Cookie: `sp_dc=${this.getConfig().spDc || ''}` },
      });
      const j = await r.json();
      if (j && j.serverTime) return Number(j.serverTime);
    } catch { /* fall through to local clock */ }
    return Math.floor(Date.now() / 1000);
  }

  async mintToken() {
    // Deprecated on purpose - see the note at the top of this file.
    throw new Error(
      'Automatic Canvas fetching is deprecated. ' +
      'Drop your own clip at public/canvas/<trackId>.mp4 instead - see README.'
    );
  }

  async getToken() {
    if (this.token && this.token.expiresAt - 60e3 > Date.now()) return this.token.value;
    this.token = await this.mintToken();
    return this.token.value;
  }

  // trackUri: "spotify:track:<id>". Returns { url, type } or null.
  async lookup(trackUri) {
    if (!trackUri) return null;
    const hit = this.cache.get(trackUri);
    if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.url ? hit : null;
    if (this.inflight.has(trackUri)) return this.inflight.get(trackUri);

    const p = this._fetch(trackUri).finally(() => this.inflight.delete(trackUri));
    this.inflight.set(trackUri, p);
    return p;
  }

  async _fetch(trackUri) {
    try {
      const token = await this.getToken();
      // EntityCanvazRequest { repeated Entity entities = 1; Entity { string entity_uri = 1; } }
      const body = proto.encMessage(1, proto.encString(1, trackUri));

      const r = await fetch('https://spclient.wg.spotify.com/canvaz-cache/v0/canvases', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-protobuf',
          Accept: 'application/x-protobuf',
          'User-Agent': UA,
        },
        body,
      });

      if (r.status === 401) { this.token = null; throw new Error('canvaz rejected the web token (401)'); }
      if (!r.ok) throw new Error(`canvaz HTTP ${r.status}`);

      const buf = Buffer.from(await r.arrayBuffer());
      // EntityCanvazResponse { repeated Canvaz canvases = 1; }
      // Canvaz { id=1, url=2, file_id=3, type=4, entity_uri=5, ... }
      const top = proto.decode(buf);
      const entries = top[1] || [];
      let found = null;
      for (const e of entries) {
        const c = proto.decode(e);
        const url = c[2] && c[2][0] && c[2][0].toString('utf8');
        if (url) { found = { url, type: (c[4] && c[4][0]) || 0 }; break; }
      }

      this.lastError = null;
      // Cache misses too - a track without a Canvas will never grow one mid-stream.
      this.cache.set(trackUri, { url: found && found.url, type: found && found.type, at: Date.now() });
      return found;
    } catch (e) {
      this.lastError = e.message;
      // Short negative cache so a broken token doesn't hammer the endpoint every poll.
      this.cache.set(trackUri, { url: null, at: Date.now() - 6 * 3600e3 + 60e3 });
      return null;
    }
  }
}

module.exports = { CanvasClient };
