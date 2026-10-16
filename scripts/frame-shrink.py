#!/usr/bin/env python3
"""
Shrink one cover frame so it fits the frame store: image bytes on STDIN, a JPEG on STDOUT.

    frame-shrink.py [--max-width 720] [--max-height 1280] [--quality 85] [--max-bytes N] < in > out.jpg

WHY THIS EXISTS — MEASURED IN PRODUCTION, 16 OCT 2026
-----------------------------------------------------
Instagram walled the anonymous feed, and every post now arrives through the official Graph API
(`src/detection/graphFeed.ts`, Business Discovery). Its cover frame is `thumbnail_url` for a video
and the image's own `media_url` otherwise — FULL-SIZE files, where the anonymous path picks a
~480 px thumbnail (measured mean 47.4 KB). `saveFrame` refuses anything over 512 KB, and the box's
backfill log showed it on most posts:

    frame size out of bounds — not saved  bytes=1052612 / 748357 / 591056 / 870691 / 571895

So every official-read post was judged on its caption alone, and footage text — the Thane-bus
class: `SWITCH` on a bumper, a SONY show card — was never read. This script turns such a file into
one the store accepts, instead of throwing the evidence away.

WHY 720 x 1280
--------------
At least the ~480 px the anonymous path stores, on which RapidOCR's 87.1% content recall against
Vision was MEASURED (321 frames, 8 Aug 2026) — so OCR input here is never smaller than the measured
baseline. The box is a 9:16 reel at 720 px wide. RapidOCR reports NORMALISED coordinates (0..1),
so `describeFrameText`'s width grouping — a title card across the frame versus a badge on a vehicle
— is unchanged by the resize. NOTHING HERE IS MEASURED ON A REAL GRAPH FRAME YET: neither the bytes
a shrunk frame comes to, nor OCR recall on one, nor how long this takes on the 961 MB box. The
worker logs one line per shrink with the before and after size so the first of those is measured
by running it.

Never upscales: a frame already inside the box is only re-encoded (an over-size PNG becomes a
JPEG). Area interpolation, because this only ever shrinks and area averaging is the downscale that
keeps thin strokes of text rather than aliasing them away.

QUALITY STEPS DOWN WHEN THE CAP NEEDS IT, AND STOPS AT 65 (review, 16 Oct 2026)
--------------------------------------------------------------------------------
`--max-bytes N` (the caller passes `MAX_FRAME_BYTES`, 524,288): the frame is encoded at `--quality`;
if that is over N it is re-encoded at 75, then 65, from the SAME decoded and resized pixels, and the
first that fits is written. MEASURED here, through this script under Pillow 12.3.0, on the input
tests/frame-shrink.test.ts builds (`noiseFrame`: a 1080x1920 frame of seeded uniform random noise,
`random.Random(7)`, saved at JPEG 95): fitted to 720x1280 it is 565,435 bytes at 85 (refused before
this), 431,505 at 75 and 363,082 at 65 — so even that worst case fits by the second step. (The same
noise handed over as a PNG, never JPEG-encoded, measured the same way: 616,158 / 480,468 / 397,169 —
so the first figures recorded here, 615,525 / 480,096 / 397,028, were not this input's.) It never
goes below 65, because what this frame is FOR is OCR, and how far quality can fall before RapidOCR
stops reading small text is NOT MEASURED — 65 is a floor chosen, not a threshold found. Still over N at 65: exit 6, a JSON error `still-too-large` on STDERR, nothing on
STDOUT. Without `--max-bytes` (or 0) there is no step-down, exactly as before.

DECODERS, IN ORDER
------------------
OpenCV first — RapidOCR imports it, so it is in the server's venv (`/opt/ds-ocr-venv`, with libgl1
and libglib installed for it). Pillow when cv2 is missing or cannot decode the file. Neither
available, or neither decodes it: a JSON error on STDERR and a non-zero exit.

A pixel cap is applied BEFORE a full decode on both paths (OPENCV_IO_MAX_IMAGE_PIXELS is set before
cv2 is imported; Pillow's header is read lazily). A small, highly compressed file can decode to
hundreds of megabytes, and this runs on a 961 MB box beside Postgres and the worker.

WHY 12 MEGAPIXELS (review, 16 Oct 2026; it was 25). Instagram's largest frames are ~2.6 MP (1440 x
1800) and a reel's ~2.1 MP (1080 x 1920), so 12 MP is still ~4.6x the largest real frame, while the
worst case it admits halves: decoded RGB is 3 bytes a pixel, and the Pillow path holds up to three
full-size copies at once (the decode, `exif_transpose`, `convert`) — ~108 MB at 12 MP against ~225 MB
at 25 MP, on a box with 961 MB beside Postgres and the worker. OpenCV holds one full-size copy plus
the resized one. Above the cap: refused from the header, nothing decoded, the usual JSON error.

OUTPUT CONTRACT
---------------
Exit 0 means STDOUT holds one complete JPEG and nothing else, and STDERR one JSON line saying the
quality that fitted (`{"ok": true, "quality": 75, "bytes": …}`). Every failure prints a JSON object on
STDERR, writes NOTHING to STDOUT, and exits non-zero — 2 bad arguments, 3 bad input, 4 cannot decode
(including over the pixel cap), 5 the encoder failed, 6 still over `--max-bytes` at quality 65 — partial
output with exit 0 would be saved as a frame that is not a frame. The caller (`src/detection/media.ts`) also checks the JPEG magic bytes
and the size of what comes back before writing anything, so this contract is the first of two
guards, not the only one.
"""

