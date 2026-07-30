/* =====================================================================
   AI ATC: voice-to-intent endpoint

   Sits between the game and Groq so the API key never reaches the browser.
   The game POSTs a transcript plus the current traffic picture; this returns
   {"intents":[{"callsign":"DAL484","action":"hdg","value":"270"}]}.

   The game calls this only for things its built-in grammar could not
   account for, so this is the open-ended half of the parser, not the hot
   path. See worker/README.md for deployment.
   ===================================================================== */

/* Origins allowed to call this. Add your GitHub Pages origin and any custom
   domain. Set ALLOWED_ORIGINS as a Worker variable to override without a
   code change: a comma-separated list, or * to allow anything. */
const DEFAULT_ORIGINS = [
  "https://zakdxn.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:8899",
  "http://127.0.0.1:8899",
];

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

/* Every action the game's router understands. Anything outside this list is
   still accepted by the game: the pilot acknowledges it and the sim records
   that nothing changed. Keep in step with AI_ACTIONS in engine.js. */
const ACTIONS = [
  "hdg", "alt", "spd", "seq", "dct", "ils", "taxi", "cto", "ctl", "luaw",
  "expect", "push", "hold", "cont", "abort", "ga", "stby", "rgr", "ho",
  "exit", "rbok", "rbbad", "monitor", "dvs", "rns", "none",
];

const SYSTEM_PROMPT = `You convert air traffic control transmissions into structured intents for a controller simulator.

You are given: the controller's transmission, the position they are working, and every aircraft on their frequency with its state.

Return ONLY JSON of this exact shape:
{"intents":[{"callsign":"<exact callsign from the aircraft list>","action":"<action>","value":"<string>"}]}

Actions and the value each expects:
  hdg     a heading, 1-360. Include "left" or "right" in value if the controller said a turn direction. e.g. "left 270"
  alt     an altitude in feet, or hundreds of feet. e.g. "5000", "080"
  spd     a speed in knots. e.g. "210"
  seq     a sequence number. e.g. "2"
  dct     a fix name to proceed direct to. e.g. "DIRTY"
  ils     clear for the ILS. value is the runway, or "" for the assigned one
  taxi    taxi clearance. value is the runway, or "" for the assigned one
  cto     cleared for takeoff. value is the runway, or ""
  ctl     cleared to land. value is the runway, or ""
  luaw    line up and wait. value is the runway, or ""
  expect  tell them to expect a runway. value is the runway
  push    pushback approved. value ""
  hold    hold position. value ""
  cont    continue taxi. value ""
  abort   cancel a takeoff clearance. value ""
  ga      go around. value ""
  stby    stand by. value is a number of minutes if one was given, else ""
  rgr     a bare acknowledgement. value ""
  ho      hand off / flash the strip. value ""
  exit    exit the runway when able. value ""
  rbok    the readback was correct. value ""
  rbbad   the readback was wrong. value ""
  monitor monitor the frequency and wait to be called. value ""
  dvs     descend via the arrival. value ""
  rns     resume normal speed. value ""
  none    the transmission needs no action. value is a short note

Rules:
- callsign MUST be copied exactly from the aircraft list. Never invent one.
- Resolve descriptions against the aircraft list: "the heavy on final" is the
  arrival with heavy true and the smallest milesOut; "the one behind him" is
  the next one back. If "addressee" is given, that is who the controller was
  talking to unless the transmission clearly names someone else.
- If "handled" is non-empty, those actions have ALREADY been applied. Return
  only the intents still outstanding. Do not repeat a handled action.
- One transmission may carry several instructions. Return one intent each.
- If the transmission is an instruction the list does not cover, still return
  an intent: use a short lowercase verb as the action and put what was asked
  in value. The simulator will have the pilot acknowledge it.
- If you cannot tell who it was for, return {"intents":[]}.
- No prose, no markdown, no code fences. JSON only.`;

function corsHeaders(origin, allowed) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (allowed) h["Access-Control-Allow-Origin"] = origin || "*";
  return h;
}

