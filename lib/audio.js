'use strict';
// Real-time audio analysis.
//
// Spotify exposes no audio data (audio-analysis returns 403 for apps created after
// Nov 2024), so the only way to get a genuine waveform is to listen to what's actually
// playing. ffmpeg captures a Windows DirectShow audio device, we FFT the PCM here, and
// the widget receives band levels over SSE.
//
// Analysis lives here rather than in the browser because OBS browser sources are
// unreliable about getUserMedia permissions - this way the page just reads numbers.

const { spawn } = require('child_process');

const SAMPLE_RATE = 44100;
const FFT_SIZE = 2048;      // ~21ms window
const HOP = 1024;           // ~43 frames/sec
// Tuned for hard dance (hardstyle / techno / hardtekk): a narrow window between
// floor and ceiling makes bars swing the full height on kicks instead of hovering
// mid-way, and the gamma curve lifts quieter detail so it stays lively between hits.
// Beat tracking runs off its own envelope, sampled far finer than the FFT hop so
// a beat period lands on a precise number of frames.
const ENV_HOP = 512;                 // ~86 envelope samples/sec at 44.1k
const ENV_SECONDS = 8;
const BPM_MIN = 80, BPM_MAX = 200;

const DB_FLOOR = -66;
const DB_CEIL = -21;
const GAMMA = 0.62;

