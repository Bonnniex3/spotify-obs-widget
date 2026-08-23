'use strict';
// Animated image -> looping video.
//
// Browsers give you no control at all over GIF/WebP playback speed: <img src="x.gif">
// has no rate API and never will. A <video> has playbackRate. So anything dropped in
// public/gif/ is transcoded once and the widget plays the result, which it can then
// speed up or slow down to the beat.
//
// Two decode paths, because ffmpeg alone isn't enough:
//
//   * ffmpeg handles GIF fine.
//   * ffmpeg CANNOT decode animated WebP - its webp decoder only does still images,
//     and an animated one is a RIFF container of partial frames with per-frame
//     offsets, alpha and blend/dispose flags. It fails with "image data not found".
//     Pillow composites those correctly, so when it's available we let Python emit
//     finished RGBA frames and hand those to ffmpeg instead.
//
// Output is VP9/WebM when the source has transparency (h264 can't carry alpha) and
// h264/mp4 otherwise. Conversions are cached and only redone when the source changes.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const GIF_DIR = path.join(__dirname, '..', 'public', 'gif');
const CACHE_DIR = path.join(GIF_DIR, '.converted');
const FRAMES_SCRIPT = path.join(__dirname, '..', 'tools', 'anim_frames.py');
const SOURCE_RE = /\.(gif|webp|apng|png)$/i;
const VIDEO_RE = /\.(mp4|webm)$/i;

function run(bin, args, opts) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(bin, args, Object.assign({ windowsHide: true }, opts || {}));
    } catch (e) {
      return resolve({ code: -1, out: e.message });
    }
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { out += b.toString(); });
    p.on('error', (e) => resolve({ code: -1, out: e.message }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

class GifLibrary {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.items = new Map();
    this.lastError = null;
    this.converting = false;
    this.pythonBin = null;      // resolved lazily, null = not checked, '' = unavailable
  }

  ffmpeg() { return this.getConfig().ffmpegPath || 'ffmpeg'; }
  ffprobe() {
    const f = this.getConfig().ffmpegPath;
    return f ? f.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : 'ffprobe';
  }

  list() { return [...this.items.values()]; }

  get(name) {
    if (name && this.items.has(name)) return this.items.get(name);
    return this.items.values().next().value || null;
  }

  async duration(file) {
    const r = await run(this.ffprobe(), [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ]);
    const d = parseFloat(r.out);
    return isFinite(d) && d > 0 ? d : 0;
  }

  // Find a python that can import Pillow. Cached after the first look.
  async python() {
    if (this.pythonBin !== null) return this.pythonBin;
    const configured = this.getConfig().pythonPath;
    for (const bin of [configured, 'python', 'python3', 'py'].filter(Boolean)) {
      const r = await run(bin, ['-c', 'import PIL; print(1)']);
      if (r.code === 0 && r.out.trim() === '1') {
        this.pythonBin = bin;
        return bin;
      }
    }
    this.pythonBin = '';
    return '';
  }

  // Pillow decodes and composites; ffmpeg encodes the resulting frame sequence.
  async convertViaFrames(src, name) {
    const py = await this.python();
    if (!py) return { error: 'Pillow not available' };

    const workDir = path.join(CACHE_DIR, '.frames-' + name);
    const r = await run(py, [FRAMES_SCRIPT, src, workDir]);
    let meta;
    try {
      meta = JSON.parse(r.out.trim().split(/\r?\n/).pop());
    } catch {
      return { error: 'frame extraction failed: ' + r.out.trim().slice(0, 160) };
    }
    if (meta.error) return { error: meta.error };

    // h264 has no alpha channel, so anything transparent has to go out as VP9.
    const ext = meta.alpha ? 'webm' : 'mp4';
    const out = path.join(CACHE_DIR, name + '.' + ext);
    const enc = meta.alpha
      ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32',
         '-deadline', 'good', '-cpu-used', '4']
      : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart'];

    const enc_r = await run(this.ffmpeg(), [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', path.join(workDir, 'frames.txt'),
      // Even dimensions or both encoders refuse.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ...enc, '-an', out,
    ]);

    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* leftovers are harmless */ }
    if (enc_r.code !== 0) return { error: 'encode failed: ' + enc_r.out.trim().slice(0, 160) };

    return { file: out, ext, alpha: !!meta.alpha, frames: meta.frames };
  }

  // Straight ffmpeg. Fine for GIF, useless for animated WebP.
  async convertViaFfmpeg(src, name) {
    const out = path.join(CACHE_DIR, name + '.mp4');
    const r = await run(this.ffmpeg(), [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', src,
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-an', out,
    ]);
    if (r.code !== 0) return { error: r.out.trim().slice(0, 160) };
    return { file: out, ext: 'mp4', alpha: false };
  }

  async refresh() {
    if (this.converting) return;
    this.converting = true;
    const problems = [];
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      let files = [];
      try {
        files = fs.readdirSync(GIF_DIR).filter((f) => SOURCE_RE.test(f) || VIDEO_RE.test(f));
      } catch { files = []; }

      const seen = new Set();
      for (const file of files) {
        const name = file.replace(/\.[^.]+$/, '');
        const src = path.join(GIF_DIR, file);
        seen.add(name);

        // Already a video - nothing to do.
        if (VIDEO_RE.test(file)) {
          this.items.set(name, {
            name, url: '/gif/' + encodeURIComponent(file),
            duration: await this.duration(src),
            source: file, alpha: /\.webm$/i.test(file), converted: false,
          });
          continue;
        }

        const srcStat = fs.statSync(src);
        const existing = ['webm', 'mp4']
          .map((e) => path.join(CACHE_DIR, name + '.' + e))
          .find((f) => { try { return fs.statSync(f).mtimeMs >= srcStat.mtimeMs; } catch { return false; } });

        let outFile = existing;
        let ext = existing ? path.extname(existing).slice(1) : null;
        let alpha = ext === 'webm';

        if (!outFile) {
          // Pillow first: it handles animated WebP and reports alpha honestly.
          let res = await this.convertViaFrames(src, name);
          if (res.error) {
            const viaPillow = res.error;
            res = await this.convertViaFfmpeg(src, name);
            if (res.error) {
              problems.push(file + ': ' + (/\.webp$/i.test(file)
                ? 'animated WebP needs Pillow (pip install pillow); ffmpeg cannot decode it. ' + viaPillow
                : res.error));
              continue;
            }
          }
          outFile = res.file; ext = res.ext; alpha = res.alpha;
          // Drop a stale sibling in the other container.
          const other = path.join(CACHE_DIR, name + '.' + (ext === 'webm' ? 'mp4' : 'webm'));
          try { fs.rmSync(other, { force: true }); } catch { /* nothing there */ }
        }

        this.items.set(name, {
          name,
          url: '/gif/.converted/' + encodeURIComponent(name + '.' + ext),
          duration: await this.duration(outFile),
          source: file,
          alpha,
          converted: true,
        });
      }

      for (const key of [...this.items.keys()]) if (!seen.has(key)) this.items.delete(key);
      this.lastError = problems.length ? problems.join(' | ') : null;
    } catch (e) {
      this.lastError = e.message;
    } finally {
      this.converting = false;
    }
  }

  watch() {
    try {
      fs.mkdirSync(GIF_DIR, { recursive: true });
      let timer = null;
      fs.watch(GIF_DIR, () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.refresh(), 700);   // settle after the copy finishes
      });
    } catch { /* watching is a convenience; refresh() still runs at startup */ }
  }
}

module.exports = { GifLibrary, GIF_DIR };
