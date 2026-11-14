/* Minimal phosphor-style canvas charts and the alt-az sky radar. */
"use strict";

const SERIES_ALPHA = [1, 0.6, 0.38, 0.8, 0.5, 0.28, 0.7];
/* VOTV skins draw in the game's multi-colour palette instead of one phosphor. */
const VOTV_SERIES = { "skin-votv-terminal": ["#ffe23a", "#3ee8ff", "#39ff4a", "#ff3df5", "#ff3b30", "#ececec", "#6b7bff"],
                      "skin-votv-unit": ["#ffd428", "#ff4a1c", "#3bff5a", "#f2f2f2", "#ff9a1c", "#9be7ff", "#c86bff"] };
function votvSkin() {
  const body = document.body.classList;
  return body.contains("skin-votv-terminal") ? "skin-votv-terminal" : body.contains("skin-votv-unit") ? "skin-votv-unit" : null;
}
function seriesColor(index, alpha = 1) {
  const skin = votvSkin();
  return skin ? VOTV_SERIES[skin][index % VOTV_SERIES[skin].length] : phosphor(alpha);
}
/* Spectrogram ramp used by the VOTV terminals: red -> magenta -> blue across the band. */
function spectrumColor(fraction) {
  const hue = 360 - Math.max(0, Math.min(1, fraction)) * 125;
  return `hsl(${hue % 360}, 100%, 55%)`;
}
const SERIES_DASH = [[], [6, 4], [2, 3], [10, 3, 2, 3], [1, 2], [8, 8], [4, 2]];