import io
import json
import os
import sys

MAX_INPUT_BYTES = 16 * 1024 * 1024  # the caller sends at most 8 MB; this is the second guard
MAX_PIXELS = 12_000_000  # ~36 MB a decoded copy; Instagram's largest frames are ~2.6 MP (see above)
# Re-encode qualities tried, in order, after --quality when the output is over --max-bytes. Never
# below the last: OCR legibility under heavier compression is not measured. Mirrored by
# SHRUNK_FRAME_QUALITY_STEPS in src/detection/media.ts (the sips path).
STEP_DOWN_QUALITIES = (75, 65)
EXIT_STILL_TOO_LARGE = 6


def fail(code: int, message: str) -> int:
    print(json.dumps({"error": message}), file=sys.stderr)
    return code


def parse_args(argv):
    opts = {"max-width": 720, "max-height": 1280, "quality": 85, "max-bytes": 0}
    i = 0
    while i < len(argv):
        name = argv[i][2:] if argv[i].startswith("--") else None
        if name not in opts or i + 1 >= len(argv):
            raise ValueError(f"unknown or incomplete argument: {argv[i]}")
        value = int(argv[i + 1])
        # --max-bytes 0 means "no size target"; every other option must be positive.
        if value < 0 or (value == 0 and name != "max-bytes") or (name == "quality" and value > 100):
            raise ValueError(f"--{name} out of range: {value}")
        opts[name] = value
        i += 2
    return opts["max-width"], opts["max-height"], opts["quality"], opts["max-bytes"]


def qualities(requested: int, max_bytes: int):
    """The qualities to try, in order: the one asked for, then each step below it, never under the floor."""
    if max_bytes <= 0:
        return [requested]
    return [requested] + [q for q in STEP_DOWN_QUALITIES if q < requested]


def fit(width: int, height: int, max_w: int, max_h: int):
    """The size inside the box, keeping aspect ratio. Never larger than the input."""
    scale = min(max_w / width, max_h / height, 1.0)
    if scale >= 1.0:
        return width, height
    return (
        min(max_w, max(1, round(width * scale))),
        min(max_h, max(1, round(height * scale))),
    )


