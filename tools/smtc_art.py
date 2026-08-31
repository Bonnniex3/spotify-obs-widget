"""Grab the cover art Windows itself is showing for the current Spotify track.

Spotify's Web API returns no artwork for local files - `album.images` comes back
empty - but Spotify does hand a thumbnail to the Windows media session (the one
behind the volume-key overlay), taken from the file's own tags. This reads that.

Usage:  python smtc_art.py <output-file> [expected-title]
Prints one line of JSON.

The thumbnail belongs to whatever is playing *right now*, so when an expected
title is supplied we check it still matches before saving - otherwise a track
change mid-call would cache the wrong cover against the wrong song.
"""

import asyncio
import json
import sys


def out(**kw):
    sys.stdout.write(json.dumps(kw) + "\n")


async def grab(path, expected):
    try:
        from winsdk.windows.media.control import (
            GlobalSystemMediaTransportControlsSessionManager as MediaManager,
        )
        from winsdk.windows.storage.streams import Buffer, DataReader, InputStreamOptions
    except ImportError:
        return {"ok": False, "reason": "winsdk not installed (pip install winsdk)"}

    try:
        mgr = await MediaManager.request_async()
    except Exception as exc:                                   # noqa: BLE001
        return {"ok": False, "reason": "media session unavailable: %s" % exc}

    for session in mgr.get_sessions():
        app = session.source_app_user_model_id or ""
        if "spotify" not in app.lower():
            continue

        props = await session.try_get_media_properties_async()
        if props is None:
            return {"ok": False, "reason": "no media properties"}

        title = props.title or ""
        if expected and title.strip().lower() != expected.strip().lower():
            return {"ok": False, "reason": "track changed", "title": title}
        if props.thumbnail is None:
            return {"ok": False, "reason": "no thumbnail", "title": title}

        stream = await props.thumbnail.open_read_async()
        buf = Buffer(stream.size)
        await stream.read_async(buf, stream.size, InputStreamOptions.READ_AHEAD)
        data = bytes(DataReader.from_buffer(buf).read_buffer(buf.length))
        if not data:
            return {"ok": False, "reason": "empty thumbnail", "title": title}

        with open(path, "wb") as fh:
            fh.write(data)
        return {
            "ok": True,
            "title": title,
            "artist": props.artist or "",
            "bytes": len(data),
            "file": path,
        }

    return {"ok": False, "reason": "no Spotify media session"}


def main():
    # The console codepage can't encode every track title; never let that crash us.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                          # noqa: BLE001
        pass

    if len(sys.argv) < 2:
        out(ok=False, reason="usage: smtc_art.py <output-file> [expected-title]")
        return 1

    path = sys.argv[1]
    expected = sys.argv[2] if len(sys.argv) > 2 else None
    try:
        result = asyncio.run(grab(path, expected))
    except Exception as exc:                                   # noqa: BLE001
        result = {"ok": False, "reason": str(exc)}
    out(**result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
