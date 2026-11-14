/* Signal Panel main controller: boot, routing, polling, console rotator, options, screensaver. */
"use strict";

const VIEWS = { console: null, sky: Sky, database: Database, signals: Signals, space: Space, system: System, control: Control };
const DEEP_SKY = new Set(["cluster", "nebula", "planetary nebula", "supernova remnant", "galaxy", "quasar", "double star", "variable star", "star", "nova"]);
const SETI = new Set(["seti signal", "radio source", "pulsar", "probe"]);

/* ======================= CONSOLE =======================
   Every value here is real:
   - VIEW COORDINATES / STELLARIUM VIEW: the live Stellarium view (polled every 2 s).
   - VIEW SPEEDS and the servo/tick sounds: the measured rate that view is turning.
   - TARGET: a database record (an object you observed in Stellarium, a planet, a
     catalogue object or an RTL-SDR event) with its live or computed position.
   Auto cycle only changes which record is displayed; it never moves Stellarium
   unless "Drive Stellarium" is enabled in options (requires the control PIN). */
const Console = {
  target: null,
  pool: [], recent: [], bucketIndex: 0,
  lastTickAt: 0, holdUntil: 0, manualUntil: 0,

  init() {
    this.holo = new Holo($("#console-holo"));
    this.holo.show("antenna", "idle");
    $("#btn-autoscan").onclick = () => { prefs.set("console.autoscan", !prefs.get("console.autoscan")); audio.ui("toggle"); this.syncButtons(); if (prefs.get("console.autoscan")) this.next(true); };
    $("#btn-next").onclick = () => { audio.ui("big"); this.next(true); };
    $("#btn-follow").onclick = () => { prefs.set("console.autoscan", false); audio.ui("toggle"); this.syncButtons(); this.follow(); };
    $("#btn-target-open").onclick = () => { if (this.target?.id) App.openRecord(this.target.id); else if (this.target?.rf_id) App.openSignal(this.target.rf_id); };
    this.syncButtons();
    setInterval(() => this.step(), 100);
    setInterval(() => this.refreshPool(), 120000);
    this.refreshPool().then(() => { if (prefs.get("console.autoscan")) this.next(true); else this.follow(); });
  },

  syncButtons() {
    const on = prefs.get("console.autoscan");
    $("#btn-autoscan").textContent = `AUTO CYCLE: ${on ? "ON" : "OFF"}`;
    $("#btn-autoscan").classList.toggle("on", on);
    $("#btn-follow").classList.toggle("on", !on);
  },

  async refreshPool() {
    const minAlt = prefs.get("console.minAlt");
    const sources = new Set(prefs.get("console.sources"));
    const buckets = {};
    try {
      const [sky, feed] = await Promise.all([api.get(`/api/sky?mag=6.5${ownParam()}`), api.get("/api/feed?limit=120")]);
      const up = sky.objects.filter(o => o.alt >= minAlt);
      buckets.planets = up.filter(o => o.category === "planet" || o.category === "moon");
      buckets.deepsky = up.filter(o => DEEP_SKY.has(o.category) && (o.vmag == null || o.vmag < (o.category.includes("star") ? 2.5 : 7)));
      buckets.seti = up.filter(o => SETI.has(o.category));
      const dayAgo = Date.now() - 86400000;
      buckets.detections = feed.items.filter(i => i.kind === "sighting" && Date.parse(i.t) > dayAgo)
        .map(i => ({ id: i.phenomenon_id, name: i.name, category: i.category, model: i.model }));
      buckets.rf = feed.items.filter(i => i.kind === "rf event" && Date.parse(i.t) > Date.now() - 2 * 86400000)
        .map(i => ({ rf_id: i.rf_id, name: `${fmt.mhz(i.center_hz, 4)} MHZ`, category: "rf event", model: "signal", rf: i }));
    } catch { return; }
    this.pool = Object.entries(buckets).filter(([key, list]) => sources.has(key) && list.length);
  },

  pick() {
    for (let attempt = 0; attempt < this.pool.length; attempt++) {
      const [, list] = this.pool[this.bucketIndex++ % this.pool.length];
      const fresh = list.filter(o => !this.recent.includes(o.name));
      const options = fresh.length ? fresh : list;
      const choice = options[Math.floor(Math.random() * options.length)];
      if (choice) return choice;
    }
    return null;
  },

  async next(force = false) {
    if (!force && Date.now() < this.manualUntil) return;
    const choice = this.pick();
    if (!choice) { this.follow(); return; }
    await this.engage(choice);
  },

  async engage(obj, manual = false) {
    this.recent = [obj.name, ...this.recent.filter(n => n !== obj.name)].slice(0, 20);
    if (manual) this.manualUntil = Date.now() + prefs.get("console.dwell") * 1000;
    this.holdUntil = Date.now() + prefs.get("console.dwell") * 1000;
    $("#console-holo-caption").textContent = "LOADING RECORD...";
    let target = { ...obj };
    if (obj.id) {
      try { target = { ...target, ...(await api.get(`/api/phenomena/${obj.id}`)) }; } catch { /* keep list data */ }
    }
    const pos = target.position;
    if (pos && pos.az != null) {
      target.az = pos.az; target.alt = pos.alt;
      target.posNote = pos.live ? "LIVE FROM STELLARIUM" : pos.as_of ? `SURVEY ${fmt.when(pos.as_of)}` : "COMPUTED FROM J2000";
    } else if (target.az != null) {
      target.posNote = target.live ? "LIVE FROM STELLARIUM" : "COMPUTED FROM J2000";
    }
    this.target = target;
    audio.ui("compute");
    this.holo.show(target.model || "unknown", target.name);
    const where = target.alt == null ? "NO SKY POSITION" : target.alt >= 0 ? "ABOVE HORIZON" : "BELOW HORIZON";
    $("#console-holo-caption").textContent = `${fmt.upper(target.category)} · ${where}`;
    this.renderTarget();
    audio.playSignature(target.planet_class === "gas giant" && target.model === "planet" ? "gasgiant" : target.model,
      Math.min(14, prefs.get("console.dwell") * 0.4), { name: target.name, category: target.category });
    if (prefs.get("console.driveStellarium") && App.state?.auth && target.az != null && target.alt > 0) {
      const body = target.category === "satellite" || SETI.has(target.category)
        ? ["/api/control/altaz", { az: target.az, alt: target.alt }] : ["/api/control/focus", { name: target.name }];
      api.post(...body).catch(() => {});
    }
  },

  follow() {
    this.target = null;
    this.holo.show("antenna", "idle");
    $("#console-holo-caption").textContent = "STELLARIUM VIEW";
    this.renderTarget();
  },

  renderTarget() {
    const t = this.target;
    if (!t) {
      const sel = App.state?.stellarium?.selection;
      $("#t-name").textContent = sel ? fmt.upper(sel).slice(0, 60) : "NO SELECTION";
      $("#t-meta").innerHTML = "SHOWING THE CURRENT STELLARIUM SELECTION";
      $("#c-naz").textContent = "---"; $("#c-nel").textContent = "---";
      return;
    }
    $("#t-name").textContent = fmt.upper(t.name);
    const lines = [];
    if (t.rf) {
      lines.push(`RADIO EVENT #${t.rf.rf_id} · ${esc(fmt.upper(t.rf.band))}`,
        `SCORE ${fmt.num(t.rf.score, 1)} · ${esc(fmt.upper(t.rf.classification || ""))}`, `RECORDED ${fmt.when(t.rf.t)}`);
    } else {
      const mag = fmt.mag(t.vmag);
      lines.push(esc(fmt.upper(t.category)) + (mag ? ` · MAG ${mag}` : "") + (t.constellation ? ` · ${esc(fmt.upper(t.constellation))}` : ""));
      if (t.sightings) lines.push(`SIGHTINGS ${fmt.int(t.sightings)} · LAST ${fmt.age(t.last_seen_utc)}`);
      if (t.group || t.catalog) lines.push(esc(fmt.upper(t.group || t.catalog)));
      if (t.posNote) lines.push(`POSITION: ${esc(t.posNote)}${t.approximate ? " (APPROXIMATE)" : ""}`);
    }
    $("#t-meta").innerHTML = lines.join("<br>");
    $("#c-naz").textContent = t.az != null ? fmt.deg(t.az) : "---";
    $("#c-nel").textContent = t.alt != null ? fmt.deg(t.alt) : "---";
  },

  /* 10 Hz: mirror the real Stellarium view; servo sounds only while it really turns. */
  step() {
    const s = App.state?.stellarium;
    const online = Boolean(s?.online);
    const view = online ? s.view : null;
    const speed = online ? s.speed || { az: 0, alt: 0 } : { az: 0, alt: 0 };
    setText("#c-az", view?.az != null ? fmt.deg(view.az) : "---");
    setText("#c-el", view?.alt != null ? fmt.deg(view.alt) : "---");
    setText("#s-azs", online ? fmt.num(speed.az, 4) : "---");
    setText("#s-els", online ? fmt.num(speed.alt, 4) : "---");
    setText("#r-fov", view?.fov ? `${fmt.num(view.fov, 2)}°` : "---");
    const azMoving = speed.az > 0.02, elMoving = speed.alt > 0.02;
    this.setStatus("#r-az", online ? (azMoving ? "Turning..." : "Steady") : "Offline", azMoving);
    this.setStatus("#r-el", online ? (elMoving ? "Turning..." : "Steady") : "Offline", elMoving);
    if (azMoving || elMoving) {
      audio.motorOn();
      const interval = Math.max(140, Math.min(900, 900 / Math.max(speed.az + speed.alt, 0.1)));
      const now = performance.now();
      if (now - this.lastTickAt > interval) { audio.tick(); this.lastTickAt = now; }
    } else if (audio.motor) audio.motorOff();
    if (this.target && Date.now() > this.holdUntil && prefs.get("console.autoscan") && App.view === "console") {
      this.holdUntil = Date.now() + 5000;  // guard against overlapping fetches
      this.next();
    }
  },

  setStatus(sel, text, active) {
    const node = $(sel);
    if (node.textContent !== text) { node.textContent = text; node.classList.toggle("blink", active); }
  },

  updateStatus(state) {
    const pc = state.pc || {};
    setText("#s-sys", pc.cpu != null ? fmt.num(pc.cpu, 1) : "---");
    setText("#s-mem", pc.memory != null ? fmt.num(pc.memory, 1) : "---");
    setText("#s-dl", pc.net_rx_bps != null ? fmt.num(pc.net_rx_bps * 8 / 1e6, 2) : "---");
    setText("#s-cd", state.objects_in_view != null ? fmt.int(state.objects_in_view) : "---");
    setText("#s-ad", state.rf_events_24h != null ? fmt.int(state.rf_events_24h) : "---");
    setText("#s-sat", state.sightings_24h != null ? fmt.int(state.sightings_24h) : "---");
    setText("#s-temp", pc.temperature != null ? fmt.num(pc.temperature, 1) : "N/A");
    if (!this.target) this.renderTarget();
  },
};