def with_cv2(data: bytes, max_w: int, max_h: int):
    """
    An encoder (quality -> JPEG bytes or None) over the decoded, resized frame via OpenCV, or None when
    cv2 is missing or cannot decode this file. The pixels are decoded and resized ONCE; a step down
    in quality re-encodes them, never re-decodes.
    """
    os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", str(MAX_PIXELS))
    try:
        import cv2  # noqa: PLC0415 — imported here so a missing cv2 falls through to Pillow
        import numpy as np  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return None
    try:
        img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    except Exception:  # noqa: BLE001 — over the pixel cap raises cv2.error
        return None
    if img is None or img.size == 0:
        return None
    height, width = img.shape[:2]
    if width * height > MAX_PIXELS:
        return None
    new_w, new_h = fit(width, height, max_w, max_h)
    if (new_w, new_h) != (width, height):
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)

    def encode(quality: int):
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        return buf.tobytes() if ok else None

    return encode


def with_pillow(data: bytes, max_w: int, max_h: int):
    """An encoder (quality -> JPEG bytes) over the decoded, resized frame via Pillow, or a string saying why not."""
    try:
        import warnings  # noqa: PLC0415
        from PIL import Image, ImageOps  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return "Pillow is not importable"
    try:
        Image.MAX_IMAGE_PIXELS = MAX_PIXELS
        # Pillow WARNS (on stderr) between the cap and twice it; the explicit check below refuses
        # instead, so stderr stays the one JSON object the contract promises.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            im = Image.open(io.BytesIO(data))
        with im:
            width, height = im.size  # header only; nothing is decoded yet
            if not width or not height:
                return "the image has no dimensions"
            if width * height > MAX_PIXELS:
                return f"the image is {width}x{height}, over the {MAX_PIXELS}-pixel cap"
            im = ImageOps.exif_transpose(im)
            im = im.convert("RGB")
            new_w, new_h = fit(im.width, im.height, max_w, max_h)
            if (new_w, new_h) != (im.width, im.height):
                box = getattr(Image, "Resampling", Image).BOX
                im = im.resize((new_w, new_h), box)
            # Force the decode now, so a truncated file fails HERE, as a decode failure.
            im.load()
    except Exception as exc:  # noqa: BLE001
        return f"Pillow could not decode it: {exc}"

    def encode(quality: int):
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=quality)
        return out.getvalue()

    return encode


def main() -> int:
    try:
        max_w, max_h, quality, max_bytes = parse_args(sys.argv[1:])
    except ValueError as exc:
        return fail(2, str(exc))

    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if not data:
        return fail(3, "no input on stdin")
    if len(data) > MAX_INPUT_BYTES:
        return fail(3, f"input over {MAX_INPUT_BYTES} bytes")

    encode = with_cv2(data, max_w, max_h)
    if encode is None:
        encode = with_pillow(data, max_w, max_h)
    if isinstance(encode, str):
        return fail(4, f"cannot decode the image (OpenCV missing or refused it; {encode})")

    out = None
    used = quality
    tried = []
    for q in qualities(quality, max_bytes):
        try:
            out = encode(q)
        except Exception as exc:  # noqa: BLE001
            return fail(5, f"the encoder failed at quality {q}: {exc}")
        if not out:
            return fail(5, f"the encoder produced nothing at quality {q}")
        tried.append([q, len(out)])
        used = q
        if max_bytes <= 0 or len(out) <= max_bytes:
            break
    else:
        # Every step tried and still over: refuse, and write NOTHING to stdout.
        print(json.dumps({"error": "still-too-large", "maxBytes": max_bytes, "tried": tried}), file=sys.stderr)
        return EXIT_STILL_TOO_LARGE

    # The quality that fitted, for the caller's log line (media.ts `qualityReported`) — on STDERR,
    # because STDOUT is the JPEG and nothing else. Informational; the caller never relies on it.
    print(json.dumps({"ok": True, "quality": used, "bytes": len(out)}), file=sys.stderr)
    # One complete write, only now: nothing reached stdout on any failure above.
    sys.stdout.buffer.write(out)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
