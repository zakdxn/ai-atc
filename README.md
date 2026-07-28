# ZEAL ATC

A VATSIM-style air traffic control simulator that runs entirely in your browser —
**you** are the controller, and every pilot *and* every other controller position
is an AI.

Think SayIntentions.ai, inverted: instead of AI ATC talking to you as a pilot,
AI pilots (and AI colleague controllers) talk to you while you work a position.

## Features

- **3 ARTCCs** — ZNY (KJFK), ZLA (KLAX), ZTL (KATL) with simplified real runway
  layouts, SIDs/STARs, fixes and per-position frequencies. Wind is rolled each
  session and selects the runway configuration; ATIS, time of day, traffic and
  events are randomized.
- **Every VATSIM position** — Clearance Delivery, Ground, Tower,
  Approach/Departure, Center — gated by VATSIM-style ratings (S1/S2/S3/C1)
  earned through points, with a sandbox override. AI controllers staff every
  position you don't hold and work traffic on their own frequencies.
- **Full flight lifecycle** — gate → IFR clearance (CRAFT format, with pilot
  readback errors you must catch) → pushback/taxi → takeoff → departure →
  enroute, and arrivals from center handoff all the way to the gate. Flight
  strips pass between position bays on every handoff.
- **Three displays** — STARS radar scope, ASDE-X surface view, and a pannable
  tower-cab view with day/dusk/night skies.
- **Radio comms** — full phraseology or VATSIM shorthand (`dal123 t l 270 d 40`),
  typed or spoken via push-to-talk (Web Speech API), per-speaker synthesized
  voices with radio squelch effects, per-frequency monitoring, and landline
  intercom to the AI positions.
- **Separation monitoring** — 3 nm / 1,000 ft (2.5 nm on final), conflict
  alerts, go-arounds, scoring.

## Running it

It's a static site — no build, no backend. Open `index.html` in Chrome/Edge
(best speech support), or serve the folder with any static server, or enable
GitHub Pages on this repo (Settings → Pages → deploy from branch → `main` /
root).

## Notes

Voices use the browser's speech synthesis with per-speaker variation plus
WebAudio radio effects. Airport geometry and procedures are simplified
approximations for gameplay, not navigational data.
