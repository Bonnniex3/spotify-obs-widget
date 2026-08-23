"""Decode an animated image into composited PNG frames plus an ffmpeg concat list.

ffmpeg's WebP decoder only handles still images - an animated WebP is a RIFF
container of partial frames with per-frame offsets, alpha, and blend/dispose
flags, and feeding one to ffmpeg gives "image data not found". Pillow does that
compositing properly, so we let it produce finished RGBA frames and hand those
to ffmpeg instead.

Usage:  python anim_frames.py <input> <outdir>
Prints one line of JSON: {"frames": n, "duration": seconds, "alpha": bool,
                          "width": w, "height": h, "list": "<concat file>"}
"""

import json
import os
import struct
import sys


def anmf_durations(path):
    """Per-frame durations straight from the WebP ANMF chunks, in ms.

    Pillow doesn't reliably surface WebP frame durations, and guessing a
    constant frame rate visibly wrecks anything with held frames.
    """
    try:
        data = open(path, 'rb').read()
    except OSError:
        return []
    if data[:4] != b'RIFF' or data[8:12] != b'WEBP':
        return []
    out, i = [], 12
    while i + 8 <= len(data):
        tag = data[i:i + 4]
        size = struct.unpack('<I', data[i + 4:i + 8])[0]
        if tag == b'ANMF':
            b = data[i + 8:i + 8 + size]
            if len(b) >= 15:
                out.append(b[12] | (b[13] << 8) | (b[14] << 16))
        i += 8 + size + (size & 1)
    return out


def main():
    if len(sys.argv) < 3:
        print(json.dumps({'error': 'usage: anim_frames.py <input> <outdir>'}))
        return 1

    src, outdir = sys.argv[1], sys.argv[2]
    try:
        from PIL import Image
    except ImportError:
        print(json.dumps({'error': 'Pillow is not installed'}))
        return 1

    os.makedirs(outdir, exist_ok=True)
    for stale in os.listdir(outdir):
        if stale.endswith('.png') or stale == 'frames.txt':
            try:
                os.remove(os.path.join(outdir, stale))
            except OSError:
                pass

    try:
        im = Image.open(src)
    except Exception as exc:                                  # noqa: BLE001
        print(json.dumps({'error': 'cannot open: %s' % exc}))
        return 1

    count = getattr(im, 'n_frames', 1)
    riff = anmf_durations(src)
    width, height = im.size
    has_alpha = False
    durations = []

    for i in range(count):
        im.seek(i)
        frame = im.convert('RGBA')
        if not has_alpha:
            alpha = frame.getchannel('A')
            if alpha.getextrema()[0] < 255:
                has_alpha = True
        frame.save(os.path.join(outdir, 'f%05d.png' % i))

        ms = riff[i] if i < len(riff) else im.info.get('duration', 0)
        # Browsers clamp absurdly short frames; 10ms matches what they'd show.
        durations.append(max(10, int(ms) or 100))

    # concat demuxer: every file needs a duration, and the last one is repeated
    # or ffmpeg drops the final frame's on-screen time entirely.
    lines = []
    for i, ms in enumerate(durations):
        lines.append("file 'f%05d.png'" % i)
        lines.append('duration %.4f' % (ms / 1000.0))
    if durations:
        lines.append("file 'f%05d.png'" % (len(durations) - 1))

    list_path = os.path.join(outdir, 'frames.txt')
    with open(list_path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines) + '\n')

    print(json.dumps({
        'frames': count,
        'duration': sum(durations) / 1000.0,
        'alpha': has_alpha,
        'width': width,
        'height': height,
        'list': list_path,
    }))
    return 0


if __name__ == '__main__':
    sys.exit(main())
