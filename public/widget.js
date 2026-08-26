/* Spotify OBS widget - browser source client.
   Polls the local server, interpolates the progress bar locally so it moves at 60fps
   instead of stepping once per poll, and drives the rotated Canvas background. */

(() => {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const opt = (k, d) => (qs.has(k) ? qs.get(k) : d);
  const num = (k, d) => (qs.has(k) ? Number(qs.get(k)) : d);
  const flag = (k, d) => (qs.has(k) ? !/^(0|false|no|off)$/i.test(qs.get(k)) : d);

  const el = {
    stage: document.getElementById('stage'),
    video: document.getElementById('video'),
    bgArt: document.getElementById('bgArt'),
    cover: document.getElementById('cover'),
    title: document.getElementById('title'),
    artist: document.getElementById('artist'),
    fill: document.getElementById('fill'),
    waveBase: document.getElementById('waveBase'),
    lyric: document.getElementById('lyric'),
    gif: document.getElementById('gif'),
    elapsed: document.getElementById('elapsed'),
    duration: document.getElementById('duration'),
  };

  // ---- options ----
  const wantCanvas = flag('canvas', true);
  const showWhenIdle = flag('idle', false);
  const hideWhenPaused = flag('hidepaused', false);
  const accentMode = opt('accent', 'auto');
  const rotate = num('rotate', 90);
  const wantWave = flag('wave', true);
  const wantLyrics = flag('lyrics', true);
  // Nudge lines early/late if they consistently land off against your setup.
  const lyricOffsetMs = num('lyricoffset', 0);
  // 0 = raw, straight from the analyser. Higher values ease between frames.
  // 0.3 takes the hard edge off without smearing the kick.
  const waveSmooth = Math.max(0, Math.min(0.95, num('smooth', 0.3)));

  el.stage.dataset.layout = opt('layout', 'bar');
  el.stage.dataset.wave = wantWave ? '1' : '0';

  // Sizing goes inline on the stage so it always beats the stylesheet defaults.
  const sty = el.stage.style;
  const setPx = (name, key) => { if (qs.has(key)) sty.setProperty(name, num(key) + 'px'); };
  setPx('--w', 'w');
  setPx('--radius', 'radius');
  setPx('--cover', 'cover');
  setPx('--gap', 'gap');
  setPx('--pad', 'pad');
  setPx('--split', 'split');
  setPx('--coverradius', 'coverradius');
  el.stage.dataset.divider = flag('divider', true) ? '1' : '0';
  setPx('--bg-blur', 'blur');
  setPx('--wave', 'waveheight');
  if (qs.has('waveopacity')) sty.setProperty('--wave-alpha', String(num('waveopacity')));
  if (qs.has('wavesat')) sty.setProperty('--wave-sat', String(num('wavesat')));
  setPx('--gif', 'gifsize');
  setPx('--gifradius', 'gifradius');
  if (qs.has('scrim')) sty.setProperty('--scrim', String(num('scrim')));
  sty.setProperty('--rotate', rotate + 'deg');
  if (qs.has('font')) sty.setProperty('--font', qs.get('font') + ', system-ui, sans-serif');
  if (accentMode !== 'auto') sty.setProperty('--accent', accentMode);

  // Auto accent is written to :root so an explicit ?accent= on the stage still wins.
  const root = document.documentElement.style;

  // ---- rotated video box ----
  // A quarter turn swaps the element's visual axes, so the <video> box has to be
  // sized with width/height swapped for it to land on the stage's footprint.
  // The stage height is content-driven, so measure rather than guess.
  const quarterTurn = Math.abs(rotate % 180) === 90;

  function setVideoBox() {
    // offsetWidth/Height, not getBoundingClientRect: the card carries an entrance
    // transform, and a scaled measurement would leave the video short of the edges.
    const sw = el.stage.offsetWidth;
    const sh = el.stage.offsetHeight;
    if (!sw || !sh) return;
    // 2px of bleed hides the hairline that rounding can leave at the edges.
    const w = (quarterTurn ? sh : sw) + 2;
    const h = (quarterTurn ? sw : sh) + 2;
    sty.setProperty('--video-w', w + 'px');
    sty.setProperty('--video-h', h + 'px');
  }
  new ResizeObserver(setVideoBox).observe(el.stage);
  setVideoBox();

  // ---- helpers ----
  const fmt = (ms) => {
    if (!isFinite(ms) || ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const mm = h ? String(m % 60).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s % 60).padStart(2, '0');
  };

  // Marquee only when the text genuinely doesn't fit. Re-checked on every resize
  // because fonts and layout settle a frame or two after the text is set.
  function measure(node) {
    const overflow = Math.max(node.scrollWidth, node.offsetWidth) - node.parentElement.clientWidth;
    node.parentElement.classList.toggle('fading', overflow > 4);
    if (overflow > 4) {
      node.style.setProperty('--shift', -(overflow + 10) + 'px');
      node.style.setProperty('--dur', Math.max(6, (overflow + 10) / 26) + 's');
      node.classList.add('marquee');
    } else {
      node.classList.remove('marquee');
      node.style.removeProperty('--shift');
    }
  }

  function setScroller(node, text) {
    const span = node.firstElementChild;
    if (span.textContent === text) return;
    span.textContent = text;
    node.classList.remove('marquee');
    node.parentElement.classList.remove('fading');
    node.style.removeProperty('--shift');
    requestAnimationFrame(() => measure(node));
  }

  for (const node of [el.title, el.artist]) {
    new ResizeObserver(() => measure(node)).observe(node.parentElement);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { measure(el.title); measure(el.artist); });
  }

  // ---- accent colour from the album art ----
  const accentCache = new Map();

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }

  const hslToCss = (h, s, l) =>
    'hsl(' + Math.round(h * 360) + ' ' + Math.round(s * 100) + '% ' + Math.round(l * 100) + '%)';

  function extractAccent(artUrl) {
    if (accentMode !== 'auto' || !artUrl) return;
    if (accentCache.has(artUrl)) { root.setProperty('--accent', accentCache.get(artUrl)); return; }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const N = 32;
        const c = document.createElement('canvas');
        c.width = c.height = N;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, N, N);
        const px = ctx.getImageData(0, 0, N, N).data;

        // Coarse RGB buckets, weighted towards saturated mid-tones so the accent
        // is a colour someone would actually name, not the muddy average.
        const bins = new Map();
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i], g = px[i + 1], b = px[i + 2];
          const [, s, l] = rgbToHsl(r, g, b);
          if (l < 0.12 || l > 0.94) continue;
          const weight = 1 + s * s * 6 * (1 - Math.abs(l - 0.5) * 1.2);
          const key = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
          const bin = bins.get(key) || { r: 0, g: 0, b: 0, w: 0 };
          bin.r += r * weight; bin.g += g * weight; bin.b += b * weight; bin.w += weight;
          bins.set(key, bin);
        }

        let best = null;
        for (const bin of bins.values()) if (!best || bin.w > best.w) best = bin;
        if (!best) return;

        let [h, s, l] = rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
        // Force it bright and punchy enough to read over video.
        s = Math.min(1, Math.max(0.55, s * 1.25));
        l = Math.min(0.68, Math.max(0.52, l));
        const css = hslToCss(h, s, l);
        accentCache.set(artUrl, css);
        root.setProperty('--accent', css);
      } catch { /* decode failure - keep the previous accent */ }
    };
    img.src = artUrl;
  }

  // ---- artwork + Canvas ----
  let currentCanvas = null;

  function setArtwork(track) {
    // Local files carry no artwork; drop the cover tile rather than showing a gap.
    el.stage.dataset.noart = track.art ? '0' : '1';
    if (!track.art) {
      el.cover.removeAttribute('src');
      el.bgArt.style.backgroundImage = '';
      return;
    }
    const proxied = '/api/art?u=' + encodeURIComponent(track.art);
    if (el.cover.getAttribute('src') === proxied) return;
    el.cover.src = proxied;
    el.bgArt.style.backgroundImage = 'url("' + proxied + '")';
    extractAccent(proxied);
  }

  function setCanvas(track) {
    const url = wantCanvas ? track.canvas : null;
    if (url === currentCanvas) return;
    currentCanvas = url;

    if (!url) {
      el.stage.dataset.canvas = '0';
      el.video.removeAttribute('src');
      el.video.load();
      return;
    }
    // Stay hidden until the clip can actually paint, so we never flash black.
    el.stage.dataset.canvas = '0';
    el.video.src = url;
    el.video.load();
    el.video.play().catch(() => { /* muted autoplay shouldn't be blocked, but don't throw */ });
  }

  el.video.addEventListener('canplay', () => { if (currentCanvas) el.stage.dataset.canvas = '1'; });
  el.video.addEventListener('error', () => { el.stage.dataset.canvas = '0'; });

  // ---- lyrics ----
  // Timestamped lines from the server, highlighted one at a time against the same
  // interpolated clock the progress bar uses.
  let lyricLines = [];
  let lyricIndex = -1;

  async function loadLyrics() {
    lyricLines = [];
    lyricIndex = -1;
    el.lyric.textContent = '';
    el.lyric.classList.remove('on');
    el.stage.dataset.lyrics = '0';
    if (!wantLyrics) return;
    try {
      const r = await fetch('/api/lyrics', { cache: 'no-store' });
      const j = await r.json();
      // Only synced lyrics are useful line-at-a-time; unsynced is left alone.
      if (j && j.synced && Array.isArray(j.lines) && j.lines.length) {
        lyricLines = j.lines;
        el.stage.dataset.lyrics = '1';
      }
    } catch { /* no lyrics is a normal outcome, not an error state */ }
  }

  function renderLyric(posMs) {
    if (!lyricLines.length) return;
    const t = posMs + lyricOffsetMs;

    // Lines are sorted, and playback almost always moves forward by one - walk
    // from the current position instead of rescanning the whole track each frame.
    let i = lyricIndex;
    if (i >= 0 && lyricLines[i].at > t) i = -1;          // seeked backwards
    while (i + 1 < lyricLines.length && lyricLines[i + 1].at <= t) i++;
    if (i === lyricIndex) return;

    lyricIndex = i;
    const text = i >= 0 ? lyricLines[i].text : '';
    el.lyric.classList.remove('on');
    // Let the fade-out land before swapping the text.
    setTimeout(() => {
      el.lyric.textContent = text;
      if (text) el.lyric.classList.add('on');
    }, 90);
  }

  // ---- beat-locked GIF ----
  // A GIF can't be sped up in a browser at all, so the server transcodes it to a
  // video and we drive playbackRate. Rate is chosen so one loop spans a whole
  // number of beats, which is what makes it land on-beat instead of drifting.
  const wantGif = flag('gif', true);
  const gifName = opt('gifname', '');
  let gifDuration = 0;
  let gifRate = 1;

  async function loadGif() {
    if (!wantGif) return;
    try {
      const r = await fetch('/api/gif' + (gifName ? '?name=' + encodeURIComponent(gifName) : ''));
      const j = await r.json();
      if (!j.gif || !j.gif.url) { el.stage.dataset.gif = '0'; return; }
      gifDuration = j.gif.duration || 0;
      el.stage.dataset.gifalpha = j.gif.alpha ? '1' : '0';
      el.gif.src = j.gif.url;
      el.gif.play().catch(() => { /* muted autoplay, shouldn't be blocked */ });
      el.stage.dataset.gif = '1';
    } catch {
      el.stage.dataset.gif = '0';
    }
  }

  function setGifTempo(bpm, confidence) {
    if (!wantGif || !gifDuration || !el.gif.src) return;
    // Below this the autocorrelation peak isn't standing clear of the noise;
    // coasting at the last known rate beats chasing a bad reading.
    if (!bpm || confidence < 0.15) return;
    const beat = 60 / bpm;
    const beats = Math.max(1, Math.round(gifDuration / beat));
    const rate = gifDuration / (beats * beat);
    // Chromium ignores rates outside this range.
    const clamped = Math.max(0.0625, Math.min(16, rate));
    if (Math.abs(clamped - gifRate) < 0.01) return;
    gifRate = clamped;
    try { el.gif.playbackRate = clamped; } catch { /* rate refused, leave as-is */ }
  }

  el.gif.addEventListener('error', () => { el.stage.dataset.gif = '0'; });

  // Chromium suspends media whenever the page stops compositing - which is exactly
  // what happens when an OBS scene hides this source. play() on the way back is
  // silently ignored if it's already running, so a periodic nudge is safe.
  function resumeMedia() {
    for (const v of [el.video, el.gif]) {
      if (v.getAttribute('src') && v.paused) v.play().catch(() => {});
    }
  }
  document.addEventListener('visibilitychange', resumeMedia);
  setInterval(resumeMedia, 3000);

  // ---- waveform (real audio) ----
  // Levels come from the server, which FFTs the actual audio device with ffmpeg.
  // Spotify exposes no audio data, and OBS browser sources can't be relied on for
  // getUserMedia, so the analysis happens server-side and arrives here over SSE.
  let bars = [];
  let target = null;    // latest levels from the server
  let shown = null;     // smoothed values actually rendered
  let lastFrameAt = 0;

  function buildBars(count) {
    if (bars.length === count) return;
    let markup = '';
    for (let i = 0; i < count; i++) markup += '<i></i>';
    el.waveBase.innerHTML = markup;
    bars = [...el.waveBase.children];
    target = new Float32Array(count);
    shown = new Float32Array(count);
  }

  function connectAudio() {
    if (!wantWave) return;
    const es = new EventSource('/api/audio');
    es.onmessage = (ev) => {
      // levels | bpm | confidence
      const parts = ev.data.split('|');
      const hex = parts[0];
      if (parts.length > 2) setGifTempo(parseFloat(parts[1]), parseFloat(parts[2]));
      const n = hex.length >> 1;
      if (!n) return;
      buildBars(n);
      for (let i = 0; i < n; i++) {
        target[i] = parseInt(hex.substr(i * 2, 2), 16) / 255;
      }
      lastFrameAt = performance.now();
    };
    // EventSource reconnects on its own; nothing to do but note the gap.
    es.onerror = () => { lastFrameAt = 0; };
  }

  function renderWave() {
    if (!bars.length) return;
    // Silence (or a dropped feed) settles the bars instead of freezing them mid-hit.
    const stale = !lastFrameAt || performance.now() - lastFrameAt > 1500;
    for (let i = 0; i < bars.length; i++) {
      const t = stale ? 0.02 : Math.max(0.02, target[i]);
      // With smoothing at 0 the bar simply is the latest analysed value.
      shown[i] = waveSmooth ? shown[i] + (t - shown[i]) * (1 - waveSmooth) : t;
      bars[i].style.transform = 'scaleY(' + shown[i].toFixed(3) + ')';
    }
  }

  // ---- progress clock ----  // ---- progress clock ----
  const clock = { progress: 0, duration: 0, playing: false, at: performance.now() };

  function sync(progressMs, durationMs, playing) {
    clock.progress = progressMs;
    clock.duration = durationMs;
    clock.playing = playing;
    clock.at = performance.now();
  }

  function tick() {
    const raw = clock.progress + (clock.playing ? performance.now() - clock.at : 0);
    const pos = Math.min(raw, clock.duration);
    const pct = clock.duration ? (pos / clock.duration) * 100 : 0;
    el.fill.style.width = pct.toFixed(3) + '%';
    if (wantWave) renderWave();
    if (wantLyrics) renderLyric(pos);
    el.elapsed.textContent = fmt(pos);
    scheduleTick();
  }

  // rAF is the right clock when we're on screen, but it stops dead whenever the
  // embedder reports the page as hidden - which would freeze the timeline and the
  // visualiser. Fall back to a timer in that case.
  function scheduleTick() {
    if (document.hidden) setTimeout(tick, 33);
    else requestAnimationFrame(tick);
  }
  scheduleTick();

  // ---- poll ----
  let lastId = null;

  // The server refreshes its snapshot every pollMs, but the widget polls more
  // often than that, so the same snapshot gets read several times while our own
  // clock keeps advancing. Comparing against the raw progressMs makes a healthy
  // clock look like drift and "corrects" it backwards. Age the snapshot forward
  // to what it implies right now instead.
  function serverPosition(s) {
    if (!s.playing) return s.progressMs;
    const age = Math.min(15000, Math.max(0, Date.now() - (s.serverTime || Date.now())));
    return Math.min(s.progressMs + age, s.durationMs || Infinity);
  }

  function render(s) {
    const live = s && s.ok && s.key;

    if (!live) {
      el.stage.dataset.active = showWhenIdle ? '1' : '0';
      el.stage.dataset.playing = '0';
      clock.playing = false;
      lastId = null;
      return;
    }

    el.stage.dataset.active = (s.playing || !hideWhenPaused) ? '1' : '0';
    el.stage.dataset.playing = s.playing ? '1' : '0';

    if (s.key !== lastId) {
      lastId = s.key;
      setScroller(el.title, s.title || '');
      setScroller(el.artist, s.artist || '');
      el.duration.textContent = fmt(s.durationMs);
      setArtwork(s);
      setCanvas(s);
      loadLyrics();
      sync(serverPosition(s), s.durationMs, s.playing);
      return;
    }

    // Canvas can arrive a poll or two after the track does.
    setCanvas(s);

    // Only resync when we've actually drifted, so seeks snap but normal play stays smooth.
    const predicted = clock.progress + (clock.playing ? performance.now() - clock.at : 0);
    const actual = serverPosition(s);
    if (s.playing !== clock.playing || Math.abs(predicted - actual) > 1500) {
      sync(actual, s.durationMs, s.playing);
    }
  }

  // Demo mode: fake track so you can size and position the source in OBS
  // before linking a Spotify account. Add ?demo=1 to the URL.
  if (flag('demo', false)) {
    const DUR = 251000;
    const started = Date.now();
    setScroller(el.title, opt('title', 'Everything In Its Right Place'));
    setScroller(el.artist, opt('artist', 'Radiohead'));
    el.duration.textContent = fmt(DUR);
    el.cover.src = '/demo-art.svg';
    el.bgArt.style.backgroundImage = 'url("/demo-art.svg")';
    extractAccent('/demo-art.svg');
    el.stage.dataset.active = '1';
    el.stage.dataset.playing = '1';
    // A stand-in 9:16 clip so the rotated background is previewable too.
    setCanvas({ canvas: '/demo-canvas.mp4' });
    sync(0, DUR, true);
    setInterval(() => sync((Date.now() - started) % DUR, DUR, true), 5000);
    loadGif();
    connectAudio();
    return;
  }

  async function loop() {
    try {
      const r = await fetch('/api/now', { cache: 'no-store' });
      render(await r.json());
    } catch {
      el.stage.dataset.active = showWhenIdle ? '1' : '0';
    }
    setTimeout(loop, 1000);
  }
  loadGif();
  connectAudio();
  loop();
})();
