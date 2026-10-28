// JTS - Job Tracking System frontend
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const L = window.JTSLetter;

  // ---------- opslag (alleen op dit apparaat) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("jts." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("jts." + k, JSON.stringify(v)); } catch { /* privé-modus */ } },
  };
  const profile = Object.assign({ name: "", email: "", phone: "", cv: "", coreStory: L.CORE_STORY, coreStoryEn: L.CORE_STORY_EN,
    key: "", model: "gemini-flash-latest", minScore: null }, store.get("profile", {}));
  const status = store.get("status", {});      // id -> {s: skip|saved|applied, at, title, company, url}
  const letters = store.get("letters", {});    // id -> tekst
  // Lokale kopie van alle vacatures (7 dagen), zodat niets verdwijnt als jobs.json ververst of offline is.
  const cache = store.get("jobsCache", {});
  let jobs = Object.values(cache), meta = store.get("meta", {}), skillRes = [], lastLoad = 0;
  // Locatievoorkeur: standaard Brabant, Rotterdam en Utrecht.
  const DEFAULT_LOCS = ["brabant", "rotterdam", "utrecht"];
  const F = Object.assign({ cat: "all", top: false, few: false, q: "", locs: [...DEFAULT_LOCS] }, store.get("filters", {}));
  if (F.v !== 2) { F.locs = [...DEFAULT_LOCS]; F.v = 2; store.set("filters", F); }   // nieuwe standaard: Mijn regio
  const isMyRegion = (locs) => locs.length === DEFAULT_LOCS.length && DEFAULT_LOCS.every((l) => locs.includes(l));
  let sortBy = store.get("sort", "new");
  // "nieuw" = nog niet gezien op dit apparaat. Wordt bijgewerkt als je de app verlaat.
  const seen = new Set(store.get("seen", []));
  const isNewSinceVisit = (j) => seen.size > 0 && !seen.has(j.id);
  const markSeen = () => { jobs.forEach((j) => seen.add(j.id)); store.set("seen", [...seen].slice(-3000)); };

  // ---------- hulpjes ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
  const hoursOld = (j) => (Date.now() - new Date(j.posted_at || j.first_seen).getTime()) / 36e5;
  function ago(j) {
    const h = hoursOld(j);
    if (h < 1) return "net geplaatst";
    if (h < 24) return `${Math.round(h)} uur geleden`;
    return `${Math.round(h / 24)} dag${h >= 36 ? "en" : ""} geleden`;
  }
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("on");
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 2200);
  }
  function setStatus(job, s) {
    status[job.id] = { s, at: new Date().toISOString(), title: job.title, company: job.company, url: job.url };
    store.set("status", status);
  }

  // skills-matcher, gedeeld met de scraper via skills.txt
  function buildSkills(txt) {
    skillRes = txt.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
      const names = l.split("|").map((n) => n.trim());
      const alt = names.sort((a, b) => b.length - a.length).map((n) => n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      return [l.split("|")[0].trim(), new RegExp(`(?<![a-z0-9])(${alt})(?![a-z0-9#+])`)];
    });
  }
  const findSkills = (text) => { const low = (text || "").toLowerCase(); return skillRes.filter(([, r]) => r.test(low)).map(([n]) => n); };

  // ---------- data ----------
  const gh = () => (profile.ghRepo && profile.ghToken ? profile : null);
  const ghHeaders = () => ({ Authorization: `Bearer ${profile.ghToken}`, Accept: "application/vnd.github+json" });

  async function fetchJobsJson() {
    // Met GitHub-token: direct uit de repo, dus zonder de ~10 min cache van GitHub Pages.
    if (gh()) {
      const r = await fetch(`https://api.github.com/repos/${profile.ghRepo}/contents/docs/jobs.json`,
        { headers: { ...ghHeaders(), Accept: "application/vnd.github.raw+json" }, cache: "no-store" });
      if (r.ok) return r.json();
    }
    const r = await fetch(`jobs.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`jobs.json ${r.status}`);
    return r.json();
  }

  function saveCache() {
    const cutoff = Date.now() - 7 * 864e5;
    for (const [id, j] of Object.entries(cache)) if (new Date(j.first_seen).getTime() < cutoff) delete cache[id];
    try { store.set("jobsCache", cache); } catch { /* opslag vol: alleen in geheugen */ }
  }

  function updateMeta(offline) {
    const upd = meta.updated_at ? new Date(meta.updated_at).toLocaleString("nl-NL", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "nog nooit";
    const mins = lastLoad ? Math.round((Date.now() - lastLoad) / 6e4) : null;
    $("#meta").textContent = `${jobs.length} vacatures · scraper ${upd}` +
      (offline ? " · offline" : mins === null ? "" : mins < 1 ? " · net opgehaald" : ` · opgehaald ${mins} min geleden`);
  }

  // Haalt jobs.json op en voegt nieuwe/bijgewerkte vacatures toe. Bestaande vacatures blijven staan.
  async function load({ quiet = false } = {}) {
    let added = 0, offline = false;
    try {
      if (!skillRes.length) buildSkills(await (await fetch("skills.txt")).text());
      const data = await fetchJobsJson();
      for (const j of data.jobs || []) {
        if (!cache[j.id]) added++;
        cache[j.id] = Object.assign({}, j, { full_text: (j.full_text || "").slice(0, 3000) });
      }
      saveCache();
      jobs = Object.values(cache);
      meta = { updated_at: data.updated_at, min_score: data.min_score, sources: data.sources };
      store.set("meta", meta);
      lastLoad = Date.now();
      if (quiet && added) toast(`${added} nieuwe vacature${added > 1 ? "s" : ""} binnen`);
    } catch (e) {
      offline = true;
      if (!quiet) toast(jobs.length ? "Offline: je ziet de laatst opgehaalde vacatures" : "Kon vacatures niet laden");
    }
    updateMeta(offline);
    if (!$("#sheet").classList.contains("on")) render();
    return added;
  }

  // Vernieuwen: haalt direct de nieuwste lijst op en start (met GitHub-token) de scraper op de achtergrond.
  let scrapeStarted = 0;
  async function refreshNow() {
    const btn = $("#btn-refresh");
    btn.disabled = true; btn.classList.add("spin");
    try {
      const n = await load();
      if (!gh()) {
        toast(n ? `${n} nieuwe vacature${n > 1 ? "s" : ""}` : "Up-to-date. Voor live scrapen: vul GitHub in bij Profiel");
        return;
      }
      if (Date.now() - scrapeStarted < 4 * 6e4) {
        toast(n ? `${n} nieuwe vacature${n > 1 ? "s" : ""}, scraper loopt nog` : "Scraper loopt al, nieuwe vacatures komen vanzelf");
        return;
      }
      const r = await fetch(`https://api.github.com/repos/${profile.ghRepo}/actions/workflows/fetch.yml/dispatches`,
        { method: "POST", headers: ghHeaders(), body: JSON.stringify({ ref: profile.ghBranch || "main" }) });
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      scrapeStarted = Date.now();
      toast((n ? `${n} nieuwe vacature${n > 1 ? "s" : ""}. ` : "") + "Scraper gestart, meer volgt binnen ±5 min");
      waitForScrape(meta.updated_at);
    } catch (e) {
      toast(`Vernieuwen mislukt: ${e.message}`);
    } finally {
      btn.disabled = false; btn.classList.remove("spin");
    }
  }
  // Op de achtergrond wachten tot de scraper klaar is; de lijst ververst dan vanzelf.
  async function waitForScrape(before) {
    for (let i = 0; i < 30; i++) {            // max ~10 minuten
      await new Promise((res) => setTimeout(res, 20000));
      const n = await load({ quiet: true });
      if (meta.updated_at !== before) { if (!n) toast("Scraper klaar, geen nieuwe vacatures"); return; }
    }
  }

  // ---------- trek omlaag om te verversen (zoals TikTok/Instagram) ----------
  const ptr = document.createElement("div");
  ptr.className = "ptr";
  ptr.innerHTML = `<span class="ptr-icon">↓</span><span class="ptr-text"></span>`;
  document.body.prepend(ptr);
  const PTR_MAX = 110, PTR_GO = 70;
  let pStart = null, pDist = 0, pulling = false, ptrBusy = false;
  function ptrShow(dist, text, cls = "") {
    ptr.className = "ptr " + cls;
    ptr.style.transform = `translate(-50%, ${dist}px)`;
    $(".ptr-text", ptr).textContent = text;
    $(".ptr-icon", ptr).textContent = cls.includes("loading") ? "↻" : "↓";
  }
  function ptrAtTop(target) {
    const card = target.closest && target.closest(".deck .card");
    return card ? card.scrollTop <= 0 : window.scrollY <= 0;
  }
  addEventListener("touchstart", (e) => {
    const v = store.get("view", "list");
    if (ptrBusy || e.touches.length !== 1 || (v !== "list" && v !== "swipe") || $("#sheet").classList.contains("on")) return;
    if (e.target.closest("input,textarea,button,a") || !ptrAtTop(e.target)) return;
    pStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }; pDist = 0; pulling = false;
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (!pStart) return;
    const dx = e.touches[0].clientX - pStart.x, dy = e.touches[0].clientY - pStart.y;
    if (!pulling) {
      if (dy > 12 && dy > Math.abs(dx) * 1.5) pulling = true;
      else if (Math.abs(dx) > 12 || dy < -4) { pStart = null; return; }
      else return;
    }
    pDist = Math.min(PTR_MAX, dy * 0.5);
    ptrShow(pDist, pDist >= PTR_GO ? "Loslaten om te verversen" : "Trek omlaag om te verversen", "dragging" + (pDist >= PTR_GO ? " ready" : ""));
  }, { passive: true });
  addEventListener("touchend", async () => {
    if (!pStart) return;
    const go = pulling && pDist >= PTR_GO;
    pStart = null; pulling = false;
    if (!go) return ptrShow(0, "");
    ptrBusy = true;
    ptrShow(PTR_GO, "Nieuwe vacatures ophalen...", "loading");
    try { await refreshNow(); } finally { ptrBusy = false; ptrShow(0, ""); }
  });
  addEventListener("touchcancel", () => { pStart = null; pulling = false; if (!ptrBusy) ptrShow(0, ""); });

  const minScore = () => profile.minScore ?? meta.min_score ?? 55;
  const score = (j) => (j.match ? j.match.score : null);
  // Alleen een echte AI-beoordeling mag een vacature als "niet junior" verbergen; de lokale schatting niet.
  const notJunior = (j) => !!(j.match && j.match.ai && j.match.is_junior === false);
  const isVisible = (j) => (j.match ? !notJunior(j) && j.match.score >= minScore() : true);
  const rank = (j) => (score(j) ?? 50) - hoursOld(j) * 0.4;

  const fewApplicants = (j) => j.applicants != null && j.applicants <= 25;
  const CATS = {
    all: () => true,
    trainee: (j) => j.traineeship,
  };
  // Regio's op basis van de plaatsnaam. Volgorde telt: de eerste die past wint.
  const REGIONS = [
    // Heel Noord-Brabant
    ["brabant", /brabant|\bnb\b|eindhoven|tilburg|den bosch|hertogenbosch|breda|helmond|\boss\b|\buden\b|veghel|waalwijk|oosterhout|roosendaal|bergen op zoom|veldhoven|boxtel|vught|udenhout|oisterwijk|dongen|etten-leur|valkenswaard|geldrop|nuenen|\bson\b|cuijk|schijndel|drunen|heusden|meierijstad|^best\b|rosmalen|kaatsheuvel|goirle|bladel|eersel|deurne|boxmeer|waalre|someren|gemert|zundert|rucphen|moerdijk|made\b|geertruidenberg|loon op zand|tilburg|berkel-enschot|sint-michielsgestel|vught|haaren|best,|oirschot|reusel|bergeijk|mierlo|asten|laarbeek|veldhoven/i],
    // Rotterdam en directe ring
    ["rotterdam", /rotterdam|schiedam|vlaardingen|capelle|barendrecht|ridderkerk|krimpen|rhoon|lansingerland|berkel en rodenrijs|bleiswijk|bergschenhoek|albrandswaard|poortugaal/i],
    // Utrecht en directe ring
    ["utrecht", /^utrecht|utrecht binnenstad|utrecht noord|utrecht oost|utrecht zuid|utrecht west|utrecht, |leidsche rijn|vleuten|nieuwegein|zeist|houten|de bilt|bilthoven|maarssen|ijsselstein|odijk|bunnik|groenekan|lopik/i],
    ["amsterdam", /amsterdam|amstelveen|hoofddorp|haarlem|diemen|zaandam|schiphol|\bnh\b|noord-holland|north holland|almere|hilversum|aalsmeer|alkmaar/i],
    ["denhaag", /den haag|the hague|gravenhage|delft|zoetermeer|rijswijk|leiden|ypenburg|westland|naaldwijk|wassenaar/i],
  ];
  const LOC_LABELS = { brabant: "Noord-Brabant", rotterdam: "Rotterdam e.o.", utrecht: "Utrecht e.o.", amsterdam: "Amsterdam e.o.",
    denhaag: "Den Haag e.o.", remote: "Remote", overig: "Overig NL" };
  function regionOf(j) {
    const loc = j.location || "";
    for (const [key, re] of REGIONS) if (re.test(loc)) return key;
    return j.remote ? "remote" : "overig";
  }
  function matchesQuery(j, q) {
    if (!q) return true;
    const hay = `${j.title} ${j.company} ${j.location} ${(j.skills || []).join(" ")} ${j.full_text}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
  }
  // f = filterstand (standaard de huidige); zo kunnen de chips tellen hoeveel er per categorie zijn.
  function filtered({ includeDone = false, deck = false, f = F } = {}) {
    return jobs.filter((j) => {
      if (!includeDone && status[j.id] && status[j.id].s !== "saved") return false;
      if ((deck || f.top) && !isVisible(j)) return false;
      if (notJunior(j)) return false;
      if (f.few && !fewApplicants(j)) return false;
      if (f.locs.length && !f.locs.includes(regionOf(j))) return false;
      return CATS[f.cat](j) && matchesQuery(j, f.q);
    }).sort(deck || sortBy === "match" ? (a, b) => rank(b) - rank(a) : (a, b) => hoursOld(a) - hoursOld(b));
  }

  function renderFilters() {
    const deck = store.get("view", "list") === "swipe";
    const count = (patch) => filtered({ includeDone: !deck, deck, f: Object.assign({}, F, patch) }).length;
    document.querySelectorAll("#filters .chip:not(.reset)").forEach((c) => {
      const k = c.dataset.f;
      if (!c.dataset.label) c.dataset.label = c.textContent;
      const on = k in CATS ? F.cat === k : F[k];
      c.classList.toggle("on", !!on);
      const n = k in CATS ? count({ cat: k }) : count({ [k]: true });
      c.textContent = `${c.dataset.label} (${n})`;
    });
    // Locatiechips: aan/uit per regio, met aantallen.
    const locChips = Object.keys(LOC_LABELS).map((k) => {
      const n = count({ locs: [k] });
      return `<button class="chip loc${F.locs.includes(k) ? " on" : ""}" data-l="${k}">${LOC_LABELS[k]} (${n})</button>`;
    });
    $("#locs").innerHTML = `<span class="row-label">Locatie</span>` +
      `<button class="chip loc mine${isMyRegion(F.locs) ? " on" : ""}" data-l="mine">📍 Mijn regio (${count({ locs: DEFAULT_LOCS })})</button>` +
      `<button class="chip loc${F.locs.length ? "" : " on"}" data-l="*">Overal (${count({ locs: [] })})</button>` + locChips.join("");
    const defaultLocs = isMyRegion(F.locs);
    const active = F.cat !== "all" || F.top || F.few || F.q || !defaultLocs;
    $("#f-reset").hidden = !active;
    if ($("#q").value !== F.q) $("#q").value = F.q;
  }
  function setFilter(patch) {
    Object.assign(F, patch);
    store.set("filters", F);
    render();
  }

  // ---------- kaarten ----------
  function cardHtml(j) {
    const m = j.match;
    const sc = m ? m.score : null;
    const cls = sc == null ? "" : sc >= 75 ? "hi" : sc >= 55 ? "mid" : "lo";
    const badges = [
      sc != null ? `<span class="b score ${cls}">${sc}% match${m.ai ? "" : " (lokaal)"}</span>` : "",
      isNewSinceVisit(j) ? `<span class="b new">nieuw</span>` : "",
      j.applicants != null ? `<span class="b ${fewApplicants(j) ? "hi" : j.applicants > 100 ? "lo" : "mid"}">${j.applicants} sollicitanten</span>` : "",
      j.traineeship ? `<span class="b tr">Traineeship</span>` : "",
      j.linkedin && j.publisher !== "LinkedIn" ? `<span class="b tr">LinkedIn</span>` : "",
      m && m.check ? `<span class="b mid">controleren</span>` : "",
      `<span class="b">${esc(ago(j))}</span>`,
      `<span class="b">${esc(j.publisher && j.publisher !== j.source ? j.publisher + " via " + j.source : j.source)}</span>`,
    ].join("");
    const benefits = (j.benefits || []).map((b) => `<span class="b">${esc(b)}</span>`).join("");
    const ignored = m && m.ignored_unrealistic && m.ignored_unrealistic.length
      ? `<div class="ignored">Genegeerd (onrealistisch): ${m.ignored_unrealistic.map((x) => `<s>${esc(x)}</s>`).join(", ")}</div>` : "";
    return `
      <h3><a class="jlink" href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener">${esc(j.title)} <span aria-hidden="true">↗</span></a></h3>
      <div class="co">${esc(j.company)} · ${esc(j.location || "")}${j.salary ? " · " + esc(j.salary) : ""}</div>
      <div class="badges">${badges}</div>
      ${m && m.reason ? `<p class="reason">${esc(m.reason)}</p>` : ""}
      <p class="desc">${esc(j.short_desc)}</p>
      ${benefits ? `<div class="badges">${benefits}</div>` : ""}
      ${m && m.matched_skills && m.matched_skills.length ? `<div class="ignored">Past: ${esc(m.matched_skills.join(", "))}</div>` : ""}
      ${ignored}`;
  }

  // Kaart vult de ruimte tussen filters en knoppen, op elk scherm.
  function sizeDeck() {
    const deck = $("#deck");
    if (!deck.offsetParent) return;
    const top = deck.getBoundingClientRect().top;
    const below = $(".swipe-actions").offsetHeight + ($(".hint").offsetHeight || 0) + $("#tabs").offsetHeight + 28;
    deck.style.height = Math.max(280, Math.min(680, innerHeight - top - below)) + "px";
  }
  addEventListener("resize", sizeDeck);
  function renderDeck() {
    const deck = $("#deck");
    requestAnimationFrame(sizeDeck);
    const list = filtered({ deck: true });
    deck.innerHTML = "";
    if (!list.length) {
      deck.innerHTML = `<div class="empty">Alles gezien in deze selectie.<br>Bekijk alle vacatures in de <a href="#" id="to-list">lijst</a>.</div>`;
      $("#to-list").onclick = (e) => { e.preventDefault(); show("list"); };
      return;
    }
    list.slice(0, 2).reverse().forEach((j, i, arr) => {
      const el = document.createElement("article");
      el.className = "card" + (i < arr.length - 1 ? " behind" : "");
      el.innerHTML = `<div class="stamp yes">SOLLICITEER</div><div class="stamp no">SKIP</div>` + cardHtml(j);
      el.dataset.id = j.id;
      deck.appendChild(el);
    });
    attachSwipe(deck.lastElementChild);
  }

  function attachSwipe(el) {
    let x0 = null, y0 = 0, dx = 0;
    el.addEventListener("pointerdown", (e) => {
      if (e.target.closest("a,button")) return;
      x0 = e.clientX; y0 = e.clientY; dx = 0; el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      if (x0 === null) return;
      if (pulling) { x0 = null; el.classList.remove("dragging"); el.style.transform = ""; return; }  // omlaag trekken = verversen, geen swipe
      dx = e.clientX - x0;
      if (Math.abs(dx) < 8 && Math.abs(e.clientY - y0) > 8) return;
      if (Math.abs(dx) > 8) el.setPointerCapture(e.pointerId);
      el.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
      $(".stamp.yes", el).style.opacity = Math.max(0, dx / 100);
      $(".stamp.no", el).style.opacity = Math.max(0, -dx / 100);
    });
    const end = () => {
      if (x0 === null) return;
      x0 = null; el.classList.remove("dragging");
      if (dx > 100) decide("yes");
      else if (dx < -100) decide("no");
      else { el.style.transform = ""; el.querySelectorAll(".stamp").forEach((s) => (s.style.opacity = 0)); }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  function decide(kind) {
    const top = $("#deck").lastElementChild;
    if (!top || !top.dataset.id) return;
    const job = jobs.find((j) => j.id === top.dataset.id);
    const dir = kind === "no" ? -1 : 1;
    top.style.transform = `translateX(${dir * 600}px) rotate(${dir * 30}deg)`;
    top.style.opacity = 0;
    if (kind === "no") { setStatus(job, "skip"); toast("Overgeslagen"); }
    if (kind === "save") { setStatus(job, "saved"); toast("Bewaard in tracker"); }
    setTimeout(() => {
      renderDeck();
      if (kind === "yes") openSheet(job);
    }, 220);
  }

  function renderList() {
    const list = filtered({ includeDone: true });
    const fresh = list.filter(isNewSinceVisit).length;
    $("#list").innerHTML = `<div class="list-head"><span class="muted">${list.length} vacatures${fresh ? ` · <b>${fresh} nieuw</b> sinds je laatste bezoek` : ""}</span>
      <button class="chip" id="sort">${sortBy === "new" ? "Nieuwste eerst" : "Beste match eerst"} ⇅</button></div>` +
      (list.length ? "" : `<div class="empty">Geen vacatures in deze selectie.</div>`);
    $("#sort").onclick = () => { sortBy = sortBy === "new" ? "match" : "new"; store.set("sort", sortBy); renderList(); };
    list.forEach((j) => {
      const el = document.createElement("article");
      el.className = "card" + (status[j.id]?.s === "skip" ? " done" : "");
      const st = status[j.id] ? `<span class="b">${{ skip: "overgeslagen", saved: "bewaard", applied: "gesolliciteerd" }[status[j.id].s]}</span>` : "";
      el.innerHTML = cardHtml(j) + `<div class="card-actions">
        <button class="btn primary" data-a="letter">Brief maken</button>
        <a class="btn" href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener">Vacature</a>
        ${st}</div>`;
      $("[data-a=letter]", el).onclick = () => openSheet(j);
      $("#list").appendChild(el);
    });
  }

  function renderTracker() {
    const rows = Object.entries(status).filter(([, v]) => v.s !== "skip").sort((a, b) => b[1].at.localeCompare(a[1].at));
    const label = { saved: "bewaard", applied: "gesolliciteerd" };
    $("#tracker").innerHTML = rows.length ? rows.map(([, v]) => `
      <div class="trow"><div><a href="${esc(safeUrl(v.url))}" target="_blank" rel="noopener">${esc(v.title)}</a><div class="muted">${esc(v.company)}</div></div>
      <div class="st">${label[v.s]}<div class="muted">${new Date(v.at).toLocaleDateString("nl-NL")}</div></div></div>`).join("")
      : `<div class="empty">Nog niets gesolliciteerd of bewaard.</div>`;
  }

  function exportCsv() {
    const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const lines = [["datum", "status", "functie", "bedrijf", "url"].join(",")];
    Object.values(status).filter((v) => v.s !== "skip").forEach((v) => lines.push([v.at.slice(0, 10), v.s, v.title, v.company, v.url].map(q).join(",")));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `jts-sollicitaties-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  // ---------- brief-sheet ----------
  function closeSheet() {
    $("#sheet").classList.remove("on"); $("#sheet-bg").classList.remove("on");
    render();
  }

  async function openSheet(job, extraKeywords) {
    const sheet = $("#sheet");
    $("#sheet-bg").classList.add("on"); sheet.classList.add("on");
    const head = `<h3>${esc(job.title)}</h3><div class="muted">${esc(job.company)} · ${esc(job.location)}</div>`;
    if (!profile.cv || !profile.key) {
      sheet.innerHTML = head + `<p>Vul eerst je cv en Gemini API-key in bij Profiel.</p>
        <div class="card-actions"><button class="btn primary" id="go-prof">Naar profiel</button>
        <a class="btn" href="${esc(safeUrl(job.url))}" target="_blank" rel="noopener">Open vacature</a></div>`;
      $("#go-prof").onclick = () => { closeSheet(); show("profile"); };
      return;
    }
    let text = letters[job.id];
    if (!text || extraKeywords) {
      sheet.innerHTML = head + `<p><span class="spinner"></span>Brief schrijven...</p>`;
      try {
        const res = await L.generate({ job, cv: profile.cv, profile, coreStory: profile.coreStory, coreStoryEn: profile.coreStoryEn,
          key: profile.key, model: profile.model || "gemini-flash-latest", extraKeywords });
        text = res.text;
        letters[job.id] = text; store.set("letters", letters);
      } catch (e) {
        sheet.innerHTML = head + `<p class="issues">Fout bij genereren: ${esc(e.message)}</p>
          <div class="card-actions"><button class="btn" id="retry">Opnieuw</button><button class="btn" id="close">Sluiten</button></div>`;
        $("#retry").onclick = () => openSheet(job);
        $("#close").onclick = closeSheet;
        return;
      }
    }
    renderSheet(job, text);
  }

  function renderSheet(job, text) {
    const sheet = $("#sheet");
    const jobKeywords = (job.skills || []).filter((s) => s !== "Engels" && s !== "Nederlands");
    const cov = L.coverage({ jobKeywords, cv: profile.cv, letter: text }, findSkills);
    const fixable = cov.filter((c) => !c.inLetter && c.inCv).map((c) => c.keyword);
    const tips = cov.filter((c) => !c.inCv).map((c) => c.keyword);
    const issues = L.problems(text);
    sheet.innerHTML = `
      <h3>${esc(job.title)}</h3><div class="muted">${esc(job.company)} · ${esc(job.location)}</div>
      <textarea id="letter">${esc(text)}</textarea>
      <div class="muted"><span id="wc">${L.wordCount(text)}</span> woorden ${issues.length ? `<span class="issues">· ${esc(issues.join(", "))}</span>` : "· ATS-clean"}</div>
      ${cov.length ? `<div class="muted" style="margin-top:10px">Keyword-dekking (groen = in brief, oranje = in cv maar niet in brief, doorgestreept = niet in cv)</div>
      <div class="cov">${cov.map((c) => `<span class="b ${c.inLetter ? "ok" : c.inCv ? "cv" : "no"}">${esc(c.keyword)}</span>`).join("")}</div>` : ""}
      ${tips.length ? `<div class="muted">Tip: beheers je ${esc(tips.slice(0, 5).join(", "))}? Zet het dan in je cv en LinkedIn-profiel.</div>` : ""}
      <div class="card-actions">
        <button class="btn primary" id="copy">Kopieer brief</button>
        <a class="btn" id="open" href="${esc(safeUrl(job.url))}" target="_blank" rel="noopener">Open vacature</a>
        ${fixable.length ? `<button class="btn" id="fix">Verwerk ontbrekende (${fixable.length})</button>` : ""}
        <button class="btn" id="regen">Nieuwe versie</button>
      </div>
      <div class="card-actions">
        <button class="btn good" id="applied">${status[job.id]?.s === "applied" ? "Gesolliciteerd ✓" : "Markeer als gesolliciteerd"}</button>
        <button class="btn" id="close">Sluiten</button>
      </div>`;
    const ta = $("#letter");
    ta.oninput = () => {
      letters[job.id] = ta.value; store.set("letters", letters);
      $("#wc").textContent = L.wordCount(ta.value);
    };
    $("#copy").onclick = async () => {
      const clean = L.sanitize(ta.value);
      try { await navigator.clipboard.writeText(clean); }
      catch { ta.value = clean; ta.select(); document.execCommand("copy"); }
      toast("Brief gekopieerd");
    };
    $("#open").onclick = () => { if (!status[job.id]) setStatus(job, "saved"); };
    if (fixable.length) $("#fix").onclick = () => openSheet(job, fixable);
    $("#regen").onclick = () => { delete letters[job.id]; openSheet(job); };
    $("#applied").onclick = () => { setStatus(job, "applied"); toast("Opgeslagen in tracker"); closeSheet(); };
    $("#close").onclick = closeSheet;
  }

  // ---------- profiel ----------
  if (!profile.ghRepo && location.hostname.endsWith(".github.io")) {
    profile.ghRepo = `${location.hostname.split(".")[0]}/${location.pathname.split("/")[1] || ""}`.replace(/\/$/, "");
  }
  function fillProfile() {
    const f = $("#profile");
    for (const k of ["name", "email", "phone", "cv", "coreStory", "coreStoryEn", "key", "model", "ghRepo", "ghToken", "ghBranch"]) f.elements[k].value = profile[k] || "";
    f.elements.minScore.value = profile.minScore ?? "";
  }
  function saveProfile(msg) {
    const f = $("#profile");
    for (const k of ["name", "email", "phone", "cv", "coreStory", "coreStoryEn", "key", "model", "ghRepo", "ghToken", "ghBranch"]) profile[k] = f.elements[k].value.trim();
    profile.minScore = f.elements.minScore.value === "" ? null : Number(f.elements.minScore.value);
    store.set("profile", profile);
    $("#profile-msg").textContent = msg;
  }
  $("#profile").onsubmit = (e) => { e.preventDefault(); saveProfile("Opgeslagen ✓"); toast("Profiel opgeslagen"); };
  let saveTimer;
  $("#profile").oninput = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveProfile("Automatisch opgeslagen ✓"), 600); };

  // ---------- blijvend bewaren ----------
  async function checkStorage() {
    const el = $("#storage-status");
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    let persisted = false;
    try { persisted = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false; } catch { /* niet ondersteund */ }
    const has = !!(profile.cv || profile.key);
    el.innerHTML = [
      has ? "✓ Je profiel staat op dit apparaat en blijft bewaard als je JTS opnieuw opent." : "Nog geen profiel op dit apparaat.",
      persisted ? "✓ De browser bewaart het blijvend." : "",
      !standalone && /iPhone|iPad/.test(navigator.userAgent)
        ? "Tip voor iPhone: Safari wist websitegegevens na 7 dagen zonder bezoek. Zet JTS op je beginscherm (Deel → Zet op beginscherm) en vul je gegevens daar één keer in. De beginscherm-app heeft zijn eigen opslag, los van Safari, en die blijft staan." : "",
    ].filter(Boolean).join("<br>");
  }

  // ---------- overzetten naar ander apparaat (versleutelde link, geen server) ----------
  const b64u = {
    enc: (bytes) => { let s = ""; bytes.forEach((b) => (s += String.fromCharCode(b))); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
    dec: (str) => Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
  };
  async function deriveKey(code, salt) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function makeTransfer(code) {
    const payload = new TextEncoder().encode(JSON.stringify({ v: 1, profile, filters: F, status }));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deriveKey(code, salt), payload));
    const all = new Uint8Array(28 + ct.length);
    all.set(salt); all.set(iv, 16); all.set(ct, 28);
    return `${location.origin}${location.pathname}#import=${b64u.enc(all)}`;
  }
  async function applyTransfer(blob, code) {
    const all = b64u.dec(blob);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(16, 28) }, await deriveKey(code, all.slice(0, 16)), all.slice(28));
    const data = JSON.parse(new TextDecoder().decode(plain));
    Object.assign(profile, data.profile); store.set("profile", profile);
    if (data.filters) { Object.assign(F, data.filters); store.set("filters", F); }
    if (data.status) { Object.assign(status, data.status); store.set("status", status); }
    fillProfile(); checkStorage(); render();
  }
  let xferLink = "";
  $("#xfer-make").onclick = async () => {
    const code = $("#xfer-code").value;
    if (code.length < 6) return toast("Kies een code van minimaal 6 tekens");
    saveProfile("Opgeslagen ✓");
    xferLink = await makeTransfer(code);
    $("#xfer-share").hidden = !navigator.share; $("#xfer-copy").hidden = false;
    $("#xfer-msg").textContent = "Link gemaakt. Stuur hem naar je andere apparaat (bijv. AirDrop of mail aan jezelf), open hem daar en vul dezelfde code in. Deel de link en de code niet met anderen.";
  };
  $("#xfer-share").onclick = () => navigator.share({ title: "JTS overzetlink", url: xferLink }).catch(() => {});
  $("#xfer-copy").onclick = async () => { try { await navigator.clipboard.writeText(xferLink); toast("Link gekopieerd"); } catch { prompt("Kopieer de link:", xferLink); } };
  async function importFrom(link) {
    const m = String(link).match(/#import=([A-Za-z0-9_-]+)/);
    if (!m) return toast("Dit is geen geldige overzetlink");
    const code = prompt("Vul de code in die je bij het maken van de overzetlink koos:");
    if (!code) return;
    try { await applyTransfer(m[1], code); toast("Gegevens overgezet ✓"); show("list"); }
    catch { toast("Verkeerde code of beschadigde link"); }
  }
  $("#xfer-import").onclick = () => importFrom($("#xfer-paste").value);
  if (location.hash.startsWith("#import=")) {
    const link = location.href;
    history.replaceState(null, "", location.pathname);   // link niet in de adresbalk laten staan
    setTimeout(() => importFrom(link), 300);
  }
  $("#cv-file").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ta = $("#profile").elements.cv;
    if (file.type !== "application/pdf") { ta.value = await file.text(); return; }
    if (!window.pdfjsLib) { toast("PDF-lezer niet geladen, plak de tekst"); return; }
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let out = "";
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await (await pdf.getPage(p)).getTextContent();
      let lastY = null;
      for (const it of page.items) {
        const y = it.transform[5];
        out += lastY !== null && Math.abs(y - lastY) > 2 ? "\n" : " ";
        out += it.str; lastY = y;
      }
      out += "\n\n";
    }
    ta.value = out.replace(/[ \t]+/g, " ").replace(/\n /g, "\n").trim();
    toast("Cv ingelezen, controleer en klik Opslaan");
  };

  // ---------- navigatie ----------
  function show(v) {
    document.querySelectorAll(".view").forEach((s) => s.classList.toggle("on", s.id === "view-" + v));
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    $("#filterbar").style.display = v === "swipe" || v === "list" ? "" : "none";
    store.set("view", v);
    render();
  }
  function render() {
    const v = store.get("view", "list");
    if (v === "swipe" || v === "list") renderFilters();
    if (v === "swipe") renderDeck();
    if (v === "list") renderList();
    if (v === "tracker") renderTracker();
  }
  $("#tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.v); };
  $("#filters").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const k = b.dataset.f;
    if (k === "reset") setFilter({ cat: "all", top: false, few: false, q: "", locs: [...DEFAULT_LOCS] });
    else if (k === "all") setFilter({ cat: "all", top: false, few: false, q: "" });
    else if (k in CATS) setFilter({ cat: F.cat === k ? "all" : k });
    else setFilter({ [k]: !F[k] });
  };
  $("#locs").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const l = b.dataset.l;
    if (l === "*") return setFilter({ locs: [] });
    if (l === "mine") return setFilter({ locs: [...DEFAULT_LOCS] });
    setFilter({ locs: F.locs.includes(l) ? F.locs.filter((x) => x !== l) : [...F.locs, l] });
  };
  let qTimer;
  $("#q").oninput = (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => setFilter({ q: e.target.value.trim() }), 200); };
  $("#btn-refresh").onclick = refreshNow;
  $("#btn-no").onclick = () => decide("no");
  $("#btn-yes").onclick = () => decide("yes");
  $("#btn-save").onclick = () => decide("save");
  $("#btn-csv").onclick = exportCsv;
  $("#sheet-bg").onclick = closeSheet;
  document.addEventListener("keydown", (e) => {
    if ($("#sheet").classList.contains("on") || e.target.matches("input,textarea")) return;
    if (store.get("view", "list") !== "swipe") return;
    if (e.key === "ArrowLeft") decide("no");
    if (e.key === "ArrowRight") decide("yes");
  });

  if ("serviceWorker" in navigator) {
    // Nieuwe versie van de app? Dan één keer herladen zodat je nooit een oude versie blijft zien.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {});
  }
  fillProfile();
  checkStorage();
  updateMeta();
  show(store.get("view", "list"));   // toont direct de lokale kopie
  load();
  // Automatisch verversen: elke 5 min, en meteen als je de app weer opent.
  setInterval(() => { load({ quiet: true }); }, 5 * 6e4);
  setInterval(() => updateMeta(), 3e4);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") markSeen();
    else if (Date.now() - lastLoad > 6e4) load({ quiet: true });
  });
  window.addEventListener("pagehide", markSeen);
})();
