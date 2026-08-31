'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Spotify } = require('./lib/spotify');
const { CanvasClient } = require('./lib/canvas');
const { AudioAnalyser, listDevices } = require('./lib/audio');
const { GifLibrary } = require('./lib/gif');
const { Lyrics } = require('./lib/lyrics');
const { LocalArt } = require('./lib/localart');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const PUBLIC = path.join(__dirname, 'public');
const CANVAS_DIR = path.join(PUBLIC, 'canvas');

const DEFAULTS = {
  port: 8888, clientId: '', spDc: '', webToken: '', pollMs: 2500,
  audioDevice: '', ffmpegPath: '', waveBands: 28, waveGainDb: 6, waveRelease: 0,
};

function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first run */ }
  const merged = { ...DEFAULTS, ...file };
  // Floor the poll rate. A saved config from an older version overrides the
  // default, so lowering the default alone doesn't protect existing installs -
  // and polling harder than this is how you earn a multi-hour rate limit.
  merged.pollMs = Math.max(2000, Number(merged.pollMs) || DEFAULTS.pollMs);
  return merged;
}
let config = loadConfig();
const getConfig = () => config;

function saveConfig(patch) {
  config = { ...config, ...patch };
  const keep = ['port', 'clientId', 'spDc', 'webToken', 'pollMs', 'audioDevice', 'ffmpegPath', 'waveBands', 'waveGainDb', 'waveRelease'];
  const out = {};
  for (const k of keep) out[k] = config[k];
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2));
}

const spotify = new Spotify(getConfig);
const canvas = new CanvasClient(getConfig);
const audio = new AudioAnalyser(getConfig, config.waveBands);
const gifs = new GifLibrary(getConfig);
const lyrics = new Lyrics(getConfig);
const localArt = new LocalArt(getConfig);

// ---- playback poll ---------------------------------------------------------
// One shared poll loop, no matter how many browser sources are connected.
let state = { ok: false, reason: 'starting' };
let lastGood = null;          // last successful read, to ride out short outages
let failures = 0;
let rateLimitedUntil = 0;

function localCanvas(trackId) {
  for (const ext of ['mp4', 'webm']) {
    if (fs.existsSync(path.join(CANVAS_DIR, trackId + '.' + ext))) {
      return '/canvas/' + trackId + '.' + ext;
    }
  }
  return null;
}

async function poll() {
  let delay = config.pollMs;
  try {
    if (!spotify.linked) {
      state = { ok: false, reason: 'not-linked' };
    } else {
      const p = await spotify.nowPlaying();
      if (!p || !p.item) {
        state = { ok: true, playing: false, item: null };
      } else {
        const it = p.item;
        const isEpisode = it.type === 'episode';
        const art = isEpisode
          ? (it.images || (it.show && it.show.images) || [])
          : ((it.album && it.album.images) || []);
        // Local files come back with a null id and no artwork. They're still a
        // perfectly good "now playing", so give them a stable key of their own
        // rather than letting the widget mistake them for nothing playing.
        const isLocal = !it.id || it.is_local === true;
        const next = {
          ok: true,
          playing: !!p.is_playing,
          id: it.id || null,
          key: it.id || it.uri || ('local:' + it.name),
          isLocal,
          uri: it.uri,
          title: it.name,
          artist: isEpisode
            ? (it.show ? it.show.name : '')
            : (it.artists || []).map((a) => a.name).join(', '),
          album: isEpisode ? (it.show ? it.show.name : '') : (it.album ? it.album.name : ''),
          art: art.length ? art[0].url : null,
          artUrl: art.length ? '/api/art?u=' + encodeURIComponent(art[0].url) : null,
          progressMs: p.progress_ms || 0,
          durationMs: it.duration_ms || 0,
          device: p.device ? p.device.name : null,
          canvas: null,
          canvasSource: null,
          serverTime: Date.now(),
        };

        // Local files carry no artwork from the API - Windows has it instead.
        if (!next.artUrl && isLocal) {
          next.artUrl = await localArt.get(next.key, it.name).catch(() => null);
          next.artSource = next.artUrl ? 'windows' : null;
        } else if (next.artUrl) {
          next.artSource = 'spotify';
        }

        // A local override wins, then the real Canvas lookup.
        const local = it.id ? localCanvas(it.id) : null;
        if (local) {
          next.canvas = local;
          next.canvasSource = 'local';
        } else if (canvas.enabled && !isEpisode && !isLocal) {
          const c = await canvas.lookup(it.uri).catch(() => null);
          if (c && c.url) {
            next.canvas = '/api/canvas?u=' + encodeURIComponent(c.url);
            next.canvasSource = 'spotify';
          }
        }
        state = next;
        lastGood = next;
        failures = 0;
        rateLimitedUntil = 0;
      }
    }
  } catch (e) {
    failures++;
    if (e.retryAfter) {
      // Spotify's Retry-After is authoritative; hammering it can extend the block.
      rateLimitedUntil = Date.now() + e.retryAfter * 1000;
      delay = Math.max(delay, e.retryAfter * 1000);
      console.log('  Spotify rate limited - retrying in ' +
        Math.round(e.retryAfter / 60) + ' min (' +
        new Date(rateLimitedUntil).toLocaleTimeString() + ')');
    } else {
      // Ordinary failure: back off so a network drop doesn't spam the API.
      delay = Math.min(30000, delay * Math.pow(2, Math.min(failures - 1, 4)));
    }

    // Don't blank the overlay for a brief hiccup - keep the last track for a few
    // minutes. Beyond that it's more likely wrong than useful.
    const age = lastGood ? Date.now() - lastGood.serverTime : Infinity;
    state = (lastGood && age < 5 * 60e3)
      ? { ...lastGood, stale: true, reason: e.message }
      : { ok: false, reason: e.message };
  }
  setTimeout(poll, delay);
}

