/* =====================================================================
   AI ATC: the things that make the job a job.

   Pilot deviations   crews that mis-hear, mis-set and blow through
   Emergencies        engine failure, medical, NORDO, general emergency
   Weather            cells that drift across the arrival and departure
                      gates, and wind shifts that force a runway change
   VFR                pop-ups requesting flight following or a transition
   Debrief            what you actually did, at the end of the session
   ===================================================================== */
"use strict";

/* =====================================================================
   PILOT DEVIATIONS
   A crew occasionally does not do what it read back. The aircraft says
   the right thing and then flies the wrong thing, so the only way to
   catch it is to watch the target, which is the real job.
   ===================================================================== */
function maybeDeviate(ac, kind, value) {
  if (ac.emerg || ac.noDeviate) return value;
  /* deviations are rare, and rarer still on the ground */
  const p = ac.alt > 500 ? 0.055 : 0.02;
  if (Math.random() > p) return value;

  if (kind === "hdg") {
    const wrong = Math.random() < 0.5
      ? norm360(value + pick([-30, -20, 20, 30]))     // dialled the wrong number
      : norm360(value + 180);                          // turned the wrong way
    ac.deviation = { kind: "heading", said: value, doing: wrong, at: G.t };
    return wrong;
  }
  if (kind === "alt") {
    const wrong = value + pick([-1000, 1000, 2000]);
    ac.deviation = { kind: "altitude", said: value, doing: wrong, at: G.t };
    return wrong;
  }
  return value;
}

/* the controller can challenge a deviating aircraft */
function checkDeviations() {
  for (const ac of G.aircraft) {
    if (!ac.deviation || ac.remove) continue;
    /* they notice themselves eventually, but not quickly */
    if (G.t - ac.deviation.at > rnd(140, 260)) {
      const d = ac.deviation;
      ac.deviation = null;
      if (d.kind === "heading") { ac.targetHdg = d.said; ac.assignedHdg = d.said; }
      else { ac.targetAlt = d.said; ac.assignedAlt = d.said; }
      ac.say(`${ac.spoken()}, sorry, correcting back to ${d.kind === "heading"
        ? "heading " + hdgWords(d.said) : altWords(d.said)}.`);
    }
  }
}

/* "verify heading", "say your assigned altitude", "you're off course" */
function challengeDeviation(ac) {
  if (!ac.deviation) return null;
  const d = ac.deviation;
  ac.deviation = null;
  addPoints(8, `caught ${ac.cs} off their assigned ${d.kind}`);
  if (d.kind === "heading") { ac.targetHdg = d.said; ac.assignedHdg = d.said; }
  else { ac.targetAlt = d.said; ac.assignedAlt = d.said; }
  return d.kind === "heading"
    ? `sorry, we had the wrong heading set, coming back to ${hdgWords(d.said)}`
    : `sorry, we were going to the wrong altitude, back to ${altWords(d.said)}`;
}

/* =====================================================================
   EMERGENCIES
   ===================================================================== */
const EMERGENCIES = [
  { id: "engine", sqk: "7700", priority: true,
    call: ac => `Mayday, mayday, mayday, ${ac.spoken()}, we've lost an engine, request immediate return, ${numWords(Math.floor(rnd(60, 240)))} souls, ${numWords(Math.floor(rnd(30, 120)))} minutes of fuel.`,
    need: "an immediate return, priority to the nearest runway" },
  { id: "medical", sqk: "7700", priority: true,
    call: ac => `${ac.spoken()}, we have a medical emergency on board, requesting priority handling and paramedics on arrival.`,
    need: "priority to land and medical services on arrival" },
  { id: "pressure", sqk: "7700", priority: true,
    call: ac => `Mayday, ${ac.spoken()}, we have a pressurisation problem, emergency descent, we need lower now.`,
    need: "an emergency descent, get everyone out of the way" },
  { id: "nordo", sqk: "7600", priority: false,
    call: null,
    need: "nothing on the radio: they are NORDO and flying the lost comms procedure" },
  { id: "gear", sqk: "7700", priority: true,
    call: ac => `${ac.spoken()}, we have an unsafe gear indication, request a low approach for a visual check, then we'll come back around.`,
    need: "a low approach, then a full stop with equipment standing by" },
  { id: "fuel", sqk: "7700", priority: true,
    call: ac => `${ac.spoken()}, declaring minimum fuel, we need the first available approach.`,
    need: "the shortest possible routing to a runway" },
];

