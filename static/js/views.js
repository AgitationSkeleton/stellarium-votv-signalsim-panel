/* Screen controllers. Each exposes enter() (view shown) and optionally refresh() / leave(). */
"use strict";

const CATEGORY_ORDER = ["planet", "moon", "comet", "asteroid", "dwarf planet", "meteor shower", "satellite", "probe",
  "star", "double star", "variable star", "nova", "cluster", "nebula", "planetary nebula", "supernova remnant",
  "galaxy", "quasar", "radio source", "pulsar", "seti signal", "constellation", "deep-sky", "interstellar object"];

function tile(label, value, sub = "", pct = null) {
  return `<div class="tile"><div class="t-label">${esc(label)}</div><div class="t-value">${value}</div>` +
    (sub ? `<div class="t-sub">${sub}</div>` : "") +
    (pct != null ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>` : "") + `</div>`;
}

function pager(node, total, offset, limit, go) {
  const page = Math.floor(offset / limit) + 1, pages = Math.max(1, Math.ceil(total / limit));
  node.innerHTML = `<span>${fmt.int(total)} RECORDS · PAGE ${page}/${pages}</span>
    <button class="btn small" data-p="prev" ${page <= 1 ? "disabled" : ""}>&lt; PREV</button>
    <button class="btn small" data-p="next" ${page >= pages ? "disabled" : ""}>NEXT &gt;</button>`;
  node.querySelector('[data-p="prev"]').onclick = () => { audio.ui("click"); go(Math.max(0, offset - limit)); };
  node.querySelector('[data-p="next"]').onclick = () => { audio.ui("click"); go(offset + limit); };
}

function facts(pairs) {
  return `<dl class="facts">${pairs.filter(([, v]) => v != null && v !== "" && v !== "---")
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

/* ---------------- shared phenomenon detail ---------------- */
const Detail = {
  holos: new WeakMap(),

  async render(container, id) {
    container.innerHTML = `<div class="muted pad blink">RETRIEVING RECORD #${esc(id)}...</div>`;
    let row;
    try { row = await api.get(`/api/phenomena/${encodeURIComponent(id)}`); }
    catch (error) { container.innerHTML = `<div class="muted pad">RECORD UNAVAILABLE: ${esc(error.message)}</div>`; return null; }
    const info = row.info || {}, live = row.live || {}, pos = row.position;
    const sat = row.satellite;
    const daily = (row.daily || []).map(d => ({ label: d.day.slice(5), v: d.n }));
    container.innerHTML = `
      <div class="d-head"><div class="d-holo holo"></div>
        <div><h3>${esc(row.name)}</h3>
          <div class="muted">${esc(fmt.upper(row.category))}${row.catalog ? ` · ${esc(fmt.upper(row.catalog))}` : ""}</div>
          <div class="actions">
            <button class="btn small" data-act="track">TRACK ON CONSOLE</button>
            <button class="btn small" data-act="point">POINT STELLARIUM</button>
          </div></div></div>
      ${facts([
        ["POSITION NOW", pos ? `AZ ${fmt.num(pos.az, 2)}° · EL ${fmt.num(pos.alt, 2)}°${pos.alt < 0 ? " (BELOW HORIZON)" : ""}${pos.live ? " · LIVE" : pos.as_of ? ` · AS OF ${fmt.when(pos.as_of)}` : " · COMPUTED"}` : "---"],
        ["RA / DEC J2000", row.ra_j2000 != null ? `${fmt.num(row.ra_j2000, 3)}° / ${fmt.num(row.dec_j2000, 3)}°${row.approximate ? " (APPROX.)" : ""}` : null],
        ["MAGNITUDE", fmt.mag(live.vmag ?? row.vmag) || null],
        ["CONSTELLATION", esc(live.iauConstellation || row.constellation || "")],
        ["OBJECT TYPE", esc(live["object-type"] || info["object-type"] || "")],
        ["DESIGNATIONS", esc(info.designations || "")],
        ["DISTANCE", live["distance-km"] ? `${fmt.int(live["distance-km"])} KM` : info["distance-ly"] ? `${esc(info["distance-ly"])} LY` : live.distance ? `${fmt.num(live.distance, 4)} AU` : null],
        ["RISE / TRANSIT / SET", live.rise ? `${esc(live.rise)} / ${esc(live.transit || "---")} / ${esc(live.set || "---")}` : null],
        ["ILLUMINATION", live.illumination != null ? fmt.pct(live.illumination) : null],
        ["PARENT BODY", esc(live.parent || info.parent || "")],
        ["ZHR / ACTIVITY", live.zhr || live.activity ? esc(`${live.zhr || ""} ${live.activity || ""}`) : null],
        ["NORAD ID", sat ? `<a href="https://www.n2yo.com/satellite/?s=${encodeURIComponent(sat.satid)}" target="_blank" rel="noopener noreferrer">${esc(sat.satid)}</a>` : null],
        ["GROUP", sat ? esc(sat.grp) : null],
        ["INT. DESIGNATOR", sat ? esc(sat.designator || "") : null],
        ["LAUNCHED", sat ? esc(sat.launch_date || "") : null],
        ["ALTITUDE", pos && pos.alt_km != null ? `${fmt.int(pos.alt_km)} KM · RANGE ${fmt.int(pos.range_km)} KM` : null],
        ["SURVEY APPEARANCES", sat ? fmt.int(sat.passes) : null],
        ["SIGHTINGS", fmt.int(row.sightings)],
        ["FIRST SEEN", row.first_seen_utc ? fmt.when(row.first_seen_utc) : null],
        ["LAST SEEN", row.last_seen_utc ? `${fmt.when(row.last_seen_utc)} (${fmt.age(row.last_seen_utc)})` : null],
        ["SOURCE", esc(fmt.upper(row.source))],
      ])}
      <p class="desc">${esc(row.notes || "")}</p>
      ${daily.length ? `<h2 class="hl">SIGHTINGS // 60 DAYS</h2><canvas class="d-daily" height="90"></canvas>` : ""}
      ${(row.transmitters || []).length ? `<h2 class="hl">SATNOGS TRANSMITTERS</h2><table class="grid"><thead><tr><th>DESCRIPTION</th><th>MODE</th><th>DOWNLINK MHz</th><th>STATUS</th></tr></thead><tbody>${
        row.transmitters.map(t => `<tr><td>${esc(t.description || "")}</td><td>${esc(t.mode || "")}</td><td>${t.downlink_low ? fmt.mhz(t.downlink_low, 3) : "---"}</td><td>${esc(t.status || "")}</td></tr>`).join("")}</tbody></table>` : ""}
      ${(row.recent_sightings || []).length ? `<h2 class="hl">RECENT SIGHTINGS</h2><div class="list">${row.recent_sightings.slice(0, 12).map(s =>
        `<div class="item"><span class="glyph">·</span><span>${fmt.when(s.observed_utc)}</span><span class="badge">${esc(fmt.upper(s.source))}</span></div>`).join("")}</div>` : ""}`;
    const holo = new Holo(container.querySelector(".d-holo"));
    holo.show(row.model, row.name);
    if (daily.length) charts.bars(container.querySelector(".d-daily"), daily, { labelEvery: Math.ceil(daily.length / 8) });
    container.querySelector('[data-act="track"]').onclick = () => { audio.ui("confirm"); App.trackOnConsole(row); };
    const point = container.querySelector('[data-act="point"]');
    if (point) point.onclick = () => Control.pointAt(row);
    return row;
  },
};

/* ---------------- SKY ---------------- */
const Sky = {
  staleMs: 20000,
  init() {
    this.radar = new SkyRadar($("#sky-radar"), { tip: $("#sky-tip"), onPick: obj => this.pick(obj), labels: prefs.get("sky.labels") || "few" });
    this.hidden = new Set(prefs.get("sky.hidden") || []);
    $("#sky-mag").value = prefs.get("sky.mag") || 7;
    $("#sky-mag-v").textContent = $("#sky-mag").value;
    $("#sky-mag").oninput = debounce(() => { $("#sky-mag-v").textContent = $("#sky-mag").value; prefs.set("sky.mag", +$("#sky-mag").value); this.refresh(); }, 250);
    $("#sky-frame-tint").onchange = () => $("#sky-frame").classList.toggle("tinted", $("#sky-frame-tint").checked);
    $("#sky-frame").classList.add("tinted");
  },
  async enter() { await this.refresh(); this.refreshFrame(); },
  async refresh() {
    let data;
    try { data = await api.get(`/api/sky?mag=${encodeURIComponent($("#sky-mag").value)}${ownParam()}`); } catch { return; }
    this.data = data;
    const cats = [...new Set(data.objects.map(o => o.category))].sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
    $("#sky-cats").innerHTML = `<button class="chip ${this.radar.labels === "all" ? "on" : ""}" data-labels="1">ALL LABELS</button>` + cats.map(c => `<button class="chip ${this.hidden.has(c) ? "" : "on"}" data-cat="${esc(c)}">${glyph(data.objects.find(o => o.category === c).model)} ${esc(fmt.upper(c))}</button>`).join("");
    $("#sky-cats [data-labels]").onclick = () => {
      this.radar.labels = this.radar.labels === "all" ? "few" : "all";
      prefs.set("sky.labels", this.radar.labels); audio.ui("toggle"); this.refresh();
    };
    $$("#sky-cats .chip[data-cat]").forEach(chip => chip.onclick = () => {
      const c = chip.dataset.cat;
      this.hidden.has(c) ? this.hidden.delete(c) : this.hidden.add(c);
      prefs.set("sky.hidden", [...this.hidden]);
      audio.ui("toggle"); this.refresh();
    });
    const visible = data.objects.filter(o => !this.hidden.has(o.category));
    this.radar.set(visible, App.state?.stellarium?.view || data.view);
    $("#sky-count").textContent = visible.length;
    const sorted = [...visible].sort((a, b) => b.alt - a.alt).slice(0, 250);
    $("#sky-list").innerHTML = sorted.map((o, i) => `<div class="item" data-i="${i}"><span class="glyph">${glyph(o.model)}</span>
      <span>${esc(o.name)}<div class="sub">${esc(fmt.upper(o.category))}${o.vmag != null ? ` · MAG ${fmt.mag(o.vmag)}` : ""}${o.stale ? " · SURVEY POS." : ""}</div></span>
      <span class="badge">EL ${o.alt.toFixed(0)}°</span></div>`).join("");
    $$("#sky-list .item").forEach(item => item.onclick = () => this.pick(sorted[+item.dataset.i]));
  },
  updateView(view) { if (this.radar) this.radar.view = view; },
  pick(obj) {
    audio.ui("click");
    this.radar.selected = obj;
    const id = obj.id;
    $("#sky-selected").classList.remove("muted");
    $("#sky-selected").innerHTML = `<b>${esc(obj.name)}</b><br>${esc(fmt.upper(obj.category))} · AZ ${obj.az.toFixed(2)}° · EL ${obj.alt.toFixed(2)}°
      ${obj.vmag != null ? ` · MAG ${fmt.mag(obj.vmag)}` : ""}<div class="actions">
      <button class="btn small" data-a="track">TRACK ON CONSOLE</button>
      ${id ? `<button class="btn small" data-a="open">OPEN RECORD</button>` : ""}
      <button class="btn small" data-a="point">POINT STELLARIUM</button></div>`;
    $('#sky-selected [data-a="track"]').onclick = () => App.trackOnConsole({ ...obj, position: { az: obj.az, alt: obj.alt } });
    const open = $('#sky-selected [data-a="open"]');
    if (open) open.onclick = () => App.openRecord(id);
    $('#sky-selected [data-a="point"]').onclick = () => Control.pointAt(obj);
  },
  async refreshFrame() {
    try {
      const info = await api.get("/api/capture/info");
      if (!info.available) { $("#sky-frame-meta").textContent = info.configured ? "NO SCREENSHOTS FOUND YET" : "SET screenshot_dirs IN CONFIG TO SHOW STELLARIUM SCREENSHOTS"; return; }
      $("#sky-frame").src = `/api/capture/latest?ts=${encodeURIComponent(info.modified)}`;
      $("#sky-frame-meta").textContent = `SCREENSHOT · ${fmt.when(info.modified)} · ${fmt.age(info.modified)}`;
    } catch { /* ignore */ }
  },
};

/* ---------------- DATABASE ---------------- */
const Database = {
  offset: 0, limit: 40, selected: null,
  init() {
    const reload = debounce(() => { this.offset = 0; this.load(); }, 300);
    $("#db-q").oninput = reload;
    for (const id of ["#db-cat", "#db-src", "#db-sort"]) $(id).onchange = () => { audio.ui("click"); reload(); };
    $("#db-seen").onchange = () => { audio.ui("toggle"); reload(); };
  },
  async enter() {
    // with "local records only" on, every listed record is a detection anyway
    const own = prefs.get("data.ownOnly");
    $("#db-seen").disabled = own;
    $("#db-seen").closest("label").title = own ? "Implied by Options > Console > Local records only" : "";
    for (const opt of $$("#db-src option")) if (opt.value === "curated") opt.hidden = own;
    if (own && ($("#db-src").value === "curated")) $("#db-src").value = "";
    this.overview(); await this.load();
  },
  async overview() {
    let o;
    try { o = await api.get(`/api/stats/overview?${ownParam().slice(1)}`); } catch { return; }
    $("#db-tiles").innerHTML = [
      tile(o.own_only ? "OBJECTS YOU OBSERVED" : "PHENOMENA ON FILE", fmt.int(o.phenomena),
        o.own_only ? "SELECTED IN STELLARIUM · CATALOGUE ENTRIES HIDDEN" : `${fmt.int(o.seen)} OBSERVED AT LEAST ONCE`),
      tile("OBSERVATIONS LOGGED", fmt.int(o.sightings), o.first_sighting ? `SINCE ${fmt.when(o.first_sighting)}` : "SELECT OBJECTS IN STELLARIUM TO LOG THEM"),
      tile("OBJECT TYPES", fmt.int(o.by_category.length), "CATEGORIES IN THE DATABASE"),
      tile("RADIO EVENTS", fmt.int(o.rf_events), "RTL-SDR BAND MONITOR"),
    ].join("");
    const days = {};
    for (const d of o.daily) { (days[d.day] ||= {})[d.source] = d.n; }
    const items = Object.keys(days).sort().map(day => ({ label: day.slice(5), values: days[day] }));
    charts.bars($("#db-daily"), items, { stacked: ["stellarium"], labelEvery: Math.ceil(items.length / 10) || 1 });
  },
  async load() {
    const params = new URLSearchParams({ q: $("#db-q").value, category: $("#db-cat").value, source: $("#db-src").value,
      sort: $("#db-sort").value, seen: $("#db-seen").checked ? "1" : "", own: prefs.get("data.ownOnly") ? "1" : "",
      limit: this.limit, offset: this.offset });
    let data;
    try { data = await api.get(`/api/phenomena?${params}`); } catch (error) { toast(`DATABASE: ${error.message}`, true); return; }
    const select = $("#db-cat"), current = select.value;
    select.innerHTML = `<option value="">ALL TYPES</option>` + data.categories.map(c =>
      `<option value="${esc(c.category)}">${esc(fmt.upper(c.category))} (${fmt.int(c.n)})</option>`).join("");
    select.value = current;
    $("#db-table tbody").innerHTML = data.items.map(r => `<tr data-id="${r.id}" class="${r.id === this.selected ? "sel" : ""}">
      <td><span class="glyph">${glyph(r.model)}</span></td><td>${esc(r.name)}</td><td>${esc(fmt.upper(r.category))}</td>
      <td class="num">${fmt.mag(r.vmag)}</td><td class="num">${r.alt != null ? `${r.alt.toFixed(0)}°` : ""}</td>
      <td class="num">${r.sightings ? fmt.int(r.sightings) : ""}</td><td>${r.last_seen_utc ? fmt.age(r.last_seen_utc) : ""}</td></tr>`).join("")
      || `<tr><td colspan="7" class="muted">NO MATCHING RECORDS</td></tr>`;
    $$("#db-table tbody tr[data-id]").forEach(tr => tr.onclick = () => this.select(+tr.dataset.id));
    pager($("#db-pager"), data.total, this.offset, this.limit, offset => { this.offset = offset; this.load(); });
  },
  async select(id) {
    this.selected = id;
    audio.ui("open");
    $$("#db-table tbody tr").forEach(tr => tr.classList.toggle("sel", +tr.dataset.id === id));
    await Detail.render($("#db-detail"), id);
  },
};

/* ---------------- SIGNALS ---------------- */
/* RF: the panel's own rtl_power band monitor (server/sources/rtlsdr.py). */
const Signals = {
  offset: 0, limit: 40, selected: null,
  init() {
    $("#rf-band").onchange = $("#rf-score").onchange = () => { audio.ui("click"); this.offset = 0; this.load(); };
    $("#rf-spec-band").onchange = () => { audio.ui("click"); prefs.set("signals.specBand", $("#rf-spec-band").value); this.spectrum(); };
    $$("#sig-subtabs button").forEach(btn => btn.onclick = () => { audio.ui("tab"); this.showSub(btn.dataset.sub); });
    Shortwave.init();
  },
  sub() { return prefs.get("signals.sub") === "sw" ? "sw" : "rf"; },
  showSub(sub) {
    prefs.set("signals.sub", sub);
    $$("#sig-subtabs button").forEach(b => b.classList.toggle("active", b.dataset.sub === sub));
    $$("#view-signals .sig-pane").forEach(pane => { pane.hidden = pane.dataset.sub !== sub; });
    this.enter();
  },
  async enter() {
    const sub = this.sub();
    $$("#sig-subtabs button").forEach(b => b.classList.toggle("active", b.dataset.sub === sub));
    $$("#view-signals .sig-pane").forEach(pane => { pane.hidden = pane.dataset.sub !== sub; });
    if (sub === "sw") { await Shortwave.enter(); return; }
    this.summary(); this.bands(); this.spectrum(); await this.load();
  },
  refresh() {
    if (this.sub() === "sw") { Shortwave.refresh(); return; }
    this.summary(); this.bands(); this.spectrum(); this.load();
  },
  async summary() {
    let s;
    try { s = await api.get("/api/rf/summary"); } catch { return; }
    const st = s.status || {};
    const state = !st.enabled ? "DISABLED" : st.available ? "ONLINE" : "ERROR";
    const detail = !st.enabled ? "SET rtlsdr.enabled IN config/panel.local.json"
      : st.error ? fmt.upper(st.error).slice(0, 90) : st.last_sweep ? `LAST SWEEP ${fmt.age(st.last_sweep)}` : "WAITING FOR FIRST SWEEP";
    $("#rf-tiles").innerHTML = [
      tile("SDR MONITOR", state, esc(detail)),
      tile("EVENTS LOGGED", fmt.int(s.total), s.first ? `SINCE ${fmt.when(s.first)}` : ""),
      tile("LAST 24 HOURS", fmt.int(App.state?.rf_events_24h), "NEW SIGNALS ABOVE THE NOISE FLOOR"),
      tile("BUSIEST BAND", esc(fmt.upper(s.by_band[0]?.band || "---")), s.by_band[0] ? `${fmt.int(s.by_band[0].n)} EVENTS` : ""),
      tile("TOP SCORE", s.top[0] ? fmt.num(s.top[0].score, 0) : "---", s.top[0] ? `${fmt.mhz(s.top[0].center_hz, 3)} MHZ · ${fmt.when(s.top[0].timestamp_utc)}` : ""),
      tile("SWEEPS STORED", fmt.int(s.sweeps), `${(st.bands || []).length} BANDS CONFIGURED`),
    ].join("");
    const band = $("#rf-band"), current = band.value;
    band.innerHTML = `<option value="">ALL BANDS</option>` + s.by_band.map(b => `<option value="${esc(b.band)}">${esc(fmt.upper(b.band))} (${fmt.int(b.n)})</option>`).join("");
    band.value = current;
    const daily = s.daily.map(d => ({ label: d.day.slice(5), v: d.n }));
    charts.bars($("#rf-daily"), daily, { labelEvery: Math.ceil(daily.length / 8) || 1 });
  },
  async bands() {
    let b;
    try { b = await api.get("/api/rf/bands?hours=24"); } catch { return; }
    const series = Object.entries(b.series).map(([band, points]) => ({ label: band, points: points.map(p => ({ t: Date.parse(p.t), v: p.noise })) }));
    charts.line($("#rf-noise"), series, { yFormat: v => `${v.toFixed(0)}`, legend: $("#rf-noise-legend") });
    const age = b.last_sweep_age;
    $("#rf-status").textContent = age != null ? `LAST SWEEP ${fmt.duration(age)} AGO` : b.status?.enabled ? "NO SWEEP YET" : "RTL-SDR MONITOR DISABLED";
  },
  async spectrum() {
    let d;
    try { d = await api.get("/api/rf/spectrum"); } catch { return; }
    const names = Object.keys(d.bands || {});
    const select = $("#rf-spec-band");
    const want = select.value || prefs.get("signals.specBand") || names[0] || "";
    select.innerHTML = names.map(n => `<option value="${esc(n)}">${esc(fmt.upper(n))}</option>`).join("") || `<option value="">NO SWEEPS YET</option>`;
    if (names.includes(want)) select.value = want;
    this.drawSpectrum($("#rf-spectrum"), d.bands?.[select.value]);
  },
  drawSpectrum(canvas, sp) {
    const points = sp ? sp.freqs.map((f, i) => ({ t: f, v: sp.powers[i] })) : [];
    const floor = sp ? sp.freqs.map(f => ({ t: f, v: sp.floor })) : [];
    charts.line(canvas, [{ label: "POWER DB", points }, { label: "NOISE FLOOR", points: floor }],
      { yFormat: v => v.toFixed(0), xFormat: t => (t / 1e6).toFixed(2) });
  },
  async load() {
    const params = new URLSearchParams({ band: $("#rf-band").value, min_score: $("#rf-score").value, limit: this.limit, offset: this.offset });
    let data;
    try { data = await api.get(`/api/rf/events?${params}`); } catch { return; }
    $("#rf-table tbody").innerHTML = data.items.map(e => `<tr data-id="${e.id}" class="${e.id === this.selected ? "sel" : ""}">
      <td>${e.id}</td><td>${fmt.when(e.timestamp_utc)}</td><td>${esc(fmt.upper(e.band))}</td><td class="num">${fmt.mhz(e.center_hz, 4)}</td>
      <td class="num">${fmt.num(e.snr_db, 1)}</td><td class="num">${fmt.num(e.score, 0)}</td><td>${esc(fmt.upper(e.classification || ""))}</td>
      <td class="num">${fmt.int(e.observations)}</td></tr>`).join("")
      || `<tr><td colspan="8" class="muted">NO EVENTS${App.state?.sources?.rtlsdr?.enabled ? "" : " · THE RTL-SDR MONITOR IS DISABLED (SEE README)"}</td></tr>`;
    $$("#rf-table tbody tr[data-id]").forEach(tr => tr.onclick = () => this.select(+tr.dataset.id));
    pager($("#rf-pager"), data.total, this.offset, this.limit, offset => { this.offset = offset; this.load(); });
  },
  async select(id) {
    this.selected = id;
    audio.ui("open");
    $$("#rf-table tbody tr").forEach(tr => tr.classList.toggle("sel", +tr.dataset.id === id));
    const box = $("#rf-detail");
    box.innerHTML = `<div class="muted pad blink">RETRIEVING SIGNAL #${id}...</div>`;
    let e;
    try { e = await api.get(`/api/rf/events/${id}`); } catch (error) { box.innerHTML = `<div class="muted pad">${esc(error.message)}</div>`; return; }
    box.innerHTML = `
      <div class="d-head"><div class="d-holo holo"></div><div>
        <h3>SIGNAL #${e.id} · ${fmt.mhz(e.center_hz, 4)} MHZ</h3>
        <div class="muted">${esc(fmt.upper(e.band))} · ${esc(fmt.upper(e.classification || ""))}</div>
        <div class="muted">FIRST ${fmt.when(e.timestamp_utc)} · LAST ${fmt.age(e.last_seen_utc)}</div></div></div>
      ${facts([
        ["SCORE", fmt.num(e.score, 1)], ["SNR", `${fmt.num(e.snr_db, 1)} DB`],
        ["PEAK / FLOOR", `${fmt.num(e.peak_db, 1)} / ${fmt.num(e.floor_db, 1)} DB`],
        ["BANDWIDTH", `${fmt.num((e.bandwidth_hz || 0) / 1000, 1)} KHZ`], ["SWEEPS SEEN IN", fmt.int(e.observations)],
      ])}
      ${e.spectrum ? `<h2 class="hl">LATEST ${esc(fmt.upper(e.band))} SWEEP</h2><canvas class="d-spec" height="150"></canvas>` : ""}
      <p class="desc">Detected by rtl_power as a cluster of bins standing out from the band's median noise floor. Strong local
        transmitters, harmonics and receiver spurs show up too; the score only ranks how far above the floor it was.</p>`;
    new Holo(box.querySelector(".d-holo")).show("signal", String(e.id));
    if (e.spectrum) this.drawSpectrum(box.querySelector(".d-spec"), e.spectrum);
  },
  leave() {},
};

/* ---------------- SYSTEM ---------------- */
const System = {
  init() { $("#sys-hours").onchange = () => { audio.ui("click"); this.history(); }; },
  async enter() { await this.refresh(); this.history(); },
  async refresh() {
    let s;
    try { s = await api.get("/api/system"); } catch { return; }
    const mem = s.memory || {}, net = s.net || {}, io = s.disk_io || {}, st = s.static || {};
    $("#sys-tiles").innerHTML = [
      tile("CPU LOAD", fmt.pct(s.cpu), `${st.cpu_cores || "?"} CORES / ${st.cpu_threads || "?"} THREADS${s.cpu_freq_mhz ? ` · ${s.cpu_freq_mhz} MHZ` : ""}`, s.cpu),
      tile("MEMORY", fmt.pct(mem.percent), `${fmt.bytes(mem.used)} / ${fmt.bytes(mem.total)}`, mem.percent),
      tile("CPU TEMPERATURE", s.temperature != null ? `${fmt.num(s.temperature, 1)}°C` : "N/A", s.temperature == null ? "NO SENSOR FOUND (SEE README)" : "", s.temperature),
      tile("NETWORK", `↓ ${fmt.rate(net.rx_bps)}`, `↑ ${fmt.rate(net.tx_bps)}`),
      tile("DISK I/O", `R ${fmt.rate(io.read_bps)}`, `W ${fmt.rate(io.write_bps)}`),
      tile("UPTIME", fmt.duration(s.uptime_seconds), `PANEL ${fmt.duration(s.panel_uptime_seconds)}`),
      tile("PROCESSES", fmt.int(s.processes), `PANEL DB ${fmt.bytes(s.panel_db_bytes)}`),
    ].join("");
    $("#sys-cores").innerHTML = (s.cpu_per_core || []).map((v, i) => `<div class="core" title="CORE ${i}: ${v}%"><span>${i}</span><i style="height:${v}%"></i></div>`).join("");
    $("#sys-disks").innerHTML = (s.disks || []).map(d => `<div class="meter"><div class="m-head"><span>${esc(d.path)}</span><span>${fmt.bytes(d.free)} FREE · ${fmt.pct(d.percent)}</span></div>
      <div class="bar"><i style="width:${d.percent}%"></i></div></div>`).join("") + `<div class="muted">PANEL DATABASE: ${fmt.bytes(s.panel_db_bytes)}</div>`;
    const names = { stellarium: "STELLARIUM", sdrsharp: "SDR#", sdrpp: "SDR++", gqrx: "GQRX", rtl_tcp: "RTL_TCP", rtl_power: "RTL_POWER (SWEEPING)", panel: "THIS PANEL" };
    $("#sys-services").innerHTML = Object.entries(s.services || {}).map(([k, v]) =>
      `<div class="svc"><span class="led ${v.running ? "on" : ""}"></span><span>${esc(names[k] || k)}</span><span class="muted">${v.running ? fmt.bytes(v.rss) : "NOT RUNNING"}</span></div>`).join("");
    const srcNames = { stellarium: "STELLARIUM REMOTE CONTROL", rtlsdr: "RTL-SDR BAND MONITOR" };
    $("#sys-sources").innerHTML = Object.entries(s.sources || {}).map(([k, v]) =>
      `<div class="svc"><span class="led ${v.available ? "on" : "bad"}"></span><span>${esc(srcNames[k] || k)}</span><span class="muted">${v.available ? (v.last_sweep ? `SWEEP ${fmt.age(v.last_sweep)}` : "ONLINE") : v.enabled === false ? "DISABLED" : esc(fmt.upper(v.error || "UNAVAILABLE")).slice(0, 60)}</span></div>`).join("");
    $("#sys-static").innerHTML = facts([["HOST", esc(st.hostname)], ["OS", esc(st.os)], ["CPU", esc(st.cpu_name)],
      ["RAM", fmt.bytes(st.memory_total)], ["BOOTED", fmt.when(st.boot_time)], ["PYTHON", esc(st.python)],
      ["SENSORS", (s.temperatures || []).slice(0, 6).map(t => `${esc(t.name)} ${fmt.num(t.value, 1)}°`).join(" · ") || "NONE"]]);
    const r = (s.sources || {}).rtlsdr || {};
    $("#sys-avail").innerHTML = facts([
      ["STATUS", r.enabled ? (r.available ? "ONLINE" : "ERROR") : "DISABLED"], ["MODE", esc(fmt.upper(r.mode || ""))],
      ["LAST SWEEP", r.last_sweep ? fmt.age(r.last_sweep) : "---"], ["BANDS", fmt.int((r.bands || []).length)],
      ["ERROR", r.error ? esc(fmt.upper(r.error)) : null]]);
  },
  async history() {
    let h;
    try { h = await api.get(`/api/system/history?hours=${$("#sys-hours").value}`); } catch { return; }
    const pts = key => h.items.map(r => ({ t: Date.parse(r.timestamp_utc), v: r[key] }));
    charts.line($("#sys-load"), [{ label: "CPU %", points: pts("cpu") }, { label: "MEMORY %", points: pts("memory") }, { label: "DISK %", points: pts("disk") }],
      { yMin: 0, yMax: 100, legend: $("#sys-load-legend") });
    const kb = key => h.items.map(r => ({ t: Date.parse(r.timestamp_utc), v: r[key] / 1024 }));
    charts.line($("#sys-net"), [{ label: "RX KB/S", points: kb("net_rx_bps") }, { label: "TX KB/S", points: kb("net_tx_bps") },
      { label: "TEMP °C", points: pts("temperature"), axis: "right" }],
      { yMin: 0, rightFormat: v => `${v.toFixed(0)}°`, legend: $("#sys-net-legend") });
  },
};

/* ---------------- CONTROL ---------------- */
const Control = {
  staleMs: 0,            // auth state must be re-checked on every visit
  init() {
    $("#ctl-login-btn").onclick = () => this.login();
    $("#ctl-pin").onkeydown = e => { if (e.key === "Enter") this.login(); };
    $("#ctl-find").onclick = () => this.find();
    $("#ctl-q").onkeydown = e => { if (e.key === "Enter") this.find(); };
    $("#ctl-goto").onclick = () => this.send("/api/control/altaz", { az: +$("#ctl-az").value, alt: +$("#ctl-el").value }, `SLEW AZ ${$("#ctl-az").value} EL ${$("#ctl-el").value}`);
    $("#ctl-fov").oninput = () => { $("#ctl-fov-v").textContent = $("#ctl-fov").value; };
    $("#ctl-fov-set").onclick = () => this.send("/api/control/fov", { fov: +$("#ctl-fov").value }, `FOV ${$("#ctl-fov").value}°`);
    $("#ctl-release").onclick = () => this.send("/api/control/release", {}, "VIEW RESTORED");
    $("#ctl-logout").onclick = async () => { await api.post("/api/auth/logout").catch(() => {}); audio.ui("close"); this.enter(); };
    $$(".dpad [data-nudge]").forEach(b => b.onclick = () => {
      const view = App.state?.stellarium?.view || {};
      const [daz, del] = b.dataset.nudge.split(",").map(Number);
      const az = ((view.az ?? +$("#ctl-az").value) + daz + 360) % 360, el = Math.max(-5, Math.min(90, (view.alt ?? +$("#ctl-el").value) + del));
      $("#ctl-az").value = az.toFixed(1); $("#ctl-el").value = el.toFixed(1);
      this.send("/api/control/altaz", { az, alt: el }, `NUDGE AZ ${az.toFixed(1)} EL ${el.toFixed(1)}`);
    });
    this.holo = new Holo($("#ctl-holo"));
    this.holo.show("antenna", "ctl");
  },
  async enter() {
    let status;
    try { status = await api.get("/api/auth/status"); } catch { return; }
    $("#ctl-login").hidden = status.authenticated;
    $("#ctl-panel").hidden = !status.authenticated;
    if (!status.control_enabled) {
      $("#ctl-login").innerHTML = `<div class="muted">CONTROL IS DISABLED: NO PIN IS CONFIGURED (SET control_pin IN config/panel.local.json).</div>`;
    }
    if (status.restore_minutes) $("#ctl-restore-min").textContent = status.restore_minutes;
    this.update(App.state);
  },
  async login() {
    try {
      await api.post("/api/auth/login", { pin: $("#ctl-pin").value });
      $("#ctl-pin").value = "";
      audio.ui("confirm");
      $("#ctl-login-msg").textContent = "";
      this.enter();
    } catch (error) {
      audio.ui("error");
      $("#ctl-login-msg").textContent = `ACCESS DENIED: ${fmt.upper(error.message)}`;
    }
  },
  async find() {
    const q = $("#ctl-q").value.trim();
    if (!q) return;
    const { results } = await api.get(`/api/control/search?q=${encodeURIComponent(q)}`).catch(() => ({ results: [] }));
    $("#ctl-results").innerHTML = results.map(name => `<button class="chip" data-n="${esc(name)}">${esc(name)}</button>`).join("") || `<span class="muted">NO MATCHES (IS STELLARIUM RUNNING?)</span>`;
    $$("#ctl-results .chip").forEach(chip => chip.onclick = () => this.send("/api/control/focus", { name: chip.dataset.n }, `FOCUS ${chip.dataset.n}`));
  },
  async send(path, body, label) {
    try {
      await api.post(path, body);
      audio.ui("confirm");
      toast(fmt.upper(label));
    } catch (error) {
      audio.ui("error");
      toast(`COMMAND FAILED: ${fmt.upper(error.message)}`, true);
      if (/PIN|401|Unauthorized/i.test(error.message)) App.show("control");
    }
  },
  /* Called from record/sky views. Requires an authorised session. */
  async pointAt(obj) {
    const status = await api.get("/api/auth/status").catch(() => ({}));
    if (!status.authenticated) { toast("ENTER THE CONTROL PIN ON THE CONTROL SCREEN FIRST", true); App.show("control"); return; }
    const pos = obj.position || obj;
    if (obj.category === "satellite" || obj.category === "seti signal" || obj.category === "probe" || obj.category === "radio source" || obj.category === "pulsar") {
      if (pos && pos.az != null) return this.send("/api/control/altaz", { az: pos.az, alt: pos.alt }, `SLEW TO ${obj.name}`);
    }
    return this.send("/api/control/focus", { name: obj.name }, `FOCUS ${obj.name}`);
  },
  update(state) {
    if (!state || !$("#ctl-state")) return;
    const s = state.stellarium || {}, v = s.view || {}, c = s.control || {};
    $("#ctl-state").innerHTML = facts([
      ["STELLARIUM", s.online ? "ONLINE" : `<span class="blink">OFFLINE</span>`],
      ["VIEW", v.az != null ? `AZ ${fmt.num(v.az, 2)}° · EL ${fmt.num(v.alt, 2)}° · FOV ${fmt.num(v.fov, 1)}°` : "---"],
      ["RA / DEC", v.ra != null ? `${fmt.num(v.ra, 3)}° / ${fmt.num(v.dec, 3)}°` : "---"],
      ["SELECTION", esc(s.selection || "NONE")],
      ["LOCATION", esc(`${s.location?.name || ""} ${fmt.num(s.location?.latitude, 3)}, ${fmt.num(s.location?.longitude, 3)}`)],
      ["PANEL CONTROL", c.active ? `ACTIVE · ${esc(c.target || "")} · AUTO-RESTORE IN ${fmt.duration(c.restore_in)}` : "IDLE (YOUR VIEW UNTOUCHED)"],
      ["CATALOG ENRICHMENT", s.enrichment && s.enrichment.pending ? `${fmt.int(s.enrichment.done)} / ${fmt.int(s.enrichment.pending)}` : "UP TO DATE"],
    ]);
  },
};
