/* SIGNALS > SHORTWAVE: Priyom numbers-station schedule, always-on markers and
   one-click tuning links to public WebSDR / KiwiSDR receivers (opened in a new
   tab; the panel never relays or records other people's receivers). */
"use strict";

const Shortwave = {
  data: null, selected: null,

  init() {
    $("#sw-family").onchange = () => { audio.ui("click"); this.render(); };
    $("#sw-hide-search").onchange = () => { audio.ui("toggle"); this.render(); };
  },

  async enter() { await this.refresh(); },

  async refresh() {
    try { this.data = await api.get("/api/shortwave?hours=12"); } catch { return; }
    this.render();
  },

  statusBadge(event) {
    if (event.status === "on-air") return `<span class="badge emergency">ON AIR · ${fmt.int(-event.minutes_until)}M</span>`;
    if (event.status === "soon") return `<span class="badge hot">IN ${fmt.int(event.minutes_until)}M</span>`;
    return `<span class="badge">IN ${fmt.duration(event.minutes_until * 60)}</span>`;
  },

  render() {
    const d = this.data;
    if (!d) return;
    const p = d.providers, prio = p.priyom, kiwi = p.kiwisdr;
    const events = d.events;
    const onAir = events.filter(e => e.status === "on-air" && !e.search);
    const next = events.find(e => e.status !== "on-air" && !e.search);
    const state = s => (!s || s.online === undefined ? "UNCHECKED" : s.online ? "ONLINE" : `OFFLINE (${fmt.upper(s.detail || "")})`);
    $("#sw-tiles").innerHTML = [
      tile("PRIYOM SCHEDULE", prio.available ? "ONLINE" : "OFFLINE", prio.available ? `${fmt.int(events.length)} TRANSMISSIONS NEXT 12H` : esc(fmt.upper(prio.error || "NOT FETCHED YET"))),
      tile("ON AIR NOW", fmt.int(onAir.length), onAir.length ? esc(onAir.slice(0, 4).map(e => e.station).join(" · ")) : "SCHEDULED STARTS IN THE LAST 15 MIN"),
      tile("NEXT TRANSMISSION", next ? esc(next.station) : "---", next ? `${fmt.num(next.freq_khz, 1)} KHZ ${esc(next.mode || "")} · IN ${fmt.int(next.minutes_until)}M` : ""),
      tile("KIWISDR NETWORK", kiwi.available ? `${fmt.int(kiwi.online)} ONLINE` : "OFFLINE", kiwi.available ? `${fmt.int(kiwi.free)} WITH FREE SLOTS` : esc(fmt.upper(kiwi.error || "NOT FETCHED YET"))),
      tile("WEBSDR TWENTE", state(p.utwente), "0-29 MHZ"),
      tile("PAVLOVA DISPATCHER", state(p.pavlova), "PRIYOM'S KIWISDR ROUTER"),
    ].join("");
    $("#sw-onair-min").textContent = fmt.int(d.on_air_minutes);

    $("#sw-continuous").innerHTML = d.continuous.map((c, i) => `<div class="sw-card" data-c="${i}">
        <b>${esc(c.station)} · ${esc(c.name)}</b><br>
        ${c.freqs.map(f => `${fmt.num(f.khz, f.khz % 1 ? 1 : 0)} KHZ ${esc(c.mode)} <span class="muted">(${esc(f.label)})</span>`).join(" · ")}
        <div class="muted">${esc(c.note)}</div></div>`).join("");
    $$("#sw-continuous .sw-card").forEach(card => card.onclick = () => this.selectContinuous(d.continuous[+card.dataset.c], card));

    const families = [...new Set(events.map(e => (e.station || "?")[0].toUpperCase()))].sort();
    const famSelect = $("#sw-family"), current = famSelect.value;
    famSelect.innerHTML = `<option value="">ALL FAMILIES</option>` +
      families.map(f => `<option value="${esc(f)}">${esc(f)} · ${esc(fmt.upper(d.families[f] || "OTHER"))}</option>`).join("");
    famSelect.value = families.includes(current) ? current : "";
    const family = famSelect.value, hideSearch = $("#sw-hide-search").checked;
    this.rows = events.filter(e => (!family || (e.station || "")[0].toUpperCase() === family) && !(hideSearch && e.search));
    $("#sw-table tbody").innerHTML = this.rows.map((e, i) => `<tr data-i="${i}" class="${this.selected === e.summary + e.start ? "sel" : ""}">
        <td>${esc(e.start.slice(11, 16))}</td><td>${this.statusBadge(e)}</td><td>${esc(e.station)}</td>
        <td class="num">${e.freq_khz ? fmt.num(e.freq_khz, e.freq_khz % 1 ? 1 : 0) : "SEARCH"}</td><td>${esc(e.mode || "")}</td><td>${esc(fmt.upper(e.target || ""))}</td></tr>`).join("")
      || `<tr><td colspan="6" class="muted">${prio.available ? "NO TRANSMISSIONS MATCH" : "SCHEDULE NOT AVAILABLE YET"}</td></tr>`;
    $$("#sw-table tbody tr[data-i]").forEach(tr => tr.onclick = () => this.selectEvent(this.rows[+tr.dataset.i], tr));
  },

  async selectEvent(event, row) {
    audio.ui("open");
    this.selected = event.summary + event.start;
    $$("#sw-table tbody tr").forEach(tr => tr.classList.toggle("sel", tr === row));
    $$("#sw-continuous .sw-card").forEach(c => c.classList.remove("sel"));
    const header = `<h3>${esc(event.station)} · ${event.freq_khz ? `${fmt.num(event.freq_khz, event.freq_khz % 1 ? 1 : 0)} KHZ` : "FREQUENCY SEARCH"}</h3>
      <div class="muted">${esc(fmt.upper(event.family || "UNCLASSIFIED"))} (ENIGMA 2000 DESIGNATOR)</div>
      <div class="muted">${fmt.when(event.start)} · ${event.status === "on-air" ? `STARTED ${fmt.int(-event.minutes_until)} MIN AGO` : `STARTS IN ${fmt.duration(event.minutes_until * 60)}`}</div>`;
    const facts_ = facts([["SCHEDULE ENTRY", esc(event.summary)], ["MODE", esc(event.mode || "---")], ["TARGET AREA", esc(event.target || "---")]]);
    if (!event.freq_khz) {
      this.renderDetail(header, facts_, [], "PRIYOM LISTS THIS AS A SEARCH: THE FREQUENCY IS NOT KNOWN IN ADVANCE.");
      return;
    }
    await this.loadLinks(header, facts_, event.freq_khz, event.mode, event.target);
  },

  async selectContinuous(c, card) {
    audio.ui("open");
    this.selected = null;
    $$("#sw-table tbody tr").forEach(tr => tr.classList.remove("sel"));
    $$("#sw-continuous .sw-card").forEach(x => x.classList.toggle("sel", x === card));
    const header = `<h3>${esc(c.station)} · ${esc(c.name)}</h3><div class="muted">CONTINUOUS MARKER · ${esc(c.mode)}</div>`;
    const facts_ = facts([["NOTES", esc(c.note)], ["SOURCE", `<a href="${esc(c.source)}" target="_blank" rel="noopener noreferrer">PRIYOM.ORG STATION PAGE</a>`]]);
    const groups = [];
    for (const f of c.freqs) {
      try {
        const t = await api.get(`/api/shortwave/tune?freq=${f.khz}&mode=${encodeURIComponent(c.mode)}&target=${encodeURIComponent(c.target)}`);
        groups.push({ label: `${fmt.num(f.khz, f.khz % 1 ? 1 : 0)} KHZ · ${f.label}`, links: t.links });
      } catch { /* ignore */ }
    }
    this.renderDetail(header, facts_, groups);
  },

  async loadLinks(header, facts_, freq, mode, target) {
    $("#sw-detail").innerHTML = `<div class="muted pad blink">FINDING RECEIVERS...</div>`;
    let t;
    try { t = await api.get(`/api/shortwave/tune?freq=${freq}&mode=${encodeURIComponent(mode || "USB")}&target=${encodeURIComponent(target || "")}`); }
    catch (error) { $("#sw-detail").innerHTML = `<div class="muted pad">${esc(error.message)}</div>`; return; }
    this.renderDetail(header, facts_, [{ label: "TUNE IN", links: t.links }]);
  },

  renderDetail(header, facts_, groups, note = "") {
    const linkHtml = link => `<div class="sw-link"><span>${esc(fmt.upper(link.provider))}
        <span class="muted">${link.online === true ? "ONLINE" : link.online === false ? `OFFLINE (${esc(link.detail || "")})` : "STATUS UNCHECKED"}${link.kind === "kiwisdr" ? ` · ${esc(link.detail || "")}` : ""}</span></span>
        <button class="btn small" data-url="${esc(link.url)}">LISTEN ↗</button></div>`;
    $("#sw-detail").innerHTML = `<div class="d-head"><div class="d-holo holo"></div><div>${header}</div></div>${facts_}
      ${note ? `<p class="desc">${esc(note)}</p>` : ""}
      ${groups.map(g => `<h2 class="hl">${esc(g.label)}</h2><div class="sw-links">${g.links.map(linkHtml).join("") || `<div class="muted">NO SUITABLE RECEIVER FOUND</div>`}</div>`).join("")}
      <p class="desc">LINKS OPEN THE RECEIVER'S OWN PAGE IN A NEW TAB, PRE-TUNED. SHARED RECEIVERS HAVE LIMITED SLOTS AND SOME APPLY TIME LIMITS; PLEASE CLOSE THE TAB WHEN DONE.</p>`;
    new Holo($("#sw-detail .d-holo")).show("signal", header);
    $$("#sw-detail [data-url]").forEach(btn => btn.onclick = () => {
      const url = btn.dataset.url;
      if (/^https?:\/\//.test(url)) { audio.ui("click"); window.open(url, "_blank", "noopener,noreferrer"); }
    });
  },
};
