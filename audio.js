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
  say(text, seed) {
    if (!this.enabled || !("speechSynthesis" in window)) return;
    if (this.queue.length > 8) this.queue.shift();   // don't let a backlog build
    this.queue.push({ text, seed });
    this.pump();
  },
  pump() {
    if (this.speaking || !this.queue.length) return;
    const { text, seed } = this.queue.shift();
    this.speaking = true;
    squelch(0.05, 0.06);
    setTimeout(() => {
      const u = new SpeechSynthesisUtterance(text);
      if (this.voices.length) u.voice = this.voices[seed.v % this.voices.length];
      u.rate = seed.rate; u.pitch = seed.pitch; u.volume = 0.9;
      u.onend = u.onerror = () => {
        squelch(0.04, 0.05);
        this.speaking = false;
        setTimeout(() => this.pump(), 140);
      };
      speechSynthesis.speak(u);
    }, 90);
  },
  stopAll() {
    this.queue = [];
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.speaking = false;
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
  const rec = new SR();
  rec.lang = "en-US"; rec.continuous = false; rec.interimResults = false;
  let listening = false;
  rec.onresult = e => onText(e.results[0][0].transcript);
  rec.onend = rec.onerror = () => { listening = false; btn.classList.remove("rec"); };
  const start = () => {
    if (listening) return;
    listening = true;
    btn.classList.add("rec");
    squelch(0.05, 0.05);
    try { rec.start(); } catch (e) {}
  };
  const stop = () => { try { rec.stop(); } catch (e) {} squelch(0.04, 0.05); };
  btn.addEventListener("mousedown", start);
  btn.addEventListener("mouseup", stop);
  btn.addEventListener("mouseleave", () => listening && stop());
  btn.addEventListener("touchstart", e => { e.preventDefault(); start(); });
  btn.addEventListener("touchend", stop);
  document.addEventListener("keydown", e => { if (e.key === "Tab") { e.preventDefault(); start(); } });
  document.addEventListener("keyup", e => { if (e.key === "Tab") { e.preventDefault(); stop(); } });
}
