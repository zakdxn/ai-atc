# AI ATC

A VATSIM-style air traffic control simulator that runs entirely in your browser.
You are the controller; every pilot and every other controller position is an AI.

Think SayIntentions.ai, inverted: instead of AI ATC talking to you as a pilot,
AI pilots (and AI colleague controllers) talk to you while you work a position.

## Features

- **All 22 VATUSA facilities**: the 20 CONUS ARTCCs plus ZAN Anchorage and HCF
  Honolulu, each with its primary airport, runway configurations selected by
  randomized wind, SIDs/STARs, entry fixes and per-position frequencies.
- **Every VATSIM position**: Clearance Delivery, Ground, Tower,
  Approach/Departure and Center, gated by VATSIM-style ratings (S1/S2/S3/C1)
  earned through points, with a sandbox override. AI controllers staff every
  position you don't hold and work traffic on their own frequencies.
- **Session SOPs**: the SOP button lists the live runway configuration, initial
  altitude, departure frequency, SIDs and per-position procedures, so you always
  know exactly what to issue.
- **Full flight lifecycle**: gate, IFR clearance (CRAFT format, with pilot
  readback errors you must catch), pushback and taxi, takeoff, departure,
  enroute, and arrivals from center handoff all the way to the gate. Flight
  strips pass between position bays on every handoff.
- **CRC-style displays**: STARS terminal radar (black scope, video map, compass
  rose, flight plan list), ASDE-X surface radar (teal, black runways, DCB button
  bar), and a top-down Tower Cab with a METAR bar. Wheel zooms, dragging pans,
  clicking a target or datablock selects it.
- **Interactive radio comms**: full phraseology or VATSIM shorthand
  (`dal123 t l 270 d 40`), typed or spoken via push-to-talk (hold the PTT button
  or Tab). Pilots understand conversational radio too: standby, say again,
  roger, partial clearances given piecemeal. Responses draw from phrase pools so
  the frequency never sounds canned. Per-speaker synthesized voices with radio
  squelch effects; monitor any AI frequency; landline intercom to the other
  positions with traffic-aware replies.
- **Separation monitoring**: 3 nm / 1,000 ft (2.5 nm on final), conflict
  alerts, go-arounds, runway protection on shared-runway fields, scoring.

## Running it

It's a static site with no build and no backend. Open `index.html` in Chrome or
Edge (best speech support), serve the folder with any static server, or enable
GitHub Pages on this repo (Settings, then Pages, deploy from branch `main`,
root folder).

## Notes

Voices use the browser's speech synthesis with per-speaker variation plus
WebAudio radio effects. Airport geometry and procedures are simplified
approximations for gameplay, not navigational data, and the Tower Cab uses
synthesized imagery because a static site cannot ship licensed satellite
photography.
