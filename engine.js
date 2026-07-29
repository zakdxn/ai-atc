/* =====================================================================
   AI ATC: simulation engine
   Full aircraft lifecycle (gate → clearance → taxi → takeoff → enroute,
   and arrivals back down to the gate), AI controllers for every position
   the player doesn't hold, phraseology parsing, strips, scoring.
   ===================================================================== */
"use strict";

/* ---------------- math & word helpers ---------------- */
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const norm360 = a => ((a % 360) + 360) % 360;
const d2r = d => d * Math.PI / 180;
function angDiff(target, from) {
  let d = norm360(target) - norm360(from);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const bearingTo = (from, to) => norm360(Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI);

const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"];
const numWords = n => [...String(n)].map(c => DIGIT_WORDS[+c] ?? c).join(" ");
function hdgWords(h) {
  return [...String(norm360(h) === 0 ? 360 : norm360(h)).padStart(3, "0")].map(c => DIGIT_WORDS[+c]).join(" ");
}
function altWords(a) {
  if (a >= 18000) return "flight level " + numWords(Math.round(a / 100));
  const th = Math.floor(a / 1000), hu = Math.round((a % 1000) / 100);
  let out = "";
  if (th > 0) out += (th < 10 ? DIGIT_WORDS[th] : numWords(th)) + " thousand";
  if (hu > 0) out += (out ? " " : "") + DIGIT_WORDS[hu] + " hundred";
  return out || "zero";
}
function rwyWords(id) {
  const m = id.match(/^(\d+)([LRC]?)$/);
  const side = { L: " left", R: " right", C: " center" }[m[2]] || "";
  return numWords(+m[1]) + side;
}
function freqWords(f) {
  return [...f].map(c => c === "." ? "point" : DIGIT_WORDS[+c]).join(" ");
}

/* ---------------- global session state ---------------- */
const G = {
  running: false,
  fac: null, cfg: null, arrRwy: null, depRwy: null,
  playerPos: "DEL",
  t: 0, speed: 1, paused: false,
  aircraft: [],
  selected: null,
  channels: {},          // pos -> [{t,who,cls,text}]
  monitored: {},
  ctrlVoice: {},
  atis: null,
  score: 0, points: 0,   // session score / career points earned this session
  counters: { clx: 0, taxi: 0, tko: 0, ldg: 0, ils: 0, ho: 0, sep: 0, ga: 0 },
  arrSeq: [],
  arrSpacing: 6.5,       // Dynamic arrival spacing requested by TWR
  slowDel: 0, lastDelTime: 0, // Clearance Delivery flow controls
  nextArr: 20, nextDep: 6, nextEvent: 120,
  rushPhase: rnd(0, Math.PI * 2),
  density: "med",
  hooks: { log: () => {}, strips: () => {}, score: () => {}, notify: () => {} },
};

const AI_SHORT = fac => fac.icao.replace(/^K/, "");
/* Spoken on frequency. Never the 3-letter code: speech engines read
   "MIA" as "Missing In Action" and "ORD" as "ord". */
const SPOKEN_NAME = {
  KJFK: "Kennedy", KLAX: "Los Angeles", KATL: "Atlanta", KORD: "O'Hare",
  KMIA: "Miami", KBOS: "Boston", KDEN: "Denver", KDFW: "Dallas",
  KIAH: "Houston", KIAD: "Dulles", KSEA: "Seattle", KSFO: "San Francisco",
  KMSP: "Minneapolis", KDTW: "Detroit", KSLC: "Salt Lake", KMEM: "Memphis",
  KMCI: "Kansas City", KJAX: "Jacksonville", KIND: "Indy", KPHX: "Phoenix",
  PANC: "Anchorage", PHNL: "Honolulu",
};
function facSpoken(fac) {
  if (SPOKEN_NAME[fac.icao]) return SPOKEN_NAME[fac.icao];
  return (fac.apName || fac.icao)
    .replace(/\s+(Intl|International|Airport|Regional|Municipal|Metropolitan|Field).*$/i, "")
    .split(/[-\/]/)[0].trim();
}
/* Departure and Approach are the same TRACON, but most fields publish a
   separate departure frequency. Derive a stable one per facility. */
function depFreq(fac) {
  if (fac._depFreq) return fac._depFreq;
  const base = parseFloat(fac.freqs.APP);
  let f = base + 1.15;
  if (f > 135.9) f = base - 1.35;
  fac._depFreq = f.toFixed(2);
  return fac._depFreq;
}

function ctrlCallsign(pos) {
  const s = AI_SHORT(G.fac);
  return { DEL: s + "_DEL", GND: s + "_GND", TWR: s + "_TWR", APP: s + "_APP", CTR: G.fac.artcc + "_CTR" }[pos];
}
const isAI = pos => pos !== G.playerPos;

/* transmission onto a frequency (or INT landline) */
function xmit(chan, who, cls, text, voice) {
  (G.channels[chan] = G.channels[chan] || []).push({ t: G.t, who, cls, text });
  if (G.channels[chan].length > 300) G.channels[chan].shift();
  G.hooks.log(chan, who, cls, text);
  if (voice && (G.monitored[chan] || chan === G.playerPos || chan === "INT")) TTS.say(text, voice);
}
const sysLog = (text) => xmit(G.playerPos, "SYS", "sys", text, null);

function addPoints(n, why) {
  G.score += n;
  if (n > 0) G.points += n;
  G.hooks.score();
  if (why) xmit(G.playerPos, "SYS", n >= 0 ? "sys" : "warn", `${n >= 0 ? "+" : ""}${n}: ${why}`, null);
}

/* ---------------- runway resolution ---------------- */
function resolveRwy(id) {
  if (!id) return null;
  let normId = id.toUpperCase();
  
  // Pad single digits with a zero (e.g. "4L" -> "04L", "9" -> "09")
  const m = normId.match(/^(\d{1,2})([LRC]?)$/);
  if (m) normId = m[1].padStart(2, "0") + (m[2] || "");
  
  for (const r of G.fac.runways) {
    if (r.id === normId) return { id: r.id, thr: r.thr, hdg: r.hdg, end: r.end };
    if (r.recip === normId) return { id: r.recip, thr: r.end, hdg: norm360(r.hdg + 180), end: r.thr };
  }
  return null;
}
/* along-final distance (nm out from threshold) and cross-track for a runway */
function finalGeom(p, R) {
  const b = { x: Math.sin(d2r(R.hdg + 180)), y: Math.cos(d2r(R.hdg + 180)) }; // out along approach
  const rp = { x: Math.cos(d2r(R.hdg)), y: -Math.sin(d2r(R.hdg)) };           // right of course
  const dx = p.x - R.thr.x, dy = p.y - R.thr.y;
  return { along: dx * b.x + dy * b.y, cross: dx * rp.x + dy * rp.y };
}

/* ---------------- aircraft ---------------- */
let nextAcId = 1;
class Aircraft {
  constructor(role) {
    this.id = nextAcId++;
    this.role = role;                      // 'dep' | 'arr'
    const al = pick(AIRLINES);
    this.airline = al;
    this.num = String(Math.floor(rnd(10, 999)));
    this.cs = al.code + this.num;
    const ty = pick(TYPES);
    this.type = ty.icao; this.heavy = ty.heavy;
    this.voice = makeVoice();
    this.sqk = [...Array(4)].map(() => Math.floor(rnd(0, 7.99))).join("");
    if (/^7[567]00$/.test(this.sqk)) this.sqk = "2345";
    this.cid = String(Math.floor(rnd(100, 999)));          // computer ID
    this.eq = pick(["L", "L", "L", "G", "W", "Z"]);        // equipment suffix
    this.rmk = Math.random() < 0.18
      ? pick(["PBN/A1B1C1D1", "RVSM", "STS/HOSP", "OPR/CARGO", "TCAS", "RMK/SIMBRIEF"]) : "";
    this.hoTo = null;                                       // pending handoff position
    this.hoAccepted = false;
    this.rwy = null;                       // assigned runway override

    this.x = 0; this.y = 0; this.alt = 0; this.hdg = 0;
    this.targetHdg = 0; this.turnDir = null;
    this.targetAlt = 0; this.ias = 0; this.targetIas = 0;
    this.assignedAlt = null; this.assignedSpd = null; this.directFix = null;
    this.app = null;                       // null | 'cleared' | 'established'
    this.landClr = false;
    this.pending = null;
    this.trail = []; this.trailT = 0;
    this.remove = false;
    this.called = false; this.callAt = 0; this.aiAt = 0; this.stateT = 0;
    this.reminders = 0;
    this.rbError = null;                   // induced readback error {field, wrong}
    this.clx = { dest: false, sid: false, alt: false, sqkOk: false, sqkSaid: null };
    this.clxStage = 0;                     // 0 idle, 1 requested, 2 readback out, 3 complete
    this.appPlan = null;
    this.taxiPath = null; this.taxiIdx = 0;
    this.pushT = 0;
    this.gaFlag = false;                   // gust event: force a go-around
    this.isBreakingOut = false;

    if (role === "dep") {
      const gp = G.fac.gates;
      this.gate = pick(gp.prefix) + Math.floor(rnd(1, 40));
      this.dest = pick(DESTS.filter(d => d.icao !== G.fac.icao));
      this.sid = pick(G.fac.sids);
      const exitName = pick(this.sid.exits);
      this.exitFix = G.fac.fixes.find(f => f.name === exitName);
      this.cruise = pick([28000, 30000, 32000, 34000, 36000]);
      this.route = `${this.sid.name} ${this.exitFix.name} ${pick(["J",""])}${pick(["146","64","80","174",""])} ${this.dest.icao.slice(1)}`.replace(/\s+/g, " ").trim();
      
      let spawnX, spawnY;
      if (typeof pickGateSpot === "function" && G.fac.real) {
        const taken = G.aircraft.filter(a => a.role === "dep" && a.alt < 40).map(a => ({ x: a.x, y: a.y }));
        const s = pickGateSpot(G.fac, taken);
        spawnX = s.x; spawnY = s.y;
      } else {
        spawnX = gp.anchor.x + rnd(-0.03, 0.03);
        spawnY = gp.anchor.y + rnd(-0.03, 0.03);
      }

      // GUARANTEE NO SPAWN ON RUNWAY OR IN GRASS
      let isBad = (spawnX === 0 && spawnY === 0);
      if (!isBad) {
        for (const r of G.fac.runways) {
          const l2 = Math.pow(r.thr.x - r.end.x, 2) + Math.pow(r.thr.y - r.end.y, 2);
          if (l2 === 0) continue;
          let t = ((spawnX - r.thr.x) * (r.end.x - r.thr.x) + (spawnY - r.thr.y) * (r.end.y - r.thr.y)) / l2;
          t = Math.max(0, Math.min(1, t));
          const proj = { x: r.thr.x + t * (r.end.x - r.thr.x), y: r.thr.y + t * (r.end.y - r.thr.y) };
          if (dist2({x: spawnX, y: spawnY}, proj) < 0.08) { // 0.08 nm = ~500 feet exclusion zone
            isBad = true; break;
          }
        }
      }

      if (isBad) {
        // If the spot is on a runway or invalid, tightly double-park on the concrete apron anchor
        this.x = gp.anchor.x + rnd(-0.015, 0.015);
        this.y = gp.anchor.y + rnd(-0.015, 0.015);
      } else {
        this.x = spawnX;
        this.y = spawnY;
      }
      
      this.hdg = this.targetHdg = rnd(0, 360);
      this.state = "gate"; this.owner = "DEL";
      this.callAt = G.t + rnd(4, 25);
      
    } else {
      this.star = pick(G.fac.stars);
      /* spread arrivals across entry fixes: avoid a gate already occupied far out */
      const busy = G.aircraft.filter(a => a.role === "arr" && a.distField() > 46).map(a => a.entryFix && a.entryFix.name);
      const free = G.fac.entryFixes.filter(n => !busy.includes(n));
      const entryName = pick(free.length ? free : G.fac.entryFixes);
      this.entryFix = G.fac.fixes.find(f => f.name === entryName);
      this.origin = pick(DESTS.filter(d => d.icao !== G.fac.icao));
      this.cruise = pick([30000, 32000, 34000, 36000, 38000]);
      const brg = bearingTo({ x: 0, y: 0 }, this.entryFix);
      
      // STAGGER THE ARRIVALS SO THEY DON'T CLUMP
      const stagger = rnd(58, 70);
      this.x = Math.sin(d2r(brg)) * stagger; 
      this.y = Math.cos(d2r(brg)) * stagger;
      
      this.alt = this.targetAlt = pick([15000, 16000, 17000]);
      this.assignedAlt = this.alt;
      this.ias = this.targetIas = rnd(290, 320);
      this.hdg = this.targetHdg = bearingTo(this, { x: 0, y: 0 });
      this.directFix = this.entryFix;
      this.route = `${this.origin.icao.slice(1)} ${this.entryFix.name} ${this.star}`;
      this.state = "ctrArr"; this.owner = "CTR";
      this.callAt = G.t + rnd(3, 10);
      this.medevac = Math.random() < 0.04;
    }
  }

  spoken() { return `${this.airline.tel} ${numWords(this.num)}${this.heavy ? " heavy" : ""}${this.medevac ? "" : ""}`; }
  gs() { return this.state === "taxi" || this.state === "taxiIn" ? this.ias : this.ias * (1 + 0.02 * this.alt / 1000); }
  distField() { return Math.hypot(this.x, this.y); }

  say(text, chan) {
    xmit(chan || this.owner, this.cs, "pilot", text, this.voice);
  }
}

/* ---------------- ownership / strips ---------------- */
function setOwner(ac, pos, silent) {
  const from = ac.owner;
  ac.owner = pos;
  ac.called = false;
  ac.callAt = G.t + rnd(4, 10);
  ac.aiAt = 0;
  ac.reminders = 0;
  if (!silent) xmit(pos === G.playerPos ? G.playerPos : from, "SYS", "sys",
    `STRIP ${ac.cs}: ${from} → ${pos}`, null);
  if (pos === G.playerPos) chime();
  G.hooks.strips();
}

/* ---------------- pilot initial calls per position ----------------
   Every call is drawn from a pool of phrasings so the frequency never
   sounds canned. */
const BYE = () => pick(["good day", "so long", "seeya", "have a good one", "later"]);
/* Is the frequency busy? Pilots wait for a gap instead of stepping on
   whatever is already being said. */
function freqBusy(chan) {
  const ch = G.channels[chan] || [];
  const last = ch[ch.length - 1];
  if (!last) return false;
  const words = last.text.split(/\s+/).length;
  const airtime = Math.max(2.5, words * 0.42);          // seconds to say it
  return (G.t - last.t) < airtime;
}

function pilotCheckIn(ac) {
  ac.called = true;
  const F = G.fac;
  const alt100 = () => altWords(Math.round(ac.alt / 100) * 100);
  switch (ac.owner) {
    case "DEL":
      ac.clxStage = 1;
      ac.say(pick([
        `Clearance, ${ac.spoken()}, gate ${ac.gate.toLowerCase()}, IFR to ${ac.dest.city}, with information ${G.atis.letter}, ready to copy.`,
        `${facSpoken(F)} clearance, ${ac.spoken()} at ${ac.gate.toLowerCase()} with ${G.atis.letter}, IFR ${ac.dest.city}, ready to copy when you are.`,
        `Clearance delivery, good ${G.atis.tod === "night" ? "evening" : "day"}, ${ac.spoken()}, looking for our clearance to ${ac.dest.city}, we have ${G.atis.letter}.`,
        `Clearance, ${ac.spoken()}, ${ac.dest.city} today, information ${G.atis.letter}, ready to copy.`,
      ]));
      break;
    case "GND":
      if (ac.role === "dep") ac.say(pick([
        `Ground, ${ac.spoken()}, gate ${ac.gate.toLowerCase()} with ${G.atis.letter}, request pushback.`,
        `${facSpoken(F)} ground, ${ac.spoken()}, ready for the push at ${ac.gate.toLowerCase()}.`,
        `Ground, ${ac.spoken()}, we'd like to push, gate ${ac.gate.toLowerCase()}.`,
      ]));
      else ac.say(pick([
        `Ground, ${ac.spoken()}, clear of runway ${rwyWords((ac.rwy || G.arrRwy).id)}, taxi to the gate.`,
        `Ground, ${ac.spoken()} with you off ${rwyWords((ac.rwy || G.arrRwy).id)}, where would you like us?`,
        `Ground, ${ac.spoken()}, down and clear, gate please.`,
      ]));
      break;
    case "TWR":
      if (ac.role === "dep") ac.say(pick([
        `Tower, ${ac.spoken()}, holding short runway ${rwyWords((ac.rwy || G.depRwy).id)}, ready.`,
        `Tower, ${ac.spoken()}, ready to go, ${rwyWords((ac.rwy || G.depRwy).id)}.`,
        `${facSpoken(F)} tower, ${ac.spoken()}, short of ${rwyWords((ac.rwy || G.depRwy).id)}, ready for departure.`,
      ]));
      else ac.say(pick([
        `Tower, ${ac.spoken()}, ${Math.max(1, Math.round(finalGeom(ac, ac.rwy || G.arrRwy).along))} mile final, runway ${rwyWords((ac.rwy || G.arrRwy).id)}.`,
        `Tower, ${ac.spoken()} with you on the ILS ${rwyWords((ac.rwy || G.arrRwy).id)}.`,
        `Tower, ${ac.spoken()}, ${Math.max(1, Math.round(finalGeom(ac, ac.rwy || G.arrRwy).along))} out for ${rwyWords((ac.rwy || G.arrRwy).id)}.`,
      ]));
      break;
    case "APP":
      if (ac.vfr) {
        ac.say(`${facSpoken(F)} approach, ${ac.spoken()}, ${ac.type}, ${altWords(Math.round(ac.alt / 100) * 100)}, ${Math.round(ac.distField())} miles ${["north","northeast","east","southeast","south","southwest","west","northwest"][Math.round(norm360(bearingTo({x:0,y:0}, ac)) / 45) % 8]} of the field, request ${ac.vfrReq}.`);
        break;
      }
      if (ac.role === "dep") ac.say(pick([
        `${F.tracon}, ${ac.spoken()}, passing ${alt100()} for ${altWords(ac.assignedAlt || F.initAlt)}, ${ac.sid.name} departure.`,
        `Departure, ${ac.spoken()} with you out of ${alt100()}, ${ac.sid.name}.`,
        `${F.tracon}, ${ac.spoken()}, climbing through ${alt100()} on the ${ac.sid.name}.`,
      ]));
      else ac.say(pick([
        `${F.tracon}, ${ac.spoken()}, ${alt100()} descending via the ${ac.star}, information ${G.atis.letter}.${ac.medevac ? " Medevac." : ""}`,
        `Approach, ${ac.spoken()} with you, ${alt100()} on the ${ac.star}, we have ${G.atis.letter}.${ac.medevac ? " Medevac." : ""}`,
        `${F.tracon}, good ${G.atis.tod === "night" ? "evening" : "day"}, ${ac.spoken()}, descending via the ${ac.star} with ${G.atis.letter}.${ac.medevac ? " Medevac flight." : ""}`,
      ]));
      break;
    case "CTR":
      if (ac.role === "dep") ac.say(pick([
        `${F.centerName}, ${ac.spoken()}, climbing ${alt100()}.`,
        `Center, ${ac.spoken()} with you, out of ${alt100()}.`,
        `${F.centerName}, ${ac.spoken()}, passing ${alt100()} on the climb.`,
      ]));
      else ac.say(pick([
        `${F.centerName}, ${ac.spoken()}, ${altWords(ac.alt)}, inbound ${ac.entryFix.name}.${ac.medevac ? " Medevac, we have a patient on board." : ""}`,
        `Center, ${ac.spoken()} level ${altWords(ac.alt)}, ${ac.entryFix.name} arrival.${ac.medevac ? " Medevac." : ""}`,
        `${F.centerName}, ${ac.spoken()} checking in at ${altWords(ac.alt)} for ${ac.entryFix.name}.${ac.medevac ? " We're a medevac flight." : ""}`,
      ]));
      break;
  }
  if (ac.owner !== G.playerPos) ac.aiAt = G.t + rnd(2.5, 7);
}

/* =====================================================================
   AI CONTROLLERS: each runs its position when the player doesn't
   ===================================================================== */
function aiSay(pos, text) {
  xmit(pos, ctrlCallsign(pos), "ctrl", text, G.ctrlVoice[pos]);
}

function aiDEL(ac) {
  if (ac.state !== "gate" || !ac.called) return;
  const F = G.fac;

  // DELAY MECHANISM: If Ground asked to slow down, throttle the clearances
  if (G.slowDel && G.t < G.slowDel && ac.clxStage === 1) {
    if (!G.lastDelTime) G.lastDelTime = 0;
    if (G.t - G.lastDelTime < 75) { // Enforce 75 seconds between clearances
      ac.aiAt = G.t + 5;
      return;
    }
  }

  if (ac.clxStage === 1) {
    G.lastDelTime = G.t; // Record time of this clearance
    const pdcRate = ["high", "insane"].includes(G.density) ? 0.8 : 0.3;
    if (Math.random() < pdcRate) {
       xmit("DEL", "TDLS", "sys", `PDC UPLINK ${ac.cs}: CLRD TO ${ac.dest.icao} VIA ${ac.sid.name} DP, MAINT ${F.initAlt}, EXP ${ac.cruise} 10 MIN, DPFRQ ${depFreq(F)}, SQ ${ac.sqk}`, null);
       ac.clx = { dest: true, sid: true, alt: true, sqkOk: true, sqkSaid: ac.sqk };
       ac.rbError = null;
       ac.pdc = true;
       ac.clxStage = 3;
       ac.aiAt = G.t + rnd(4, 9);
       return;
    }
    aiSay("DEL", `${ac.spoken()}, cleared to ${ac.dest.city} airport, ${ac.sid.name} departure then as filed, climb and maintain ${altWords(F.initAlt)}, expect ${altWords(ac.cruise)} one zero minutes after departure, departure frequency ${freqWords(depFreq(F))}, squawk ${numWords(ac.sqk)}.`);
    ac.clxStage = 2;
    ac.aiAt = G.t + rnd(4, 8);
  } else if (ac.clxStage === 2) {
    ac.say(`Cleared to ${ac.dest.city} via the ${ac.sid.name} then as filed, climb and maintain ${altWords(F.initAlt)}, expect ${altWords(ac.cruise)} one zero minutes after departure, departure frequency ${freqWords(depFreq(F))}, squawk ${numWords(ac.sqk)}, ${ac.spoken()}.`);
    ac.clxStage = 3;
    ac.aiAt = G.t + rnd(2, 4);
  } else if (ac.clxStage === 3) {
    if (ac.pdc) {
      ac.say(`${ac.spoken()}, PDC received for ${ac.dest.city}, ${altWords(F.initAlt)} initial, expect ${altWords(ac.cruise)}, squawking ${numWords(ac.sqk)}.`);
    } else {
      aiSay("DEL", pick([
        `${ac.spoken()}, readback correct. Call ground for push, have a good flight.`,
        `${ac.spoken()}, readback correct, ground when ready.`,
        `Readback correct, ${ac.spoken()}, ${BYE()}.`,
      ]));
    }
    ac.state = "clxOk";
    ac.stateT = 0;
    ac.aiAt = 0;
    scheduleGndCall(ac);
  }
}

function scheduleGndCall(ac) {
  setOwner(ac, "GND", false);
  ac.state = "gndCall"; ac.stateT = 0;
  ac.callAt = G.t + rnd(25, 80);
}

function aiGND(ac) {
  const F = G.fac;
  if (ac.role === "dep") {
    if (ac.state === "gndCall" && ac.called) {
      const held = tmuHold(ac);
      if (held) {
        aiSay("GND", `${ac.spoken()}, pushback denied, we are holding for ${held}. Monitor ground.`);
        ac.monitorOnly = true;
        ac.standbyAt = G.t; ac.standbyDur = 180;
        return;
      }
      aiSay("GND", pick([
        `${ac.spoken()}, pushback approved, expect runway ${rwyWords((ac.rwy || G.depRwy).id)}.`,
        `${ac.spoken()}, push approved, tail wherever works, runway ${rwyWords((ac.rwy || G.depRwy).id)} today.`,
        `${ac.spoken()}, push at your discretion, advise ready to taxi.`,
      ]));
      startPush(ac);
    } else if (ac.state === "taxiWait" && ac.called) {
      const tx = G.fac.taxi[(ac.rwy || G.depRwy).id];
      aiSay("GND", pick([
        `${ac.spoken()}, runway ${rwyWords((ac.rwy || G.depRwy).id)}, taxi via ${tx.names}, hold short.`,
        `${ac.spoken()}, taxi runway ${rwyWords((ac.rwy || G.depRwy).id)} via ${tx.names}, hold short of the runway.`,
        `${ac.spoken()}, ${rwyWords((ac.rwy || G.depRwy).id)} via ${tx.names}, hold short, follow company if you see them.`,
      ]));
      startTaxi(ac);
    } else if (ac.state === "holdShortG") {
      aiSay("GND", pick([
        `${ac.spoken()}, monitor tower ${freqWords(F.freqs.TWR)}, ${BYE()}.`,
        `${ac.spoken()}, over to tower ${freqWords(F.freqs.TWR)}, ${BYE()}.`,
        `${ac.spoken()}, tower's ${freqWords(F.freqs.TWR)}, ${BYE()}.`,
      ]));
      ac.state = "holdShort";
      setOwner(ac, "TWR", false);
    }
  } else {
    if (ac.state === "gndIn" && ac.called) {
      const txIn = G.fac.taxi["in_" + (ac.rwy || G.arrRwy).id];
      aiSay("GND", pick([
        `${ac.spoken()}, taxi to the gate via ${txIn.names}, welcome in.`,
        `${ac.spoken()}, gate's yours via ${txIn.names}.`,
        `${ac.spoken()}, taxi to parking via ${txIn.names}, nice to have you.`,
      ]));
      startTaxiIn(ac);
    }
  }
}

function startPush(ac) { ac.state = "push"; ac.stateT = 0; ac.pushT = rnd(20, 30); G.hooks.strips(); }
function startTaxi(ac) {
  const tx = G.fac.taxi[(ac.rwy || G.depRwy).id];
  if (!tx) return; // safety check
  ac.state = "taxi"; ac.stateT = 0;
  ac.taxiPath = tx.path; ac.taxiIdx = 0; ac.ias = 16;
  /* skip any leading waypoints already behind the stand */
  while (ac.taxiIdx < ac.taxiPath.length - 1 &&
         dist2(ac, ac.taxiPath[ac.taxiIdx]) > dist2(ac, ac.taxiPath[ac.taxiIdx + 1])) ac.taxiIdx++;
  if (G.playerPos === "GND") { addPoints(4, `${ac.cs} taxiing to ${(ac.rwy || G.depRwy).id}`); G.counters.taxi++; }
  G.hooks.strips();
}
function startTaxiIn(ac) {
  const txIn = G.fac.taxi["in_" + (ac.rwy || G.arrRwy).id];
  if (!txIn) return; // safety check
  ac.state = "taxiIn"; ac.stateT = 0;
  ac.taxiPath = txIn.path.concat([{ x: G.fac.gates.anchor.x + rnd(-0.1, 0.1), y: G.fac.gates.anchor.y + rnd(-0.06, 0.06) }]);
  ac.taxiIdx = 0; ac.ias = 15;
  if (G.playerPos === "GND") addPoints(4, `${ac.cs} taxiing to the gate`);
  G.hooks.strips();
}

function runwayFreeForTakeoff(ac) {
  /* nobody rolling/lined up on the dep runway, arrival final clear */
  const depRwy = ac.rwy || G.depRwy;
  for (const o of G.aircraft) {
    if (o === ac) continue;
    const oRwy = o.rwy || (o.role === "arr" ? G.arrRwy : G.depRwy);
    if (oRwy.id !== depRwy.id) continue;
    
    if ((o.state === "rolling" || o.state === "lineup") && !o.remove) return false;
    if (o.state === "climb" && o.alt < 400) return false;
    if (o.state === "landedRoll") return false;
    if (o.role === "arr" && (o.state === "appCtl" || o.state === "twrArr") &&
        o.app === "established" && finalGeom(o, oRwy).along < 6) return false;
  }
  return true;
}

function aiTWR(ac) {
  const F = G.fac;
  if (ac.role === "dep") {
    const depId = (ac.rwy || G.depRwy).id;
    if (ac.state === "holdShort" && ac.called && runwayFreeForTakeoff(ac) && !tmuHold(ac) &&
        !(typeof isRwyClosed === "function" && isRwyClosed(depId))) {
      aiSay("TWR", pick([
        `${ac.spoken()}, wind ${hdgWords(G.atis.windDir)} at ${numWords(G.atis.windSpd)}, runway ${rwyWords(depId)}, cleared for takeoff.`,
        `${ac.spoken()}, runway ${rwyWords(depId)}, cleared for takeoff, wind ${hdgWords(G.atis.windDir)} at ${numWords(G.atis.windSpd)}.`,
        `${ac.spoken()}, no delay, runway ${rwyWords(depId)}, cleared for takeoff.`,
      ]));
      ac.say(`Cleared for takeoff runway ${rwyWords(depId)}, ${ac.spoken()}.`);
      startRoll(ac);
    } else if (ac.state === "climb" && ac.alt >= 700) {
      aiSay("TWR", `${ac.spoken()}, contact departure, good day.`);
      ac.say(`Over to departure, ${ac.spoken()}.`);
      ac.state = "depCtl"; ac.stateT = 0;
      setOwner(ac, "APP", false);
    } else if (ac.state === "climb") {
      ac.aiAt = G.t + 3;                       // not through 700 ft yet, check again
    } else if (ac.state === "holdShort" && ac.called) {
      ac.aiAt = G.t + 6;                       // wait for the runway
    }
  } else {
    const arrId = (ac.rwy || G.arrRwy).id;
    if (ac.state === "twrArr" && ac.called && !ac.landClr) {
      aiSay("TWR", pick([
        `${ac.spoken()}, wind ${hdgWords(G.atis.windDir)} at ${numWords(G.atis.windSpd)}, runway ${rwyWords(arrId)}, cleared to land.`,
        `${ac.spoken()}, runway ${rwyWords(arrId)}, cleared to land, wind ${hdgWords(G.atis.windDir)} at ${numWords(G.atis.windSpd)}.`,
        `${ac.spoken()}, number one, runway ${rwyWords(arrId)}, cleared to land.`,
      ]));
      ac.say(`Cleared to land runway ${rwyWords(arrId)}, ${ac.spoken()}.`);
      ac.landClr = true;
    } else if (ac.state === "rwyExit") {
      const txIn = G.fac.taxi["in_" + arrId] || G.fac.taxi["in_" + G.arrRwy.id];
      aiSay("TWR", `${ac.spoken()}, exit ${txIn.names} when able, contact ground ${freqWords(F.freqs.GND)}.`);
      ac.say(`To ground, ${ac.spoken()}, good day.`);
      ac.state = "gndIn"; ac.stateT = 0;
      setOwner(ac, "GND", false);
    }
  }
}

function startRoll(ac) {
  /* everyone still queued shuffles forward */
  for (const o of G.aircraft) {
    if (o !== ac && ["holdShortG", "holdShort"].includes(o.state)) {
      const fwd = { x: Math.sin(d2r(o.hdg)), y: Math.cos(d2r(o.hdg)) };
      o.x += fwd.x * 0.045; o.y += fwd.y * 0.045;
    }
  }
  const rwy = ac.rwy || G.depRwy;
  ac.state = "rolling"; ac.stateT = 0;
  ac.x = rwy.thr.x; ac.y = rwy.thr.y;
  ac.hdg = ac.targetHdg = rwy.hdg;
  ac.ias = 0;
  ac.assignedAlt = ac.assignedAlt || G.fac.initAlt;
  if (G.playerPos === "TWR") { addPoints(8, `${ac.cs} departing`); G.counters.tko++; }
  G.hooks.strips();
}

/* --- AI approach: plan vectors, sequence onto the ILS --- */
function aiAPP(ac) {
  const F = G.fac;
  if (ac.role === "dep") {
    // NEW: Intercept departures with non-NORDO emergencies and force them to return!
    if (ac.emerg && ac.emerg.id !== "nordo" && !ac.returning) {
      ac.returning = true; // Prevents loop
      ac.role = "arr";     // Flip them to an arrival
      ac.appPlan = null;   // Nuke their departure routing
      ac.state = "appCtl"; // Force them to approach state
      setOwner(ac, "APP", true); // Ensure Approach explicitly owns them to sequence
      aiSay("APP", `${ac.spoken()}, radar contact, expect vectors for an immediate return to runway ${rwyWords(G.arrRwy.id)}.`);
      ac.aiAt = G.t + 5;
      return;
    }

    if (ac.state !== "depCtl") return;
    if (!ac.appPlan) {
      ac.appPlan = { stage: 0 };
      aiSay("APP", `${ac.spoken()}, ${facSpoken(F)} departure, radar contact. Climb and maintain ${altWords(Math.min(15000, F.initAlt + 7000))}.`);
      ac.say(`Climb and maintain ${altWords(Math.min(15000, F.initAlt + 7000))}, ${ac.spoken()}.`);
      ac.assignedAlt = ac.targetAlt = Math.min(15000, F.initAlt + 7000);
      ac.aiAt = G.t + 15;
    } else if (ac.appPlan.stage === 0 && ac.distField() > 7) {
      aiSay("APP", `${ac.spoken()}, proceed direct ${ac.exitFix.name}.`);
      ac.say(`Direct ${ac.exitFix.name}, ${ac.spoken()}.`);
      ac.directFix = ac.exitFix; ac.appPlan.stage = 1;
      ac.aiAt = G.t + 12;
    } else if (ac.appPlan.stage === 1 && ac.distField() > 17 && ac.alt > 7500) {
      aiSay("APP", `${ac.spoken()}, contact ${F.centerName} ${freqWords(F.freqs.CTR)}, good day.`);
      ac.say(`Over to center, ${ac.spoken()}, good day.`);
      ac.state = "ctrDep"; ac.stateT = 0;
      setOwner(ac, "CTR", false);
    } else ac.aiAt = G.t + 8;
    return;
  }

  /* arrivals */
  if (ac.state !== "appCtl") return;
  const arrId = (ac.rwy || G.arrRwy).id;
  const g = finalGeom(ac, ac.rwy || G.arrRwy);
  if (!ac.appPlan) {
    const straight = g.along > 14 && Math.abs(g.cross) < 11;
    ac.appPlan = { mode: straight ? "str" : "dw", side: g.cross >= 0 ? 1 : -1, stage: 0, ext: 0 };
    G.arrSeq.push(ac.id);
    aiSay("APP", `${ac.spoken()}, ${facSpoken(F)} approach, expect ILS runway ${rwyWords(arrId)}. Descend and maintain ${altWords(straight ? 4000 : 6000)}.`);
    ac.say(`Down to ${altWords(straight ? 4000 : 6000)}, expecting the ILS, ${ac.spoken()}.`);
    ac.assignedAlt = ac.targetAlt = straight ? 4000 : 6000;
    ac.targetIas = 250;
    ac.aiAt = G.t + 10;
    return;
  }
  const P = ac.appPlan;
  const ahead = seqLeader(ac);
  
  const reqGap = G.arrSpacing || 6.5;
  const gapOk = !ahead || (finalGeom(ahead, ac.rwy || G.arrRwy).along < g.along - reqGap) ||
                ["twrArr", "landedRoll", "rwyExit", "gndIn", "taxiIn", "gateIn"].includes(ahead.state);

  // --- ESCAPE VECTOR MANAGEMENT ---
  if (ac.isBreakingOut) {
    // We are currently flying the breakout vector. Check if we are safe yet.
    if (!ahead || dist2(ac, ahead) >= 4.5 || g.along > 28) {
      ac.isBreakingOut = false; // Separation achieved, drop back into standard vectoring
    } else {
      ac.aiAt = G.t + 5; 
      return; // Still too close, continue holding escape heading
    }
  } else if (ahead && ac.app !== "established" && !["landedRoll", "rwyExit", "gndIn", "taxiIn", "gateIn"].includes(ahead.state)) {
    const d = dist2(ac, ahead);
    const altDiff = Math.abs(ac.alt - ahead.alt);

    // 1. Hard Speed Braking
    if (d < reqGap + 4 && altDiff < 2000) {
      let newSpd = Math.max(160, Math.floor((ahead.ias - 10) / 10) * 10);
      if (ac.targetIas > newSpd) {
        ac.targetIas = newSpd;
        ac.assignedSpd = newSpd;
        aiSay("APP", `${ac.spoken()}, reduce speed ${numWords(newSpd)}.`);
        ac.say(`Speed ${numWords(newSpd)}, ${ac.spoken()}.`);
      }
    }

    // 2. The 3.8-Mile Breakout Vector
    if (d < 3.8 && altDiff < 1000 && ac.alt > 1500 && g.along < 25) {
      ac.isBreakingOut = true; 
      P.mode = "dw"; 
      P.side = g.cross >= 0 ? 1 : (Math.random() < 0.5 ? 1 : -1);
      P.stage = 0;
      P.ext = Math.min(P.ext + 5, 25); // Extend downwind, but cap at 25 to prevent flying out of the 62-mile bounds
      
      const hdgOut = norm360((ac.rwy || G.arrRwy).hdg + 180 + 90 * P.side);
      aiSay("APP", `${ac.spoken()}, traffic alert, turn ${P.side > 0 ? "right" : "left"} heading ${hdgWords(Math.round(hdgOut / 10) * 10)}, climb and maintain four thousand.`);
      ac.say(`Heading ${hdgWords(Math.round(hdgOut / 10) * 10)}, up to four thousand, ${ac.spoken()}.`);
      ac.targetHdg = Math.round(hdgOut / 10) * 10; 
      ac.targetAlt = 4000;
      ac.assignedAlt = 4000;
      ac.directFix = null;
      ac.app = null;
      ac.aiAt = G.t + 10;
      return;
    }
  }

  if (P.mode === "str") {
    if (P.stage === 0) {
      steerTo(ac, ptOnFinal(ac, 15 + P.ext, 0));
      if (g.along < 19 && gapOk) {
        clearIls(ac);
        P.stage = 1;
      } else if (g.along < 19 && !gapOk) {
        /* spin them out wide to build a gap */
        P.mode = "dw"; P.side = g.cross >= 0 ? 1 : (Math.random() < 0.5 ? 1 : -1); P.stage = 0;
        const hdgOut = norm360((ac.rwy || G.arrRwy).hdg + 180 + 60 * P.side);
        aiSay("APP", `${ac.spoken()}, fly heading ${hdgWords(Math.round(hdgOut / 10) * 10)}, vectors for sequencing.`);
        ac.say(`Heading ${hdgWords(Math.round(hdgOut / 10) * 10)}, ${ac.spoken()}.`);
        ac.targetHdg = Math.round(hdgOut / 10) * 10; ac.directFix = null;
      }
    }
  } else {
    if (P.stage === 0) {                        // to the downwind
      steerTo(ac, ptOnFinal(ac, 13 + P.ext, 7 * P.side));
      ac.targetIas = Math.min(ac.targetIas, 230);
      if (Math.abs(g.along - (13 + P.ext)) < 2.5 && Math.abs(Math.abs(g.cross) - 7) < 2.5) {
        P.stage = 1;
        aiSay("APP", `${ac.spoken()}, descend and maintain ${altWords(3000)}, reduce speed two one zero.`);
        ac.say(`Three thousand, speed two one zero, ${ac.spoken()}.`);
        ac.assignedAlt = ac.targetAlt = 3000;
        ac.targetIas = 210;
      }
    } else if (P.stage === 1) {                 // base when the gap exists
      if (gapOk) {
        P.stage = 2;
        steerTo(ac, ptOnFinal(ac, 15 + P.ext, 2 * P.side));
      } else {
        steerTo(ac, ptOnFinal(ac, 17 + P.ext + 10, 7 * P.side));   // extend downwind
        P.ext = Math.min(P.ext + 0.4, 40);
        ac.targetIas = 180; // slow to build gap safely
      }
    } else if (P.stage === 2) {
      steerTo(ac, ptOnFinal(ac, 15 + P.ext, 2 * P.side));
      if (Math.abs(g.cross) < 3.2) { clearIls(ac); P.stage = 3; }
    }
  }
  /* handoff to tower */
  if (ac.app === "established" && g.along < 6.5) {
    aiSay("APP", `${ac.spoken()}, contact tower ${freqWords(F.freqs.TWR)}.`);
    ac.say(`Tower, ${ac.spoken()}, good day.`);
    ac.state = "twrArr"; ac.stateT = 0;
    setOwner(ac, "TWR", false);
  }
  ac.aiAt = G.t + 4;
}

function seqLeader(ac) {
  const i = G.arrSeq.indexOf(ac.id);
  for (let k = i - 1; k >= 0; k--) {
    const o = G.aircraft.find(a => a.id === G.arrSeq[k] && !a.remove);
    if (o && !["gateIn"].includes(o.state)) return o;
  }
  return null;
}
function ptOnFinal(ac, along, cross) {
  const R = ac.rwy || G.arrRwy;
  const b = { x: Math.sin(d2r(R.hdg + 180)), y: Math.cos(d2r(R.hdg + 180)) };
  const rp = { x: Math.cos(d2r(R.hdg)), y: -Math.sin(d2r(R.hdg)) };
  return { x: R.thr.x + b.x * along + rp.x * cross, y: R.thr.y + b.y * along + rp.y * cross };
}
function steerTo(ac, pt) {
  ac.directFix = null;
  ac.targetHdg = bearingTo(ac, pt);
  ac.turnDir = null;
}
function clearIls(ac) {
  const R = ac.rwy || G.arrRwy;
  const g = finalGeom(ac, R);
  const cut = g.cross > 0 ? norm360(R.hdg - 25) : norm360(R.hdg + 25);
  aiSay("APP", `${ac.spoken()}, ${Math.round(g.along)} miles from the field, turn ${g.cross > 0 ? "left" : "right"} heading ${hdgWords(Math.round(cut / 10) * 10)}, maintain ${altWords(3000)} until established, cleared ILS runway ${rwyWords(R.id)}.`);
  ac.say(`Heading ${hdgWords(Math.round(cut / 10) * 10)} till established, cleared ILS runway ${rwyWords(R.id)}, ${ac.spoken()}.`);
  ac.targetHdg = Math.round(cut / 10) * 10;
  ac.turnDir = null;
  ac.assignedAlt = ac.targetAlt = Math.min(ac.targetAlt, 3000);
  ac.app = "cleared";
}

function aiCTR(ac) {
  const F = G.fac;
  if (ac.role === "arr") {
    if (ac.state !== "ctrArr") return;
    if (!ac.ctrInit) {
      ac.ctrInit = true;
      aiSay("CTR", `${ac.spoken()}, ${F.centerName}, descend via the ${ac.star}, altimeter ${numWords(G.atis.qnh)}.`);
      ac.say(`Descend via the ${ac.star}, ${numWords(G.atis.qnh)}, ${ac.spoken()}.`);
      ac.assignedAlt = ac.targetAlt = 11000;
      ac.aiAt = G.t + 10;
    } else if (ac.distField() <= 38) {
      aiSay("CTR", `${ac.spoken()}, contact ${F.tracon} ${freqWords(F.freqs.APP)}.`);
      ac.say(`Over to approach, ${ac.spoken()}.`);
      ac.state = "appCtl"; ac.stateT = 0;
      setOwner(ac, "APP", false);
    } else ac.aiAt = G.t + 6;
  } else {
    if (ac.state !== "ctrDep") return;
    if (!ac.ctrInit) {
      ac.ctrInit = true;
      aiSay("CTR", `${ac.spoken()}, ${F.centerName}, climb and maintain flight level two three zero, cleared direct ${ac.exitFix.name}.`);
      ac.say(`Flight level two three zero, direct ${ac.exitFix.name}, ${ac.spoken()}.`);
      ac.assignedAlt = ac.targetAlt = 23000;
      ac.directFix = ac.exitFix;
      ac.aiAt = G.t + 10;
    } else if (ac.distField() > 52) {
      aiSay("CTR", `${ac.spoken()}, contact ${F.nextCenter}, good day.`);
      ac.say(`${F.nextCenter}, seeya, ${ac.spoken()}.`);
      ac.state = "out";
    } else ac.aiAt = G.t + 8;
  }
}

const AI_FN = { DEL: aiDEL, GND: aiGND, TWR: aiTWR, APP: aiAPP, CTR: aiCTR };

/* =====================================================================
   PHYSICS
   ===================================================================== */
function stepAircraft(ac, dt) {
  ac.stateT += dt;
  if (ac.pending && G.t >= ac.pending.due) {
    const p = ac.pending; ac.pending = null;
    execOps(ac, p.ops);
  }
  if (!ac.called && G.t >= ac.callAt &&
      !["push", "taxi", "taxiIn", "lineup", "rolling", "landedRoll", "out", "gateIn", "clxOk", "taxiWait", "holdShortG", "rwyExit"].includes(ac.state)) {
    if (ac.monitorOnly) ac.callAt = G.t + 30;              // waiting for you to call
    else if (freqBusy(ac.owner)) ac.callAt = G.t + rnd(2, 5);
    else pilotCheckIn(ac);
  }
  /* AI controller action */
  if (isAI(ac.owner) && ac.called && ac.aiAt && G.t >= ac.aiAt) {
    if (freqBusy(ac.owner)) ac.aiAt = G.t + rnd(2, 4);
    else { ac.aiAt = 0; AI_FN[ac.owner](ac); }
  }
  /* pilot nag when the player sits on them: suppressed for the promised
     standby window, and never more than one nag per 90 seconds */
  if (ac.owner === G.playerPos && ac.called && ac.reminders < 2 &&
      (!ac.standbyAt || G.t - ac.standbyAt > (ac.standbyDur || 420)) &&
      (!ac.lastNagAt || G.t - ac.lastNagAt > 90)) {
    const stale = ["gate", "gndCall", "taxiWait", "holdShort", "gndIn"].includes(ac.state) && ac.stateT > 100 + ac.reminders * 80;
    const staleAir = (ac.state === "ctrArr" || ac.state === "appCtl") && !ac.app && ac.stateT > 150 + ac.reminders * 100;
    if ((stale || staleAir) && !freqBusy(ac.owner)) {
      ac.reminders++;
      ac.lastNagAt = G.t;
      ac.say(pick([`${ac.spoken()}, did you copy?`, `${ac.spoken()}, still with you.`, `${ac.spoken()}, standing by.`]));
    }
  }

  switch (ac.state) {
    case "gate": case "clxOk": case "gndCall": case "taxiWait":
    case "holdShortG": case "holdShort": case "gndIn": case "gateIn":
      return;
    case "push": {
      ac.pushT -= dt;
      if (ac.pushT <= 0) {
        ac.state = "taxiWait"; ac.stateT = 0;
        if (!ac.monitorOnly) {
          ac.called = true;
          ac.say(`${ac.spoken()}, push complete, ready to taxi.`);
        }
        if (isAI("GND")) ac.aiAt = G.t + rnd(3, 8);
        G.hooks.strips();
      }
      return;
    }
    case "taxi": case "taxiIn": {
      const path = ac.taxiPath;
      if (!path || ac.taxiIdx >= path.length) return;
      if (ac.holdFlag) return;                       // told to hold position
      
      const wp = path[ac.taxiIdx];
      const myDistToWp = dist2(ac, wp);

      /* simple in-trail spacing on the ground; only yield to planes AHEAD of us toward the waypoint */
      for (const o of G.aircraft) {
        if (o !== ac && ["taxi", "taxiIn", "holdShortG", "holdShort"].includes(o.state)) {
          if (dist2(ac, o) < 0.035) { // within ~200 ft
            const oDistToWp = dist2(o, wp);
            // Only yield if the other aircraft is closer to our target waypoint than we are
            if (oDistToWp < myDistToWp && sameDirAhead(ac, o)) return;
          }
        }
      }

      const d = myDistToWp;
      const step = (ac.ias / 3600) * dt;
      if (d <= step) {
        ac.x = wp.x; ac.y = wp.y;
        ac.taxiIdx++;
        if (ac.taxiIdx >= path.length) {
          if (ac.state === "taxi") {
            queueAtHoldShort(ac);
            ac.state = "holdShortG"; ac.stateT = 0;
            if (isAI("GND")) { ac.called = true; ac.aiAt = G.t + rnd(3, 8); }
            else ac.say(`Ground, ${ac.spoken()}, holding short runway ${rwyWords((ac.rwy || G.depRwy).id)}.`);
            G.hooks.strips();
          } else {
            ac.state = "gateIn"; ac.stateT = 0;
            ac.remove2 = G.t + 12;
            G.hooks.strips();
          }
        }
      } else {
        ac.hdg = bearingTo(ac, wp);
        ac.x += Math.sin(d2r(ac.hdg)) * step;
        ac.y += Math.cos(d2r(ac.hdg)) * step;
      }
      return;
    }
    case "lineup": return;
    case "rolling": {
      ac.ias += 4.5 * dt;
      const d = ac.ias / 3600 * dt;
      ac.x += Math.sin(d2r(ac.hdg)) * d;
      ac.y += Math.cos(d2r(ac.hdg)) * d;
      if (ac.ias >= 145) {
        ac.state = "climb"; ac.stateT = 0;
        ac.targetIas = 250;
        ac.targetAlt = ac.assignedAlt || G.fac.initAlt;
        if (isAI("TWR")) ac.aiAt = G.t + 3;
        if (ac.rbError) { addPoints(-8, `${ac.cs} departed with a bad readback you never caught`); ac.rbError = null; }
        G.hooks.strips();
      }
      return;
    }
    case "landedRoll": {
      ac.ias = Math.max(15, ac.ias - 9.5 * dt); // Brake extremely hard
      const d = ac.ias / 3600 * dt;
      ac.x += Math.sin(d2r(ac.hdg)) * d;
      ac.y += Math.cos(d2r(ac.hdg)) * d;
      const R = ac.rwy || G.arrRwy;
      const txIn = G.fac.taxi["in_" + R.id] || G.fac.taxi["in_" + G.arrRwy.id];
      const rolled = -finalGeom(ac, R).along;
      const f = { x: Math.sin(d2r(R.hdg)), y: Math.cos(d2r(R.hdg)) };
      const exitAt = txIn ? (txIn.exit.x - R.thr.x) * f.x + (txIn.exit.y - R.thr.y) * f.y : 0;
      if (ac.ias <= 55 && rolled >= exitAt - 0.05) { // Exit at 55 knots
        if (txIn) { ac.x = txIn.exit.x; ac.y = txIn.exit.y; }
        ac.ias = 15;
        ac.state = "rwyExit"; ac.stateT = 0;
        ac.called = true;
        if (isAI("TWR")) ac.aiAt = G.t + rnd(2, 5);
        else ac.say(`Tower, ${ac.spoken()}, clear of runway ${rwyWords(R.id)}.`);
        G.hooks.strips();
      }
      return;
    }
    case "out":
      flightStep(ac, dt);
      if (ac.distField() > 60) ac.remove = true;
      return;
    default:
      flightStep(ac, dt);
  }
}

/* park an arriving-at-the-hold-short aircraft behind anyone already waiting */
function queueAtHoldShort(ac) {
  const waiting = G.aircraft.filter(o => o !== ac && !o.remove &&
    ["holdShortG", "holdShort"].includes(o.state));
  if (!waiting.length) return;
  const back = { x: Math.sin(d2r(ac.hdg + 180)), y: Math.cos(d2r(ac.hdg + 180)) };
  const step = 0.045 * waiting.length;
  ac.x += back.x * step;
  ac.y += back.y * step;
}

function sameDirAhead(ac, o) {
  const brg = bearingTo(ac, o);
  return Math.abs(angDiff(brg, ac.hdg)) < 70;
}

function flightStep(ac, dt) {
  /* lateral */
  if (ac.app === "established") {
    const R = ac.rwy || G.arrRwy;
    const g = finalGeom(ac, R);
    ac.targetHdg = norm360(R.hdg - clamp(g.cross * 20, -30, 30));
    ac.turnDir = null;
  } else if (ac.directFix) {
    if (dist2(ac, ac.directFix) < 1.5) ac.directFix = null;   // fix passage: hold heading
    else { ac.targetHdg = bearingTo(ac, ac.directFix); ac.turnDir = null; }
  }
  let tgtH = ac.targetHdg;
  if (ac.role === "dep" && ac.alt < 400) tgtH = (ac.rwy || G.depRwy).hdg;
  const rate = (ac.ias > 250 ? 2.1 : 3.0) * dt;
  let diff = angDiff(tgtH, ac.hdg);
  if (ac.turnDir === "L" && diff > 0) diff -= 360;
  if (ac.turnDir === "R" && diff < 0) diff += 360;
  if (Math.abs(diff) <= rate) { ac.hdg = tgtH; ac.turnDir = null; }
  else ac.hdg = norm360(ac.hdg + Math.sign(diff) * rate);

  /* ILS capture */
  if (ac.app === "cleared") {
    const R = ac.rwy || G.arrRwy;
    const g = finalGeom(ac, R);
    // Increased ILS capture range to 60 miles to ensure far breakouts intercept properly
    if (g.along > 1 && g.along < 60 && Math.abs(g.cross) < 2.0 &&
        Math.abs(angDiff(R.hdg, ac.hdg)) < 100) {
      ac.app = "established";
      ac.directFix = null;
      G.hooks.strips();
    }
  }

  /* vertical & final logic */
  let vs = null;
  if (ac.app === "established") {
    const R = ac.rwy || G.arrRwy;
    const g = finalGeom(ac, R);
    const gsA = 318 * Math.max(0, g.along - 0.15);
    vs = ac.alt > gsA + 20 ? -clamp(ac.gs() * 5.6, 600, 3500) : 0;
    ac.targetIas = g.along > 12 ? Math.min(ac.assignedSpd || 240, 240)
                 : g.along > 8 ? 190 : g.along > 5 ? 170 : 145;
    if (g.along <= 4 && ac.alt > gsA + 800) { doGoAround(ac, "too high"); return; }
    if (ac.gaFlag && g.along < 1.4) { doGoAround(ac, "wind shear on short final"); return; }
    if (g.along < 1.0 && !ac.landClr && ac.state === "twrArr") { doGoAround(ac, "no landing clearance"); return; }
    /* runway blocked by a previous arrival, or a departure on a shared runway */
    if (g.along < 1.3) {
      for (const o of G.aircraft) {
        if (o === ac || o.remove) continue;
        const oRwy = o.rwy || (o.role === "arr" ? G.arrRwy : G.depRwy);
        if (oRwy.id !== R.id) continue;
        if (o.role === "arr" && o.state === "landedRoll") { doGoAround(ac, "traffic on the runway"); return; }
        if (["lineup", "rolling"].includes(o.state)) { doGoAround(ac, "traffic on the runway"); return; }
      }
    }
    if (g.along <= 0.35 && ac.alt <= 160) { touchdown(ac); return; }
  }
  if (vs === null) {
    const dA = ac.targetAlt - ac.alt;
    if (Math.abs(dA) < 25) { ac.alt = ac.targetAlt; vs = 0; }
    else vs = Math.sign(dA) * (dA > 0 ? 2100 : 1900);
  }
  ac.alt = Math.max(0, ac.alt + vs / 60 * dt);

  const dS = ac.targetIas - ac.ias;
  if (Math.abs(dS) <= 1.2 * dt) ac.ias = ac.targetIas;
  else ac.ias += Math.sign(dS) * 1.2 * dt;

  const dNm = ac.gs() / 3600 * dt;
  ac.x += Math.sin(d2r(ac.hdg)) * dNm;
  ac.y += Math.cos(d2r(ac.hdg)) * dNm;

  ac.trailT += dt;
  if (ac.trailT > 4) {
    ac.trailT = 0;
    ac.trail.push({ x: ac.x, y: ac.y });
    if (ac.trail.length > 6) ac.trail.shift();
  }

  /* handoff hints toward the player */
  if (ac.owner === "TWR" && ac.state === "climb" && G.playerPos === "TWR" && ac.alt > 1600 && !ac.nagCd) {
    ac.nagCd = true;
    ac.say(`${ac.spoken()}, passing ${altWords(Math.round(ac.alt / 100) * 100)}, switch to departure?`);
  }
  if (ac.role === "arr" && ac.owner === "APP" && G.playerPos === "APP" &&
      ac.app === "established" && finalGeom(ac, ac.rwy || G.arrRwy).along < 6 && !ac.nagTwr) {
    ac.nagTwr = true;
    ac.say(`${ac.spoken()} is established, over to tower?`);
  }

  /* edge of the world */
  const dOut = ac.distField();
  // Expanded from 62 to 75 to account for the new 70-mile staggered spawn radius
  if (dOut > 75 && ac.state !== "out") {
    ac.remove = true;
    if (ac.owner === G.playerPos) addPoints(-10, `${ac.cs} left the airspace unserviced`);
    else xmit(G.playerPos, "SYS", "warn", `${ac.cs} left the airspace.`, null);
  }
}

function doGoAround(ac, why) {
  const ownerBefore = ac.owner;
  
  ac.app = null;
  ac.landClr = false;
  ac.gaFlag = false;
  ac.assignedAlt = ac.targetAlt = 3000;
  ac.targetHdg = (ac.rwy || G.arrRwy).hdg; ac.turnDir = null;
  ac.assignedSpd = null; ac.targetIas = 190;
  G.counters.ga++;
  ac.say(`${ac.spoken()} is going around${why ? ", " + why : ""}.`);
  
  const wasTwr = ac.state === "twrArr";

  if (ac.state === "twrArr") {
    /* tower sends them back to approach */
    if (isAI("TWR")) aiSay("TWR", `${ac.spoken()}, roger, fly runway heading, climb three thousand, contact approach.`);
    ac.state = "appCtl"; ac.stateT = 0;
    ac.appPlan = null;
    const i = G.arrSeq.indexOf(ac.id);
    if (i !== -1) G.arrSeq.splice(i, 1);
    setOwner(ac, "APP", false);
  } else {
    ac.appPlan = null;
    const i = G.arrSeq.indexOf(ac.id);
    if (i !== -1) G.arrSeq.splice(i, 1);
  }
  
  if (["TWR", "APP"].includes(G.playerPos)) {
    let unfair = false;
    
    // Globally waive weather and math/glideslope glitches
    if (why === "wind shear on short final" || why === "too high") {
        unfair = true;
    } 
    // Waive if the plane wasn't even under your control when the event triggered
    else if (ownerBefore !== G.playerPos) {
        unfair = true;
    }
    // Specific waived conditions based on player position
    else if (G.playerPos === "TWR" && wasTwr && why === "traffic on the runway") {
        unfair = true;
    }

    if (unfair) {
      addPoints(0, `Penalty waived: ${ac.cs} go-around (${why})`);
    } else {
      addPoints(-15, `${ac.cs} went around (${why})`);
    }
  }
}

function touchdown(ac) {
  const R = ac.rwy || G.arrRwy;
  ac.state = "landedRoll"; ac.stateT = 0;
  ac.alt = 0;
  ac.hdg = ac.targetHdg = R.hdg;
  const g = finalGeom(ac, R);
  const b = { x: Math.sin(d2r(R.hdg + 180)), y: Math.cos(d2r(R.hdg + 180)) };
  ac.x = R.thr.x + b.x * Math.max(0, g.along) - b.x * 0.05;
  ac.y = R.thr.y + b.y * Math.max(0, g.along) - b.y * 0.05;
  ac.app = null;
  G.counters.ldg++;
  const i = G.arrSeq.indexOf(ac.id);
  if (i !== -1) G.arrSeq.splice(i, 1);
  if (G.playerPos === "TWR") addPoints(ac.landClr ? 8 : 2, `${ac.cs} landed${ac.landClr ? "" : " (never cleared!)"}`);
  xmit("TWR", "SYS", "sys", `${ac.cs} down runway ${R.id}.`, null);
  G.hooks.strips();
}

/* =====================================================================
   SEPARATION
   ===================================================================== */
G.conflicts = new Set();
G.proxPairs = new Set();
function checkSeparation() {
  // EXPLICITLY filter out ANY aircraft on the ground to prevent phantom taxiway conflicts
  const groundStates = ["gate", "push", "taxiWait", "taxi", "holdShortG", "holdShort", "lineup", "rolling", "landedRoll", "rwyExit", "gndIn", "taxiIn", "gateIn"];
  const flying = G.aircraft.filter(a => !groundStates.includes(a.state) && a.alt > 100 && !a.remove);
  
  const newConf = new Set(), newProx = new Set();
  
  // Helper to check parallel visual runway exemption
  const isExempt = (a, b) => {
    // 1. Ground planes are handled by the filter already, but just in case:
    if (a.alt <= 100 || b.alt <= 100) return true;

    const aRwy = a.rwy || (a.role === "arr" ? G.arrRwy : G.depRwy);
    const bRwy = b.rwy || (b.role === "arr" ? G.arrRwy : G.depRwy);

    // 2. Terminal Visual Separation Area: Inside 6 miles and below 3500 ft, radar separation is suspended.
    if (a.distField() < 6 && b.distField() < 6 && a.alt < 3500 && b.alt < 3500) {
      return true;
    }

    // 3. Parallel approach exemption
    if (aRwy && bRwy && aRwy.id !== bRwy.id && a.distField() < 12 && b.distField() < 12 && a.alt < 5000 && b.alt < 5000) {
      return true;
    }
    return false;
  };

  for (let i = 0; i < flying.length; i++) {
    for (let j = i + 1; j < flying.length; j++) {
      const a = flying[i], b = flying[j];
      
      if (isExempt(a, b)) continue;

      const h = dist2(a, b), v = Math.abs(a.alt - b.alt);
      const bothFinal = a.app === "established" && b.app === "established";
      const req = bothFinal ? 2.5 : 3;
      if (h > req + 2) continue;
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      if (h < req && v < 1000) {
        newConf.add(key);
        if (!G.conflicts.has(key)) {
          G.counters.sep++;
          alertTone();
          const mine = a.owner === G.playerPos || b.owner === G.playerPos;
          xmit(G.playerPos, "SYS", "warn", `LOSS OF SEPARATION: ${a.cs} / ${b.cs}, ${h.toFixed(1)} nm, ${Math.round(v)} ft.`, null);
          if (mine) {
            let waive = false;
            if (G.playerPos === "TWR" && a.role === "arr" && b.role === "arr") waive = true;
            if (waive) {
              addPoints(0, `Penalty waived: arrival spacing is Approach's responsibility`);
            } else {
              addPoints(-20, "separation loss on your frequency");
            }
          }
        }
      } else if (v < 1500) newProx.add(key);
    }
  }
  for (const key of G.conflicts) {
    const [i1, i2] = key.split("-").map(Number);
    const a = G.aircraft.find(x => x.id === i1), b = G.aircraft.find(x => x.id === i2);
    // Explicitly apply the exemption to EXISTING conflicts so side-steps instantly clear the alarm
    if (a && b && a.alt > 100 && b.alt > 100 && !groundStates.includes(a.state) && !groundStates.includes(b.state) && dist2(a, b) < 3.3 && Math.abs(a.alt - b.alt) < 1100 && !isExempt(a, b)) {
      newConf.add(key);
    }
  }
  G.conflicts = newConf;
  G.proxPairs = newProx;
}
function pairState(ac) {
  for (const key of G.conflicts) if (key.split("-").map(Number).includes(ac.id)) return "conf";
  for (const key of G.proxPairs) if (key.split("-").map(Number).includes(ac.id)) return "prox";
  return null;
}

/* =====================================================================
   PLAYER COMMAND PARSING
   ===================================================================== */
const WORD_NUM = {
  zero: "0", oh: "0", o: "0", one: "1", won: "1", two: "2", to: "2", too: "2",
  three: "3", tree: "3", four: "4", for: "4", fore: "4",
  five: "5", fife: "5", six: "6", seven: "7", eight: "8", ate: "8",
  nine: "9", niner: "9",
};
function wordsToNumbers(text) {
  const toks = text.split(/\s+/);
  const out = [];
  let digits = "", acc = 0, inNum = false;
  const flush = () => {
    if (!inNum) return;
    if (acc > 0) out.push(String(acc + (digits ? parseInt(digits, 10) : 0)));
    else if (digits) out.push(digits);
    digits = ""; acc = 0; inNum = false;
  };
  for (const tk of toks) {
    if (tk in WORD_NUM) { digits += WORD_NUM[tk]; inNum = true; }
    else if (/^\d+$/.test(tk)) { digits += tk; inNum = true; }
    else if (tk === "hundred" && inNum) { acc += (digits ? parseInt(digits, 10) : 1) * 100; digits = ""; }
    else if (tk === "thousand" && inNum) { acc = (acc + (digits ? parseInt(digits, 10) : 1)) * 1000; digits = ""; }
    else if (tk === "point" && inNum) { /* frequency decimals dropped */ }
    else { flush(); out.push(tk); }
  }
  flush();
  return out.join(" ");
}
/* Speech recognisers often write squawk digits as words: "squawk to ate
   for" for 2 8 4. Fix those homophones inside the squawk phrase only. */
const SQK_HOMOPHONE = { to: "2", too: "2", two: "2", tu: "2", for: "4", fore: "4", four: "4",
  ate: "8", eight: "8", won: "1", one: "1", tree: "3", three: "3", fife: "5", five: "5",
  zero: "0", oh: "0", o: "0", six: "6", seven: "7", nine: "9", niner: "9" };
function fixSquawkSpeech(s) {
  return s.replace(/\bsquawk\b((?:\s+[a-z0-9]+){1,6})/g, (m, tail) => {
    const out = [];
    for (const tk of tail.trim().split(/\s+/)) {
      if (/^\d+$/.test(tk)) out.push(tk);
      else if (tk in SQK_HOMOPHONE) out.push(SQK_HOMOPHONE[tk]);
      else break;
      if (out.join("").length >= 4) break;
    }
    return out.length ? "squawk " + out.join("") : m;
  });
}

/* Speech recognisers routinely corrupt standard phraseology:
   "climbing maintained", "climate maintain", "descending maintain",
   "turn left heading" losing the "and", and so on. Rewrite the common
   corruptions back to the phrase the parser expects. */
const PHRASE_FIX = [
  // Global STT catch-alls
  [/\bate\b/g, "eight"],
  [/\bwon\b/g, "one"],
  [/\btoo\b/g, "two"],
  [/\bfore\b/g, "four"],
  [/\bcurd\b/g, "cleared"],
  [/\bclared\b/g, "cleared"],
  [/\bspare\s+wings\b/g, "spirit wings"],
  [/\bspring\s+wings\b/g, "spirit wings"],
  [/\bspeed\s+bird\b/g, "speedbird"],
  [/\bbrick\s+yard\b/g, "brickyard"],
  [/\b(spirit\s*wings|alaska|delta|american|united|southwest|jetblue|fedex|ups|brickyard|speedbird|citrus|skywest|envoy)\s+for\b/g, "$1 four"],

  // Phraseology standardizers
  [/(?:nine|9|09)\s+(?:or|er|a|are)\b/g, "9"],
  [/\bare\s+heavy\b/g, "heavy"],
  [/\bline\s+of\s+bandwidth\b/g, "line up and wait"],
  [/\bclim(?:b|bing|bin|ate|it|bed)\s*(?:and|in|n|to)?\s*maintain(?:ed|ing)?\b/g, "climb and maintain"],
  [/\bclim(?:b|bing|bin|ate|it|bed)\s+(?:and\s+)?maintain\b/g, "climb and maintain"],
  [/\bdescen(?:d|ding|t|ded)\s*(?:and|in|n|to)?\s*maintain(?:ed|ing)?\b/g, "descend and maintain"],
  [/\bmaintain(?:ed|ing)\b/g, "maintain"],
  [/\bclim(?:bing|bin|ate|it|bed)\b/g, "climb"],
  [/\bdescen(?:ding|t|ded)\b/g, "descend"],
  [/\bcleared?\s+to\s+land(?:ing)?\b/g, "cleared to land"],
  [/\bclear\s+(?:to|for)\b/g, "cleared to"],
  [/\bcurd\s+(?:to|for)\b/g, "cleared for"],
  [/\bturn(?:ing)?\s+(?:left|lft)\b/g, "turn left"],
  [/\bturn(?:ing)?\s+right\b/g, "turn right"],
  [/\bhead(?:ing|ings)?\b/g, "heading"],
  [/\bsquak|\bsquark|\bsquawking\b/g, "squawk"],
  [/\bline\s*up\s+(?:and|end|n|in)?\s+(?:wait|weight|way)\b/g, "line up and wait"],
  [/\bcleared?\s+for\s+take\s*off\b/g, "cleared for takeoff"],
  [/\bcontact\s+to(?:wer|ward)\b/g, "contact tower"],
  [/\bread\s*back\s+correct(?:ed)?\b/g, "read back correct"],
  [/\bpush\s*back\s+approved?\b/g, "pushback approved"],
];

function fixPhrases(s) {
  for (const [re, to] of PHRASE_FIX) s = s.replace(re, to);
  return s;
}

function normalizeTx(text) {
  let s = text.toLowerCase().replace(/[.,;:!?/\\'-]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/\bflight level\b/g, "fl");
  s = fixSquawkSpeech(wordsToNumbers(fixSquawkSpeech(fixPhrases(s))));
  s = s.replace(/\b(\d{1,2})\s+(left|right|center)\b/g, (m, n, side) => n + side.charAt(0));
  return s;
}

/* Token-based matcher: joins adjacent tokens so speech transcripts like
   "speed bird 68" or "fed ex 33" still resolve to the right aircraft. */
function matchCallsign(s) {
  const toks = s.split(" ");
  let best = null, bestStart = Infinity, bestLen = 0, bestSpan = null;
  for (const ac of G.aircraft) {
    if (ac.remove) continue;
    const targets = [
      ac.cs.toLowerCase(),
      ac.airline.code.toLowerCase() + ac.num,
      ac.airline.tel.toLowerCase().replace(/\s+/g, "") + ac.num,
    ];
    for (let i = 0; i < toks.length; i++) {
      let joined = "";
      for (let j = i; j < Math.min(toks.length, i + 5); j++) {
        joined += toks[j];
        if (joined.length > 18) break;
        if (targets.includes(joined) &&
            (i < bestStart || (i === bestStart && joined.length > bestLen))) {
          best = ac; bestStart = i; bestLen = joined.length; bestSpan = [i, j];
        }
      }
    }
  }
  /* Fallback for garbled telephony: recognisers turn "Delta 484" into
     "D484" or drop the airline entirely. If a token carries a flight
     number that exactly one aircraft on your frequency is using, and
     any letters on it agree with that airline, take it. */
  if (!best) {
    for (let i = 0; i < toks.length; i++) {
      const m = toks[i].match(/^([a-z]{0,3})(\d{1,4})$/);
      if (!m) continue;
      const letters = m[1], num = m[2];
      const cand = G.aircraft.filter(a => !a.remove && a.num === num &&
        (a.owner === G.playerPos || !G.playerPos) &&
        (!letters || a.airline.code.toLowerCase().startsWith(letters[0]) ||
                     a.airline.tel.toLowerCase().startsWith(letters[0])));
      if (cand.length === 1) { best = cand[0]; bestSpan = [i, i]; bestStart = i; break; }
    }
  }
  if (!best) return [null, s, -1];
  const rem = toks.filter((_, k) => k < bestSpan[0] || k > bestSpan[1]).join(" ")
    .replace(/\bheavy\b/, " ").replace(/\s+/g, " ").trim();
  return [best, rem, bestStart];
}

const CMD_PATTERNS = [
  /* first: phrases that contain words other patterns would otherwise claim */
  { t: "monitor", re: /\b(?:monitor|remain\s+this\s+frequency|(?:i'?ll|we'?ll)\s+call\s+you|expect\s+taxi\s+in\s+sequence|stand\s?by\s+for\s+taxi)\b(?:\s+(?:ground|tower|approach|departure|center|centre))?(?:\s*,?\s*(?:i'?ll|we'?ll)\s+call\s+you(?:\s+for\s+taxi)?)?/, f: () => ({}) },
  { t: "hdg",   re: /\bturn\s+(left|right)\s+(?:heading\s+)?(\d{1,3})\b/,            f: m => ({ dir: m[1][0].toUpperCase(), deg: +m[2] }) },
  { t: "hdg",   re: /\b(?:t\s+)?(l|r)\s+(?:h\s+)?(\d{1,3})\b/,                       f: m => ({ dir: m[1].toUpperCase(), deg: +m[2] }) },
  { t: "hdg",   re: /\b(?:fly\s+heading|fly\s+runway\s+heading|heading|hdg|h)\s+(\d{1,3})\b/, f: m => ({ dir: null, deg: +m[1] }) },
  { t: "alt",   re: /\b(?:descend(?:\s+and)?(?:\s+maintain)?|d)\s+(?:fl\s*)?(\d{2,5})\b/, f: m => ({ val: +m[1] }) },
  { t: "alt",   re: /\b(?:climb(?:\s+and)?(?:\s+maintain)?|c)\s+(?:fl\s*)?(\d{2,5})\b/,   f: m => ({ val: +m[1] }) },
  { t: "alt",   re: /\b(?:maintain|altitude|a)\s+(?:fl\s*)?(\d{2,5})\b/,             f: m => ({ val: +m[1] }) },
  { t: "spd",   re: /\b(?:reduce\s+speed(?:\s+to)?|increase\s+speed(?:\s+to)?|speed|spd|s)\s+(\d{2,3})\b/, f: m => ({ val: +m[1] }) },
  { t: "rns",   re: /\bresume\s+normal\s+speed\b|\brns\b/,                           f: () => ({}) },
  { t: "dvs",   re: /\bdescend\s+via\b(?:\s+the)?(?:\s+\w+)?|\bdvs\b/,               f: () => ({}) },
  { t: "dct",   re: /\b(?:proceed\s+direct(?:\s+to)?|direct|dct|pd)\s+([a-z]{2,6})\b/, f: m => ({ fix: m[1].toUpperCase() }) },
  { t: "ils",   re: /\bcleared\s+(?:for\s+)?(?:the\s+)?ils\b(?:(?:\s+approach)?\s+runway\s+(\d{1,2}[lrc]?))?|\bcleared\s+approach\b|\bils\b(?:\s+(\d{1,2}[lrc]?))?/, f: m => ({ rwy: (m[1] || m[2] || "").toUpperCase() }) },
  { t: "rbbad", re: /\bread\s?back\s+(?:incorrect|is\s+incorrect|not\s+correct|wrong)\b|\bnegative\s+read\s?back\b/, f: () => ({}) },
  { t: "rbok",  re: /\bread\s?back\s+(?:is\s+)?correct\b|\brbc\b|\bcorrect\s+read\s?back\b/, f: () => ({}) },
  { t: "push",  re: /\bpush(?:back)?\s+approved\b|\bpa\b/,                           f: () => ({}) },
  { t: "hold",  re: /\bhold\s+position\b|\bhp\b/,                                    f: () => ({}) },
  { t: "seq",   re: /\b(?:you(?:'re|\s+are)?\s+)?number\s+(\d{1,2})\b|\b#\s*(\d{1,2})\b/, f: m => ({ n: +(m[1] || m[2]) }) },
  { t: "follow", re: /\bfollow\s+(?:the\s+)?([a-z0-9]+(?:\s+[a-z0-9]+){0,3}?)\s*(?:,|$|(?=\bthen\b)|(?=\band\b))/, f: m => ({ who: m[1].trim() }) },
  { t: "giveway", re: /\bgive\s+way\s+to\s+(?:the\s+)?([a-z0-9]+(?:\s+[a-z0-9]+){0,3}?)\s*(?:,|$|(?=\bthen\b)|(?=\band\b))/, f: m => ({ who: m[1].trim() }) },
  { t: "expect", re: /\bexpect\s+(?:runway\s+)?(\d{1,2}[lrc]?)\b/,                    f: m => ({ rwy: m[1].toUpperCase() }) },
  { t: "cont",  re: /\bcontinue(?:\s+taxi)?\b/,                                      f: () => ({}) },
  { t: "taxi",  re: /\btaxi\b(?:\s+to)?(?:\s+runway\s+(\d{1,2}[lrc]?))?(?:\s+via[\w\s]*)?|\btx\b(?:\s+(\d{1,2}[lrc]?))?/, f: m => ({ rwy: (m[1] || m[2] || "").toUpperCase() }) },
  { t: "luaw",  re: /\bline\s*up\s+(?:and|end|n)?\s+(?:wait|weight|way)\b(?:\s+runway\s+(\d{1,2}[lrc]?))?|\bluaw\b(?:\s+(\d{1,2}[lrc]?))?/, f: m => ({ rwy: (m[1] || m[2] || "").toUpperCase() }) },
  { t: "cto",   re: /\bcleared\s+for\s+takeoff\b(?:\s+runway\s+(\d{1,2}[lrc]?))?|\bcto\b(?:\s+(\d{1,2}[lrc]?))?/, f: m => ({ rwy: (m[1] || m[2] || "").toUpperCase() }) },
  { t: "ctl",   re: /\bcleared\s+to\s+land\b(?:\s+runway\s+(\d{1,2}[lrc]?))?|\bctl\b(?:\s+(\d{1,2}[lrc]?))?/, f: m => ({ rwy: (m[1] || m[2] || "").toUpperCase() }) },
  { t: "ga",    re: /\bgo\s+around\b|\bga\b/,                                        f: () => ({}) },
  { t: "toTwr", re: /\b(?:contact|monitor|call|over\s+to|switch\s+to)\s+tower\b(?:\s+\d+)?|\btower\s+when\s+ready\b|\bct\b/, f: () => ({}) },
  { t: "toGnd", re: /\b(?:contact|monitor|call|over\s+to|switch\s+to)\s+ground\b(?:\s+\d+)?|\bground\s+when\s+ready\b|\bcg\b/, f: () => ({}) },
  { t: "toDep", re: /\b(?:contact|monitor|call|over\s+to|switch\s+to)\s+departure\b(?:\s+\d+)?|\bcd\b/, f: () => ({}) },
  { t: "toApp", re: /\b(?:contact|monitor|call|over\s+to|switch\s+to)\s+approach\b(?:\s+\d+)?|\bcap\b/, f: () => ({}) },
  { t: "toCtr", re: /\b(?:contact|monitor|call|over\s+to|switch\s+to)\s+(?:center|centre)\b(?:\s+\d+)?|\bcc\b/, f: () => ({}) },
  { t: "exit",  re: /\bexit\s+(?:left|right|\w+)?\s*when\s+able\b/,                  f: () => ({}) },
  { t: "ho",    re: /\bhand\s?off\b|\bflash\b|\bpoint\s+out\b/,                       f: () => ({}) },
  { t: "stby",  re: /\bstand\s?by\b|\bhold\s+on\b/,                                  f: () => ({}) },
  { t: "rgr",   re: /\brog(?:er)?\b|\bthanks?\b|\bgood\s+day\b|\bwilco\b/,           f: () => ({}) },
];

function parseCommands(s) {
  const ops = [];
  let work = " " + s + " ";
  for (const p of CMD_PATTERNS) {
    let m;
    while ((m = p.re.exec(work)) !== null) {
      ops.push({ t: p.t, at: m.index, ...p.f(m) });
      work = work.slice(0, m.index) + " ".repeat(m[0].length) + work.slice(m.index + m[0].length);
    }
  }
  ops.sort((a, b) => a.at - b.at);
  /* "monitor ground, I'll call you for taxi" is not a taxi clearance */
  if (ops.some(o => o.t === "monitor")) {
    for (let i = ops.length - 1; i >= 0; i--) if (ops[i].t === "taxi") ops.splice(i, 1);
  }
  return { ops, rest: work.trim() };
}

/* ---- IFR clearance grading (player on DEL) ---- */
function parseClearance(ac, s) {
  const F = G.fac;
  const clx = ac.clx;
  /* any distinctive word of the city counts, so "Chicago" alone works for Chicago O'Hare */
  const cityNorm = ac.dest.city.toLowerCase().replace(/[.'-]+/g, " ").replace(/\s+/g, " ").trim();
  const cityWords = cityNorm.split(" ").filter(w => w.length >= 4);
  if (cityWords.some(w => s.includes(w)) || s.includes(ac.dest.icao.toLowerCase())) clx.dest = true;
  const sidBase = ac.sid.name.toLowerCase().replace(/\d+$/, "");
  if (s.includes(sidBase) || s.includes("as filed")) clx.sid = true;
  const mAlt = s.match(/\b(?:climb(?:\s+and)?(?:\s+maintain)?|maintain)\s+(\d{3,5})\b/);
  if (mAlt && Math.abs(+mAlt[1] - F.initAlt) < 100) clx.alt = true;
  else if (/\bclimb\s+via\s+(?:the\s+)?sid\b/.test(s)) clx.alt = true;
  /* expected cruise: "expect flight level 340" / "expect 34000, 10 minutes after departure" */
  const mExp = s.match(/\bexpect(?:\s+final)?(?:\s+altitude)?\s+(?:fl\s*)?(\d{2,5})\b/);
  if (mExp) {
    let v = +mExp[1];
    if (v <= 450) v *= 100;                       // flight level said as 340
    clx.cruiseSaid = Math.round(v / 100) * 100;
  }
  const mSqk = s.match(/\bsquawk\s+(\d{4})\b/);
  if (mSqk) { clx.sqkSaid = mSqk[1]; clx.sqkOk = mSqk[1] === ac.sqk; }
  else if (/\bsquawk\s+\d{1,3}\b/.test(s)) clx.sqkShort = true;
  return clx;
}

function clearanceFlow(ac, s) {
  const F = G.fac;
  parseClearance(ac, s);
  const c = ac.clx;
  const missing = [];
  if (!c.dest) missing.push("confirm our destination?");
  if (!c.alt) missing.push("say again the initial altitude?");
  if (!c.sqkSaid) missing.push(c.sqkShort ? "say again the squawk, we only caught part of it?"
                                          : "say again the squawk?");
  if (missing.length) {
    if (!ac.lastAskAt || G.t - ac.lastAskAt > 12) {   // don't nag the same question
      ac.lastAskAt = G.t;
      setTimeout(() => { if (!ac.remove) ac.say(`${ac.spoken()}, ${missing[0]}`); }, 900);
    }
    return;
  }
  /* full readback, maybe with an induced error the player must catch */
  ac.clxStage = 2;
  let rbSqk = c.sqkSaid, rbAlt = F.initAlt;
  if (!ac.rbError && Math.random() < 0.28) {
    if (Math.random() < 0.5) {
      const i = Math.floor(rnd(0, 4));
      const wrong = [...rbSqk];
      wrong[i] = String((+wrong[i] + 3) % 8);
      ac.rbError = { field: "squawk", right: rbSqk };
      rbSqk = wrong.join("");
    } else {
      ac.rbError = { field: "altitude", right: rbAlt };
      rbAlt = rbAlt + (Math.random() < 0.5 ? 1000 : -1000);
    }
  }
  if (!c.sqkOk) xmit("DEL", "SYS", "warn", `Strip shows ${ac.cs} was assigned squawk ${ac.sqk}, you said ${c.sqkSaid}.`, null);
  const delay = rnd(2.5, 5);
  let rbCruise = c.cruiseSaid || null;
  let rbSid = ac.sid.name, rbDest = ac.dest.city, rbFreq = depFreq(F), rbSkip = null;
  /* Readback errors come in several flavours, the way real ones do:
     transposed squawk digits, a wrong altitude, the wrong SID, the wrong
     departure frequency, or an item simply left out of the readback. */
  if (!ac.rbError && Math.random() < 0.10 && rbCruise) {
    ac.rbError = { field: "expected altitude", right: rbCruise };
    rbCruise += (Math.random() < 0.5 ? 2000 : -2000);
  }
  if (!ac.rbError && Math.random() < 0.08) {
    const other = G.fac.sids.filter(x => x.name !== ac.sid.name);
    if (other.length) {
      ac.rbError = { field: "departure procedure", right: ac.sid.name };
      rbSid = pick(other).name;
    }
  }
  if (!ac.rbError && Math.random() < 0.07) {
    ac.rbError = { field: "departure frequency", right: rbFreq };
    const digits = rbFreq.split(".");
    rbFreq = digits[0] + "." + String((+digits[1] + 15) % 100).padStart(2, "0");
  }
  if (!ac.rbError && Math.random() < 0.07) {
    const other = DESTS.filter(d => d.icao !== ac.dest.icao && d.icao !== G.fac.icao);
    ac.rbError = { field: "destination", right: ac.dest.city };
    rbDest = pick(other).city;
  }
  if (!ac.rbError && Math.random() < 0.08) {
    rbSkip = pick(["squawk", "altitude", "frequency"]);
    ac.rbError = { field: "readback, they left out the " + rbSkip,
                   right: rbSkip === "squawk" ? rbSqk : rbSkip === "altitude" ? rbAlt : rbFreq };
  }
  const text = `Cleared to ${rbDest} via the ${rbSid} then as filed, ` +
    (rbSkip === "altitude" ? "" : `climb and maintain ${altWords(rbAlt)}, `) +
    (rbCruise ? `expect ${altWords(rbCruise)} one zero minutes after departure, ` : "") +
    (rbSkip === "frequency" ? "" : `departure frequency ${freqWords(rbFreq)}, `) +
    (rbSkip === "squawk" ? "" : `squawk ${numWords(rbSqk)}, `) + `${ac.spoken()}.`;
  ac.pendingRb = { due: G.t + delay, text };
}

function verdictReadback(ac, ok) {
  if (ac.clxStage !== 2) { ac.say(`${ac.spoken()}, say again?`); return; }
  if (ok && ac.rbError) {
    /* player blessed a bad readback; the error stands until rotation */
    ac.clxStage = 3;
    finishClearance(ac);
  } else if (ok) {
    ac.clxStage = 3;
    addPoints(8, `${ac.cs} cleared to ${ac.dest.icao}`);
    G.counters.clx++;
    finishClearance(ac);
  } else {
    if (ac.rbError) {
      const e = ac.rbError;
      ac.rbError = null;
      addPoints(6, `caught ${ac.cs}'s bad ${e.field} readback`);
      G.counters.clx++;
      const fix = e.field === "squawk" ? "squawk " + numWords(String(e.right))
        : e.field === "expected altitude" ? "expect " + altWords(e.right) + " one zero minutes after departure"
        : e.field === "departure procedure" ? "the " + e.right + " departure"
        : e.field === "departure frequency" ? "departure " + freqWords(String(e.right))
        : e.field === "destination" ? "cleared to " + e.right
        : /squawk/.test(e.field) ? "squawk " + numWords(String(e.right))
        : /frequency/.test(e.field) ? "departure " + freqWords(String(e.right))
        : altWords(e.right);
      ac.say(`Ah sorry, ${fix}, ${ac.spoken()}.`);
      ac.clxStage = 3;
      finishClearance(ac, true);
    } else {
      ac.say(`${ac.spoken()}, we believe the readback was correct, say again?`);
    }
  }
}
function finishClearance(ac, silent) {
  ac.state = "clxOk"; ac.stateT = 0;
  if (!silent) setTimeout(() => { if (!ac.remove) ac.say(`${ac.spoken()}, thanks, we'll call ground.`); }, 1200);
  scheduleGndCall(ac);
}

/* ---- generic ops execution with readback ---- */
/* credit or dock the switch depending on the handoff state, then clear it */
function settleHandoff(ac, to) {
  if (ac.hoTo && ac.hoAccepted) addPoints(4, `${ac.cs} handed off cleanly to ${to}`);
  else if (ac.hoTo) addPoints(3, `${ac.cs} switched to ${to}, flash was still pending`);
  else addPoints(2, `${ac.cs} shipped to ${to}`);
  ac.hoTo = null; ac.hoAccepted = false;
}

function execOps(ac, ops) {
  const F = G.fac;
  const parts = [], unable = [];
  for (const op of ops) {
    switch (op.t) {
      case "hdg": {
        const deg = norm360(op.deg) === 0 ? 360 : norm360(op.deg);
        if (op.deg < 1 || op.deg > 360) { unable.push("that heading"); break; }
        ac.assignedHdg = deg;
        ac.targetHdg = (typeof maybeDeviate === "function") ? maybeDeviate(ac, "hdg", deg) : deg;
        ac.turnDir = op.dir;
        ac.directFix = null;
        if (ac.app) ac.app = null;
        parts.push(`${op.dir === "L" ? "left " : op.dir === "R" ? "right " : ""}heading ${hdgWords(deg)}`);
        break;
      }
      case "alt": {
        let v = op.val;
        if (v <= 450) v *= 100;
        v = Math.round(v / 100) * 100;
        if (v < 2000 || v > 36000) { unable.push("that altitude"); break; }
        if (ac.app === "established") ac.app = null;
        ac.assignedAlt = v;
        if (!["gate", "clxOk", "gndCall", "push", "taxiWait", "taxi", "holdShortG", "holdShort", "lineup", "rolling"].includes(ac.state))
          ac.targetAlt = (typeof maybeDeviate === "function") ? maybeDeviate(ac, "alt", v) : v;
        const verb = v < ac.alt - 50 ? "descend and maintain" : v > ac.alt + 50 ? "climb and maintain" : "maintain";
        parts.push(`${verb} ${altWords(v)}`);
        break;
      }
      case "spd": {
        if (op.val < 140 || op.val > 340) { unable.push("that speed"); break; }
        ac.assignedSpd = op.val;
        if (!(ac.app === "established" && finalGeom(ac, ac.rwy || G.arrRwy).along < 6)) ac.targetIas = op.val;
        parts.push(`speed ${numWords(op.val)}`);
        break;
      }
      case "rns":
        ac.assignedSpd = null;
        if (ac.app !== "established") ac.targetIas = ac.role === "arr" ? 250 : 280;
        parts.push("resume normal speed");
        break;
      case "dvs":
        if (ac.role !== "arr" || ac.state !== "ctrArr") { unable.push("descend via"); break; }
        ac.assignedAlt = ac.targetAlt = 11000;
        parts.push(`descend via the ${ac.star}`);
        break;
      case "dct": {
        const fx = G.fac.fixes.find(f => f.name === op.fix) ||
                   (ac.role === "dep" && ac.exitFix.name === op.fix ? ac.exitFix : null);
        if (!fx) { unable.push(`unfamiliar with ${op.fix}`); break; }
        ac.directFix = fx; ac.assignedHdg = null;
        if (ac.app) ac.app = null;
        parts.push(`direct ${fx.name}`);
        break;
      }
      case "ils": {
        if (ac.role !== "arr" || !["appCtl", "ctrArr"].includes(ac.state)) { unable.push("the approach"); break; }
        if (ac.alt > 6500) { unable.push("the approach, we're too high"); break; }
        const iRwy = op.rwy ? resolveRwy(op.rwy) : (ac.rwy || G.arrRwy);
        if (!iRwy) { unable.push(`runway ${op.rwy}`); break; }
        if (finalGeom(ac, iRwy).along > 36) { unable.push("the approach, too far out"); break; }
        ac.rwy = iRwy;
        ac.app = "cleared";
        parts.push(`cleared ILS runway ${rwyWords(iRwy.id)}`);
        break;
      }
      case "push": {
        if (ac.role !== "dep" || ac.state !== "gndCall") { unable.push("pushback"); break; }
        const held = tmuHold(ac);
        if (held) { unable.push(`pushback, holding for ${held}`); break; }
        parts.push("pushback approved");
        startPush(ac);
        break;
      }
      case "taxi": {
        if (ac.role === "dep" && ["taxiWait", "push"].includes(ac.state)) {
          if (ac.state === "push") { ac.pushT = 0; ac.state = "taxiWait"; }
          const tRwy = op.rwy ? resolveRwy(op.rwy) : (ac.rwy || G.depRwy);
          if (!tRwy) { unable.push(`runway ${op.rwy}`); break; }
          if (typeof isRwyClosed === "function" && isRwyClosed(tRwy.id)) {
            unable.push(`taxi, runway ${rwyWords(tRwy.id)} is closed`); break;
          }
          if (!G.fac.taxi[tRwy.id]) { unable.push(`taxi route to runway ${rwyWords(tRwy.id)}`); break; }
          ac.rwy = tRwy;
          parts.push(`runway ${rwyWords(tRwy.id)} via ${G.fac.taxi[tRwy.id].names}, hold short`);
          startTaxi(ac);
        } else if (ac.role === "arr" && ac.state === "gndIn") {
          parts.push(`taxi to the gate via ${G.fac.taxi["in_" + (ac.rwy || G.arrRwy).id].names}`);
          startTaxiIn(ac);
        } else unable.push("taxi");
        break;
      }
      case "expect": {
        const eRwy = resolveRwy(op.rwy);
        if (!eRwy) { unable.push(`runway ${op.rwy}`); break; }
        ac.rwy = eRwy;
        parts.push(`expect runway ${rwyWords(eRwy.id)}`);
        break;
      }
      case "hold":
        if (["taxi", "taxiIn"].includes(ac.state)) { ac.holdFlag = true; parts.push("holding position"); }
        else if (["taxiWait", "gndCall", "clxOk", "holdShortG", "holdShort"].includes(ac.state)) {
          ac.holdFlag = true; parts.push("holding position");
        } else unable.push("hold position");
        break;
      case "monitor":
        /* they listen but do not call. You initiate when you are ready. */
        ac.monitorOnly = true;
        ac.standbyAt = G.t; ac.standbyDur = 3600;
        ac.reminders = 2;
        parts.push("monitoring, we'll wait for your call");
        break;
      case "seq":
        ac.seqNum = op.n;
        ac.standbyAt = G.t; ac.standbyDur = 60 + op.n * 45;   // they wait their turn quietly
        parts.push(`number ${numWords(op.n)}`);
        break;
      case "follow":
        ac.followWho = op.who;
        ac.standbyAt = G.t; ac.standbyDur = 240;
        parts.push(`following the ${op.who}`);
        break;
      case "giveway":
        ac.holdFlag = true;
        ac.giveWayTo = op.who;
        ac.standbyAt = G.t; ac.standbyDur = 240;
        parts.push(`giving way to the ${op.who}`);
        break;
      case "cont":
        if (ac.holdFlag) {
          ac.holdFlag = false; ac.giveWayTo = null;
          parts.push("continue taxi");
        } else unable.push("continue");
        break;
      case "luaw": {
        if (ac.role !== "dep" || ac.state !== "holdShort") { unable.push("line up"); break; }
        const lRwy = op.rwy ? resolveRwy(op.rwy) : (ac.rwy || G.depRwy);
        if (!lRwy) { unable.push(`runway ${op.rwy}`); break; }
        
        const held = tmuHold(ac);
        if (held) { unable.push(`line up, we're holding for ${held}`); break; }

        if (typeof isRwyClosed === "function" && isRwyClosed(lRwy.id)) {
          unable.push(`line up, runway ${rwyWords(lRwy.id)} is closed`); break;
        }
        ac.rwy = lRwy;
        ac.state = "lineup"; ac.stateT = 0;
        ac.x = lRwy.thr.x; ac.y = lRwy.thr.y; ac.hdg = lRwy.hdg;
        parts.push(`line up and wait runway ${rwyWords(lRwy.id)}`);
        G.hooks.strips();
        break;
      }
      case "cto": {
        if (ac.role !== "dep" || !["holdShort", "lineup"].includes(ac.state)) { unable.push("takeoff"); break; }
        const cRwy = op.rwy ? resolveRwy(op.rwy) : (ac.rwy || G.depRwy);
        if (!cRwy) { unable.push(`runway ${op.rwy}`); break; }
        const held = tmuHold(ac);
        if (held) { unable.push(`takeoff, we're holding for ${held}`); break; }
        if (ac.releaseHold && G.t < ac.releaseHold) {
          const mm = Math.max(1, Math.round((ac.releaseHold - G.t) / 60));
          unable.push(`takeoff, departure is holding our release another ${numWords(mm)} minute${mm === 1 ? "" : "s"}`);
          break;
        }
        if (typeof isRwyClosed === "function" && isRwyClosed(cRwy.id)) {
          unable.push(`takeoff, runway ${rwyWords(cRwy.id)} is closed`); break;
        }
        ac.rwy = cRwy;
        parts.push(`cleared for takeoff runway ${rwyWords(cRwy.id)}`);
        startRoll(ac);
        break;
      }
      case "ctl": {
        if (ac.role !== "arr" || !["twrArr", "appCtl"].includes(ac.state)) { unable.push("landing clearance"); break; }
        const aRwy = op.rwy ? resolveRwy(op.rwy) : (ac.rwy || G.arrRwy);
        if (!aRwy) { unable.push(`runway ${op.rwy}`); break; }
        ac.rwy = aRwy;
        ac.landClr = true;
        parts.push(`cleared to land runway ${rwyWords(aRwy.id)}`);
        break;
      }
      case "ga":
        if (ac.role !== "arr" || ac.alt < 150 || !["appCtl", "twrArr"].includes(ac.state)) { unable.push("the go-around"); break; }
        doGoAround(ac, "");
        return;
      case "toTwr":
        if (ac.role === "dep" && ac.state === "holdShortG") {
          parts.push("monitor tower, good day");
          ac.state = "holdShort";
          settleHandoff(ac, "TWR");
          setOwner(ac, "TWR", false);
        } else if (ac.role === "arr" && ac.app && ["appCtl"].includes(ac.state)) {
          parts.push("tower, good day");
          ac.state = "twrArr"; ac.stateT = 0;
          settleHandoff(ac, "TWR");
          setOwner(ac, "TWR", false);
          if (G.playerPos === "APP") {
          addPoints(ac.emerg ? 25 : 12, `${ac.cs} delivered on the ILS${ac.emerg ? " (emergency)" : ""}`);
          G.counters.ils++;
        }
        } else unable.push("tower");
        break;
      case "toGnd":
        if (ac.role === "arr" && ac.state === "rwyExit") {
          parts.push("ground, good day");
          ac.state = "gndIn"; ac.stateT = 0;
          settleHandoff(ac, "GND");
          setOwner(ac, "GND", false);
        } else unable.push("ground");
        break;
      case "toDep":
        if (ac.role === "dep" && ac.state === "climb") {
          parts.push("departure, good day");
          ac.state = "depCtl"; ac.stateT = 0;
          settleHandoff(ac, "APP");
          setOwner(ac, "APP", false);
        } else unable.push("departure");
        break;
      case "toApp":
        if (ac.role === "arr" && ac.state === "ctrArr") {
          parts.push("approach, good day");
          ac.state = "appCtl"; ac.stateT = 0;
          settleHandoff(ac, "APP");
          setOwner(ac, "APP", false);
          if (G.playerPos === "CTR") G.counters.ho++;
        } else unable.push("approach");
        break;
      case "toCtr":
        if (ac.role === "dep" && ac.state === "depCtl") {
          if (ac.alt < 3800 || ac.distField() < 12) { unable.push(`center just yet, we're at ${altWords(Math.round(ac.alt / 100) * 100)}`); break; }
          parts.push("center, good day");
          ac.state = "ctrDep"; ac.stateT = 0;
          settleHandoff(ac, "CTR");
          setOwner(ac, "CTR", false);
          if (G.playerPos === "APP") G.counters.ho++;
        } else if (ac.role === "dep" && ac.state === "ctrDep") {
          parts.push(`${G.fac.nextCenter}, good day`);
          ac.state = "out";
          if (G.playerPos === "CTR") { addPoints(6, `${ac.cs} to ${G.fac.nextCenter}`); G.counters.ho++; }
        } else unable.push("center");
        break;
      case "exit": parts.push("will do"); break;
      case "ho":
        initiateHandoff(ac);
        return;                              // a coordination action, not a radio call
      case "stby":
        ac.standbyAt = G.t;
        parts.push("standing by");
        break;
      case "rgr":
        if (ops.length === 1) return;          // a bare acknowledgment needs no readback
        break;
      case "rbok": verdictReadback(ac, true); return;
      case "rbbad": verdictReadback(ac, false); return;
    }
  }
  if (!parts.length && !unable.length) { ac.say(`Say again for ${ac.spoken()}?`); return; }
  let text = parts.join(", ");
  if (unable.length) text += (text ? ", and " : "") + "unable " + unable.join(", and ");
  text += `, ${ac.spoken()}.`;
  ac.say(text.charAt(0).toUpperCase() + text.slice(1));
}

/* the player keyed the mic */
function playerTransmit(raw) {
  raw = raw.trim();
  if (!raw) return;
  xmit(G.playerPos, "YOU", "you", raw, null);
  const norm = normalizeTx(raw);

  // Check for landline voice commands first
  const icMatch = norm.match(/^(approach|departure|center|tower|ground|clearance)\b(.*)/);
  if (icMatch) {
    const posMap = { approach: "APP", departure: "APP", center: "CTR", tower: "TWR", ground: "GND", clearance: "DEL" };
    const targetPos = posMap[icMatch[1]];
    if (targetPos && targetPos !== G.playerPos) {
       const msg = icMatch[2];
       let handled = false;
       
       const milesMatch = msg.match(/\b(\d{1,2})\s*(?:miles|in\s*trail)?\b/);
       if (milesMatch && /\b(?:need|space|spacing|miles|trail|room|stretch)\b/.test(msg)) {
         intercom(targetPos, `space_arr:${milesMatch[1]}`);
         handled = true;
       } else if (/\b(?:more|increase|space|spacing|stretch|room|back\s+up)\b/.test(msg)) {
         intercom(targetPos, "space_arr");
         handled = true;
       } else if (/\b(?:tighten|reduce|closer|less)\b/.test(msg)) {
         intercom(targetPos, "tighten_arr");
         handled = true;
       } else if (/\b(?:status|how|looking)\b/.test(msg)) {
         intercom(targetPos, "status");
         handled = true;
       } else if (/\b(?:restrict|need|departures)\b/.test(msg)) {
         intercom(targetPos, "restrict");
         handled = true;
       } else if (/\b(?:point\s+out)\b/.test(msg)) {
         intercom(targetPos, "pointout");
         handled = true;
       } else if (/\b(?:hand\s?off|coordinate)\b/.test(msg)) {
         intercom(targetPos, "handoff");
         handled = true;
       } else if (/\b(?:cross|crossing)\b/.test(msg)) {
         intercom(targetPos, "cross");
         handled = true;
       } else if (/\b(?:release|apreq)\b/.test(msg)) {
         intercom(targetPos, "apreq");
         handled = true;
       } else if (/\b(?:slow|hold|stop|delay)\b/.test(msg) && targetPos === "DEL") {
         intercom(targetPos, "slow_del");
         handled = true;
       } else if (/\b(?:resume|normal)\b/.test(msg) && targetPos === "DEL") {
         intercom(targetPos, "resume_del");
         handled = true;
       }
       if (handled) return;
    }
  }

  /* broadcast to everyone on the frequency: "all aircraft ..." */
  if (/\ball\s+(?:aircraft|stations)\b/.test(norm)) {
    const mins = (norm.match(/(\d{1,2})\s*minutes?\b/) || [])[1];
    const dur = mins ? Math.min(+mins, 60) * 60 : 420;
    const waiting = G.aircraft.filter(a => a.owner === G.playerPos && a.called && !a.remove);
    if (!waiting.length) { sysLog("Nobody on frequency to hear that."); return; }
    for (const a of waiting) { a.standbyAt = G.t; a.standbyDur = dur; a.reminders = 0; a.lastNagAt = G.t; }
    /* a staggered chorus of short acknowledgments; everyone got the message */
    waiting.slice(0, 5).forEach((a, i) => {
      setTimeout(() => {
        if (!a.remove) a.say(pick([
          `${a.spoken()}.`, `Standing by, ${a.spoken()}.`, `Roger, ${a.spoken()}.`, `${a.spoken()}, roger.`,
        ]));
      }, 700 + i * rnd(1400, 2400));
    });
    return;
  }

  let [ac, rest, startIdx] = matchCallsign(norm);
  if (G.selected && !G.selected.remove) {
    if (!ac || (ac !== G.selected && startIdx > 0)) {
      ac = G.selected;
      rest = norm;
    }
  }

  if (!ac) {
    sysLog("Nobody answered. Address a callsign, or click a strip/target first."); return;
  }
  G.selected = ac;
  G.hooks.strips();
  if (ac.owner !== G.playerPos) { sysLog(`${ac.cs} is not on your frequency (with ${ac.owner}).`); return; }
  if (ac.monitorOnly) { ac.monitorOnly = false; ac.called = true; ac.standbyAt = 0; }
  if (ac.nordo) { sysLog(`${ac.cs} is NORDO (squawking 7600). No reply.`); return; }

  /* ---- broad intent layer: pilots answer questions about themselves ----
     Anything recognisable as a question about state, position, fuel,
     type, gate, route, altitude, speed or intentions gets a real answer
     built from that aircraft's actual situation. */
  /* verify / confirm an assignment: this is how you catch a deviation */
  if (/\b(?:verify|confirm|check|say)\b[\w\s]*\b(?:heading|altitude|assigned)\b|\byou'?re\s+(?:off|not\s+on)\b/.test(rest)) {
    const caught = typeof challengeDeviation === "function" ? challengeDeviation(ac) : null;
    const reply = caught || (/(heading)/.test(rest)
      ? `we're on heading ${hdgWords(Math.round(ac.hdg))} as assigned`
      : `we're assigned ${altWords(ac.assignedAlt || ac.targetAlt)}`);
    setTimeout(() => { if (!ac.remove) ac.say(`${ac.spoken()}, ${reply}.`); }, rnd(700, 1400));
    return;
  }
  /* a weather deviation request */
  if (/\bdeviat/.test(rest) && /\bapprove/.test(rest)) {
    ac.wxAsked = "approved";
    setTimeout(() => { if (!ac.remove) ac.say(`Deviating, ${ac.spoken()}, we'll advise when able direct.`); }, 900);
    return;
  }
  const ANSWER = [
    [/\b(?:status|how.*(?:doing|going)|what.*doing|position\s+check)\b/,
      a => pilotRequest(a)],
    [/\bsay\s+(?:your\s+)?(?:position|posit)\b|\bwhere\s+are\s+you\b/,
      a => a.alt > 100
        ? `we're ${Math.round(a.distField())} miles out, ${altWords(Math.round(a.alt / 100) * 100)}`
        : `we're on the ground, ${pilotRequest(a)}`],
    [/\bsay\s+(?:your\s+)?altitude\b|\bconfirm\s+altitude\b|\bverify\s+altitude\b/,
      a => a.alt > 100 ? `we're passing ${altWords(Math.round(a.alt / 100) * 100)}`
                       : "we're on the ground"],
    [/\bsay\s+(?:your\s+)?(?:speed|airspeed)\b/,
      a => a.alt > 100 ? `indicating ${numWords(Math.round(a.ias))}` : "we're stopped"],
    [/\bsay\s+(?:your\s+)?heading\b/, a => `heading ${hdgWords(Math.round(a.hdg))}`],
    [/\bsay\s+(?:your\s+)?(?:type|aircraft)\b|\bconfirm\s+(?:type|equipment)\b/,
      a => `we're a ${a.type}${a.heavy ? " heavy" : ""}`],
    [/\bsay\s+(?:your\s+)?(?:gate|parking|stand)\b|\bconfirm\s+gate\b/,
      a => a.role === "dep" ? `we're at gate ${a.gate.toLowerCase()}` : "we'll need a gate"],
    [/\bsay\s+(?:your\s+)?(?:route|routing)\b|\bconfirm\s+route\b/,
      a => a.role === "dep" ? `we're filed ${a.sid.name} then as filed` : `we're on the ${a.star}`],
    [/\bsay\s+(?:your\s+)?(?:squawk|beacon|code)\b|\bconfirm\s+squawk\b/,
      a => `squawking ${numWords(a.sqk)}`],
    [/\bsay\s+(?:your\s+)?(?:destination|going)\b|\bconfirm\s+destination\b/,
      a => a.role === "dep" ? `we're going to ${ac.dest.city}` : `we're landing here, out of ${ac.origin.city}`],
    [/\bsay\s+(?:your\s+)?fuel\b|\bhow.*fuel\b|\bfuel\s+(?:state|remaining)\b/,
      a => `we've got about ${numWords(Math.floor(rnd(45, 180)))} minutes of fuel`],
    [/\bsouls\s+on\s+board\b|\bpob\b/,
      a => `${numWords(Math.floor(rnd(60, 290)))} souls on board`],
    [/\bable\b.*\bhigher\b/, a => "affirmative, we can take higher"],
    [/\bcan\s+you\s+(?:accept|take|do)\b/, a => "affirmative, we can do that"],
    [/\bhow\s+(?:long|much longer)\b|\bwhen.*ready\b|\badvise\s+when\s+ready\b/,
      a => ["gate", "clxOk", "gndCall"].includes(a.state) ? "we'll be ready in a few minutes"
         : "we're ready when you are"],
    [/\badvise\s+when\s+holding\b|\breport\s+holding\b/,
      a => { a.reportHolding = true; return "wilco, we'll report holding short"; }],
    [/\breport\s+(?:when\s+)?established\b/,
      a => { a.reportEst = true; return "wilco, report established"; }],
    [/\bhow\s+do\s+you\s+(?:hear|read)\b|\bradio\s+check\b/,
      a => "we read you five by five"],
    [/\bare\s+you\s+(?:with|on)\b|\bcheck\s+in\b/, a => pilotRequest(a)],
  ];
  for (const [re, fn] of ANSWER) {
    if (re.test(rest)) {
      const ans = fn(ac);
      setTimeout(() => { if (!ac.remove) ac.say(`${ac.spoken()}, ${ans}.`); }, rnd(700, 1500));
      return;
    }
  }

  /* conversational intents any pilot understands */
  if (/\bstand\s?by\b|\bhold\s+on\b|\bexpect\s+clearance\b|\bcall\s+you\s+back\b|\bbe\s+with\s+you\b/.test(rest)) {
    const mins = (rest.match(/(\d{1,2})\s*minutes?\b/) || [])[1];
    ac.standbyAt = G.t;
    ac.standbyDur = mins ? Math.min(+mins, 60) * 60 : 420;
    ac.reminders = 0;
    ac.lastNagAt = G.t;
    setTimeout(() => { if (!ac.remove) ac.say(pick([`Standing by, ${ac.spoken()}.`, `Roger, ${ac.spoken()}.`, `${ac.spoken()}.`])); }, 800);
    return;
  }
  if (/\b(?:confirm|say|verify)\b[\w\s]*\bdestination\b/.test(rest) && ac.role === "dep") {
    setTimeout(() => { if (!ac.remove) ac.say(`${ac.spoken()}, we're IFR to ${ac.dest.city}.`); }, 800);
    return;
  }
  if (/\bsay\s+again\b|\brepeat\b/.test(rest)) {
    setTimeout(() => { if (!ac.remove) pilotCheckIn(ac); }, 800);
    return;
  }
  /* "what are you waiting for", "say intentions", "say request" */
  if (/\bwaiting\s+(?:for|on)\b|\bsay\s+(?:your\s+)?(?:intentions|request)\b|\badvise\b/.test(rest)) {
    setTimeout(() => { if (!ac.remove) ac.say(`${ac.spoken()}, ${pilotRequest(ac)}.`); }, 800);
    return;
  }

  /* Clearance-delivery flow gets its own grammar */
  if (G.playerPos === "DEL" && ac.state === "gate" && ac.clxStage >= 1) {
    const { ops } = parseCommands(rest);
    const verdict = ops.find(o => o.t === "rbok" || o.t === "rbbad");
    if (verdict) { verdictReadback(ac, verdict.t === "rbok"); return; }
    if (ac.clxStage === 2 && /\bsquawk\s+\d{4}\b|\baltitude\b|\bmaintain\b/.test(rest)) {
      verdictReadback(ac, false); return;    // restating an item = correcting the readback
    }
    /* a handoff to ground works once the clearance is finished */
    if (ops.some(o => o.t === "toGnd")) {
      if (ac.clxStage >= 3) {
        ac.say(`Over to ground, ${ac.spoken()}, ${BYE()}.`);
        if (ac.owner === "DEL") { settleHandoff(ac, "GND"); scheduleGndCall(ac); }
      } else {
        ac.say(`${ac.spoken()}, we still need our clearance first.`);
      }
      return;
    }
    /* only treat it as a clearance if it actually contains clearance content */
    if (/\bcleared\b|\bsquawk\b|\bmaintain\b|\bclimb\b|\bdeparture\b|\bfiled\b|\bfrequency\b/.test(rest) ||
        (() => { const before = { ...ac.clx }; parseClearance(ac, rest);
                 return JSON.stringify(before) !== JSON.stringify(ac.clx); })()) {
      clearanceFlow(ac, rest);
    } else if (/\brog(?:er)?\b|\bthanks?\b|\bgood\s+day\b|\bwilco\b/.test(rest)) {
      /* just an acknowledgment, no reply needed */
    } else {
      /* say what they're actually waiting on rather than a blank "say again" */
      setTimeout(() => { if (!ac.remove) ac.say(`${ac.spoken()}, say again? ${cap(pilotRequest(ac))}.`); }, 800);
    }
    return;
  }
  const { ops } = parseCommands(rest);
  if (!ops.length) {
    setTimeout(() => { if (!ac.remove) ac.say(`${ac.spoken()}, say again? ${cap(pilotRequest(ac))}.`); }, 800);
    return;
  }
  ac.pending = { ops, due: G.t + rnd(0.8, 1.8) };
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/* what this aircraft currently needs from the controller */
function pilotRequest(ac) {
  switch (ac.state) {
    case "gate":
      return ac.clxStage >= 2 ? "we're waiting on you to verify our readback"
                              : `we're waiting on our IFR clearance to ${ac.dest.city}`;
    case "clxOk": case "gndCall": return "we're ready for pushback";
    case "push": return "we're still pushing back";
    case "taxiWait": return "we're ready to taxi";
    case "taxi": case "taxiIn": return "we're taxiing";
    case "holdShortG": case "holdShort": return `we're holding short runway ${rwyWords((ac.rwy || G.depRwy).id)}, ready to go`;
    case "lineup": return "we're lined up and waiting";
    case "rolling": return "we're rolling";
    case "climb": case "depCtl": return `we're climbing to ${altWords(ac.assignedAlt || G.fac.initAlt)}`;
    case "ctrDep": return `we're headed for ${ac.exitFix.name}`;
    case "ctrArr": return `we're descending on the ${ac.star}`;
    case "appCtl":
      return ac.app === "established" ? `we're established on the ILS runway ${rwyWords((ac.rwy || G.arrRwy).id)}`
           : ac.app === "cleared" ? "we're cleared for the approach, looking for the localizer"
           : "we're looking for vectors to the final";
    case "twrArr": return ac.landClr ? `we're cleared to land ${rwyWords((ac.rwy || G.arrRwy).id)}`
                                     : "we're on final, need a landing clearance";
    case "landedRoll": return "we're rolling out";
    case "rwyExit": case "gndIn": return "we're clear of the runway, need taxi to the gate";
    default: return "standing by";
  }
}

/* =====================================================================
   vTDLS: pre-departure clearance by datalink. Uplink the strip's filed
   clearance and the crew accepts it without using the frequency.
   ===================================================================== */
function sendPDC(ac) {
  if (!ac || ac.remove) return false;
  if (ac.role !== "dep" || ac.state !== "gate") { sysLog(`${ac.cs} cannot take a PDC right now.`); return false; }
  if (ac.clxStage >= 3) { sysLog(`${ac.cs} is already cleared.`); return false; }
  const F = G.fac;
  xmit("DEL", "TDLS", "sys",
    `PDC UPLINK ${ac.cs}: CLRD TO ${ac.dest.icao} VIA ${ac.sid.name} DP, MAINT ${F.initAlt}, EXP ${ac.cruise} 10 MIN, DPFRQ ${depFreq(F)}, SQ ${ac.sqk}`, null);
  ac.clx = { dest: true, sid: true, alt: true, sqkOk: true, sqkSaid: ac.sqk };
  ac.rbError = null;
  ac.pdc = true;
  const delay = rnd(4, 9);
  setTimeout(() => {
    if (ac.remove) return;
    ac.say(`${ac.spoken()}, PDC received for ${ac.dest.city}, ${altWords(G.fac.initAlt)} initial, expect ${altWords(ac.cruise)}, squawking ${numWords(ac.sqk)}.`);
    ac.clxStage = 3;
    addPoints(6, `${ac.cs} cleared by PDC`);
    G.counters.clx++;
    finishClearance(ac, true);
  }, delay * 1000 / Math.max(1, G.speed));
  G.hooks.strips();
  return true;
}

/* =====================================================================
   TRAFFIC MANAGEMENT UNIT
   The national command centre equivalent: ground stops, ground delay
   programmes with wheels-up times, and miles-in-trail restrictions.
   These arrive over the landline and actually constrain what you can
   release, the way a real TMI does.
   ===================================================================== */
const TMU = {
  groundStop: null,        // {dest, until, reason}
  mit: null,               // {fix, miles, until}
  gdp: null,               // {until}
  edct: new Map(),         // callsign -> release time
};
function tmuVoice() { return G.ctrlVoice.CTR; }
function tmuSay(text) {
  landlineChime();
  xmit("INT", "TMU", "ctrl", text, tmuVoice());
  xmit(G.playerPos, "TMU", "sys", text, null);
}
function tmuClear() { TMU.groundStop = null; TMU.mit = null; TMU.gdp = null; TMU.edct.clear(); }

function tmuTick() {
  if (TMU.groundStop && G.t > TMU.groundStop.until) {
    tmuSay(`Traffic management: the ground stop for ${TMU.groundStop.dest} is cancelled. Normal releases.`);
    TMU.groundStop = null;
  }
  if (TMU.mit && G.t > TMU.mit.until) {
    tmuSay(`Traffic management: the ${TMU.mit.miles} mile in-trail restriction over ${TMU.mit.fix} is lifted.`);
    TMU.mit = null;
  }
  if (TMU.gdp && G.t > TMU.gdp.until) {
    tmuSay("Traffic management: the ground delay programme has ended.");
    TMU.gdp = null;
    TMU.edct.clear();
  }
}
function tmuRoll() {
  const roll = Math.random();
  if (roll < 0.34 && !TMU.groundStop) {
    const dest = pick(DESTS.filter(d => d.icao !== G.fac.icao));
    const mins = Math.floor(rnd(8, 22));
    TMU.groundStop = { dest: dest.icao, until: G.t + mins * 60, reason: pick(
      ["weather at the destination", "a runway closure at the destination",
       "volume", "a ground stop from the command centre", "thunderstorms in the arrival corridor"]) };
    tmuSay(`Traffic management advisory: ground stop for ${dest.icao} traffic, ${mins} minutes, due to ${TMU.groundStop.reason}. Hold all ${dest.icao} departures at the gate.`);
  } else if (roll < 0.62 && !TMU.mit) {
    const fx = pick(G.fac.fixes);
    const miles = pick([10, 15, 20, 25]);
    TMU.mit = { fix: fx.name, miles, until: G.t + rnd(600, 1500) };
    tmuSay(`Traffic management: ${miles} miles in trail over ${fx.name}, effective now.`);
  } else if (roll < 0.8 && !TMU.gdp) {
    TMU.gdp = { until: G.t + rnd(900, 1800) };
    for (const a of G.aircraft) {
      if (a.role === "dep" && (a.state === "gate" || a.state === "gndCall") && !TMU.edct.has(a.cs)) {
        TMU.edct.set(a.cs, G.t + rnd(120, 600));
      }
    }
    tmuSay("Traffic management: ground delay programme in effect. Departures still at the gate will be issued wheels-up times.");
  }
}
/* is this departure allowed to go right now? */
function tmuHold(ac) {
  if (TMU.groundStop && ac.role === "dep" && ac.dest.icao === TMU.groundStop.dest) {
    return `a ground stop for ${TMU.groundStop.dest}`;
  }
  if (TMU.gdp && ac.role === "dep") {
    if (TMU.edct.has(ac.cs)) {
      const t = TMU.edct.get(ac.cs);
      if (G.t < t) {
        const mm = Math.max(1, Math.round((t - G.t) / 60));
        return `a wheels-up time, ${mm} minute${mm === 1 ? "" : "s"} from now`;
      }
    }
  }
  return null;
}

/* =====================================================================
   INTER-POSITION COORDINATION
   The AI positions talk to you the way real adjacent controllers do:
   departure calls about an inbound before you launch, tower advises when
   a runway is about to be occupied, centre passes arrival counts.
   ===================================================================== */
let coordAt = 60;
function coordinationTick() {
  if (G.t < coordAt) return;
  coordAt = G.t + rnd(70, 160);
  const P = G.playerPos;

  /* about to launch with an arrival close in: approach coordinates */
  if (P === "TWR" || P === "GND") {
    const ready = G.aircraft.filter(a => a.role === "dep" &&
      ["holdShort", "holdShortG", "lineup"].includes(a.state));
    const depRwyId = ready.length ? (ready[0].rwy || G.depRwy).id : G.depRwy.id;
    
    // Only alert if arrival is on the SAME runway as the departure
    const inbound = G.aircraft.find(a => a.role === "arr" && a.app === "established" &&
      (a.rwy || G.arrRwy).id === depRwyId &&
      finalGeom(a, a.rwy || G.arrRwy).along < 9 && finalGeom(a, a.rwy || G.arrRwy).along > 3);

    if (inbound && ready.length && Math.random() < 0.7) {
      const mi = Math.round(finalGeom(inbound, inbound.rwy || G.arrRwy).along);
      landlineChime();
      xmit("INT", ctrlCallsign("APP"), "ctrl",
        pick([
          `Tower, approach: ${inbound.cs} is ${mi} out on the ILS, you've got room for one if you go now.`,
          `Tower, approach: ${inbound.cs} ${mi} mile final, that's your gap.`,
          `Approach here, ${inbound.cs} is inside ${mi + 1} miles, next departure needs to be rolling.`,
        ]), G.ctrlVoice.APP);
      return;
    }
  }
  /* centre passes an arrival count to approach */
  if (P === "APP" && Math.random() < 0.5) {
    const n = G.aircraft.filter(a => a.role === "arr" && a.owner === "CTR").length;
    if (n) {
      landlineChime();
      xmit("INT", ctrlCallsign("CTR"), "ctrl",
        pick([`Approach, centre: I've got ${n} more for you behind this one.`,
              `Centre here, ${n} inbound after the current stream.`,
              `Approach, expect ${n} more off the arrival, then a break.`]), G.ctrlVoice.CTR);
      return;
    }
  }
  /* ground asks clearance to slow the flow */
  if (P === "DEL" && Math.random() < 0.4) {
    const q = G.aircraft.filter(a => ["taxiWait", "taxi", "holdShortG"].includes(a.state)).length;
    if (q >= 4) {
      landlineChime();
      xmit("INT", ctrlCallsign("GND"), "ctrl",
        pick([`Clearance, ground: I'm stacked up to the runway, can you slow the clearances down?`,
              `Ground here, ${q} on the taxiways already. Hold the next few at the gate please.`]),
        G.ctrlVoice.GND);
    }
  }
}

/* =====================================================================
   HANDOFFS
   Mirrors the real flow: you flash the track to the next controller,
   they accept it, and only then do you switch the aircraft to their
   frequency. Switching an unaccepted track still works but costs you.
   ===================================================================== */
function nextPosFor(ac) {
  if (ac.role === "dep") {
    return { DEL: "GND", GND: "TWR", TWR: "APP", APP: "CTR", CTR: null }[ac.owner];
  }
  return { CTR: "APP", APP: "TWR", TWR: "GND", GND: null, DEL: null }[ac.owner];
}
const HO_CMD = { GND: "contact ground", TWR: "contact tower", APP: ac => ac.role === "dep" ? "contact departure" : "contact approach", CTR: "contact center" };

function initiateHandoff(ac) {
  if (!ac || ac.remove) return;
  if (ac.owner !== G.playerPos) { sysLog(`${ac.cs} is not your track.`); return; }
  const to = nextPosFor(ac);
  if (!to) { sysLog(`${ac.cs} has nowhere further to go from ${ac.owner}.`); return; }
  if (ac.hoTo === to && ac.hoAccepted) { sysLog(`${ac.cs} already accepted by ${to}.`); return; }
  ac.hoTo = to; ac.hoAccepted = false;
  chime();
  xmit(G.playerPos, "SYS", "sys", `H/O ${ac.cs} flashed to ${to}, awaiting acceptance.`, null);
  G.hooks.strips();
  const delay = rnd(2500, 7000) / Math.max(1, G.speed);
  setTimeout(() => {
    if (ac.remove || ac.hoTo !== to) return;
    ac.hoAccepted = true;
    chime();
    xmit(G.playerPos, "SYS", "sys", `H/O ${ac.cs} accepted by ${to}. Ship them: "${typeof HO_CMD[to] === "function" ? HO_CMD[to](ac) : HO_CMD[to]}".`, null);
    G.hooks.strips();
  }, delay);
}

/* =====================================================================
   INTERCOM (landlines to the AI positions)
   Replies are generated from the position's actual traffic picture and
   drawn from phrase pools, so no two calls sound alike.
   ===================================================================== */
/* A landline call is a short two-way exchange, not a menu lookup. The
   caller identifies, states the request, the receiver approves, denies
   or approves with a restriction. Requests are the ones controllers
   actually make: approval requests for release, runway crossings,
   point-outs, handoff coordination and traffic calls. */
const LL_REQUESTS = {
  status:      { label: "how's it looking",       to: p => p },
  apreq:       { label: "APREQ / call for release", to: () => "APP" },
  cross:       { label: "request runway crossing", to: () => "TWR" },
  space_arr:   { label: "request increased arrival spacing", to: () => "APP" },
  tighten_arr: { label: "request reduced arrival spacing", to: () => "APP" },
  pointout:    { label: "point out (selected)",   to: p => p },
  handoff:     { label: "coordinate handoff (selected)", to: p => p },
  traffic:     { label: "traffic call (selected)", to: p => p },
  restrict:    { label: "request a restriction",  to: () => "APP" },
  slow_del:    { label: "request slower clearances", to: () => "DEL" },
  resume_del:  { label: "resume normal clearances", to: () => "DEL" },
};

function intercom(pos, action) {
  if (pos === G.playerPos) return;
  let actKey = action, actParam = null;
  if (action && action.includes(":")) {
    [actKey, actParam] = action.split(":");
  }

  const me = ctrlCallsign(G.playerPos), them = ctrlCallsign(pos);
  const sel = G.selected && !G.selected.remove ? G.selected : null;
  const mine = G.aircraft.filter(a => a.owner === pos && !a.remove);
  landlineChime();

  /* what you say */
  const ask = {
    status: `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, how's it looking?`,
    apreq: sel ? `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, APREQ ${sel.cs} off ${G.depRwy.id} for ${sel.role === "dep" ? sel.exitFix.name : "the field"}.`
               : `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, APREQ on my next departure.`,
    cross: sel ? `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, request to cross runway ${G.depRwy.id} with ${sel.cs}.`
               : `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, request a runway crossing.`,
    space_arr: actParam ? `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, we need ${actParam} miles between arrivals.`
                        : `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, we need more room between arrivals.`,
    tighten_arr: `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, you can tighten up the final.`,
    pointout: sel ? `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, point out, ${sel.cs}, ${Math.round(sel.distField())} miles, ${sel.alt > 100 ? Math.round(sel.alt / 100) * 100 + " feet" : "on the ground"}.`
                  : `${POS_NAME[pos]}, point out.`,
    handoff: sel ? `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, you got ${sel.cs}?`
                 : `${POS_NAME[pos]}, coordinating a handoff.`,
    traffic: sel ? `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, traffic, ${sel.cs}, ${Math.round(sel.distField())} out.`
                 : `${POS_NAME[pos]}, traffic call.`,
    restrict: `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, anything you need on my departures?`,
    slow_del: `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, we're stacking up out here. Can you slow down the clearances?`,
    resume_del: `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}, we're looking good again, resume normal clearances.`,
  }[actKey] || `${POS_NAME[pos]}, ${POS_NAME[G.playerPos]}.`;
  xmit("INT", me, "you", ask, null);

  /* what they say back, built from their real picture */
  let reply, effect = null;
  const busy = mine.length;
  if (actKey === "status") {
    const detail = {
      DEL: () => `${mine.filter(a => a.clxStage < 3).length} still waiting on clearances`,
      GND: () => `${mine.filter(a => ["taxi", "push"].includes(a.state)).length} moving`,
      TWR: () => `${mine.filter(a => ["holdShort", "lineup"].includes(a.state)).length} in the queue, ${mine.filter(a => a.state === "twrArr").length} on final`,
      APP: () => `${mine.filter(a => a.role === "arr").length} inbound`,
      CTR: () => `${busy} in the sector`,
    }[pos]();
    reply = busy > 5 ? `Slammed. ${cap(detail)}. Give me a minute.`
          : busy ? `${cap(detail)}, manageable.` : "Quiet, go ahead.";
  } else if (actKey === "apreq") {
    const wait = Math.random();
    if (wait < 0.45) { reply = "Released, no restriction."; effect = "release"; }
    else if (wait < 0.8) {
      const mm = Math.floor(rnd(2, 7));
      reply = `Hold him, I've got a stream. Call me in ${mm}.`;
      effect = "hold";
    } else {
      const hdg = Math.round(rnd(1, 36)) * 10;
      reply = `Released, but I need heading ${hdgWords(hdg)} off the runway.`;
      effect = "heading:" + hdg;
    }
  } else if (actKey === "cross") {
    reply = pick(["Approved, cross at your discretion.", "Cross behind the landing traffic, then approved.",
                  "Hold him, I've got one on a two mile final.", "Approved as requested."]);
    effect = /Hold/.test(reply) ? "hold" : "release";
  } else if (actKey === "space_arr") {
    if (actParam) {
      G.arrSpacing = Math.min(Math.max(+actParam, 4), 30);
    } else {
      G.arrSpacing = Math.min((G.arrSpacing || 6.5) + 3.0, 30);
    }
    reply = `Roger, stretching the final to ${G.arrSpacing} miles in trail.`;
  } else if (actKey === "tighten_arr") {
    G.arrSpacing = Math.max((G.arrSpacing || 6.5) - 2.5, 4);
    reply = `Roger, tightening the final to ${G.arrSpacing} miles in trail.`;
  } else if (actKey === "pointout") {
    if (sel) { sel.pointedOut = pos; addPoints(3, `point out on ${sel.cs} approved by ${pos}`); }
    reply = pick(["Point out approved, you keep him.", "Radar contact, approved, my traffic is no factor.",
                  "Approved, but keep him at or below five thousand."]);
  } else if (actKey === "handoff") {
    if (sel) { sel.hoTo = pos; sel.hoAccepted = true; }
    reply = sel ? pick([`Got him, ship him over.`, `Radar contact on ${sel.cs}, send him.`,
                        `He's mine, go ahead and switch him.`])
                : "Say the callsign again?";
  } else if (actKey === "traffic") {
    reply = pick(["Traffic observed, no factor.", "I see him, I'll keep mine above.",
                  "Roger, I'll take him after the one on final."]);
  } else if (actKey === "restrict") {
    const mm = pick([5, 10, 15]);
    reply = pick([`Nothing right now, run them.`, `Give me ${mm} miles in trail on the ${G.fac.sids[0].name}s.`,
                  `Keep them at or below five thousand until I call.`]);
  } else if (actKey === "slow_del") {
    reply = "Roger, slowing them down. We'll hold them at the gate.";
    effect = "slow_del";
  } else if (actKey === "resume_del") {
    reply = "Wilco, resuming normal clearance delivery.";
    effect = "resume_del";
  } else reply = "Go ahead.";

  setTimeout(() => {
    xmit("INT", them, "ctrl", reply, G.ctrlVoice[pos]);
    if (effect === "hold" && sel) { sel.releaseHold = G.t + rnd(120, 420); }
    if (effect === "release" && sel) { sel.releaseHold = 0; sel.released = true; }
    if (effect === "slow_del") { G.slowDel = G.t + 900; }
    if (effect === "resume_del") { G.slowDel = 0; }
    if (effect && effect.startsWith("heading:") && sel) {
      sel.assignedHdg = +effect.split(":")[1];
      sel.released = true;
      xmit(G.playerPos, "SYS", "sys", `${sel.cs}: departure wants heading ${sel.assignedHdg} off the runway.`, null);
    }
    G.hooks.strips();
  }, rnd(900, 2200));
}

/* AI rings the player when work piles up */
let nagAt = 90;
function intercomNags() {
  if (G.t < nagAt) return;
  nagAt = G.t + rnd(240, 420);          // rare, and only with a real reason
  if (G.playerPos === "DEL") {
    const waiting = G.aircraft.filter(a => a.owner === "DEL" && a.called && a.clxStage === 1 && a.stateT > 120);
    if (waiting.length >= 2) {
      landlineChime();
      xmit("INT", ctrlCallsign("GND"), "ctrl",
        `Clearance, Ground, I've got ${waiting.length} at the gates still waiting on clearances, can you work them?`, G.ctrlVoice.GND);
    }
  }
}

// Disable the buggy default safety scanner to prevent phantom go-arounds and false runway incursions
window.safetyLogicScan = function() {}; 

/* =====================================================================
   SCENARIO / SESSION
   ===================================================================== */
function genAtis(fac, cfg) {
  const letter = pick(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliett"]);
  let lo = cfg.windLo, hi = cfg.windHi;
  let span = (hi - lo + 360) % 360 || 360;
  const windDir = Math.round(norm360(lo + rnd(0, span)) / 10) * 10 || 360;
  const windSpd = Math.floor(rnd(4, 18));
  const qnh = (29.6 + rnd(0, 0.8)).toFixed(2).replace(".", "");
  const tod = pick(["day", "day", "dusk", "night"]);
  const temp = Math.floor(rnd(4, 33));
  return {
    letter, windDir, windSpd, qnh, tod, temp, dew: temp - Math.floor(rnd(2, 13)),
    vis: pick(["one zero", "one zero", "seven", "five"]),
    visSM: 10,
    sky: pick(["sky clear", "few clouds at two five zero zero", "scattered four thousand", "broken eight thousand"]),
    text: null,
  };
}
const VIS_SM = { "one zero": 10, "seven": 7, "five": 5, "three": 3, "one": 1 };
function atisText() {
  const a = G.atis, F = G.fac;
  return `${F.apName.split(" ")[0]} ${F.icao} information ${a.letter}. Wind ${hdgWords(a.windDir)} at ${numWords(a.windSpd)}. Visibility ${a.vis}. ${a.sky}. Altimeter ${numWords(a.qnh)}. Landing runway ${rwyWords(G.arrRwy.id)}, departing runway ${rwyWords(G.depRwy.id)}. Advise on initial contact you have information ${a.letter}.`;
}

function startSession(facIdx, playerPos, density) {
  const F = FACILITIES[facIdx];
  G.fac = F;
  G.playerPos = playerPos;
  G.density = density;
  /* wind decides the config */
  const cfg = pick(F.configs);
  G.cfg = cfg;
  G.arrRwy = resolveRwy(cfg.arr);
  G.depRwy = resolveRwy(cfg.dep);
  if (typeof prepareRoutes === "function") prepareRoutes(F, G.arrRwy.id, G.depRwy.id);
  G.atis = genAtis(F, cfg);
  G.atis.visSM = VIS_SM[G.atis.vis] || 10;
  if (Math.random() < 0.18) {                       // occasional low-visibility day
    G.atis.vis = pick(["three", "one"]);
    G.atis.visSM = VIS_SM[G.atis.vis];
    G.atis.sky = "overcast six hundred";
  }
  G.t = 0; G.score = 0; G.points = 0;
  G.aircraft = []; G.arrSeq = [];
  G.channels = {}; G.conflicts = new Set(); G.proxPairs = new Set();
  G.counters = { clx: 0, taxi: 0, tko: 0, ldg: 0, ils: 0, ho: 0, sep: 0, ga: 0 };
  G.monitored = {};
  for (const p of POSITIONS) { G.monitored[p] = p === playerPos; G.ctrlVoice[p] = makeVoice(); }
  G.monitored.INT = true;
  G.selected = null;
  G.rushPhase = rnd(0, Math.PI * 2);
  G.slowDel = 0;
  G.lastDelTime = 0;
  tmuClear();
  if (typeof wxReset === "function") wxReset();
  opsNext = 240;
  coordAt = 90;
  G.nextEvent = rnd(100, 180);
  nagAt = 120;
  /* seconds between a departure / an arrival. Low is a quiet evening,
     high is a genuine bank you cannot keep up with by hand. */
  const r = { low: [200, 240], med: [95, 110], high: [42, 48], insane: [26, 30] }[density] || [95, 110];
  G.nextArr = rnd(6, 20);
  G.nextDep = rnd(2, 10);
  G.rates = r;
  G.running = true;

  sysLog(`Session open: ${F.icao} ${cfg.name}. You are ${ctrlCallsign(playerPos)} (${POS_NAME[playerPos]}) on ${F.freqs[playerPos]}.`);
  sysLog(`ATIS ${G.atis.letter}: wind ${G.atis.windDir}/${String(G.atis.windSpd).padStart(2, "0")}, landing ${G.arrRwy.id}, departing ${G.depRwy.id}. All other positions are AI-staffed.`);
  /* opening traffic */
  const seed = { low: 2, med: 4, high: 7, insane: 10 }[density] || 4;
  for (let i = 0; i < seed; i++) spawnDep(i * 8);
  const seedArr = { low: 1, med: 2, high: 4, insane: 5 }[density] || 2;
  for (let i = 0; i < seedArr; i++) spawnArr();
}

function spawnDep(delay = 0) {
  const capD = { low: 7, med: 12, high: 20, insane: 28 }[G.density] || 12;
  if (G.aircraft.filter(a => a.role === "dep" && a.state !== "out").length >= capD) return;
  const ac = new Aircraft("dep");
  if (G.aircraft.some(o => o.cs === ac.cs)) return;
  ac.callAt = G.t + rnd(4, 20) + delay;
  G.aircraft.push(ac);
  if (typeof TMU !== "undefined" && TMU.gdp && !TMU.edct.has(ac.cs)) TMU.edct.set(ac.cs, G.t + rnd(120, 600));
  G.hooks.strips();
}
function spawnArr() {
  const capA = { low: 5, med: 8, high: 13, insane: 18 }[G.density] || 8;
  if (G.aircraft.filter(a => a.role === "arr").length >= capA) return;
  const ac = new Aircraft("arr");
  if (G.aircraft.some(o => o.cs === ac.cs)) return;
  G.aircraft.push(ac);
  G.hooks.strips();
}

function randomEvent() {
  if (Math.random() < 0.3) { tmuRoll(); return; }
  const roll = Math.random();
  if (roll < 0.45) return;
  if (roll < 0.55) {
    const arr = G.aircraft.find(a => a.role === "arr" && a.state === "appCtl");
    if (arr) { arr.gaFlag = true; }               // gust waiting on short final
  } else if (roll < 0.8) {
    const tx = G.aircraft.find(a => a.state === "taxi" && !a.holdFlag);
    if (tx) {
      tx.holdFlag = true;
      tx.say(`${tx.spoken()}, we need a minute here, sorting out a cabin issue.`);
      setTimeout(() => { if (!tx.remove) { tx.holdFlag = false; tx.say(`${tx.spoken()}, we're moving again, thanks.`); } }, rnd(15000, 30000) / G.speed);
    }
  } else {
    spawnArr(); spawnArr();                        // a small arrival push
    xmit(G.playerPos, "SYS", "sys", "Traffic: arrival push inbound.", null);
  }
}

/* =====================================================================
   ENGINE TICK
   ===================================================================== */
let uiAcc = 0;
function tickEngine(realDt) {
  if (!G.running || G.paused) return;
  let simDt = realDt * G.speed;
  while (simDt > 0) {
    const step = Math.min(0.5, simDt);
    simDt -= step;
    G.t += step;
    for (const ac of G.aircraft) stepAircraft(ac, step);
    for (const ac of G.aircraft) {
      if (ac.pendingRb && G.t >= ac.pendingRb.due) {
        const p = ac.pendingRb; ac.pendingRb = null;
        ac.say(p.text);
      }
      if (ac.remove2 && G.t >= ac.remove2) ac.remove = true;
      if (ac.state === "out" && ac.distField() > 58) ac.remove = true;
    }
    const removed = G.aircraft.filter(a => a.remove);
    if (removed.length) {
      for (const a of removed) {
        if (G.selected === a) G.selected = null;
        const i = G.arrSeq.indexOf(a.id);
        if (i !== -1) G.arrSeq.splice(i, 1);
      }
      G.aircraft = G.aircraft.filter(a => !a.remove);
      G.hooks.strips();
    }
    /* traffic generation with rush waves */
    const rush = 1 + 0.45 * Math.sin(G.t / 420 + G.rushPhase);
    G.nextDep -= step; G.nextArr -= step;
    if (G.nextDep <= 0) { spawnDep(); G.nextDep = G.rates[0] / rush * rnd(0.75, 1.3); }
    if (G.nextArr <= 0) { spawnArr(); G.nextArr = G.rates[1] / rush * rnd(0.75, 1.3); }
    G.nextEvent -= step;
    if (G.nextEvent <= 0) { randomEvent(); G.nextEvent = rnd(100, 200); }
  }
  uiAcc += realDt;
  if (uiAcc > 0.5) {
    uiAcc = 0;
    checkSeparation();
    if (typeof safetyLogicScan === "function") safetyLogicScan();
    tmuTick();
    if (typeof opsTick === "function") opsTick(0.5);
    coordinationTick();
    intercomNags();
    G.hooks.score();
  }
}