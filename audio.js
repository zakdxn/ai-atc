/* =====================================================================
   AI ATC: audio: pilot/controller voices, radio effects, PTT input
   Browser speechSynthesis can't be routed through WebAudio, so the
   radio feel comes from squelch clicks + static bursts wrapped around
   each transmission, with per-speaker voice/rate/pitch variation.
   ===================================================================== */
"use strict";

let AC_ctx = null;
function audioCtxGet() {
  if (!AC_ctx) {
    try { AC_ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  if (AC_ctx && AC_ctx.state === "suspended") AC_ctx.resume();
  return AC_ctx;
}

/* short white-noise burst, the radio squelch */
function squelch(vol = 0.05, dur = 0.07) {
  const ctx = audioCtxGet();
  if (!ctx) return;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.value = 2100; bp.Q.value = 0.8;
  const g = ctx.createGain(); g.gain.value = vol;
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start();
}

function beep(freq, dur, count = 1, gap = 0.12, vol = 0.06) {
  const ctx = audioCtxGet();
  if (!ctx) return;
  for (let i = 0; i < count; i++) {
    const t0 = ctx.currentTime + i * (dur + gap);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = freq; osc.type = "square";
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur);
  }
}
const landlineChime = () => beep(620, 0.09, 2, 0.07, 0.05);
const alertTone = () => beep(880, 0.14, 3);
const chime = () => beep(1320, 0.05, 1);

/* ---------------- TTS with a transmission queue ---------------- */
const TTS = {
  enabled: true,
  voices: [],
  queue: [],
  speaking: false,
  init() {
    if (!("speechSynthesis" in window)) { this.enabled = false; return; }
    const load = () => { this.voices = speechSynthesis.getVoices().filter(v => v.lang.startsWith("en")); };
    load();
    speechSynthesis.onvoiceschanged = load;
  },
  held: false,          // true while the player keys the mic
  current: null,
  say(text, seed) {
    if (!this.enabled || !("speechSynthesis" in window)) return;
    if (this.queue.length > 8) this.queue.shift();   // don't let a backlog build
    this.queue.push({ text, seed });
    this.pump();
  },
  pump() {
    if (this.held || this.speaking || !this.queue.length) return;
    const item = this.queue.shift();
    this.current = item;
    this.speaking = true;
    squelch(0.05, 0.06);
    setTimeout(() => {
      if (this.held) {                       // keyed during the lead-in: drop it
        this.speaking = false;
        this.current = null;
        return;
      }
      const u = new SpeechSynthesisUtterance(item.text);
      if (this.voices.length) u.voice = this.voices[item.seed.v % this.voices.length];
      u.rate = item.seed.rate; u.pitch = item.seed.pitch; u.volume = 0.9;
      u.onend = u.onerror = () => {
        squelch(0.04, 0.05);
        this.speaking = false;
        this.current = null;
        setTimeout(() => this.pump(), 140);
      };
      speechSynthesis.speak(u);
    }, 90);
  },
  /* The controller keys the mic: nobody talks over you. Keying over a
     transmission drops it, the way stepping on someone does, since you
     have already read it in the log and want to answer. */
  hold() {
    this.held = true;
    this.current = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.speaking = false;
  },
  release() {
    this.held = false;
    setTimeout(() => this.pump(), 260);
  },
  stopAll() {
    this.queue = [];
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.speaking = false;
    this.current = null;
  },
};

function makeVoice() {
  return { v: Math.floor(Math.random() * 16), rate: 0.95 + Math.random() * 0.28, pitch: 0.72 + Math.random() * 0.55 };
}
const ATIS_VOICE = { v: 3, rate: 0.98, pitch: 0.55 };

/* ---------------- push-to-talk speech recognition ---------------- */
function initPTT(btn, onText) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.disabled = true;
    btn.style.opacity = 0.4;
    btn.title = "Speech recognition not supported in this browser (try Chrome)";
    return;
  }
  /* The mic stays keyed for as long as the button is held. Chrome's
     recognizer likes to stop on its own at every pause, so it is
     restarted transparently and the finalized pieces are accumulated;
     the whole transmission goes out on release. */
  const rec = new SR();
  rec.lang = "en-US"; rec.continuous = true; rec.interimResults = true;
  let listening = false, buf = "", pending = "";
  rec.onresult = e => {
    pending = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const txt = e.results[i][0].transcript;
      if (e.results[i].isFinal) buf += (buf ? " " : "") + txt.trim();
      else pending += txt;
    }
  };
  rec.onerror = ev => {
    if (ev.error === "no-speech" || ev.error === "aborted") return;   // keep the key down
    listening = false; btn.classList.remove("rec"); TTS.release();
  };
  rec.onend = () => {
    if (listening) { try { rec.start(); } catch (e) {} return; }      // still held: resume
    btn.classList.remove("rec");
    const said = (buf + " " + pending).trim();
    buf = ""; pending = "";
    TTS.release();
    if (said) onText(said);
  };
  const start = () => {
    if (listening) return;
    listening = true;
    buf = ""; pending = "";
    btn.classList.add("rec");
    TTS.hold();                       // you have the frequency
    squelch(0.05, 0.05);
    try { rec.start(); } catch (e) {}
  };
  const stop = () => {
    if (!listening) return;
    listening = false;                // tells onend this was a real release
    squelch(0.04, 0.05);
    try { rec.stop(); } catch (e) { btn.classList.remove("rec"); TTS.release(); }
  };
  btn.addEventListener("mousedown", start);
  btn.addEventListener("mouseup", stop);
  btn.addEventListener("mouseleave", () => listening && stop());
  btn.addEventListener("touchstart", e => { e.preventDefault(); start(); });
  btn.addEventListener("touchend", stop);
  document.addEventListener("keydown", e => { if (e.key === "Tab") { e.preventDefault(); start(); } });
  document.addEventListener("keyup", e => { if (e.key === "Tab") { e.preventDefault(); stop(); } });
}
