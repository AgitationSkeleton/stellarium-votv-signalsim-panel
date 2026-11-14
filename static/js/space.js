/* SPACE screen: NASA and JAXA posts/images, categorised by agency and feed. */
"use strict";

const Space = {
  source: "", agency: "", offset: 0, limit: 30, items: [], selected: null,

  init() {
    const saved = prefs.get("space.filter") || "";
    [this.agency, this.source] = saved.includes(":") ? saved.split(":") : ["", ""];
    document.body.classList.toggle("space-tint", Boolean(prefs.get("space.tint")));
  },

  async enter() {
    await this.loadSources();
    await this.load();
  },
  refresh() { this.loadSources(); this.load(true); },

  async loadSources() {
    let data;
    try { data = await api.get("/api/space/sources"); } catch { return; }
    this.sources = data.sources;
    const tab = (agency, source, label) => {
      const active = this.agency === agency && this.source === source;
      return `<button data-agency="${esc(agency)}" data-source="${esc(source)}" class="${active ? "active" : ""}">${esc(label)}</button>`;
    };
    const agencies = [["NASA", "NASA"], ["JAXA", "JAXA"], ["JAPAN", "JAPAN · OTHER"]];
    const rows = agencies.filter(([agency]) => data.sources.some(s => s.agency === agency)).map(([agency, label]) => {
      const sources = data.sources.filter(s => s.agency === agency);
      return `<div class="space-row"><span class="group">${esc(label)}</span>${tab(agency, "", `ALL ${label.split(" ")[0]}`)}` +
        sources.map(s => tab(agency, s.id, fmt.upper(s.name)) ).join("") + `</div>`;
    });
    $("#space-tabs").innerHTML = `<div class="space-row">${tab("", "", "ALL SOURCES")}` +
      `<label class="toggle"><input type="checkbox" id="space-tint" ${prefs.get("space.tint") ? "checked" : ""}> PHOSPHOR TINT</label></div>` + rows.join("");
    $$("#space-tabs button").forEach(btn => btn.onclick = () => {
      audio.ui("tab");
      this.agency = btn.dataset.agency; this.source = btn.dataset.source; this.offset = 0;
      prefs.set("space.filter", `${this.agency}:${this.source}`);
      $$("#space-tabs button").forEach(b => b.classList.toggle("active", b === btn));
      this.load();
    });
    $("#space-tint").onchange = e => { prefs.set("space.tint", e.target.checked); document.body.classList.toggle("space-tint", e.target.checked); audio.ui("toggle"); };
    const ok = data.sources.filter(s => s.available);
    const problems = data.sources.filter(s => !s.available);
    const newest = ok.map(s => s.fetched).filter(Boolean).sort().pop();
    $("#space-status").innerHTML = `${ok.length}/${data.sources.length} FEEDS OK · ${fmt.int(data.sources.reduce((n, s) => n + s.stored, 0))} POSTS STORED` +
      (newest ? ` · LAST FETCH ${fmt.age(newest)}` : "") +
      (problems.length ? ` · UNAVAILABLE: ${problems.map(s => `<span title="${esc(s.error || "waiting for first fetch")}">${esc(fmt.upper(s.name))}</span>`).join(", ")}` : "");
  },

  async load(quiet = false) {
    const params = new URLSearchParams({ source: this.source, agency: this.agency, limit: this.limit, offset: this.offset });
    let data;
    try { data = await api.get(`/api/space/items?${params}`); } catch { return; }
    const signature = data.items.map(i => i.key).join("|");
    if (quiet && signature === this.signature) return;      // nothing new: keep the DOM (and loaded images) as is
    this.signature = signature;
    this.items = data.items;
    $("#space-grid").innerHTML = data.items.map((item, i) => `<div class="space-card ${this.selected === item.key ? "sel" : ""}" data-i="${i}">
        <div class="thumb">${item.has_image ? `<img loading="lazy" decoding="async" alt="" src="/api/space/image?key=${encodeURIComponent(item.key)}">` : `<span class="ph">${item.agency === "JAXA" ? "▲" : "✶"}</span>`}</div>
        <div class="meta"><b>${esc(item.title)}</b><div class="muted">${esc(item.group || item.agency)} · ${esc(fmt.upper(item.source_name))}<br>${item.published_utc ? fmt.when(item.published_utc) : ""}</div></div>
      </div>`).join("") || `<div class="muted pad">NO POSTS YET (FEEDS ARE FETCHED EVERY 30-60 MIN)</div>`;
    $$("#space-grid .space-card").forEach(card => card.onclick = () => this.select(this.items[+card.dataset.i], card));
    pager($("#space-pager"), data.total, this.offset, this.limit, offset => { this.offset = offset; this.load(); });
  },

  select(item, card) {
    audio.ui("open");
    this.selected = item.key;
    $$("#space-grid .space-card").forEach(c => c.classList.toggle("sel", c === card));
    const host = (() => { try { return new URL(item.link).hostname.toUpperCase(); } catch { return "SOURCE"; } })();
    $("#space-detail").innerHTML = `
      ${item.has_image ? `<img class="space-figure" alt="" src="/api/space/image?key=${encodeURIComponent(item.key)}">` : ""}
      <h3>${esc(item.title)}</h3>
      <div class="muted">${esc(item.agency)} · ${esc(fmt.upper(item.source_name))}${item.published_utc ? ` · ${fmt.when(item.published_utc)} (${fmt.age(item.published_utc)})` : ""}</div>
      ${item.credit ? `<div class="muted">CREDIT: ${esc(item.credit)}</div>` : ""}
      ${item.media_type === "video" ? `<div class="muted">TODAY'S APOD IS A VIDEO; THE IMAGE IS ITS THUMBNAIL.</div>` : ""}
      ${item.media_type === "live" ? `<div class="muted">LIVE IMAGE · REFRESHED AUTOMATICALLY</div>` : ""}
      <p class="desc">${esc(item.summary || "")}</p>
      <div class="actions"><button class="btn small" data-open="1">OPEN ON ${esc(host)} ↗</button></div>`;
    const open = $("#space-detail [data-open]");
    open.onclick = () => { if (/^https:\/\//.test(item.link)) { audio.ui("click"); window.open(item.link, "_blank", "noopener,noreferrer"); } };
  },
};
