/* Shared helpers: DOM, API, formatting, preferences. */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

const api = {
  async get(path) {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${await response.text().catch(() => "")}`.trim());
    return response.json();
  },
  async post(path, body = {}) {
    const response = await fetch(path, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Panel-Request": "1" },
      body: JSON.stringify(body),
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const message = (payload && (payload.error || payload.message)) || `${response.status}`;
      throw new Error(message);
    }
    return payload || {};
  },
};

const fmt = {
  num(value, digits = 2) { return value == null || Number.isNaN(+value) ? "---" : (+value).toFixed(digits); },
  int(value) { return value == null ? "---" : Math.round(+value).toLocaleString("en-US"); },
  pct(value, digits = 1) { return value == null ? "---" : `${(+value).toFixed(digits)}%`; },
  bytes(value) {
    if (value == null) return "---";
    let amount = +value;
    for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
      if (Math.abs(amount) < 1024 || unit === "TB") return `${amount.toFixed(amount < 10 && unit !== "B" ? 2 : 1)} ${unit}`;
      amount /= 1024;
    }
  },
  rate(bps) { return bps == null ? "---" : `${fmt.bytes(bps)}/s`; },
  duration(seconds) {
    if (seconds == null) return "---";
    seconds = Math.max(0, Math.floor(seconds));
    const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
    return d ? `${d}D ${h}H ${m}M` : h ? `${h}H ${m}M` : `${m}M ${seconds % 60}S`;
  },
  age(iso) {
    if (!iso) return "---";
    const seconds = (Date.now() - Date.parse(iso)) / 1000;
    if (Number.isNaN(seconds)) return "---";
    if (seconds < 90) return `${Math.max(0, Math.round(seconds))}S AGO`;
    if (seconds < 5400) return `${Math.round(seconds / 60)}M AGO`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)}H AGO`;
    return `${Math.round(seconds / 86400)}D AGO`;
  },
  when(iso) {
    if (!iso) return "---";
    const date = new Date(iso);
    if (Number.isNaN(+date)) return esc(iso);
    const p = n => String(n).padStart(2, "0");
    if (prefs.get("display.utc")) {
      return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}Z`;
    }
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
  },
  mhz(hz, digits = 4) { return hz == null ? "---" : (hz / 1e6).toFixed(digits); },
  deg(value, digits = 4) { return value == null ? "---" : (+value).toFixed(digits); },
  mag(value) { return value == null || +value >= 50 ? "" : (+value).toFixed(1); },
  upper(value) { return String(value ?? "").toUpperCase(); },
};

/* Single-character glyphs per hologram model, used in lists and the radar. */
const GLYPHS = {
  planet: "◉", ringed: "♄", moon: "☾", star: "✶", binary: "⁑", nova: "✺", galaxy: "◎", quasar: "⊛",
  nebula: "☁", cluster: "⁂", constellation: "✧", asteroid: "◆", comet: "☄", meteor: "↯", satellite: "⌖",
  station: "⌘", starlink: "▭", debris: "✕", rocketbody: "▮", telescope: "⌕", probe: "⟟", pulsar: "⊕",
  unknown: "?", signal: "≋",
};
const glyph = model => GLYPHS[model] || "·";

/* ---------------- preferences (localStorage, per browser) ---------------- */
const PREF_DEFAULTS = {
  "audio.master": 0.8, "audio.muted": false,
  "music.track": "", "music.vol": 0.35,
  "sfx.rotator.on": true, "sfx.rotator.vol": 0.5,
  "sfx.ui.on": true, "sfx.ui.vol": 0.45,
  "sfx.signature.on": true, "sfx.signature.vol": 0.35,
  "sfx.alerts.on": true, "sfx.alerts.vol": 0.6,
  "sfx.chatter.on": true, "sfx.chatter.vol": 0.35,
  "display.theme": "lime", "display.font": "draco", "display.scale": "m",
  "display.scanlines": true, "display.glow": true, "display.flicker": true, "display.vignette": true,
  "display.reduceMotion": false, "display.utc": false, "display.dateFormat": "dmy",
  "display.tickerSpeed": 0.5, "display.spinSpeed": 0.5, "display.skin": "signalsim", "display.customColor": "#52ff52", "data.ownOnly": false,
  "console.autoscan": true, "console.dwell": 45,
  "console.minAlt": 10, "console.sources": ["detections", "planets", "deepsky", "seti", "rf"],
  "console.screensaverMinutes": 10,
  "console.driveStellarium": false,
};

const prefs = {
  _data: {},
  load() {
    try { this._data = JSON.parse(localStorage.getItem("panel.prefs") || "{}") || {}; }
    catch { this._data = {}; }
  },
  get(key) { return key in this._data ? this._data[key] : PREF_DEFAULTS[key]; },
  set(key, value) {
    this._data[key] = value;
    try { localStorage.setItem("panel.prefs", JSON.stringify(this._data)); } catch { /* private mode */ }
    document.dispatchEvent(new CustomEvent("prefs", { detail: { key, value } }));
  },
  reset() {
    this._data = {};
    try { localStorage.removeItem("panel.prefs"); } catch { /* ignore */ }
    document.dispatchEvent(new CustomEvent("prefs", { detail: { key: "*" } }));
  },
};
prefs.load();

let toastTimer = null;
function toast(message, bad = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("bad", bad);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}

/* "&own=1" when Options > Console > Local records only is on. */
const ownParam = () => (prefs.get("data.ownOnly") ? "&own=1" : "");

/* Write text only when it changed (avoids style recalcs on 10 Hz readouts). */
function setText(sel, value) {
  const node = typeof sel === "string" ? $(sel) : sel;
  const text = String(value);
  if (node && node.textContent !== text) node.textContent = text;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

/* Read the current phosphor colour as an "r, g, b" string for canvas drawing. */
function phosphor(alpha = 1) {
  const rgb = getComputedStyle(document.body).getPropertyValue("--c").trim() || "82, 255, 82";
  return `rgba(${rgb}, ${alpha})`;
}

function sizeCanvas(canvas) {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(50, Math.round(rect.width));
  const cssHeight = canvas.dataset.h ? +canvas.dataset.h : (+canvas.getAttribute("height") || rect.height || 150);
  if (!canvas.dataset.h) canvas.dataset.h = String(cssHeight);
  const height = canvas.classList.contains("square") ? width : cssHeight;
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height };
}