const charts = {
  /* series: [{label, points: [{t: ms, v}], axis?: "right"}] */
  line(canvas, series, { yMin = null, yMax = null, yFormat = v => v.toFixed(0), rightFormat = null, legend = null, xSpan = null, xFormat = null } = {}) {
    const { ctx, width, height } = sizeCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const pad = { l: 46, r: rightFormat ? 52 : 10, t: 8, b: 20 };
    const all = series.flatMap(s => s.points);
    if (!all.length) { this.empty(ctx, width, height); return; }
    let t0 = Math.min(...all.map(p => p.t)), t1 = Math.max(...all.map(p => p.t));
    if (xSpan) t0 = Math.min(t0, t1 - xSpan);
    if (t1 === t0) t1 = t0 + 1;
    const range = axis => {
      const values = series.filter(s => (s.axis || "left") === axis).flatMap(s => s.points.map(p => p.v)).filter(v => v != null);
      if (!values.length) return [0, 1];
      let lo = axis === "left" && yMin != null ? yMin : Math.min(...values), hi = axis === "left" && yMax != null ? yMax : Math.max(...values);
      if (hi === lo) { hi += 1; lo -= 1; }
      const slack = (hi - lo) * 0.08;
      return [axis === "left" && yMin != null ? lo : lo - slack, axis === "left" && yMax != null ? hi : hi + slack];
    };
    const [l0, l1] = range("left"), [r0, r1] = range("right");
    const X = t => pad.l + (t - t0) / (t1 - t0) * (width - pad.l - pad.r);
    const Y = (v, axis) => { const [a, b] = axis === "right" ? [r0, r1] : [l0, l1]; return height - pad.b - (v - a) / (b - a) * (height - pad.t - pad.b); };
    this.grid(ctx, width, height, pad);
    ctx.font = `11px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillStyle = phosphor(0.55);
    for (let i = 0; i <= 4; i++) {
      const v = l0 + (l1 - l0) * i / 4, y = Y(v, "left");
      ctx.fillText(yFormat(v), 2, y + 4);
      if (rightFormat) { const rv = r0 + (r1 - r0) * i / 4; ctx.fillText(rightFormat(rv), width - pad.r + 6, y + 4); }
    }
    const spanHours = (t1 - t0) / 3.6e6;
    for (let i = 0; i <= 4; i++) {
      const t = t0 + (t1 - t0) * i / 4, d = new Date(t);
      const label = xFormat ? xFormat(t) : spanHours > 48 ? `${d.getMonth() + 1}/${d.getDate()}` : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      ctx.fillText(label, Math.min(width - 40, Math.max(pad.l, X(t) - 16)), height - 5);
    }
    series.forEach((s, idx) => {
      ctx.strokeStyle = votvSkin() ? seriesColor(idx) : phosphor(SERIES_ALPHA[idx % SERIES_ALPHA.length]);
      ctx.setLineDash(votvSkin() ? [] : SERIES_DASH[idx % SERIES_DASH.length]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const p of s.points) {
        if (p.v == null) { started = false; continue; }
        const x = X(p.t), y = Y(p.v, s.axis || "left");
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);
    if (legend) this.legend(legend, series.map(s => s.label));
  },

  bars(canvas, items, { format = v => String(v), labelEvery = 1, stacked = null, legend = null } = {}) {
    const { ctx, width, height } = sizeCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    if (!items.length) { this.empty(ctx, width, height); return; }
    const pad = { l: 34, r: 6, t: 8, b: 20 };
    const totals = items.map(it => stacked ? stacked.reduce((sum, key) => sum + (it.values[key] || 0), 0) : it.v);
    const max = Math.max(1, ...totals);
    const bw = (width - pad.l - pad.r) / items.length;
    this.grid(ctx, width, height, pad);
    ctx.font = `11px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillStyle = phosphor(0.55);
    ctx.fillText(format(max), 2, pad.t + 8);
    ctx.fillText("0", 2, height - pad.b);
    items.forEach((it, i) => {
      const x = pad.l + i * bw + 1;
      let base = height - pad.b;
      const parts = stacked ? stacked.map(key => it.values[key] || 0) : [it.v];
      parts.forEach((v, k) => {
        const h = v / max * (height - pad.t - pad.b);
        ctx.fillStyle = votvSkin() ? (stacked ? seriesColor(k) : votvSkin() === "skin-votv-terminal" ? spectrumColor(i / Math.max(1, items.length - 1)) : seriesColor(0))
          : phosphor(stacked ? SERIES_ALPHA[k % SERIES_ALPHA.length] * 0.85 : 0.8);
        ctx.fillRect(x, base - h, Math.max(1, bw - 2), h);
        base -= h;
      });
      if (i % labelEvery === 0) { ctx.fillStyle = phosphor(0.55); ctx.fillText(it.label, x, height - 5); }
    });
    if (legend && stacked) this.legend(legend, stacked);
  },

  grid(ctx, width, height, pad) {
    ctx.strokeStyle = phosphor(0.1);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) { const y = pad.t + (height - pad.t - pad.b) * i / 4; ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); }
    ctx.stroke();
  },

  empty(ctx, width, height) {
    ctx.fillStyle = phosphor(0.4);
    ctx.font = `13px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillText("NO DATA", width / 2 - 30, height / 2);
  },

  legend(node, labels) {
    if (votvSkin()) {
      node.innerHTML = labels.map((label, i) => `<span><i style="background:${seriesColor(i)}"></i>${esc(String(label).toUpperCase())}</span>`).join("");
      return;
    }
    node.innerHTML = labels.map((label, i) =>
      `<span><i style="opacity:${SERIES_ALPHA[i % SERIES_ALPHA.length]};${SERIES_DASH[i % SERIES_DASH.length].length ? "background:repeating-linear-gradient(90deg,currentColor 0 4px,transparent 4px 7px)" : ""}"></i>${esc(String(label).toUpperCase())}</span>`).join("");
  },
};

/* ---------------- alt-az radar ----------------
   Zenith in the centre, horizon on the rim, north up, east LEFT (looking up
   at the sky, as on a planisphere). */
class SkyRadar {
  constructor(canvas, { onPick = null, tip = null, labels = true } = {}) {
    this.canvas = canvas;
    this.objects = [];
    this.view = null;
    this.selected = null;
    this.onPick = onPick;
    this.tip = tip;
    this.labels = labels;
    this.sweep = 0;
    canvas.classList.add("square");
    canvas.addEventListener("click", e => { const hit = this.hit(e); if (hit && this.onPick) this.onPick(hit); });
    canvas.addEventListener("mousemove", e => this.hover(e));
    canvas.addEventListener("mouseleave", () => { if (this.tip) this.tip.hidden = true; });
    let last = 0;
    const loop = now => {
      if (now - last >= 32 && this.canvas.isConnected && this.canvas.offsetParent !== null && !document.hidden) {
        last = now;
        this.draw();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  project(az, alt) {
    const r = (90 - Math.max(-5, alt)) / 90 * this.R;
    const a = az * Math.PI / 180;
    return [this.cx - Math.sin(a) * r, this.cy - Math.cos(a) * r];
  }

  set(objects, view) { this.objects = objects || []; this.view = view; }

  draw() {
    const { ctx, width } = sizeCanvas(this.canvas);
    const size = width;
    this.cx = size / 2; this.cy = size / 2; this.R = size / 2 - 26;
    ctx.clearRect(0, 0, size, size);
    ctx.font = `12px ${getComputedStyle(document.body).fontFamily}`;
    // rings + spokes
    ctx.strokeStyle = phosphor(0.22); ctx.lineWidth = 1;
    for (const alt of [0, 30, 60]) { ctx.beginPath(); ctx.arc(this.cx, this.cy, (90 - alt) / 90 * this.R, 0, Math.PI * 2); ctx.stroke(); }
    ctx.strokeStyle = phosphor(0.12);
    for (let az = 0; az < 360; az += 30) { const [x, y] = this.project(az, 0); ctx.beginPath(); ctx.moveTo(this.cx, this.cy); ctx.lineTo(x, y); ctx.stroke(); }
    ctx.fillStyle = phosphor(0.8);
    for (const [label, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
      const [x, y] = this.project(az, -9); ctx.fillText(label, x - 4, y + 4);
    }
    ctx.fillStyle = phosphor(0.35);
    for (const alt of [30, 60]) ctx.fillText(`${alt}°`, this.cx + 3, this.cy - (90 - alt) / 90 * this.R - 3);
    // sweep
    if (!document.body.classList.contains("reduce-motion")) this.sweep = (this.sweep + 0.6) % 360;
    const grad = ctx.createConicGradient ? ctx.createConicGradient((this.sweep - 90 - 40) * Math.PI / 180, this.cx, this.cy) : null;
    if (grad) {
      grad.addColorStop(0, phosphor(0)); grad.addColorStop(40 / 360, phosphor(0.16)); grad.addColorStop(40 / 360 + 0.001, phosphor(0)); grad.addColorStop(1, phosphor(0));
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(this.cx, this.cy, this.R, 0, Math.PI * 2); ctx.fill();
    }
    // Stellarium field of view
    if (this.view && this.view.az != null) {
      const [x, y] = this.project(this.view.az, this.view.alt);
      const rr = Math.min(this.R * 1.5, (this.view.fov || 60) / 2 / 90 * this.R);
      ctx.strokeStyle = phosphor(0.75); ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y); ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8); ctx.stroke();
      ctx.fillStyle = phosphor(0.8); ctx.fillText("VIEW", x + 6, y - 6);
    }
    // objects
    this.screen = [];
    ctx.textBaseline = "middle";
    for (const obj of this.objects) {
      if (obj.az == null || obj.alt == null || obj.alt < -2) continue;
      const [x, y] = this.project(obj.az, obj.alt);
      const bright = obj.vmag == null ? 0.75 : Math.max(0.3, Math.min(1, 1.1 - obj.vmag / 10));
      const delta = ((obj.az - this.sweep + 540) % 360) - 180;
      const ping = Math.abs(delta) < 6 ? 0.35 : 0;
      ctx.fillStyle = phosphor(Math.min(1, bright + ping));
      const g = glyph(obj.model);
      const big = obj.category === "planet" || obj.category === "moon" || obj === this.selected;
      ctx.font = `${big ? 18 : 13}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.fillText(g, x - (big ? 6 : 4), y);
      const labelled = this.labels === "all" ? obj.category !== "satellite"
        : this.labels && (big || (obj.vmag != null && obj.vmag < 1.0 && obj.category !== "constellation"));
      if (labelled) {
        ctx.font = `11px ${getComputedStyle(document.body).fontFamily}`;
        ctx.fillStyle = phosphor(0.6);
        ctx.fillText(obj.name.toUpperCase().slice(0, 18), x + 9, y);
      }
      this.screen.push([x, y, obj]);
    }
    ctx.textBaseline = "alphabetic";
    if (this.selected) {
      const s = this.screen.find(([, , o]) => o === this.selected);
      if (s) { ctx.strokeStyle = phosphor(1); ctx.lineWidth = 1.5; ctx.strokeRect(s[0] - 11, s[1] - 11, 22, 22); }
    }
  }

  hit(event) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left, my = event.clientY - rect.top;
    let best = null, bestD = 14;
    for (const [x, y, obj] of this.screen || []) { const d = Math.hypot(x - mx, y - my); if (d < bestD) { bestD = d; best = obj; } }
    return best;
  }

  hover(event) {
    if (!this.tip) return;
    const hit = this.hit(event);
    if (!hit) { this.tip.hidden = true; this.canvas.style.cursor = ""; return; }
    this.canvas.style.cursor = "pointer";
    const rect = this.canvas.getBoundingClientRect();
    this.tip.hidden = false;
    this.tip.textContent = `${hit.name.toUpperCase()} · ${hit.category.toUpperCase()} · AZ ${hit.az.toFixed(1)} EL ${hit.alt.toFixed(1)}${hit.vmag != null ? ` · MAG ${hit.vmag.toFixed(1)}` : ""}`;
    this.tip.style.left = `${Math.min(rect.width - 200, event.clientX - rect.left + 14)}px`;
    this.tip.style.top = `${event.clientY - rect.top + 10}px`;
  }
}
