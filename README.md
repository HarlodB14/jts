# JTS - Job Tracking System

Jij bent de ATS. JTS haalt elk uur junior IT-vacatures en traineeships op, checkt ze tegen je cv en maakt met één swipe een ATS-clean motivatiebrief in B2-Nederlands.

- **Scraper** (`scraper/fetch_jobs.py`):
  - **LinkedIn via Apify**: de [LinkedIn Jobs Scraper](https://apify.com/curious_coder/linkedin-jobs-scraper) draait op de servers van Apify, zonder jouw account. Hij geeft ook het aantal sollicitanten.
  - **JSearch**: Google for Jobs, met daarin vacatures van LinkedIn, Indeed en Glassdoor.
  - Verder Adzuna, Jooble, Careerjet, Arbeitnow, Remotive en Himalayas.
  - Dit script benadert linkedin.com zelf nooit (hard geblokkeerd in de code).
- **Matching** (`scraper/match.py`): Gemini beoordeelt elke nieuwe vacature tegen je cv, negeert onrealistische eisen en geeft een score van 0 tot 100. Een lokale skills-check vangt rare AI-scores af.
- **App** (`docs/`): een PWA op GitHub Pages met swipe, lijst, tracker en profiel. Je cv en API-key blijven in de browser op je eigen apparaat.

## Setup (eenmalig, ~15 minuten)

1. **Gratis keys aanmaken**
   - Gemini: https://aistudio.google.com/apikey
   - Apify (LinkedIn): maak een account op https://apify.com en kopieer je API-token via Settings → API & Integrations. Het gratis plan geeft $5 tegoed per maand, genoeg voor ~4800 LinkedIn-vacatures.
   - JSearch: https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch, gratis plan (200 requests per maand).
   - Adzuna: https://developer.adzuna.com (app_id + app_key)
   - Jooble: https://jooble.org/api/about
   - Careerjet: https://www.careerjet.nl/partners (affiliate-id)

   Alleen Gemini is verplicht. **Zonder Apify en de NL-keys krijg je bijna geen Nederlandse vacatures**, want de bronnen zonder key zijn internationaal.
2. **Repo op GitHub zetten.** Maak een nieuwe repo `jts` en push deze map:
   ```bash
   git init && git add . && git commit -m "JTS" && git branch -M main
   git remote add origin https://github.com/<jouw-naam>/jts.git && git push -u origin main
   ```
3. **Secrets instellen.** Ga naar Settings → Secrets and variables → Actions en voeg toe:
   - `GEMINI_API_KEY`
   - `APIFY_TOKEN`
   - `JSEARCH_KEY`
   - `CV_TEXT` (de platte tekst van je cv)
   - `ADZUNA_APP_ID`
   - `ADZUNA_APP_KEY`
   - `JOOBLE_KEY`
   - `CAREERJET_AFFID`
4. **Pages aanzetten.** Ga naar Settings → Pages, kies Source: *Deploy from a branch*, branch `main`, map `/docs`.
5. **Eerste run starten.** Ga naar Actions → *JTS vacatures ophalen* → *Run workflow*.
6. **App openen.** Open `https://<jouw-naam>.github.io/jts/` op je telefoon en kies *Zet op beginscherm*. Vul bij **Profiel** je gegevens, je cv en je Gemini-key in.

## Gebruik
- **Vacatures** (hoofdscherm): alle vacatures van de afgelopen 7 dagen, nieuwste bovenaan. Je kunt omzetten naar beste match eerst. Wat je nog niet gezien hebt, krijgt het label *nieuw*. Klik op de titel ↗ om de vacature te openen.
- **Zoeken en filters**: het zoekveld zoekt in titel, bedrijf, plaats, skills en vacaturetekst. De filters zijn Traineeships, NL, Remote, ≤ 25 sollicitanten (alleen LinkedIn) en Alleen top-match. Het getal op elke filter is het aantal vacatures. *Alles* of *✕ Wis filters* zet alles terug.
  - Let op: filters en zoeken werken op de vacatures die al opgehaald zijn. Ze starten geen nieuwe zoekopdracht.
- **Verversen**:
  - De app haalt elke 5 minuten zelf nieuwe data op, en ook meteen als je de app weer opent. Nieuwe vacatures worden toegevoegd, oude blijven 7 dagen staan, ook als ze uit de bron verdwijnen. Offline zie je de laatst opgehaalde lijst.
  - **Trek omlaag** (bovenaan de lijst of op de swipe-kaart) of tik op **↻**: haalt direct de nieuwste lijst op.
  - Zonder GitHub-token ververst dit alleen de lijst (de scraper zelf draait elk uur).
  - **↻ met GitHub-token**: als je bij Profiel een repo en token invult, start ↻ de scraper direct. De app wacht dan tot de nieuwe vacatures binnen zijn (±2 min) en leest ze rechtstreeks uit je repo, zonder de ~10 minuten cache van GitHub Pages.
  - Het token maak je via GitHub → Settings → Developer settings → Fine-grained tokens, met alleen toegang tot je JTS-repo: *Actions: Read and write* en *Contents: Read-only*.
  - Het token blijft alleen op je eigen apparaat.
- **Swipe rechts** (of ✓ / pijltje rechts): de brief wordt gemaakt. Daarna *Kopieer brief* → *Open vacature* → plakken en zelf versturen → *Markeer als gesolliciteerd*.
- **Swipe links**: overslaan. **☆**: bewaren in de tracker.
- **Keyword-dekking**: groen staat al in je brief. Oranje staat in je cv maar nog niet in je brief, en met *Verwerk ontbrekende* komt het erin. Doorgestreept staat niet in je cv.

## Lokaal bekijken
```bash
python3 -m http.server 8766 --directory docs
```
Open daarna http://localhost:8766. Lokaal staan er pas vacatures in als je `python scraper/fetch_jobs.py` hebt gedraaid met je keys als omgevingsvariabelen.

## Aanpassen
- Zoektermen, filters, drempels en het Gemini-model staan in `scraper/config.yaml`. Daar staan ook de LinkedIn-zoek-URL's, hoe vaak Apify draait en welke actor het is. Een andere Apify LinkedIn-scraper kun je daar invullen, maar controleer dan of de velden nog kloppen in `src_linkedin_apify`.
- Skills staan in `docs/skills.txt`.
- De brief-regels en het standaard kernverhaal staan in `docs/letter.js`. Het kernverhaal kun je ook aanpassen in Profiel.

## Privacy
`docs/jobs.json` is publiek. Het bevat alleen vacaturedata, scores, gematchte skill-namen en een korte algemene reden, en nooit je cv-tekst. Je cv staat alleen in de GitHub-secret en in de localStorage van je browser.
