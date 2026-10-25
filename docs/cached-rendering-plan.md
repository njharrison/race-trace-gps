# Cached rendering refactor (work branch)

Goal: preserve the existing source-timestamp geometry and move all race processing out of viewport redraws.

## Invariants
- Source F1 session timestamps only; replay wall-clock time never changes geometry.
- Completed lap 1 occupies race distance 0–1; official lap 57 finishes at distance 57.
- Historical hover position, tyre, lap and team are sourced from the recorded state at that time.
- Finish crossings, VSC/SC/pit projections, retirements, lapped projections and driver profiles must remain unchanged.

## Pipeline
1. Parse and index GPS/timing once per recording revision. Keep immutable source-time arrays.
2. Compute official alignment, lap crossings, driver pace profiles, pit stop evidence, and race distance once per revision. Cache by revision and settings that actually affect each calculation.
3. Build per-driver numeric arrays: distance, source time, base cumulative reference time and base gap. Store independent driver geometry and metadata.
4. For reference-lap adjustment `delta`, calculate gap on render as `baseGap + distance * delta` (confirm sign against existing implementation). For learned variable-pace reference, cache cumulative pace and apply its difference.
5. Render from cached numeric arrays; viewport, visibility and pit projection adjustments do not trigger race processing.
6. Append new GPS/timing samples incrementally, invalidating only affected driver segments and dependent reference curves. Keep full-rebuild fallback for seek, recording replacement, alignment changes and non-monotone timestamps.
7. Consider worker offloading only after profiling demonstrates remaining blocking work.

## Performance acceptance
- Pan/zoom never parses GPS/timing or recomputes lap crossings.
- Same chart and tooltip output as baseline for completed race, prerace, live early laps, pauses and seeking.
- Aim for smooth 60fps viewport interaction on full-race recording.
- Measure phase timings with `window.RACE_TRACE_PERF=true` in console (development branch only).

## Release gate
Do not merge into main or change the Home Assistant resource until benchmark and regression tests pass and the live race is over.
