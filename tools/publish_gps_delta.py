#!/usr/bin/env python3
"""Publish a small GPS recording delta alongside gps-recording.json.

Invoke after each recorder write (or periodically while recording).
The full GPS archive remains the source of truth and is not modified.
"""
import argparse
import json
import os
import tempfile
from pathlib import Path


def publish(source: Path, seconds: float = 90) -> Path:
    with source.open("r", encoding="utf-8") as handle:
        full = json.load(handle)
    samples = full.get("samples", [])
    if full.get("schema_version") != 1 or not isinstance(samples, list):
        raise ValueError("Expected schema_version 1 and samples array")
    if not samples:
        start = 0
    else:
        # recorded_at is the wall-clock used by the HA replay recorder.
        end = samples[-1].get("recorded_at")
        start = len(samples) - 1
        if isinstance(end, (int, float)):
            while start > 0:
                stamp = samples[start - 1].get("recorded_at")
                if not isinstance(stamp, (int, float)) or end - stamp > seconds:
                    break
                start -= 1
        else:
            start = max(0, len(samples) - 120)
    delta = {
        "schema_version": 1,
        "run": full.get("run"),
        "geometry": {"circuit_key": full.get("geometry", {}).get("circuit_key")},
        "first_recorded_at": samples[0].get("recorded_at") if samples else None,
        "sample_start": start,
        "sample_count": len(samples),
        "samples": samples[start:],
    }
    dest = source.with_name(source.stem + "-delta.json")
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8",
                                 dir=dest.parent, prefix=".gps-delta-",
                                 suffix=".json", delete=False) as temp:
        json.dump(delta, temp, separators=(",", ":"))
        temp_name = temp.name
    os.replace(temp_name, dest)
    return dest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("recording", type=Path,
                        help="Path to gps-recording.json")
    parser.add_argument("--window", type=float, default=90,
                        help="Rolling wall-clock seconds (default 90)")
    args = parser.parse_args()
    print(publish(args.recording, args.window))
