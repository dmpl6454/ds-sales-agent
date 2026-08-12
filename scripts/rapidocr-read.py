#!/usr/bin/env python3
"""
Read the text in an image with RapidOCR, and print it in the SAME shape the Swift
Vision helper prints, so `src/detection/ocr.ts` can parse either with one parser.

WHY A SEPARATE ENGINE EXISTS AT ALL
-----------------------------------
Apple's Vision framework is the measured best reader here — on the founding frame
(`DbtNU9UzWYU`) it read `SWITCH` off the bus bumper at confidence 1.00, which tesseract
missed entirely while reading the same title card. But Vision is macOS-only, and the
detection pipeline is moving to a Linux server where it does not exist.

Tesseract was rejected on measurement, not preference: 46 of 60 frames against Vision's
58, and it misses the one token the whole feature was built to catch. RapidOCR (ONNX
Runtime, offline, no API, no key) is the candidate replacement — and it ships ONLY if it
is measured on the same frames and answers the founding question. `scripts/ocr-bakeoff.ts`
is that measurement. An unmeasured engine is worse than a known-worse one, because its
verdicts cannot be compared to anything already stored.

OUTPUT CONTRACT — ONE JSON ARRAY, exactly what the Swift helper prints
---------------------------------------------------------------------

    [{"text": "...", "confidence": 0.98, "x": 0.10, "y": 0.05, "w": 0.79, "h": 0.08}, ...]

An ARRAY, not one object per line. This was line-delimited at first, under a docblock in
`ocr.ts` claiming it matched the Swift helper — and it did not: the Swift writes
`JSONSerialization.data(withJSONObject: out)` where `out` is an array, and
`parseVisionOutput` therefore does `JSON.parse` and returns null for anything that is not
an array. Result: on the server the engine was selected, the script ran, exited 0 and
printed four correct observations, and the outcome was `failed`.

The claim was written without checking the format it claimed to match. `parseVisionOutput`
is the ONE parser for both engines — a second parser would be a second place for the
confidence floor and the width grouping to drift — so the producer is what changes.

Coordinates are NORMALISED to the image (0..1) because `describeFrameText` groups
observations by WIDTH: a title card spanning most of the frame versus a badge on a
vehicle. Pixel coordinates would make that grouping depend on the frame's resolution, and
the corpus has several.

Every failure prints a JSON object on STDERR and exits non-zero. It must never print an
empty result and exit 0: "this machine could not read the frame" and "this frame has no
text" are different facts, and collapsing them is how absence of data becomes a claim
about the post. An empty ARRAY with exit 0 is the honest way to say "read it, no text".
"""

import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: rapidocr-read.py <image-path>"}), file=sys.stderr)
        return 2

    path = sys.argv[1]

    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as exc:  # noqa: BLE001 — any import problem is the same answer to the caller
        print(json.dumps({"error": f"rapidocr is not importable: {exc}"}), file=sys.stderr)
        return 3

    try:
        from PIL import Image

        with Image.open(path) as im:
            width, height = im.size
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"cannot open image: {exc}"}), file=sys.stderr)
        return 4

    if not width or not height:
        print(json.dumps({"error": "image has no dimensions"}), file=sys.stderr)
        return 4

    try:
        engine = RapidOCR()
        result, _elapsed = engine(path)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"ocr failed: {exc}"}), file=sys.stderr)
        return 5

    observations = []

    # A genuinely textless frame returns None or an empty list. That is a SUCCESSFUL read
    # of a frame with no text — an empty ARRAY and exit 0 — and the caller distinguishes
    # it from the failures above by the exit code, never by the emptiness of the output.
    for item in result or []:
        # RapidOCR yields (box, text, score); box is 4 [x, y] points in pixels.
        try:
            box, text, score = item[0], item[1], item[2]
        except (IndexError, TypeError):
            continue
        if not text or not str(text).strip():
            continue

        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]

        observations.append(
            {
                "text": str(text),
                "confidence": float(score),
                "x": min(xs) / width,
                "y": min(ys) / height,
                "w": (max(xs) - min(xs)) / width,
                "h": (max(ys) - min(ys)) / height,
            }
        )

    print(json.dumps(observations))
    return 0


if __name__ == "__main__":
    sys.exit(main())
