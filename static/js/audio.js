/* Procedural Web Audio engine: every sound is synthesised from oscillators and
   noise. Two styles: bright, clean console beeps (Signal Simulator-like) and a
   darker, echoing lo-fi set (Voices of the Void-like). */
"use strict";

/* ---------- soundscape definitions ---------- */
// [layer id, label, hint, on by default, default volume]
const SOUNDSCAPES = {
  signalsim: {
    label: "SIGNAL SIMULATOR STYLE",
    ambience: [
      ["drone", "BASE DRONE", "Deep detuned drone", true, 0.5],
      ["fans", "SERVER RACK FANS", "Filtered fan noise", true, 0.25],
      ["hum", "CONSOLE HUM", "Mains hum and harmonics", false, 0.2],
      ["rumble", "DEEP ROOM RUMBLE", "Low room tone", false, 0.3],
      ["energy", "ENERGY HUM", "Pulsing high field hum", false, 0.15],
      ["processing", "COMPUTER PROCESSING", "Quiet data chatter", false, 0.15],
      ["crickets", "NIGHT OUTSIDE", "Crickets", false, 0.25],
      ["wind", "WIND", "Cold wind outside", false, 0.25],
    ],
    music: [["", "NONE"], ["pad_calm", "GENERATIVE PAD: CALM"], ["pad_drift", "GENERATIVE PAD: DRIFT"], ["pad_dark", "GENERATIVE PAD: DARK"]],
    flavor: "clean",
  },
  votv: {
    label: "VOICES OF THE VOID STYLE",
    ambience: [
      ["v_drone", "BASE DRONE", "Dark room drone", true, 0.5],
      ["v_servers", "SERVER ROOM", "Server racks humming", true, 0.3],
      ["v_pc", "PC WORKING", "Desk computer whine and fan", false, 0.2],
      ["v_dish", "DISH", "Resonant metal creaks of a big dish", false, 0.25],
      ["v_basement", "BASEMENT", "Rumble with the odd drip", false, 0.25],
      ["@outside", "OUTSIDE (TIME OF DAY)", "Birds by day, crickets by night; follows the time-of-day setting", false, 0.3],
      ["v_wind", "HIGH WIND", "Strong gusting wind", false, 0.2],
    ],
    music: [["", "NONE"], ["@music_ambience", "MUSIC AMBIENCE (TIME OF DAY)"], ["pad_calm", "PAD: MORNING"],
            ["pad_drift", "PAD: EVENING"], ["pad_dark", "PAD: NIGHT"]],
    flavor: "void",
  },
};

const prefKey = name => name.replace(/[^\w@]/g, "_");
for (const scape of Object.values(SOUNDSCAPES)) {
  for (const [name, , , on, vol] of scape.ambience) {
    if (!(`amb.${prefKey(name)}.on` in PREF_DEFAULTS)) PREF_DEFAULTS[`amb.${prefKey(name)}.on`] = on;
    if (!(`amb.${prefKey(name)}.vol` in PREF_DEFAULTS)) PREF_DEFAULTS[`amb.${prefKey(name)}.vol`] = vol;
  }
}
Object.assign(PREF_DEFAULTS, { "audio.soundscape": "signalsim", "audio.timeOfDay": "auto", "music.votvTrack": "",
                               "sfx.sonar.on": true, "sfx.sonar.vol": 0.4 }, { ...PREF_DEFAULTS });

const soundscape = () => SOUNDSCAPES[prefs.get("audio.soundscape")] || SOUNDSCAPES.signalsim;
const isVoid = () => soundscape().flavor === "void";
const pickOne = value => (Array.isArray(value) ? value[Math.floor(Math.random() * value.length)] : value);
const rand = (a, b) => a + Math.random() * (b - a);

