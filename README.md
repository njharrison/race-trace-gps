# Race Trace GPS

Experimental Home Assistant GPS-based F1 race trace, independently installable through HACS.

**Status:** early prototype. This now plots time gap at equal race distance, using the furthest-progressed car as a reference. It is an initial gap renderer, **not yet** the full approved Singapore visualisation. It currently downloads both full recordings every five seconds, so do not leave it running for long races until incremental loading is added. Production `custom:f1-race-trace` is unaffected.

## Fast development via GitHub Pages

The `.github/workflows/pages.yml` workflow publishes `race-trace-gps.js` on each main-branch update. Enable **Settings → Pages → Build and deployment → GitHub Actions** once. After the deployment succeeds, the development module is available at:

`https://njharrison.github.io/race-trace-gps/race-trace-gps.js`

For development, replace the HACS dashboard resource with this **JavaScript module** resource (do not load both simultaneously). Append a new `?v=<commit-sha>` after each deployment to force a fresh module request, and reload the entire dashboard tab so the browser creates the updated custom element. GitHub Pages deployments may take a short while. Keep HACS installed for stable releases but do not simultaneously register the HACS and Pages resources.

This bypasses HACS file delivery, not the need to reload an already-open browser page. If the Pages script fails to load, restore the HACS resource.

## Install through HACS

1. Open **HACS → ⋮ → Custom repositories**.
2. Add `https://github.com/njharrison/race-trace-gps` as a **Dashboard** repository.
3. Install **Race Trace GPS** and reload the browser.
4. If HACS does not add the dashboard resource automatically, add `/hacsfiles/race-trace-gps/race-trace-gps.js` as a **JavaScript module** under **Settings → Dashboards → Resources**.
5. Add a manual dashboard card:

```yaml
type: custom:race-trace-gps
gps_url: /local/f1-race-trace/gps-recording.json
timing_url: /local/f1-race-trace/live-recording.json
height: 460
```

Both files must be accessible from your browser and belong to the same session. GPS requires schema-version-1 geometry.points, samples[].recorded_at, and driver x/y positions. Timing requires schema-version-1 samples with driver completed_laps.

## Development and limitations

Source is bundled from the shared geometry, timing-sync, start/finish calibration, and official timing-led alignment modules on the `dev/shared-race-trace-engine` branch of [home-assistant-f1-race-trace](https://github.com/njharrison/home-assistant-f1-race-trace). No production bundle is overwritten.

Current limitations: no polished Singapore-style renderer or interactive controls, no incremental GPS downloads, no automated CI verification of this distributed bundle, and no guarantee of reliable start/finish calibration until enough official lap transitions are recorded. GPS points use simple nearest-centreline projection; complex pit lane paths may need trajectory-aware projection. Recording files served under `/local/` should not contain private credentials.

## Stationary drivers and gap chart

The card ends a driver's final trace at the beginning of a stationary GPS spell lasting at least five seconds. If the driver resumes moving, the intermediate stop remains part of their trajectory. The Y-axis is seconds behind/ahead of the furthest-progressed car at the same distance, with the reference trace in white. Outlying gap values are visually clipped at the 1st/99th percentiles to keep the graph readable; underlying samples are retained.

## Reference and driver controls

The default **Learned clean-lap pace** reference calculates a median normalised 101-point lap-time profile from qualifying complete laps across all cars. It needs at least five accepted clean laps, otherwise it falls back to the furthest-progressed car's GPS trace. Switch the reference in the card dropdown to compare both methods. This is an initial implementation and has not yet been verified against the offline Singapore golden master.

Driver buttons below the graph toggle visibility; **Show all drivers** resets the selection. Labels are taken from the latest timing sample when available, falling back to the racing number. The chart only draws laps from lap 1 onwards, while pre-race GPS remains available for calibration.

## Retirement and stationary GPS behaviour

The card detects official retirement from `retired: true` or driver `status`, `driver_status`, or `race_status` equal to `RETIRED`, `RET`, `DNF`, or `OUT` in timing samples. An officially retired driver's trace ends at the last moving GPS position and displays a large X; no stationary tail is shown.

Without an official retirement, a stationary car's trace may continue vertically for up to five seconds before it freezes. Motion detection uses GPS coordinate displacement of at least one metre between observations. This implementation is provisional and should be checked against Bortoleto's Singapore recording, particularly the exact field carrying retirement status and whether the GPS recorder continues to sample a stopped car. It does not infer a five-second interval when recording samples have ceased entirely.