// ---- FFT (iterative radix-2 Cooley-Tukey, in-place) ----
function makeFFT(n) {
  const levels = Math.log2(n) | 0;
  if (2 ** levels !== n) throw new Error('FFT size must be a power of 2');
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      let j = 0;
      for (let b = 0; b < levels; b++) j = (j << 1) | ((i >>> b) & 1);
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

class AudioAnalyser {
  constructor(getConfig, bands = 28) {
    this.getConfig = getConfig;
    this.bands = bands;
    this.clients = new Set();
    this.proc = null;
    this.lastError = null;
    this.frames = 0;
    this.peak = 0;

    this.fft = makeFFT(FFT_SIZE);
    this.re = new Float32Array(FFT_SIZE);
    this.im = new Float32Array(FFT_SIZE);
    this.ring = new Float32Array(FFT_SIZE);
    this.ringFill = 0;
    this.levels = new Float32Array(bands);

    // ---- beat tracking state ----
    this.envLen = Math.round((SAMPLE_RATE / ENV_HOP) * ENV_SECONDS);
    this.env = new Float32Array(this.envLen);   // circular
    this.envAt = 0;
    this.envFilled = 0;
    this.lp = 0;                                 // one-pole lowpass, isolates the kick
    this.lpA = Math.exp(-2 * Math.PI * 150 / SAMPLE_RATE);
    this.envAcc = 0;
    this.envCnt = 0;
    this.bpm = 0;
    this.bpmConfidence = 0;
    this.lastBpmAt = 0;

    // Hann window, precomputed.
    this.win = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      this.win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
    }

    // Log-spaced band edges: linear bins waste most bars on the top octaves,
    // where music has almost nothing going on.
    // Start low: hardstyle kicks live around 40-60Hz and that punch is the point.
    const fMin = 30, fMax = 15000;
    const hzPerBin = SAMPLE_RATE / FFT_SIZE;
    this.edges = [];
    for (let i = 0; i <= bands; i++) {
      const f = fMin * Math.pow(fMax / fMin, i / bands);
      this.edges.push(Math.max(1, Math.min(FFT_SIZE / 2 - 1, Math.round(f / hzPerBin))));
    }
  }

  get running() { return !!this.proc; }

  addClient(res) {
    this.clients.add(res);
    this.start();
    res.on('close', () => {
      this.clients.delete(res);
      // Nothing listening - don't keep a capture process burning CPU.
      if (!this.clients.size) this.stop();
    });
  }

  start() {
    if (this.proc) return;
    const device = this.getConfig().audioDevice;
    if (!device) { this.lastError = 'no audioDevice configured'; return; }

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'dshow',
      '-audio_buffer_size', '30',
      '-i', 'audio=' + device,
      '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-f', 's16le', '-acodec', 'pcm_s16le', '-',
    ];

    try {
      this.proc = spawn(this.getConfig().ffmpegPath || 'ffmpeg', args, { windowsHide: true });
    } catch (e) {
      this.lastError = 'could not start ffmpeg: ' + e.message;
      this.proc = null;
      return;
    }

    this.lastError = null;
    this.frames = 0;
    this.envFilled = 0;
    this.bpm = 0;
    this.bpmConfidence = 0;
    this.proc.stdout.on('data', (buf) => this.onPcm(buf));
    this.proc.stderr.on('data', (b) => { this.lastError = b.toString().trim().slice(0, 300); });
    this.proc.on('error', (e) => { this.lastError = e.message; this.proc = null; });
    this.proc.on('close', (code) => {
      this.proc = null;
      if (code && !this.lastError) this.lastError = 'ffmpeg exited with code ' + code;
      // Device hiccup (sleep, unplug) - retry while anyone is still listening.
      if (this.clients.size) setTimeout(() => this.start(), 1500);
    });
  }

  stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try { p.kill(); } catch { /* already gone */ }
  }

  onPcm(buf) {
    // s16le mono -> float, fed through a ring buffer so FFT windows overlap.
    const count = buf.length >> 1;
    for (let i = 0; i < count; i++) {
      const sample = buf.readInt16LE(i * 2) / 32768;

      // Beat envelope: lowpass to the kick band, then RMS per ENV_HOP.
      this.lp = (1 - this.lpA) * sample + this.lpA * this.lp;
      this.envAcc += this.lp * this.lp;
      if (++this.envCnt === ENV_HOP) {
        this.env[this.envAt] = Math.sqrt(this.envAcc / ENV_HOP);
        this.envAt = (this.envAt + 1) % this.envLen;
        if (this.envFilled < this.envLen) this.envFilled++;
        this.envAcc = 0; this.envCnt = 0;
        const now = Date.now();
        if (this.envFilled === this.envLen && now - this.lastBpmAt > 1000) {
          this.lastBpmAt = now;
          this.estimateBpm();
        }
      }

      this.ring[this.ringFill++] = sample;
      if (this.ringFill === FFT_SIZE) {
        this.analyse();
        // Slide by HOP, keeping the tail for the next window.
        this.ring.copyWithin(0, HOP);
        this.ringFill = FFT_SIZE - HOP;
      }
    }
  }

  // Autocorrelate the onset envelope. Correlating at 1x/2x/3x/4x the beat period
  // is what stops it settling on half or double tempo.
  estimateBpm() {
    const N = this.envLen;
    const flux = new Float32Array(N - 1);
    let mean = 0;
    for (let i = 1; i < N; i++) {
      const a = this.env[(this.envAt + i) % N];
      const b = this.env[(this.envAt + i - 1) % N];
      const d = a - b;
      flux[i - 1] = d > 0 ? d : 0;      // onsets only
      mean += flux[i - 1];
    }
    mean /= flux.length;
    for (let i = 0; i < flux.length; i++) flux[i] -= mean;

    const fps = SAMPLE_RATE / ENV_HOP;
    let best = 0, bestScore = 0;
    const scores = [];

    for (let bpm = BPM_MIN; bpm <= BPM_MAX; bpm += 0.5) {
      const lag = (fps * 60) / bpm;
      let score = 0;
      for (let mult = 1; mult <= 4; mult++) {
        const L = lag * mult;
        const il = L | 0;
        const fr = L - il;
        if (il + 1 >= flux.length) break;
        let sum = 0;
        const lim = flux.length - il - 1;
        for (let i = 0; i < lim; i++) {
          sum += flux[i] * (flux[i + il] * (1 - fr) + flux[i + il + 1] * fr);
        }
        score += sum / lim;
      }
      scores.push(score);
      if (score > bestScore) { bestScore = score; best = bpm; }
    }

    // Compare the winner against the MEDIAN candidate, not the mean: tempo
    // harmonics all score highly and drag a mean upward, which made a clean
    // lock look uncertain.
    const sorted = scores.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] || 0;
    const conf = bestScore > 0 && median > 0
      ? Math.min(1, (bestScore / median - 1) / 6)
      : (bestScore > 0 ? 1 : 0);

    if (bestScore <= 0) { this.bpmConfidence = 0; return; }
    this.bpmConfidence = conf;
    // Ease toward the new reading unless it's a big jump (track change).
    this.bpm = !this.bpm || Math.abs(best - this.bpm) > 12 ? best : this.bpm * 0.6 + best * 0.4;
  }

  analyse() {
    const { re, im, win } = this;
    let peak = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = this.ring[i];
      if (s > peak) peak = s; else if (-s > peak) peak = -s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    this.peak = peak;
    this.fft(re, im);

    const out = this.levels;
    const gainDb = Number(this.getConfig().waveGainDb) || 0;
    const release = Number(this.getConfig().waveRelease) || 0;
    for (let b = 0; b < this.bands; b++) {
      const lo = this.edges[b];
      const hi = Math.max(lo + 1, this.edges[b + 1]);
      let sum = 0;
      for (let k = lo; k < hi; k++) sum += re[k] * re[k] + im[k] * im[k];
      const mag = Math.sqrt(sum / (hi - lo)) / (FFT_SIZE / 4);
      const db = 20 * Math.log10(mag + 1e-9) + gainDb;
      // Tilt the top end up: high frequencies carry far less energy, and without
      // this the right-hand bars sit flat no matter what's playing.
      const tilt = (b / this.bands) * 14;
      let v = (db + tilt - DB_FLOOR) / (DB_CEIL - DB_FLOOR);
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      v = Math.pow(v, GAMMA);
      // Release defaults to 0 = raw per-frame values, nothing carried over. Raise
      // waveRelease (0-0.9) in config.json to put decay tails back on.
      out[b] = v > out[b] || !release ? v : out[b] * release + v * (1 - release);
    }

    this.frames++;
    this.broadcast(out);
  }

  broadcast(levels) {
    if (!this.clients.size) return;
    // Two hex chars per band keeps each frame tiny at ~43fps.
    let s = '';
    for (let i = 0; i < levels.length; i++) {
      s += Math.round(levels[i] * 255).toString(16).padStart(2, '0');
    }
    // levels | bpm | confidence
    const payload = 'data:' + s + '|' + this.bpm.toFixed(1) + '|' +
      this.bpmConfidence.toFixed(2) + '\n\n';
    for (const res of this.clients) {
      try { res.write(payload); } catch { this.clients.delete(res); }
    }
  }
}

// Parse `ffmpeg -list_devices` output into the audio device names.
function listDevices(ffmpegPath) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath || 'ffmpeg',
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { windowsHide: true });
    let err = '';
    p.stderr.on('data', (b) => { err += b.toString(); });
    p.on('error', () => resolve({ devices: [], error: 'ffmpeg not found on PATH' }));
    p.on('close', () => {
      const devices = [];
      for (const line of err.split(/\r?\n/)) {
        const m = line.match(/"([^"]+)"\s+\(audio\)/);
        if (m) devices.push(m[1]);
      }
      resolve({ devices, error: devices.length ? null : 'no audio devices found' });
    });
  });
}

module.exports = { AudioAnalyser, listDevices, SAMPLE_RATE, FFT_SIZE };