function allowedOrigins(env) {
  const raw = (env && env.ALLOWED_ORIGINS) || "";
  if (raw.trim() === "*") return "*";
  const list = raw.split(",").map(s => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ORIGINS;
}

function originOk(origin, allow) {
  if (allow === "*") return true;
  if (!origin) return false;                 // browsers always send it on CORS
  return allow.includes(origin);
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...(headers || {}) },
  });
}

/* Optional daily cap, so a runaway loop or someone else's script cannot empty
   your Groq account. Needs a KV namespace bound as ATC_KV; without one this
   silently does nothing. */
async function overDailyCap(env) {
  const cap = parseInt((env && env.DAILY_CAP) || "0", 10);
  if (!cap || !env.ATC_KV) return false;
  const key = "calls:" + new Date().toISOString().slice(0, 10);
  const n = parseInt((await env.ATC_KV.get(key)) || "0", 10);
  if (n >= cap) return true;
  /* 48 h expiry so yesterday's counter tidies itself up */
  await env.ATC_KV.put(key, String(n + 1), { expirationTtl: 172800 });
  return false;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allow = allowedOrigins(env);
    const ok = originOk(origin, allow);
    const cors = corsHeaders(origin, ok);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
    if (!ok) return json({ error: "origin not allowed" }, 403, corsHeaders(origin, false));
    if (!env.GROQ_API_KEY) return json({ error: "GROQ_API_KEY is not set on the Worker" }, 500, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "body must be JSON" }, 400, cors); }

    const transcript = String((body && body.transcript) || "").slice(0, 400);
    if (!transcript.trim()) return json({ intents: [] }, 200, cors);

    if (await overDailyCap(env)) {
      /* an empty list is a valid answer: the game falls back to its grammar */
      return json({ intents: [], note: "daily cap reached" }, 200, cors);
    }

    const ctx = (body && body.context) || {};
    /* trim the traffic list: a long prompt is a slow prompt */
    const aircraft = Array.isArray(ctx.aircraft) ? ctx.aircraft.slice(0, 30) : [];

    const userMsg = JSON.stringify({
      transmission: transcript,
      addressee: (body && body.addressee) || null,
      handled: (body && body.handled) || [],
      controllerPosition: ctx.position,
      facility: ctx.facility,
      zulu: ctx.zulu,
      landingRunway: ctx.arrRwy,
      departingRunway: ctx.depRwy,
      atis: ctx.atis,
      aircraft,
    });

    const model = (env && env.GROQ_MODEL) || "llama-3.1-8b-instant";
    let res;
    try {
      res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 500,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMsg },
          ],
        }),
      });
    } catch (e) {
      return json({ intents: [], error: "groq unreachable" }, 200, cors);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      /* 200 with an empty list on purpose: the game must fall back cleanly
         rather than treat a provider hiccup as a lost transmission */
      return json({ intents: [], error: `groq ${res.status}`, detail: detail.slice(0, 300) }, 200, cors);
    }

    let parsed;
    try {
      const data = await res.json();
      const text = data && data.choices && data.choices[0] &&
                   data.choices[0].message && data.choices[0].message.content;
      parsed = JSON.parse(stripFence(String(text || "{}")));
    } catch {
      return json({ intents: [], error: "model did not return usable JSON" }, 200, cors);
    }

    const names = new Set(aircraft.map(a => String(a.callsign || "").toUpperCase()));
    const intents = (Array.isArray(parsed.intents) ? parsed.intents : [])
      .slice(0, 6)
      .map(it => ({
        callsign: String((it && it.callsign) || "").toUpperCase().trim(),
        action: String((it && it.action) || "").toLowerCase().trim().slice(0, 24),
        value: it && it.value == null ? "" : String(it.value).slice(0, 120),
      }))
      .filter(it => it.action && (!it.callsign || names.size === 0 || names.has(it.callsign)));

    return json({ intents, model }, 200, cors);
  },
};

/* models occasionally wrap JSON in a fence despite being told not to */
function stripFence(t) {
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : t).trim();
}