function declareEmergency(ac, forced) {
  if (!ac || ac.emerg || ac.remove || ac.alt < 300) return;
  const e = forced || pick(EMERGENCIES);
  ac.emerg = e;
  ac.noDeviate = true;
  ac.sqk = e.sqk;
  ac.priority = e.priority;
  alertTone();
  if (e.id === "nordo") {
    ac.nordo = true;
    xmit(G.playerPos, "SYS", "warn",
      `${ac.cs} is squawking 7600. No radio. They will fly the lost communications procedure.`, null);
  } else {
    ac.say(e.call(ac));
    xmit(G.playerPos, "SYS", "warn",
      `EMERGENCY: ${ac.cs} squawking ${e.sqk}. They need ${e.need}.`, null);
  }
  /* an emergency jumps the arrival queue */
  if (ac.role === "arr") {
    const i = G.arrSeq.indexOf(ac.id);
    if (i > 0) { G.arrSeq.splice(i, 1); G.arrSeq.unshift(ac.id); }
  }
  G.hooks.strips();
}

/* NORDO aircraft ignore everything and fly the procedure */
function nordoStep(ac) {
  if (!ac.nordo) return;
  if (ac.role === "arr" && !ac.app) {
    ac.directFix = null;
    ac.targetHdg = G.arrRwy.hdg;
    ac.targetAlt = Math.min(ac.targetAlt, 3000);
    if (finalGeom(ac, G.arrRwy).along < 18 && Math.abs(finalGeom(ac, G.arrRwy).cross) < 3) {
      ac.app = "cleared";
    }
  }
}

/* =====================================================================
   WEATHER
   ===================================================================== */
const WX = { cells: [], nextShift: 0 };

function wxReset() {
  WX.cells = [];
  WX.nextShift = G.t + rnd(1500, 3000);
}
function wxSpawnCell() {
  if (WX.cells.length >= 4) return;
  const brg = rnd(0, 360), d = rnd(12, 34);
  WX.cells.push({
    x: Math.sin(d2r(brg)) * d, y: Math.cos(d2r(brg)) * d,
    r: rnd(2.5, 7), drift: rnd(0, 360), spd: rnd(6, 16),
    born: G.t, life: rnd(900, 2400),
  });
  xmit(G.playerPos, "WX", "warn",
    `Weather: a cell is developing ${Math.round(d)} miles ${compassWord(brg)} of the field. Expect deviation requests.`, null);
}
function compassWord(b) {
  return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][
    Math.round(norm360(b) / 45) % 8];
}
function wxTick(dt) {
  for (const c of WX.cells) {
    c.x += Math.sin(d2r(c.drift)) * c.spd / 3600 * dt;
    c.y += Math.cos(d2r(c.drift)) * c.spd / 3600 * dt;
  }
  WX.cells = WX.cells.filter(c => G.t - c.born < c.life);

  /* aircraft ask to deviate around a cell in front of them */
  for (const ac of G.aircraft) {
    if (ac.alt < 3000 || ac.remove || ac.app === "established" || ac.wxAsked) continue;
    if (ac.owner !== G.playerPos) continue;
    for (const c of WX.cells) {
      const ahead = { x: ac.x + Math.sin(d2r(ac.hdg)) * 8, y: ac.y + Math.cos(d2r(ac.hdg)) * 8 };
      if (Math.hypot(ahead.x - c.x, ahead.y - c.y) < c.r + 1.5) {
        ac.wxAsked = true;
        ac.say(pick([
          `${ac.spoken()}, we're painting a cell about ${Math.round(Math.hypot(ac.x - c.x, ac.y - c.y))} ahead, request deviation ${pick(["left", "right"])} of course.`,
          `${ac.spoken()}, request ${pick(["twenty", "thirty"])} degrees ${pick(["left", "right"])} for weather.`,
          `${ac.spoken()}, we need to go around this build-up, request deviation.`,
        ]));
        break;
      }
    }
  }
  /* a wind shift can force a runway change mid-session */
  if (G.t > WX.nextShift) {
    WX.nextShift = G.t + rnd(1800, 3600);
    const cfg = G.fac.configs.find(c => c !== G.cfg);
    if (cfg && G.aircraft.length < 26) {
      G.atis.windDir = norm360(resolveRwy(cfg.arr).hdg + rnd(-25, 25));
      G.atis.windSpd = Math.floor(rnd(10, 20));
      G.atis.letter = String.fromCharCode(G.atis.letter.charCodeAt(0) + 1);
      landlineChime();
      xmit("INT", ctrlCallsign("TWR") , "ctrl",
        `Heads up, the wind has shifted to ${Math.round(G.atis.windDir)} at ${G.atis.windSpd}. We're going to have to swap to the ${cfg.name}. New ATIS shortly.`,
        G.ctrlVoice.TWR);
      xmit(G.playerPos, "WX", "warn",
        `WIND SHIFT: ${String(Math.round(G.atis.windDir)).padStart(3, "0")}/${G.atis.windSpd}. Runway change to ${cfg.arr} arrivals, ${cfg.dep} departures is coming. Use SAFETY LOGIC > RWY CFG when you are ready.`, null);
    }
  }
}

