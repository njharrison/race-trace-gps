# Race Trace GPS

Experimental Home Assistant GPS-based F1 race trace, independently installable through HACS.

**Status:** early prototype. This is a distance-vs-recording-time diagnostic chart, **not yet** the approved Singapore race-gap renderer. It currently downloads both full recordings every five seconds, so do not leave it running for long races until incremental loading is added. Production `custom:f1-race-trace` is unaffected.

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

Current limitations: no live-gap renderer, no incremental GPS downloads, no automated CI verification of this distributed bundle, and no guarantee of reliable start/finish calibration until enough official lap transitions are recorded. GPS points use simple nearest-centreline projection; complex pit lane paths may need trajectory-aware projection. Recording files served under `/local/` should not contain private credentials.