/* ======================= APP ======================= */
const STALE_MS = 60000;
const App = {
  enteredAt: {},
  state: null, view: "console", lastSighting: null, lastRf: null, idleSince: Date.now(), saver: false,

  boot() {
    applyDisplayPrefs();
    const params = new URLSearchParams(location.search);
    const log = $("#boot-log");
    const line = text => { log.textContent += `${text}\n`; };
    // Real link checks against the panel server, not decoration.
    (async () => {
      try {
        const st = await api.get("/api/state");
        const src = st.sources || {};
        const ok = v => (v ? "OK" : "UNAVAILABLE");
        line(`SIGNAL PANEL ${st.version} ............. ONLINE`);
        line(`STELLARIUM REMOTE CONTROL ....... ${st.stellarium.online ? "OK" : "OFFLINE"}`);
        line(`RTL-SDR BAND MONITOR ............ ${src.rtlsdr?.enabled ? ok(src.rtlsdr?.available) : "DISABLED"}`);
        line(`PHENOMENA ON FILE ............... ${fmt.int(st.phenomena_total)}`);
      } catch (error) {
        line(`PANEL SERVER UNREACHABLE: ${error.message}`);
      }
    })();
    const power = async () => {
      $("#boot-power").disabled = true;
      await audio.init();
      audio.ui("power");
      setTimeout(() => this.start(params), 450);
    };
    $("#boot-power").onclick = power;
    // Kiosk mode (?kiosk=1): start straight away; audio unlocks on the first click/keypress.
    if (params.get("kiosk") === "1") {
      this.start(params);
      const unlock = () => { audio.init(); window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
      window.addEventListener("pointerdown", unlock); window.addEventListener("keydown", unlock);
    }
  },

  start(params) {
    if (this.started) return;
    this.started = true;
    $("#boot").hidden = true;
    $("#monitor").hidden = false;
    for (const ctl of Object.values(VIEWS)) if (ctl?.init) ctl.init();
    Console.init();
    Options.init();
    $$("#tabs .tab").forEach(tab => tab.onclick = () => { audio.ui("tab"); this.show(tab.dataset.view); });
    $("#btn-options").onclick = () => Options.open();
    $("#btn-mute").onclick = () => { prefs.set("audio.muted", !prefs.get("audio.muted")); this.syncMute(); };
    $("#btn-fullscreen").onclick = () => this.fullscreen();
    $("#btn-screensaver").onclick = () => this.enterSaver();
    $("#btn-power").onclick = () => this.powerOff();
    this.syncMute();
    this.bindIdle();
    this.bindKeys();
    this.show(params.get("view") && VIEWS[params.get("view")] !== undefined ? params.get("view") : prefs.get("app.view") || "console");
    this.poll();
    setInterval(() => this.poll(), 2000);
    this.ticker();
    setInterval(() => this.ticker(), 30000);
    setInterval(() => this.refreshActive(), 20000);
    setInterval(() => this.clock(), 1000);
    this.scheduleChatter();
    this.scheduleFlicker();
    if (params.get("saver") === "1") setTimeout(() => this.enterSaver(), 800);
  },

  show(view) {
    if (!(view in VIEWS)) view = "console";
    const previous = VIEWS[this.view];
    if (previous && previous.leave && this.view !== view) previous.leave();
    this.view = view;
    prefs.set("app.view", view);
    $$("#views .view").forEach(section => { section.hidden = section.dataset.view !== view; });
    $$("#tabs .tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === view));
    // Each screen keeps its DOM (lists, scroll position, selection, loaded images)
    // between visits; it only re-fetches when its data is older than STALE_MS or
    // after a resize/theme change. The 20 s refresh keeps the visible one current.
    const ctl = VIEWS[view];
    const entered = this.enteredAt[view] || 0;
    if (ctl && ctl.enter) {
      if (!entered || Date.now() - entered > (ctl.staleMs ?? STALE_MS)) { this.enteredAt[view] = Date.now(); ctl.enter(); }
      else if (ctl.resume) ctl.resume();
    }
  },
  invalidateViews() { this.enteredAt = {}; },

  refreshActive() {
    if (document.hidden) return;
    this.enteredAt[this.view] = Date.now();
    const ctl = VIEWS[this.view];
    if (this.view === "sky") { Sky.refresh(); if (Math.random() < 0.2) Sky.refreshFrame(); }
    else if (this.view === "system") System.refresh();
    else if (ctl && ctl.refresh && this.view !== "database") ctl.refresh();
  },

  async poll() {
    if (document.hidden && Date.now() - (this.lastPoll || 0) < 15000) return;   // hidden tab: poll every 15 s
    this.lastPoll = Date.now();
    let state;
    try { state = await api.get("/api/state"); }
    catch {
      this.setLed("#led-stel", "bad"); $("#bezel-led").style.background = "var(--danger)";
      return;
    }
    $("#bezel-led").style.background = "";
    this.state = state;
    const src = state.sources || {};
    this.setLed("#led-stel", state.stellarium.online ? "on" : "bad");
    this.setLed("#led-sdr", !src.rtlsdr?.enabled ? "" : src.rtlsdr.available ? "on" : "bad");
    Console.updateStatus(state);
    if (this.view === "sky") Sky.updateView(state.stellarium.view);
    if (this.view === "control") Control.update(state);
    if (this.view === "system" && Date.now() - (this.lastSystem || 0) > 5000) { this.lastSystem = Date.now(); System.refresh(); }
    this.checkAlerts(state);
  },

  checkAlerts(state) {
    const s = state.latest_sighting, r = state.latest_rf;
    if (this.lastSighting !== null && s && s.id !== this.lastSighting && s.category !== "constellation") {
      audio.alert("detection");
      toast(`OBSERVATION LOGGED: ${fmt.upper(s.name)} (${fmt.upper(s.category)})`);
      this.ticker();
    }
    if (this.lastRf !== null && r && r.id !== this.lastRf) {
      audio.alert("rf");
      toast(`RADIO EVENT #${r.id}: ${fmt.mhz(r.center_hz, 4)} MHZ · SCORE ${fmt.num(r.score, 1)}`);
      this.ticker();
    }
    this.lastSighting = s ? s.id : 0;
    this.lastRf = r ? r.id : 0;
  },

  setLed(sel, cls) { const n = $(sel); n.className = `led ${cls}`; },

  clock() {
    const now = new Date(), p = n => String(n).padStart(2, "0");
    const utc = prefs.get("display.utc");
    const h = utc ? now.getUTCHours() : now.getHours(), m = utc ? now.getUTCMinutes() : now.getMinutes(), s = utc ? now.getUTCSeconds() : now.getSeconds();
    const d = utc ? now.getUTCDate() : now.getDate(), mo = (utc ? now.getUTCMonth() : now.getMonth()) + 1, y = utc ? now.getUTCFullYear() : now.getFullYear();
    $("#top-clock").textContent = `${p(h)}:${p(m)}:${p(s)}${utc ? "Z" : ""}`;
    $("#c-time").textContent = `${p(h)}:${p(m)}`;
    const fmtDate = prefs.get("display.dateFormat");
    $("#c-date").textContent = fmtDate === "mdy" ? `${p(mo)}/${p(d)}/${y}` : fmtDate === "iso" ? `${y}-${p(mo)}-${p(d)}` : `${p(d)}/${p(mo)}/${y}`;
    if (this.saver === false && prefs.get("console.screensaverMinutes") > 0 && Date.now() - this.idleSince > prefs.get("console.screensaverMinutes") * 60000 && $("#options").hidden) this.enterSaver();
  },

  async ticker() {
    let feed;
    try { feed = await api.get("/api/feed?limit=30"); } catch { return; }
    const parts = feed.items.map(i => {
      if (i.kind === "rf event") return `≋ RF EVENT #${i.rf_id} <b>${fmt.mhz(i.center_hz, 4)} MHZ</b> ${esc(fmt.upper(i.band))} SCORE ${fmt.num(i.score, 0)} · ${fmt.age(i.t)}`;
      return `${glyph(i.model)} OBSERVED <b>${esc(fmt.upper(i.name))}</b> (${esc(fmt.upper(i.category))}) · ${fmt.age(i.t)}`;
    });
    $("#ticker-track").innerHTML = parts.join(" &nbsp;&nbsp;///&nbsp;&nbsp; ") || "NO RECENT ACTIVITY";
  },

  scheduleFlicker() {
    setTimeout(() => {
      const screen = $("#screen");
      if (screen && document.body.classList.contains("fx-flicker") && !document.body.classList.contains("reduce-motion") && !document.hidden) {
        screen.classList.add("flick");
        setTimeout(() => screen.classList.remove("flick"), 450);
      }
      this.scheduleFlicker();
    }, 6000 + Math.random() * 8000);
  },

  scheduleChatter() {
    const wait = 7000 + Math.random() * 22000;
    setTimeout(() => {
      if (App.view === "console" && prefs.get("sfx.chatter.on") && !document.hidden) audio.chatter();
      this.scheduleChatter();
    }, wait);
    if (!this.sonarScheduled) {
      this.sonarScheduled = true;
      const sonar = () => setTimeout(() => {
        if (prefs.get("audio.soundscape") === "votv" && !document.hidden) audio.sonar();
        sonar();
      }, 25000 + Math.random() * 35000);
      sonar();
    }
  },

  trackOnConsole(obj) {
    this.show("console");
    const target = { ...obj };
    if (obj.position) { target.az = obj.position.az; target.alt = obj.position.alt; }
    Console.engage(target, true);
  },
  openRecord(id) { this.show("database"); Database.select(id); },
  openSignal(id) { this.show("signals"); Signals.select(id); },

  syncMute() {
    const muted = prefs.get("audio.muted");
    $("#btn-mute").classList.toggle("off", muted);
    $("#btn-mute").title = muted ? "Unmute (M)" : "Mute (M)";
  },

  fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => toast("FULLSCREEN NOT AVAILABLE", true));
  },

  enterSaver() {
    if (this.saver) return;
    this.saver = this.view;
    this.show("console");
    document.body.classList.add("saver");
    if (!prefs.get("console.autoscan")) { this.saverForcedScan = true; prefs.set("console.autoscan", true); Console.syncButtons(); Console.next(true); }
  },

  exitSaver() {
    if (!this.saver) return;
    const back = this.saver;
    this.saver = false;
    document.body.classList.remove("saver");
    if (this.saverForcedScan) { this.saverForcedScan = false; prefs.set("console.autoscan", false); Console.syncButtons(); }
    if (back !== "console") this.show(back);
  },

  bindIdle() {
    const wake = () => { this.idleSince = Date.now(); if (this.saver && Date.now() - this.saverAt > 800) this.exitSaver(); };
    for (const evt of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(evt, wake, { passive: true });
    const original = this.enterSaver.bind(this);
    this.enterSaver = () => { this.saverAt = Date.now(); original(); };
  },

  bindKeys() {
    window.addEventListener("keydown", e => {
      if (e.target.matches("input, select, textarea")) return;
      const keys = Object.keys(VIEWS);
      if (/^[1-9]$/.test(e.key)) { audio.ui("tab"); this.show(keys[+e.key - 1]); }
      else if (e.key === "o" || e.key === "O") Options.open();
      else if (e.key === "m" || e.key === "M") { prefs.set("audio.muted", !prefs.get("audio.muted")); this.syncMute(); }
      else if (e.key === "f" || e.key === "F") this.fullscreen();
      else if (e.key === "s" || e.key === "S") setTimeout(() => this.enterSaver(), 50);
      else if (e.key === "n" || e.key === "N") Console.next(true);
      else if (e.key === "Escape") Options.close();
    });
  },

  powerOff() {
    audio.ui("close");
    audio.powerOff();
    $("#monitor").hidden = true;
    $("#boot").hidden = false;
    $("#boot-power").disabled = false;
    $("#boot-power").onclick = async () => {
      await audio.init(); audio.ui("power");
      $("#boot").hidden = true; $("#monitor").hidden = false;
    };
  },
};

/* ======================= DISPLAY PREFS ======================= */
/* Interface skins. The VOTV skins carry their own palettes (from the game's
   terminals); the phosphor colour applies to the Signal Simulator skin. */
const SKINS = {
  signalsim: { label: "SIGNAL SIMULATOR STYLE (PHOSPHOR MONITORS)", body: [] },
  votv_terminal: { label: "VOTV STYLE · MONOCHROME CONSOLE TERMINAL", body: ["skin-votv", "skin-votv-terminal"], rgb: [236, 236, 236] },
  votv_unit: { label: "VOTV STYLE · AMBER PROCESSING UNIT", body: ["skin-votv", "skin-votv-unit"], rgb: [255, 212, 40] },
};
const THEMES = {
  lime: ["LIME (SIGNAL SIMULATOR)", [82, 255, 82]], phosphor: ["P1 GREEN", [51, 255, 102]],
  teal: ["TEAL", [40, 240, 190]], cyan: ["CYAN", [80, 230, 255]], blue: ["BLUE", [90, 150, 255]],
  purple: ["PURPLE", [180, 120, 255]], magenta: ["MAGENTA", [255, 80, 230]], pink: ["PINK", [255, 130, 190]],
  red: ["RED", [255, 70, 60]], orange: ["ORANGE", [255, 140, 40]], amber: ["AMBER", [255, 176, 46]],
  yellow: ["YELLOW", [240, 235, 80]], white: ["WHITE", [225, 240, 225]], custom: ["CUSTOM (PICK BELOW)", null],
};
function themeRgb() {
  const key = prefs.get("display.theme");
  if (key === "custom") {
    const hex = String(prefs.get("display.customColor") || "#52ff52").replace("#", "");
    const value = parseInt(hex.length === 3 ? hex.split("").map(c => c + c).join("") : hex, 16);
    if (!Number.isNaN(value)) {
      // keep custom colours bright enough to read on black
      const rgb = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
      const max = Math.max(...rgb, 1);
      return max < 140 ? rgb.map(v => Math.round(v * 140 / max)) : rgb;
    }
  }
  return (THEMES[key] || THEMES.lime)[1] || THEMES.lime[1];
}
function hueOf([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 38;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
function applyDisplayPrefs() {
  const body = document.body;
  const skin = SKINS[prefs.get("display.skin")] || SKINS.signalsim;
  for (const cls of ["skin-votv", "skin-votv-terminal", "skin-votv-unit"]) body.classList.toggle(cls, skin.body.includes(cls));
  const rgb = skin.rgb || themeRgb();
  body.style.setProperty("--c", rgb.join(", "));
  body.style.setProperty("--hl-text", `rgb(${rgb.map(v => Math.round(v * 0.1)).join(", ")})`);
  body.style.setProperty("--tint-rot", `${Math.round(hueOf(rgb) - 38)}deg`);  // sepia sits at ~38 deg
  body.classList.toggle("font-mono", prefs.get("display.font") === "mono");
  for (const size of ["s", "l", "xl"]) body.classList.toggle(`scale-${size}`, prefs.get("display.scale") === size);
  body.classList.toggle("fx-scanlines", prefs.get("display.scanlines"));
  body.classList.toggle("fx-glow", prefs.get("display.glow"));
  body.classList.toggle("fx-flicker", prefs.get("display.flicker"));
  body.classList.toggle("fx-vignette", prefs.get("display.vignette"));
  body.classList.toggle("reduce-motion", prefs.get("display.reduceMotion"));
  // 100% = the original 90 s per pass; default 50% = 180 s.
  const ticker = Math.max(0.1, Math.min(2, +prefs.get("display.tickerSpeed") || 0.5));
  body.style.setProperty("--ticker-duration", `${(90 / ticker).toFixed(1)}s`);
}
document.addEventListener("prefs", e => {
  if (e.detail.key === "*" || e.detail.key.startsWith("display.")) applyDisplayPrefs();
  if (["display.theme", "display.customColor", "display.skin"].includes(e.detail.key) && App.started) { App.invalidateViews(); App.refreshActive(); }
  if (e.detail.key === "data.ownOnly" && App.started) {
    Console.refreshPool();
    const ctl = VIEWS[App.view];
    if (ctl && ctl.enter) ctl.enter();
  }
});

/* ======================= OPTIONS ======================= */
const Options = {
  init() {
    $("#opt-close").onclick = () => this.close();
    $("#options").addEventListener("click", e => { if (e.target.id === "options") this.close(); });
    $$("#opt-tabs button").forEach(btn => btn.onclick = () => {
      audio.ui("tab");
      $$("#opt-tabs button").forEach(b => b.classList.toggle("active", b === btn));
      $$(".opt-tab").forEach(tab => { tab.hidden = tab.dataset.tab !== btn.dataset.tab; });
    });
  },
  open() { this.render(); $("#options").hidden = false; audio.ui("open"); },
  close() { if ($("#options").hidden) return; $("#options").hidden = true; audio.ui("close"); },

  slider(key, label, hint = "", { min = 0, max = 1, step = 0.01, show = v => `${Math.round(v * 100)}` } = {}, toggleKey = null) {
    const id = `opt-${key.replace(/\W/g, "_")}`;
    return `<div class="opt-row">
      ${toggleKey ? `<input type="checkbox" data-toggle="${esc(toggleKey)}" ${prefs.get(toggleKey) ? "checked" : ""} aria-label="${esc(label)} on">` : "<span></span>"}
      <span class="o-name">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ""}</span>
      <input type="range" id="${id}" data-key="${esc(key)}" min="${min}" max="${max}" step="${step}" value="${prefs.get(key)}">
      <span class="o-val" data-for="${id}">${show(prefs.get(key))}</span>
      ${toggleKey && toggleKey.startsWith("amb.") ? "" : ""}</div>`;
  },
  check(key, label, hint = "") {
    return `<div class="opt-row"><input type="checkbox" data-toggle="${esc(key)}" ${prefs.get(key) ? "checked" : ""}>
      <span class="o-name">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ""}</span><span></span><span></span></div>`;
  },
  select(key, label, options, hint = "") {
    return `<div class="opt-row"><span></span><span class="o-name">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ""}</span>
      <select data-select="${esc(key)}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(prefs.get(key)) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select><span></span></div>`;
  },

  render() {
    $("#opt-audio").innerHTML = [
      this.slider("audio.master", "MASTER VOLUME", "", {}, null),
      this.check("audio.muted", "MUTE EVERYTHING"),
      this.select("audio.soundscape", "SOUNDSCAPE", Object.entries(SOUNDSCAPES).map(([key, s]) => [key, s.label]),
        "Every sound is synthesised live in your browser; pick the overall style"),
      ...(prefs.get("audio.soundscape") === "votv" ? [
        this.select("audio.timeOfDay", "TIME OF DAY", [["auto", "AUTO (FOLLOW THE CLOCK)"], ["day", "DAYTIME ONLY"], ["night", "NIGHTTIME ONLY"], ["both", "BOTH (ALTERNATE EVERY 10 MIN)"]],
          "Drives the OUTSIDE ambience and the MUSIC AMBIENCE track"),
        this.slider("sfx.sonar.vol", "SONAR PINGS", "Occasional sonar ping every 25-60 s", {}, "sfx.sonar.on"),
      ] : []),
      `<div class="opt-group">AMBIENCE LAYERS (LOOPED, MIX FREELY)</div>`,
      ...soundscape().ambience.map(([name, label, hint]) => this.slider(`amb.${prefKey(name)}.vol`, label, hint, {}, `amb.${prefKey(name)}.on`)),
      `<div class="opt-group">MUSIC</div>`,
      this.select(prefs.get("audio.soundscape") === "votv" ? "music.votvTrack" : "music.track", "TRACK", soundscape().music),
      this.slider("music.vol", "MUSIC VOLUME"),
      `<div class="opt-group">CONSOLE SOUNDS</div>`,
      this.slider("sfx.rotator.vol", "VIEW SERVO + TICKS", "Plays while the real Stellarium view is turning", {}, "sfx.rotator.on"),
      this.slider("sfx.chatter.vol", "IDLE COMPUTER CHATTER", "Random beeps and blips while on the console", {}, "sfx.chatter.on"),
      this.slider("sfx.ui.vol", "INTERFACE CLICKS", "", {}, "sfx.ui.on"),
      this.slider("sfx.signature.vol", "OBJECT SIGNAL SIGNATURES", "A synthesised radio signature per object type when a target is acquired (satellites send their name in Morse)", {}, "sfx.signature.on"),
      this.slider("sfx.alerts.vol", "DETECTION ALERTS", "Logged Stellarium observations and new RTL-SDR events", {}, "sfx.alerts.on"),
      this.check("audio.pauseHidden", "PAUSE AUDIO WHEN TAB IS HIDDEN"),
      `<div class="row"><button class="btn small" data-preview="tick">TEST TICK</button><button class="btn small" data-preview="alert">TEST ALERT</button><button class="btn small" data-preview="click">TEST CLICK</button><button class="btn small" data-preview="signature">TEST SIGNATURE</button></div>`,
    ].join("");
    $("#opt-display").innerHTML = [
      this.select("display.skin", "INTERFACE SKIN", Object.entries(SKINS).map(([key, s]) => [key, s.label]),
        "Phosphor monitors in the style of Signal Simulator, or terminal styles inspired by Voices of the Void"),
      this.select("display.theme", "PHOSPHOR COLOUR", Object.entries(THEMES).map(([key, [label]]) => [key, label]),
        "Phosphor skin only; the VOTV-style skins have fixed palettes"),
      `<div class="opt-row"><span></span><span class="o-name">CUSTOM COLOUR<small>Used when PHOSPHOR COLOUR is CUSTOM</small></span>
        <input type="color" data-color="display.customColor" value="${esc(prefs.get("display.customColor"))}"><span></span></div>`,
      this.select("display.font", "CONSOLE FONT", [["draco", "BLOCK HEADINGS (DEFAULT)"], ["mono", "PLAIN MONOSPACE"]]),
      this.select("display.scale", "TEXT SIZE", [["s", "SMALL"], ["m", "MEDIUM"], ["l", "LARGE"], ["xl", "EXTRA LARGE (WALL SCREEN)"]]),
      this.check("display.scanlines", "SCANLINES"), this.check("display.glow", "PHOSPHOR GLOW"),
      this.check("display.flicker", "CRT FLICKER"), this.check("display.vignette", "VIGNETTE"),
      this.slider("display.tickerSpeed", "TICKER SCROLL SPEED", "100% = original speed", { min: 0.1, max: 2, step: 0.05, show: v => `${Math.round(v * 100)}%` }),
      this.slider("display.spinSpeed", "HOLOGRAM SPIN SPEED", "Rotation of all holograms", { min: 0.1, max: 2, step: 0.05, show: v => `${Math.round(v * 100)}%` }),
      this.check("display.reduceMotion", "REDUCE MOTION", "Halves hologram speed further, slows the ticker, no radar sweep"),
      this.check("display.utc", "SHOW TIMES IN UTC"),
      this.select("display.dateFormat", "DATE FORMAT", [["dmy", "DD/MM/YYYY"], ["mdy", "MM/DD/YYYY"], ["iso", "YYYY-MM-DD"]]),
    ].join("");
    const sources = prefs.get("console.sources");
    const sourceNames = [["detections", "YOUR STELLARIUM OBSERVATIONS (24H)"], ["planets", "PLANETS + MOON"],
      ["deepsky", "BRIGHT STARS + DEEP SKY"], ["seti", "RADIO SOURCES, PULSARS, SETI SIGNALS"], ["rf", "RTL-SDR EVENTS (48H)"]];
    $("#opt-console").innerHTML = [
      this.check("console.autoscan", "AUTO CYCLE", "Cycle the console through database records automatically (screensaver mode)"),
      this.slider("console.dwell", "DWELL TIME PER TARGET", "Seconds to hold on each target", { min: 10, max: 300, step: 5, show: v => `${v}S` }),
      this.slider("console.minAlt", "MINIMUM ELEVATION", "Ignore targets lower than this", { min: 0, max: 60, step: 1, show: v => `${v}°` }),
      this.slider("console.screensaverMinutes", "SCREENSAVER AFTER IDLE", "0 disables", { min: 0, max: 60, step: 1, show: v => (+v ? `${v}M` : "OFF") }),
      `<div class="opt-group">DATA</div>`,
      this.check("data.ownOnly", "MY OBSERVATIONS ONLY",
        "Show only objects you have selected in Stellarium. Hides catalogue entries and the curated radio/SETI list unless you observed them. Applies to Database, Sky and Auto cycle."),
      `<div class="opt-group">AUTO CYCLE SOURCES</div>`,
      ...sourceNames.map(([key, label]) => `<div class="opt-row"><input type="checkbox" data-source="${key}" ${sources.includes(key) ? "checked" : ""}><span class="o-name">${esc(label)}</span><span></span><span></span></div>`),
      `<div class="opt-group">STELLARIUM</div>`,
      this.check("console.driveStellarium", "DRIVE STELLARIUM DURING AUTO CYCLE",
        "Requires the control PIN. Moves the real Stellarium view to each target; your own view is restored a few idle minutes after cycling stops."),
      `<div class="row"><button class="btn small danger" id="opt-reset">RESET ALL PREFERENCES</button></div>`,
    ].join("");
    $("#opt-about").innerHTML = `<p class="note">SIGNAL PANEL ${esc(App.state?.version || "")} · A LAN CONSOLE FOR STELLARIUM, AN RTL-SDR AND PUBLIC SPACE / SHORTWAVE DATA.</p>
      <p class="note">LIVE SKY FROM STELLARIUM REMOTE CONTROL · OBSERVATIONS = OBJECTS YOU SELECT IN STELLARIUM · RADIO EVENTS FROM RTL_POWER · NASA / JAXA FEEDS · PRIYOM SCHEDULE.</p>
      <p class="note">FAN-MADE THEMES INSPIRED BY SIGNAL SIMULATOR AND VOICES OF THE VOID; NOT AFFILIATED WITH EITHER GAME.</p>
      <p class="note">KEYS: 1-7 SCREENS · O OPTIONS · M MUTE · F FULLSCREEN · S SCREENSAVER · N NEXT TARGET · ESC CLOSE.<br>
      URL FLAGS: ?kiosk=1 (skip power button) · ?saver=1 (start in screensaver) · ?view=sky.</p>`;
    this.bind();
  },

  bind() {
    $$("#options input[type=range][data-key]").forEach(input => input.oninput = () => {
      prefs.set(input.dataset.key, +input.value);
      const out = $(`#options [data-for="${input.id}"]`);
      if (out) out.textContent = this.formatFor(input.dataset.key, +input.value);
    });
    $$("#options [data-toggle]").forEach(box => box.onchange = () => { prefs.set(box.dataset.toggle, box.checked); audio.ui("toggle"); App.syncMute(); Console.syncButtons(); });
    $$("#options [data-select]").forEach(sel => sel.onchange = () => {
      prefs.set(sel.dataset.select, sel.value); audio.ui("click");
      if (sel.dataset.select === "audio.soundscape" || sel.dataset.select === "display.skin") {
        const tab = $("#opt-tabs button.active")?.dataset.tab;
        this.render();
        if (tab) $(`#opt-tabs [data-tab="${tab}"]`).click();
      }
    });
    $$("#options [data-color]").forEach(input => input.oninput = () => {
      prefs.set(input.dataset.color, input.value);
      if (prefs.get("display.theme") !== "custom") prefs.set("display.theme", "custom");
    });
    $$("#options [data-source]").forEach(box => box.onchange = () => {
      const set = new Set(prefs.get("console.sources"));
      box.checked ? set.add(box.dataset.source) : set.delete(box.dataset.source);
      prefs.set("console.sources", [...set]); audio.ui("toggle"); Console.refreshPool();
    });
    $$("#options [data-preview]").forEach(btn => btn.onclick = () => {
      const kind = btn.dataset.preview;
      if (kind === "tick") audio.tick();
      else if (kind === "alert") audio.alert("detection");
      else if (kind === "signature") audio.playSignature("planet", 5, { name: "Jupiter", category: "planet" });
      else audio.ui("click");
    });
    const reset = $("#opt-reset");
    if (reset) reset.onclick = () => { prefs.reset(); audio.ui("error"); this.render(); App.syncMute(); Console.syncButtons(); };
  },

  formatFor(key, v) {
    if (key === "console.dwell") return `${v}S`;
    if (key === "console.minAlt") return `${v}°`;
    if (key === "console.screensaverMinutes") return v ? `${v}M` : "OFF";
    if (key === "display.tickerSpeed" || key === "display.spinSpeed") return `${Math.round(v * 100)}%`;
    return `${Math.round(v * 100)}`;
  },
};

window.addEventListener("resize", debounce(() => { if (App.started) { App.invalidateViews(); App.refreshActive(); } }, 400));
App.boot();
