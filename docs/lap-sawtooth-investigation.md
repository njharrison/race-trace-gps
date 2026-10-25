# Repeated within-lap sawtooth: diagnosis and acceptance criteria

Observed live on 25 October 2026 around lap 8: nearly all drivers show the same periodic within-lap slope and abrupt lap-boundary reset. This is strong evidence of a systematic projection/reference-clock artefact, not independent driving performance.

## Current code path
- `lapProfileCache` learns 101 fractional-distance timing bins per completed lap.
- `driverProfiles` learns per-driver median fractional timing shapes.
- `profileEval(profile, fraction)` uses a smoothed cubic interpolation to construct a reference timestamp.
- `series` subtracts original GPS source timestamp from that reference, then optionally applies temporal smoothing.
- `profiledTraces` exists but the series loop uses raw `traces` unless `applyTimingCorrections` is enabled.

## Investigation before a live fix
1. For each driver, compute the plotted gap immediately before/after each integer distance crossing, using interpolation at the *same crossing*, not nearby samples.
2. Compare that with the official crossing time difference and inspect GPS distance phase offset, crossing alignment, and interpolation errors.
3. Measure the median residual as a function of fractional lap distance, across drivers and completed clean laps. A field-wide periodic residual points to a common reference/distance calibration issue; a driver-specific residual points to profile estimation.
4. Check whether the per-driver profile and the global learned reference share the same distance origin and endpoint clock. Confirm the reference time is continuous at integer lap distances and that source GPS time is continuous there.
5. Correct the source of the discontinuity, not the visible pixels; preserve actual sector pace differences and pit-loss events.

## Required tests
- Synthetic cars with identical lap pacing but constant offset must plot constant gap, including through every lap crossing.
- Synthetic cars with genuine sector pace changes must preserve those changes.
- Official crossings at integer distance must not introduce discontinuities.
- Replay pause must not alter geometry (source session timestamps only).
- Regression comparison with a full live recording and official lap timings before release.

Do not change production or assert that a speculative formula is a confirmed fix.