/* ---------- time of day ---------- */
function timeOfDayPhase() {
  const mode = prefs.get("audio.timeOfDay");
  if (mode === "day" || mode === "night") return mode;
  if (mode === "both") return Math.floor(Date.now() / 600000) % 2 ? "night" : "day";
  const hour = new Date().getHours();
  return hour >= 6 && hour < 19 ? "day" : "night";
}
function musicPhase() {
  const mode = prefs.get("audio.timeOfDay");
  if (mode === "day") return "pad_calm";
  if (mode === "night") return "pad_dark";
  if (mode === "both") return ["pad_calm", "pad_drift", "pad_dark"][Math.floor(Date.now() / 600000) % 3];
  const hour = new Date().getHours();
  return hour >= 6 && hour < 17 ? "pad_calm" : hour < 21 ? "pad_drift" : "pad_dark";
}
function resolveLayer(name) {
  if (name === "@outside") return timeOfDayPhase() === "day" ? "v_birds" : "v_crickets";
  if (name === "@music_ambience") return musicPhase();
  return name;
}

/* Morse for satellite signatures */
const MORSE = { A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---", K: "-.-",
  L: ".-..", M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--",
  X: "-..-", Y: "-.--", Z: "--..", 0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-", 5: ".....", 6: "-....",
  7: "--...", 8: "---..", 9: "----." };

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.layers = new Map();      // slot -> {name, gain, stop()}
    this.motor = null;
    this.signature = null;
    this.ready = false;
  }

  async init() {
    if (this.ctx) { await this.ctx.resume(); this.applyPrefs(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8; this.limiter.ratio.value = 8;
    this.master.connect(this.limiter).connect(this.ctx.destination);
    this.noiseBuffer = this.makeNoise(4);
    this.buses = {};
    for (const name of ["amb", "music", "rotator", "ui", "signature", "alerts", "chatter", "sonar"]) {
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      this.buses[name] = gain;
    }
    // a feedback echo used by the darker soundscape
    this.echo = this.ctx.createDelay(1.5); this.echo.delayTime.value = 0.38;
    const feedback = this.ctx.createGain(); feedback.gain.value = 0.38;
    const tone = this.ctx.createBiquadFilter(); tone.type = "lowpass"; tone.frequency.value = 2200;
    this.echoIn = this.ctx.createGain(); this.echoIn.gain.value = 0.5;
    this.echoIn.connect(this.echo).connect(tone).connect(feedback).connect(this.echo);
    tone.connect(this.master);
    this.ready = true;
    this.applyPrefs();
    document.addEventListener("prefs", () => this.applyPrefs());
    document.addEventListener("visibilitychange", () => {
      if (!this.ctx) return;
      if (document.hidden && prefs.get("audio.pauseHidden")) this.ctx.suspend(); else this.ctx.resume();
    });
    setInterval(() => this.applyPrefs(), 30000);   // time-of-day layers follow the clock
  }

  /* ---------- primitives ---------- */
  makeNoise(seconds, color = "white") {
    const length = Math.floor(this.ctx.sampleRate * seconds);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = color === "brown" ? (last + 0.02 * white) / 1.02 : white;
      data[i] = color === "brown" ? last * 3.5 : white;
    }
    return buffer;
  }
  noise(out, { type = "lowpass", freq = 1000, q = 0.7, gain = 1 } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer; src.loop = true;
    src.loopStart = Math.random() * 2;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(filter).connect(g).connect(out);
    src.start(0, Math.random() * 3);
    return { src, filter, gain: g, stop: () => { try { src.stop(); } catch { /* stopped */ } } };
  }
  osc(out, { type = "sine", freq = 220, gain = 1, detune = 0 } = {}) {
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    const g = this.ctx.createGain(); g.gain.value = gain;
    o.connect(g).connect(out);
    o.start();
    return { osc: o, gain: g, stop: () => { try { o.stop(); } catch { /* stopped */ } } };
  }
  lfo(param, { rate = 0.1, depth = 1 } = {}) {
    const o = this.ctx.createOscillator(); o.frequency.value = rate;
    const g = this.ctx.createGain(); g.gain.value = depth;
    o.connect(g).connect(param); o.start();
    return { stop: () => { try { o.stop(); } catch { /* stopped */ } } };
  }
  /* one enveloped note: used by UI sounds, alerts, chatter and events inside layers */
  note(out, freq, { at = 0, dur = 0.08, type = "square", gain = 0.2, attack = 0.004, slideTo = null, filter = null } = {}) {
    const t = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o.connect(g);
    if (filter) { const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = filter; node = node.connect(f); }
    node.connect(out);
    if (isVoid() && out !== this.echoIn) node.connect(this.echoIn);
    o.start(t); o.stop(t + dur + 0.05);
  }
  burst(out, { at = 0, dur = 0.02, freq = 3000, q = 1, gain = 0.3, type = "bandpass" } = {}) {
    const t = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 3); src.stop(t + dur + 0.02);
  }
  /* repeating event generator inside a layer; returns a stopper */
  every(minMs, maxMs, fn) {
    let timer = null, alive = true;
    const loop = () => { if (!alive) return; try { fn(); } catch { /* ignore */ } timer = setTimeout(loop, rand(minMs, maxMs)); };
    timer = setTimeout(loop, rand(minMs, maxMs) * 0.3);
    return { stop: () => { alive = false; clearTimeout(timer); } };
  }

  /* ---------- ambience + music recipes ---------- */
  buildLayer(name, out) {
    const parts = [];
    const add = p => { parts.push(p); return p; };
    switch (name) {
      case "drone": {
        const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 180; f.connect(out);
        add(this.osc(f, { type: "sawtooth", freq: 55, gain: 0.25 })); add(this.osc(f, { type: "sawtooth", freq: 55.35, gain: 0.25 }));
        add(this.osc(out, { type: "sine", freq: 27.5, gain: 0.35 }));
        add(this.lfo(f.frequency, { rate: 0.05, depth: 70 }));
        break;
      }
      case "fans": { const n = add(this.noise(out, { type: "bandpass", freq: 700, q: 0.6, gain: 0.5 })); add(this.lfo(n.filter.frequency, { rate: 0.07, depth: 60 }));
        add(this.osc(out, { type: "sine", freq: 118, gain: 0.04 })); break; }
      case "hum": [60, 120, 180, 240].forEach((f, i) => add(this.osc(out, { freq: f, gain: 0.22 / (i + 1) }))); break;
      case "rumble": add(this.noise(out, { type: "lowpass", freq: 70, gain: 1.4 })); break;
      case "energy": {
        const o = add(this.osc(out, { type: "triangle", freq: 880, gain: 0.08 })); add(this.osc(out, { type: "sine", freq: 1320.5, gain: 0.04 }));
        add(this.lfo(o.gain.gain, { rate: 3.1, depth: 0.04 })); break;
      }
      case "processing": add(this.every(60, 260, () => this.note(out, pickOne([880, 1320, 1760, 2093, 2637]), { dur: rand(0.02, 0.06), gain: 0.08 }))); break;
      case "crickets": case "v_crickets":
        add(this.every(700, 1500, () => { const f = rand(4200, 4800); for (let i = 0; i < 3; i++) this.note(out, f, { at: i * 0.06, dur: 0.04, type: "sine", gain: 0.12 }); }));
        add(this.noise(out, { type: "lowpass", freq: 400, gain: 0.15 })); break;
      case "wind": case "v_wind": {
        const n = add(this.noise(out, { type: "bandpass", freq: name === "wind" ? 450 : 650, q: 0.9, gain: 0.9 }));
        add(this.lfo(n.filter.frequency, { rate: 0.09, depth: 250 })); add(this.lfo(n.gain.gain, { rate: 0.13, depth: 0.45 })); break;
      }
      case "v_drone": {
        const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 120; f.connect(out);
        add(this.osc(f, { type: "sawtooth", freq: 41.2, gain: 0.3 })); add(this.osc(f, { type: "square", freq: 41.6, gain: 0.12 }));
        add(this.noise(out, { type: "lowpass", freq: 200, gain: 0.4 })); add(this.lfo(f.frequency, { rate: 0.03, depth: 50 })); break;
      }
      case "v_servers": add(this.noise(out, { type: "bandpass", freq: 1500, q: 0.5, gain: 0.35 })); add(this.osc(out, { freq: 50, gain: 0.12 }));
        add(this.osc(out, { freq: 3150, gain: 0.006 })); break;
      case "v_pc": add(this.noise(out, { type: "highpass", freq: 2500, gain: 0.12 })); add(this.osc(out, { freq: 2140, gain: 0.008 }));
        add(this.every(4000, 12000, () => { for (let i = 0; i < 6; i++) this.burst(out, { at: i * rand(0.02, 0.07), dur: 0.015, freq: 5000, gain: 0.08 }); })); break;
      case "v_dish": add(this.noise(out, { type: "lowpass", freq: 90, gain: 0.6 }));
        add(this.every(6000, 16000, () => this.note(out, rand(90, 160), { dur: rand(1.2, 2.4), type: "sawtooth", gain: 0.05, attack: 0.4, slideTo: rand(80, 170), filter: 500 }))); break;
      case "v_basement": add(this.noise(out, { type: "lowpass", freq: 60, gain: 1.2 }));
        add(this.every(3000, 9000, () => this.note(out, rand(1400, 2000), { dur: 0.12, type: "sine", gain: 0.1, slideTo: 700 }))); break;
      case "v_birds": add(this.noise(out, { type: "bandpass", freq: 500, q: 0.8, gain: 0.25 }));
        add(this.every(1500, 5000, () => { const base = rand(2500, 4200); const n = Math.floor(rand(2, 6));
          for (let i = 0; i < n; i++) this.note(out, base * rand(0.9, 1.15), { at: i * 0.11, dur: 0.08, type: "sine", gain: 0.06, slideTo: base * rand(1.1, 1.4) }); })); break;
      case "pad_calm": case "pad_drift": case "pad_dark": add(this.pad(name, out)); break;
      default: break;
    }
    return { stop: () => parts.forEach(p => p.stop()) };
  }

  /* slow generative chord pad (music) */
  pad(kind, out) {
    const chords = {
      pad_calm: [[220, 277.2, 329.6, 415.3], [196, 246.9, 293.7, 370], [174.6, 220, 261.6, 329.6], [196, 246.9, 293.7, 392]],
      pad_drift: [[146.8, 220, 261.6, 349.2], [130.8, 196, 246.9, 329.6], [164.8, 246.9, 293.7, 392], [146.8, 196, 261.6, 329.6]],
      pad_dark: [[110, 130.8, 164.8, 207.7], [103.8, 123.5, 155.6, 196], [98, 116.5, 146.8, 185], [92.5, 110, 138.6, 174.6]],
    }[kind];
    const filter = this.ctx.createBiquadFilter(); filter.type = "lowpass"; filter.frequency.value = kind === "pad_dark" ? 700 : 1400;
    filter.connect(out);
    const sweep = this.lfo(filter.frequency, { rate: 0.02, depth: 300 });
    let index = 0;
    const play = () => {
      const chord = chords[index++ % chords.length];
      const t = this.ctx.currentTime;
      for (const f of chord) {
        for (const detune of [-6, 6]) {
          const o = this.ctx.createOscillator(); o.type = "triangle"; o.frequency.value = f; o.detune.value = detune;
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 3.5);
          g.gain.setValueAtTime(0.05, t + 8); g.gain.exponentialRampToValueAtTime(0.0001, t + 12.5);
          o.connect(g).connect(filter); o.start(t); o.stop(t + 13);
        }
      }
      if (Math.random() < 0.6) this.note(filter, pickOne(chord) * 2, { at: rand(2, 6), dur: 2.5, type: "sine", gain: 0.04, attack: 0.05 });
    };
    play();
    const timer = setInterval(play, 9000);
    return { stop: () => { clearInterval(timer); sweep.stop(); } };
  }

  busLevel(bus) {
    const map = { rotator: "sfx.rotator", ui: "sfx.ui", signature: "sfx.signature", alerts: "sfx.alerts", chatter: "sfx.chatter", sonar: "sfx.sonar" };
    if (bus === "amb") return 1;
    if (bus === "music") return prefs.get("music.vol");
    const key = map[bus];
    return prefs.get(`${key}.on`) ? prefs.get(`${key}.vol`) : 0;
  }
  layerOn(name) { return prefs.get(`amb.${prefKey(name)}.on`); }
  layerVol(name) { return prefs.get(`amb.${prefKey(name)}.vol`); }

  applyPrefs() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(prefs.get("audio.muted") ? 0 : prefs.get("audio.master"), now, 0.08);
    for (const [bus, gain] of Object.entries(this.buses)) gain.gain.setTargetAtTime(this.busLevel(bus), now, 0.1);
    this.echoIn.gain.setTargetAtTime(isVoid() ? 0.5 : 0, now, 0.1);
    const scape = soundscape();
    const wanted = new Map();
    for (const [name] of scape.ambience) {
      if (this.layerOn(name)) wanted.set(`amb:${name}`, { name: resolveLayer(name), bus: "amb", vol: this.layerVol(name) });
    }
    const track = prefs.get(scape.flavor === "void" ? "music.votvTrack" : "music.track");
    if (track) wanted.set("music", { name: resolveLayer(track), bus: "music", vol: 1 });
    for (const [slot, layer] of this.layers) {
      const want = wanted.get(slot);
      if (!want || want.name !== layer.name) this.stopLayer(slot);
    }
    for (const [slot, want] of wanted) this.startLayer(slot, want.name, want.bus, want.vol);
  }

  startLayer(slot, name, bus, volume) {
    const existing = this.layers.get(slot);
    if (existing) { existing.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.4); return; }
    const gain = this.ctx.createGain(); gain.gain.value = 0;
    gain.connect(this.buses[bus]);
    const built = this.buildLayer(name, gain);
    gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 1.2);
    this.layers.set(slot, { name, gain, stop: built.stop });
  }

  stopLayer(slot) {
    const layer = this.layers.get(slot);
    if (!layer) return;
    this.layers.delete(slot);
    layer.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.8);
    setTimeout(() => { layer.stop(); layer.gain.disconnect(); }, 4000);
  }

  /* ---------- interface sounds ---------- */
  ui(kind) {
    if (!this.ready || this.busLevel("ui") <= 0) return;
    const out = this.buses.ui, v = isVoid();
    const w = v ? "sine" : "square", g = v ? 0.25 : 0.12;
    const seq = {
      click: [[v ? rand(900, 1300) : 1800, 0, 0.03]],
      hover: [[v ? 700 : 2400, 0, 0.015]],
      tab: [[v ? 660 : 1320, 0, 0.04], [v ? 990 : 1760, 0.045, 0.04]],
      toggle: [[v ? 520 : 1046, 0, 0.03], [v ? 780 : 1568, 0.035, 0.03]],
      open: [[v ? 440 : 880, 0, 0.09, v ? 880 : 1760]],
      close: [[v ? 880 : 1760, 0, 0.09, v ? 440 : 880]],
      confirm: [[v ? 523 : 1046, 0, 0.06], [v ? 659 : 1318, 0.07, 0.06], [v ? 784 : 1568, 0.14, 0.1]],
      error: [[v ? 140 : 180, 0, 0.12], [v ? 120 : 160, 0.15, 0.18]],
      big: [[v ? 330 : 660, 0, 0.18]],
      zoom: [[300, 0, 0.25, 1200]],
      compute: Array.from({ length: 8 }, (_, i) => [pickOne(v ? [400, 600, 800] : [1320, 1760, 2093, 2637]), i * 0.05, 0.035]),
      power: [[110, 0, 0.9, 880], [220, 0.15, 0.8, 1760]],
      download: Array.from({ length: 6 }, (_, i) => [600 + i * 220, i * 0.04, 0.035]),
    }[kind] || [[1500, 0, 0.03]];
    for (const [freq, at, dur, slideTo] of seq) {
      this.note(out, freq, { at, dur, type: kind === "error" ? "sawtooth" : kind === "power" ? "sine" : w, gain: g, slideTo,
                             filter: kind === "error" ? 900 : v ? 2500 : null });
    }
  }

  /* rotator: motor hum while the real Stellarium view turns, plus servo ticks */
  motorOn() {
    if (!this.ready || this.motor) return;
    const gain = this.ctx.createGain(); gain.gain.value = 0;
    gain.connect(this.buses.rotator);
    const parts = isVoid()
      ? [this.osc(gain, { type: "sawtooth", freq: 48, gain: 0.25 }), this.noise(gain, { type: "bandpass", freq: 300, q: 2, gain: 0.5 })]
      : [this.osc(gain, { type: "sawtooth", freq: 92, gain: 0.18 }), this.osc(gain, { type: "square", freq: 184.5, gain: 0.05 }),
         this.noise(gain, { type: "bandpass", freq: 900, q: 1.2, gain: 0.35 })];
    parts.push(this.lfo(gain.gain, { rate: 7, depth: 0.04 }));
    gain.gain.setTargetAtTime(0.5, this.ctx.currentTime, 0.15);
    this.motor = { gain, parts };
  }

  motorOff() {
    if (!this.motor) return;
    const { gain, parts } = this.motor;
    this.motor = null;
    gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
    setTimeout(() => { parts.forEach(p => p.stop()); gain.disconnect(); }, 800);
  }

  tick() {
    if (!this.ready || this.busLevel("rotator") <= 0) return;
    if (isVoid()) this.note(this.buses.rotator, 1200 * rand(0.95, 1.05), { dur: 0.03, type: "sine", gain: 0.2 });
    else this.burst(this.buses.rotator, { dur: 0.012, freq: rand(2500, 3500), q: 3, gain: 0.5 });
  }

  /* ---------- object signal signatures ---------- */
  playSignature(model, seconds = 9, { name = "", category = "" } = {}) {
    this.stopSignature();
    if (!this.ready || this.busLevel("signature") <= 0) return;
    const out = this.ctx.createGain(); out.gain.value = 0;
    out.connect(this.buses.signature);
    if (isVoid()) out.connect(this.echoIn);
    const now = this.ctx.currentTime;
    out.gain.setTargetAtTime(1, now, 0.5);
    out.gain.setTargetAtTime(0, now + seconds - 1.5, 0.5);
    const parts = this.signatureRecipe(model, out, { name, category, seconds });
    const timer = setTimeout(() => this.stopSignature(), (seconds + 1.5) * 1000);
    this.signature = { out, parts, timer };
  }

  signatureRecipe(model, out, { name, category, seconds }) {
    const p = [];
    const pitch = isVoid() ? 0.75 : 1;
    const kind = category === "seti signal" ? "seti" : model;
    switch (kind) {
      case "planet": case "moon": case "ringed": {
        const o = this.osc(out, { type: "sine", freq: 320 * pitch, gain: 0.25 }); p.push(o, this.lfo(o.osc.frequency, { rate: 0.35, depth: 90 }));
        p.push(this.noise(out, { type: "bandpass", freq: 800, q: 2, gain: 0.15 })); break;
      }
      case "gasgiant": {   // Jupiter-style decametric "ocean waves"
        const n = this.noise(out, { type: "bandpass", freq: 600 * pitch, q: 1.5, gain: 0.6 });
        p.push(n, this.lfo(n.gain.gain, { rate: 0.5, depth: 0.5 }), this.lfo(n.filter.frequency, { rate: 0.21, depth: 300 })); break;
      }
      case "pulsar": { const rate = /crab/i.test(name) ? 30 : /vela/i.test(name) ? 11 : 1.4;
        p.push(this.noise(out, { type: "lowpass", freq: 1500, gain: 0.08 }), this.every(1000 / rate, 1000 / rate, () => this.burst(out, { dur: 0.03, freq: 1200 * pitch, gain: 0.7 }))); break; }
      case "star": case "nova": case "binary": case "quasar":
        p.push(this.noise(out, { type: "highpass", freq: 1500, gain: 0.12 }), this.every(30, 220, () => this.burst(out, { dur: rand(0.005, 0.03), freq: rand(1000, 6000), gain: 0.4 }))); break;
      case "galaxy": case "nebula": case "cluster": case "constellation": {
        const n = this.noise(out, { type: "lowpass", freq: 900 * pitch, gain: 0.35 }); p.push(n, this.lfo(n.gain.gain, { rate: 0.12, depth: 0.25 }));
        p.push(this.osc(out, { type: "sine", freq: 110 * pitch, gain: 0.08 })); break;
      }
      case "satellite": case "station": case "starlink": case "telescope": {   // the object's name in Morse
        const text = String(name || "SAT").toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, 12);
        let t = 0.3; const unit = 0.07;
        for (const ch of text) {
          if (ch === " ") { t += unit * 4; continue; }
          for (const sym of MORSE[ch] || "") { const d = sym === "." ? unit : unit * 3;
            if (t + d < seconds - 1.5) this.note(out, 760 * pitch, { at: t, dur: d, type: "sine", gain: 0.3, attack: 0.005 }); t += d + unit; }
          t += unit * 2;
        }
        p.push(this.noise(out, { type: "bandpass", freq: 1000, q: 0.8, gain: 0.08 })); break;
      }
      case "debris": case "rocketbody": case "signal": p.push(this.noise(out, { type: "bandpass", freq: 1800, q: 0.4, gain: 0.35 }),
        this.osc(out, { type: "sine", freq: rand(600, 1400), gain: 0.06 })); break;
      case "asteroid": case "meteor": case "comet":
        p.push(this.every(20, 400, () => this.burst(out, { dur: 0.006, freq: 4000, q: 0.5, gain: 0.8 }))); break;
      case "probe": {   // FSK telemetry
        let bit = 0; p.push(this.every(40, 40, () => this.note(out, (bit = Math.random() < 0.5 ? 0 : 1) ? 2200 * pitch : 1200 * pitch, { dur: 0.04, type: "square", gain: 0.08, attack: 0.002 })));
        p.push(this.noise(out, { type: "lowpass", freq: 3000, gain: 0.06 })); break;
      }
      case "seti": default: {   // eerie narrowband tone drifting around a nod to the 21 cm line
        const o = this.osc(out, { type: "sine", freq: 1420 / 2 * pitch, gain: 0.18 });
        o.osc.frequency.linearRampToValueAtTime(1420 / 2 * pitch * 1.03, this.ctx.currentTime + seconds);
        p.push(o, this.lfo(o.gain.gain, { rate: 0.18, depth: 0.12 }), this.noise(out, { type: "lowpass", freq: 2500, gain: 0.12 })); break;
      }
    }
    return p;
  }

  stopSignature() {
    if (!this.signature) return;
    const { out, parts, timer } = this.signature;
    this.signature = null;
    clearTimeout(timer);
    out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    setTimeout(() => { parts.forEach(part => part.stop()); out.disconnect(); }, 900);
  }

  chatter() {
    if (!this.ready || this.busLevel("chatter") <= 0) return;
    const n = Math.floor(rand(1, 5)), v = isVoid();
    for (let i = 0; i < n; i++) this.note(this.buses.chatter, pickOne(v ? [330, 440, 550, 660] : [1046, 1318, 1568, 2093, 2637]),
      { at: i * rand(0.06, 0.12), dur: rand(0.03, 0.08), type: v ? "sine" : "square", gain: v ? 0.25 : 0.1 });
  }

  sonar() {
    if (!this.ready || this.busLevel("sonar") <= 0) return;
    this.note(this.buses.sonar, 1180, { dur: 2.2, type: "sine", gain: 0.35, attack: 0.01 });
    this.note(this.buses.sonar, 1180 * 1.5, { at: 0.002, dur: 0.6, type: "sine", gain: 0.05 });
  }

  alert(kind) {
    if (!this.ready || this.busLevel("alerts") <= 0) return;
    const out = this.buses.alerts, v = isVoid(), w = v ? "sine" : "square", g = v ? 0.3 : 0.14;
    const seq = {
      detection: [[784, 0, 0.1], [988, 0.12, 0.1], [1175, 0.24, 0.18]],
      rf: [[1200, 0, 0.08], [900, 0.1, 0.08], [1200, 0.2, 0.08], [900, 0.3, 0.08]],
      satellite: [[1318, 0, 0.25], [988, 0.2, 0.35]],
      download: Array.from({ length: 6 }, (_, i) => [600 + i * 220, i * 0.04, 0.035]),
    }[kind] || [[1000, 0, 0.2]];
    for (const [freq, at, dur] of seq) this.note(out, v ? freq / 2 : freq, { at, dur, type: w, gain: g });
  }

  async powerOff() {
    if (!this.ctx) return;
    for (const slot of [...this.layers.keys()]) this.stopLayer(slot);
    this.motorOff(); this.stopSignature();
    setTimeout(() => this.ctx && this.ctx.suspend(), 1500);
  }
}

const audio = new AudioEngine();
