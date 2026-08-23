'use strict';
// Official Spotify Web API: OAuth (Authorization Code + PKCE, so no client secret)
// plus the currently-playing poll. This half is stable and documented.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCOPES = 'user-read-currently-playing user-read-playback-state';
const TOKENS_FILE = path.join(__dirname, '..', 'tokens.json');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class Spotify {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.verifier = null;
    this.tokens = null;
    try { this.tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { /* not linked yet */ }
  }

  get linked() { return !!(this.tokens && this.tokens.refresh_token); }

  redirectUri() { return `http://127.0.0.1:${this.getConfig().port}/callback`; }

  authUrl() {
    this.verifier = b64url(crypto.randomBytes(64));
    const challenge = b64url(crypto.createHash('sha256').update(this.verifier).digest());
    const q = new URLSearchParams({
      client_id: this.getConfig().clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES,
    });
    return `https://accounts.spotify.com/authorize?${q}`;
  }

  save() {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(this.tokens, null, 2));
  }

  async exchange(code) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(),
      client_id: this.getConfig().clientId,
      code_verifier: this.verifier || '',
    });
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    this.tokens = { ...j, expires_at: Date.now() + j.expires_in * 1000 };
    this.save();
  }

  async refresh() {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token,
      client_id: this.getConfig().clientId,
    });
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    // Spotify only sometimes returns a fresh refresh_token; keep the old one otherwise.
    this.tokens = { ...this.tokens, ...j, expires_at: Date.now() + j.expires_in * 1000 };
    this.save();
  }

  async accessToken() {
    if (!this.linked) throw new Error('not linked');
    if (!this.tokens.access_token || this.tokens.expires_at - 60e3 < Date.now()) await this.refresh();
    return this.tokens.access_token;
  }

  async nowPlaying() {
    const token = await this.accessToken();
    const r = await fetch('https://api.spotify.com/v1/me/player?additional_types=track,episode', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 204) return null;          // nothing active
    if (r.status === 429) { const wait = Number(r.headers.get('retry-after') || 3); const e = new Error('rate limited'); e.retryAfter = wait; throw e; }
    if (!r.ok) throw new Error(`player HTTP ${r.status}`);
    const j = await r.json();
    if (!j || !j.item) return null;
    return j;
  }
}

module.exports = { Spotify, SCOPES };