/* =====================================================================
   VFR POP-UPS
   ===================================================================== */
function spawnVFR() {
  if (!["APP", "CTR", "TWR"].includes(G.playerPos)) return;
  if (G.aircraft.filter(a => a.vfr).length >= 2) return;
  const ac = new Aircraft("arr");
  ac.vfr = true;
  ac.cs = pick(["N", "N", "N"]) + Math.floor(rnd(100, 999)) + pick(["SP", "MC", "TB", "AB", "CX"]);
  ac.airline = { code: "N", tel: "November" };
  ac.num = ac.cs.slice(1);
  ac.type = pick(["C172", "SR22", "PA28", "BE36", "C208"]);
  ac.heavy = false;
  const brg = rnd(0, 360), d = rnd(16, 30);
  ac.x = Math.sin(d2r(brg)) * d; ac.y = Math.cos(d2r(brg)) * d;
  ac.alt = ac.targetAlt = ac.assignedAlt = pick([3500, 4500, 5500, 6500]);
  ac.ias = ac.targetIas = rnd(95, 150);
  ac.hdg = ac.targetHdg = rnd(0, 360);
  ac.directFix = null;
  ac.state = "appCtl";
  ac.owner = G.playerPos === "CTR" ? "CTR" : "APP";
  ac.called = false;
  ac.callAt = G.t + rnd(2, 8);
  ac.vfrReq = pick(["flight following", "a Bravo transition", "a transition through your airspace"]);
  ac.app = null;
  G.aircraft.push(ac);
  G.hooks.strips();
}

/* =====================================================================
   DEBRIEF
   ===================================================================== */
function sessionDebrief() {
  const c = G.counters;
  const mins = Math.max(1, G.t / 60);
  const rows = [
    ["Time on position", `${Math.round(mins)} minutes`],
    ["Score", String(G.score)],
    ["Clearances issued", String(c.clx)],
    ["Aircraft taxied", String(c.taxi)],
    ["Departures rolled", String(c.tko)],
    ["Arrivals landed", String(c.ldg)],
    ["Delivered on the ILS", String(c.ils)],
    ["Handoffs", String(c.ho)],
    ["Go-arounds", String(c.ga)],
    ["Losses of separation", String(c.sep)],
    ["Movements per hour", String(Math.round((c.ldg + c.tko) / mins * 60))],
  ];
  let grade = "Developmental";
  const rate = (c.ldg + c.tko) / mins * 60;
  if (c.sep === 0 && rate > 18) grade = "Excellent";
  else if (c.sep <= 1 && rate > 10) grade = "Solid";
  else if (c.sep > 3) grade = "Unsafe: too many losses of separation";
  return { rows, grade };
}

/* =====================================================================
   TICK
   ===================================================================== */
let opsNext = 240;
function opsTick(dt) {
  if (!G.running) return;
  wxTick(dt);
  checkDeviations();
  for (const ac of G.aircraft) if (ac.nordo) nordoStep(ac);

  if (G.t < opsNext) return;
  opsNext = G.t + rnd(220, 480);
  const roll = Math.random();
  if (roll < 0.22) {
    const cand = G.aircraft.filter(a => !a.emerg && a.alt > 2000 && !a.remove);
    if (cand.length) declareEmergency(pick(cand));
  } else if (roll < 0.5) {
    wxSpawnCell();
  } else if (roll < 0.68) {
    spawnVFR();
  }
}
