// JTS brief-generator: prompt, Gemini-call, sanitizer en keyword-dekking.
(function (root) {
  // Kernverhaal uit het cv-profiel. Komt in elke brief terug, telkens in andere woorden.
  // Overschrijfbaar via het profiel-scherm.
  const CORE_STORY =
    "Ik ben begonnen op het vmbo en heb daarna drie mbo-opleidingen gehaald, alle drie versneld. " +
    "Daarna heb ik de hbo-bachelor Informatica (Software Engineering) aan Avans afgerond. " +
    "Die stapeling vroeg discipline, doorzettingsvermogen en een vaste manier van werken. " +
    "Tijdens mijn afstudeerstage bij Guerrilla werkte ik voor het eerst in een grote AAA-codebase zonder eerdere game-ervaring. " +
    "Bij CBYTE bouw ik software voor klanten en zit ik ook bij klantgesprekken, urenschattingen en support. " +
    "Ik leer snel en praat makkelijk met klanten en collega's. Ik wil groeien als developer-consultant die klanten adviseert en de oplossing zelf mee bouwt.";
  const CORE_STORY_EN =
    "I started in pre-vocational school and then earned three vocational (MBO) diplomas, all fast-tracked, " +
    "followed by a Bachelor's in Computer Science (Software Engineering) at Avans. " +
    "That path took discipline, persistence and a structured way of working. " +
    "During my graduation internship at Guerrilla I worked in a large AAA codebase for the first time, without prior game dev experience. " +
    "At CBYTE I build software for clients and join client meetings, effort estimates and support. " +
    "I learn fast and communicate easily, and I want to grow as a developer consultant who advises clients and builds the solution.";

  const BANNED_PHRASES = [
    "gepassioneerd", "passie voor", "dynamische omgeving", "ik ben ervan overtuigd",
    "met veel enthousiasme", "uitdagende omgeving", "naadloos", "in de snel veranderende",
    "ik zou graag mijn", "hierbij solliciteer ik", "bovendien", "daarnaast",
    "passionate", "dynamic environment", "i am confident", "seamless", "fast-paced",
    "i am writing to", "furthermore", "moreover",
  ];
  const MAX_WORDS = 250;   // halve A4
  const MIN_WORDS = 170;
  const DEFAULT_MODEL = "gemini-3.5-flash";

  function buildPrompt({ job, cv, profile, coreStory, coreStoryEn, extraKeywords }) {
    const en = job.lang === "en";
    const lines = [
      `Schrijf een complete, unieke motivatiebrief voor de vacature hieronder. Taal: ${en ? "Engels" : "Nederlands"} op B2-niveau.`,
      `De brief moet zo specifiek zijn dat hij alleen voor ${job.company} en de functie ${job.title} kan gelden.`,
      "",
      "VASTE REGELS (strikt):",
      `- Tussen ${MIN_WORDS} en ${MAX_WORDS} woorden (een halve A4). Platte tekst. Geen kopjes, opsommingstekens, tabellen, emoji of markdown.`,
      `- Opbouw: aanhef (bijv. "Beste team van ${job.company},"), precies drie alinea's, afsluiting met naam.`,
      `- Alinea 1 (motivatie): waarom je bij ${job.company} als ${job.title} wilt werken. Noem minstens twee concrete dingen uit de vacaturetekst (product, klanten, team, taken of technologie) en zeg wat je daaraan aanspreekt. Begin NIET met het kernverhaal.`,
      "- Alinea 2 (rode draad): verwerk het kernverhaal hieronder in eigen woorden. Laat zien hoe de stapeling van vmbo via drie versnelde mbo's naar hbo Informatica bewijst dat je een gedisciplineerde engineer bent, en koppel dat aan wat DEZE vacature vraagt. Niet letterlijk kopiëren, elke brief anders formuleren.",
      "- Alinea 3 (bewijs): twee of drie concrete ervaringen of skills uit het cv die direct aansluiten op de eisen van de vacature, met een korte zin waarom dat helpt in deze rol. Sluit af met een zin over een gesprek.",
      "- Korte zinnen. Gewone woorden. Geen jargon-stapels.",
      "- Gebruik NOOIT: gedachtestreepjes (— of –), puntkomma's, uitroeptekens, of een dubbele punt midden in een zin.",
      `- Vermijd deze woorden en clichés: ${BANNED_PHRASES.join(", ")}.`,
      "- Neem belangrijke vakwoorden uit de vacature letterlijk over, maar ALLEEN als ze echt in het cv staan. Verzin geen ervaring.",
      "- Geen onderwerpregel, geen datum, geen adresblok.",
      "",
      "KERNVERHAAL (rode draad, verplicht in elke brief):",
      en ? (coreStoryEn || CORE_STORY_EN) : (coreStory || CORE_STORY),
      "",
      "CV:",
      cv.slice(0, 8000),
      "",
      `VACATURE: ${job.title} bij ${job.company} (${job.location})`,
      job.full_text.slice(0, 5000),
    ];
    if (extraKeywords && extraKeywords.length) {
      lines.push("", `Verwerk deze vakwoorden die in het cv staan zeker in de brief: ${extraKeywords.join(", ")}.`);
    }
    lines.push("", `Sluit af met: ${en ? "Kind regards" : "Met vriendelijke groet"}, ${profile.name || "[naam]"}`);
    if (profile.email || profile.phone) {
      lines.push(`Zet daaronder op aparte regels: ${[profile.email, profile.phone].filter(Boolean).join(" en ")}`);
    }
    return lines.join("\n");
  }

  // Deterministische schoonmaak van AI-herkenbare tekens.
  function sanitize(text) {
    let t = text.replace(/\r/g, "");
    t = t.replace(/^```[a-z]*\n?|```$/gm, "");
    t = t.replace(/\*\*|__|^#+\s*/gm, "");
    t = t.replace(/^\s*[-*•·]\s+/gm, "");
    t = t.replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2");
    t = t.replace(/\s*[—–]\s*/g, ", ");
    t = t.replace(/\s+-\s+/g, ", ");
    t = t.replace(/;/g, ",");
    t = t.replace(/!/g, ".");
    t = t.replace(/([a-zÀ-ɏ]):\s+(?=[a-zÀ-ɏ])/g, "$1, ");
    t = t.replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'").replace(/…/g, "...");
    t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "");
    t = t.replace(/,\s*,/g, ",").replace(/,\s*\./g, ".");
    t = t.replace(/[ \t]+/g, " ").replace(/ +\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    return t.trim();
  }

  function wordCount(t) {
    return (t.match(/\S+/g) || []).length;
  }

  // job is optioneel: dan wordt ook gecontroleerd of de brief volledig en vacaturespecifiek is.
  function problems(t, job) {
    const out = [];
    const paras = t.split(/\n\s*\n/).filter((p) => wordCount(p) >= 25).length;
    if (wordCount(t) < MIN_WORDS - 30) out.push(`te kort (${wordCount(t)} woorden)`);
    if (paras < 3) out.push("minder dan drie volledige alinea's");
    if (job) {
      const low0 = t.toLowerCase();
      const company = String(job.company || "").toLowerCase().split(/[\s(,]/)[0];
      const titleWord = String(job.title || "").toLowerCase().replace(/junior|medior|\(.*?\)/g, "").trim().split(/\s+/)[0];
      if (company && company.length > 2 && !low0.includes(company) && titleWord && !low0.includes(titleWord)) out.push("noemt bedrijf en functie niet");
    }
    if (/[—–;!]/.test(t)) out.push("verboden leesteken");
    const low = t.toLowerCase();
    const hits = BANNED_PHRASES.filter((p) => low.includes(p));
    if (hits.length) out.push("cliché: " + hits.join(", "));
    if (wordCount(t) > MAX_WORDS + 20) out.push(`te lang (${wordCount(t)} woorden)`);
    return out;
  }

  const FALLBACK_MODEL = "gemini-flash-lite-latest";
  // Oude of trage modelkeuzes automatisch omzetten naar het snelle standaardmodel.
  const normalizeModel = (m) => (!m || m === "gemini-flash-latest" ? DEFAULT_MODEL : m);

  async function callGemini({ key, model, prompt }) {
    try {
      return await callModel({ key, model, prompt });
    } catch (e) {
      // Drukte of timeout bij het gekozen model: één keer terugvallen op het snelle lite-model.
      if (model !== FALLBACK_MODEL && /\b(404|429|500|503)\b|timeout|aborted|failed to fetch/i.test(e.message)) {
        return callModel({ key, model: FALLBACK_MODEL, prompt });
      }
      throw e;
    }
  }

  // Harde limiet over het hele verzoek (ook als het antwoord halverwege blijft hangen).
  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  }

  function callModel(opts) {
    return withTimeout(callModelRaw(opts), 35000);
  }

  async function callModelRaw({ key, model, prompt }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const generationConfig = { temperature: 0.8, maxOutputTokens: 3000 };
    // Minimaal denken: ~4 s per brief. "low" of hoger duurt bij drukte soms meer dan een minuut.
    if (!/lite/.test(model)) generationConfig.thinkingConfig = { thinkingLevel: "minimal" };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
  }

  async function generate(opts) {
    const prompt = buildPrompt(opts);
    const model = normalizeModel(opts.model);
    let text = sanitize(await callGemini({ key: opts.key, model, prompt }));
    let issues = problems(text, opts.job);
    // Onvolledig of fout? Maximaal twee keer opnieuw, met de fouten erbij als aanwijzing.
    for (let i = 0; i < 2 && issues.length; i++) {
      const retry = prompt + `\n\nLET OP: een eerdere versie was afgekeurd (${issues.join(", ")}). Schrijf de VOLLEDIGE brief opnieuw volgens alle regels.`;
      const again = sanitize(await callGemini({ key: opts.key, model: i ? FALLBACK_MODEL : model, prompt: retry }));
      const againIssues = problems(again, opts.job);
      if (againIssues.length <= issues.length) { text = again; issues = againIssues; }
    }
    return { text, issues, words: wordCount(text) };
  }

  // Keyword-dekking: welke vacature-kernwoorden staan in brief / cv.
  function coverage({ jobKeywords, cv, letter }, skillMatcher) {
    const cvSet = new Set(skillMatcher(cv));
    const letterSet = new Set(skillMatcher(letter));
    return jobKeywords.map((k) => ({
      keyword: k,
      inLetter: letterSet.has(k),
      inCv: cvSet.has(k),
    }));
  }

  const api = { CORE_STORY, CORE_STORY_EN, BANNED_PHRASES, MAX_WORDS, DEFAULT_MODEL, normalizeModel, buildPrompt, sanitize, problems, wordCount, generate, coverage };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.JTSLetter = api;
})(typeof window !== "undefined" ? window : globalThis);