// ---- http ------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  }, extra || {}));
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json');
const html = (res, code, body) => send(res, code, body, 'text/html; charset=utf-8');

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  if (rel === '/setup' || rel === '/setup/') rel = '/setup.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^[/\\]+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

function page(title, body) {
  return '<!doctype html><meta charset="utf-8"><title>' + title + '</title>' +
    '<style>body{font:15px/1.7 system-ui,sans-serif;background:#0d1117;color:#e6edf3;' +
    'display:grid;place-items:center;min-height:100vh;margin:0;text-align:center}' +
    'a{color:#1db954}code{background:#161b22;padding:3px 7px;border-radius:6px}</style>' +
    '<div>' + body + '</div>';
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:' + config.port);
  const p = u.pathname;

  try {
    if (p === '/api/now') return json(res, 200, state);

    // Live audio levels, one SSE frame per FFT hop (~43/sec).
    if (p === '/api/audio') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000' + String.fromCharCode(10, 10));
      audio.addClient(res);
      return;
    }

    // Fetched once per track by the widget, not on every poll.
    if (p === '/api/lyrics') {
      const st = state && state.ok ? state : null;
      if (!st || !st.title) return json(res, 200, { lines: [], synced: false, source: 'none' });
      const rec = await lyrics.get({
        id: st.id, title: st.title, artist: st.artist,
        album: st.album, durationMs: st.durationMs,
      });
      return json(res, 200, rec || { lines: [], synced: false, source: 'none' });
    }

    // Which clip the widget should loop, and how long it is - the widget needs the
    // duration to pick a rate that lands the loop on a whole number of beats.
    // Cover pulled from the Windows media session for a local file.
    if (p === '/api/localart') {
      const file = localArt.pathFor(u.searchParams.get('k') || '');
      if (!file) return send(res, 404, 'no local art');
      return fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, 'no local art');
        send(res, 200, data, 'image/png', {
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        });
      });
    }

    if (p === '/api/gif') {
      const item = gifs.get(u.searchParams.get('name'));
      return json(res, 200, {
        gif: item || null,
        available: gifs.list().map((g) => g.name),
        error: gifs.lastError,
      });
    }

    if (p === '/api/audio/devices') {
      const r = await listDevices(config.ffmpegPath);
      return json(res, 200, { ...r, selected: config.audioDevice || null });
    }

    if (p === '/api/status') {
      return json(res, 200, {
        linked: spotify.linked,
        clientId: config.clientId ? config.clientId.slice(0, 6) + '...' : null,
        redirectUri: spotify.redirectUri(),
        spDc: config.spDc ? 'set' : 'not set',
        canvasLastError: canvas.lastError,
        canvasCached: canvas.cache.size,
        audioDevice: config.audioDevice || null,
        audioRunning: audio.running,
        audioClients: audio.clients.size,
        audioFrames: audio.frames,
        audioPeak: Number(audio.peak.toFixed(4)),
        audioLastError: audio.lastError,
        waveBands: config.waveBands,
        bpm: Number(audio.bpm.toFixed(1)),
        bpmConfidence: Number(audio.bpmConfidence.toFixed(2)),
        gifs: gifs.list().map((g) => ({ name: g.name, duration: Number(g.duration.toFixed(3)) })),
        gifError: gifs.lastError,
        rateLimited: rateLimitedUntil > Date.now(),
        rateLimitClearsAt: rateLimitedUntil > Date.now()
          ? new Date(rateLimitedUntil).toISOString() : null,
        pollMs: config.pollMs,
        lyricsLastError: lyrics.lastError,
        localArtLastError: localArt.lastError,
        localArtCached: localArt.cache.size,
        lyricsCached: lyrics.cache.size,
        state,
      });
    }

    if (p === '/api/config' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      const prevClientId = config.clientId;
      const patch = {};
      for (const k of ['clientId', 'spDc', 'webToken', 'audioDevice', 'ffmpegPath']) {
        if (typeof body[k] === 'string') patch[k] = body[k].trim();
      }
      // Tokens are issued against a specific client ID; keeping them after a swap
      // leaves the server thinking it's linked while every refresh fails.
      if (patch.clientId && patch.clientId !== prevClientId) {
        try { fs.rmSync(path.join(__dirname, 'tokens.json'), { force: true }); } catch { /* nothing to clear */ }
        spotify.tokens = null;
        console.log('  Client ID changed - cleared stored tokens, re-link required.');
      }
      saveConfig(patch);
      if ('audioDevice' in patch) { audio.stop(); if (audio.clients.size) audio.start(); }
      canvas.token = null;
      canvas.cache.clear();
      canvas.lastError = null;
      return json(res, 200, { ok: true });
    }

    if (p === '/login') {
      if (!config.clientId) {
        return html(res, 400, page('Setup', '<h2>No Client ID yet</h2><p>Open <a href="/setup">/setup</a> first.</p>'));
      }
      res.writeHead(302, { Location: spotify.authUrl() });
      return res.end();
    }

    if (p === '/callback') {
      const err = u.searchParams.get('error');
      if (err) {
        return html(res, 400, page('Failed', '<h2>Spotify said no</h2><p><code>' + err +
          '</code></p><p><a href="/setup">Back to setup</a></p>'));
      }
      await spotify.exchange(u.searchParams.get('code'));
      return html(res, 200, page('Linked',
        '<h2>Linked</h2><p>Add this URL as an OBS Browser Source:</p><p><code>http://127.0.0.1:' +
        config.port + '/</code></p><p><a href="/">Preview the widget</a> &middot; <a href="/setup">Back to setup</a></p>'));
    }

    // Proxy album art so the browser source can read its pixels for the accent colour.
    if (p === '/api/art') {
      const src = u.searchParams.get('u') || '';
      if (!/^https:\/\/[a-z0-9.-]*scdn\.co\//i.test(src)) return send(res, 400, 'bad art url');
      const r = await fetch(src);
      if (!r.ok) return send(res, 502, 'art fetch failed');
      const buf = Buffer.from(await r.arrayBuffer());
      return send(res, 200, buf, r.headers.get('content-type') || 'image/jpeg', {
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
    }

    // Same for the Canvas video, so everything the widget loads is same-origin.
    if (p === '/api/canvas') {
      const src = u.searchParams.get('u') || '';
      if (!/^https:\/\/[a-z0-9.-]*(scdn\.co|spotifycdn\.com)\//i.test(src)) return send(res, 400, 'bad canvas url');
      const headers = {};
      if (req.headers.range) headers.Range = req.headers.range;
      const r = await fetch(src, { headers });
      const buf = Buffer.from(await r.arrayBuffer());
      const extra = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      };
      const cr = r.headers.get('content-range');
      if (cr) extra['Content-Range'] = cr;
      return send(res, r.status === 206 ? 206 : 200, buf, r.headers.get('content-type') || 'video/mp4', extra);
    }

    return serveStatic(res, p);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('');
    console.log('  Port ' + config.port + ' is already in use.');
    console.log('  The widget is probably already running - check for another window.');
    console.log('  Running two copies doubles the Spotify polling and risks a rate limit.');
    console.log('');
    process.exit(1);
  }
  console.log('  Server error: ' + e.message);
  process.exit(1);
});

server.listen(config.port, '127.0.0.1', () => {
  const base = 'http://127.0.0.1:' + config.port;
  console.log('');
  console.log('  Spotify OBS widget');
  console.log('');
  console.log('  Widget (OBS Browser Source):  ' + base + '/');
  console.log('  Setup / link account:         ' + base + '/setup');
  console.log('  Diagnostics:                  ' + base + '/api/status');
  if (!config.audioDevice) console.log('  Audio device not set - waveform will be idle. Pick one in setup.');
  console.log('');
  if (!spotify.linked) console.log('  Not linked to Spotify yet - open the setup page above.\n');
  gifs.refresh().then(() => {
    const names = gifs.list().map((g) => g.name);
    console.log(names.length
      ? '  GIFs ready: ' + names.join(', ')
      : '  No GIFs yet - drop one in public/gif/ and it converts automatically.');
    if (gifs.lastError) console.log('  GIF problem: ' + gifs.lastError);
  });
  gifs.watch();
  poll();
});
