"""JTS - haalt junior IT-vacatures op uit gratis job-API's en schrijft docs/jobs.json.

Bronnen: Indeed + Glassdoor via JobSpy (zonder key), LinkedIn via Apify (scraper draait bij Apify, niet vanaf hier), JSearch (Google for Jobs:
LinkedIn/Indeed/Glassdoor), Adzuna, Jooble, Careerjet (keys via env), Arbeitnow, Remotive, Himalayas (zonder key).
Dit script benadert linkedin.com zelf nooit.
"""
import hashlib
import html
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
import yaml
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
CFG = yaml.safe_load((ROOT / "scraper" / "config.yaml").read_text())
OUT = ROOT / "docs" / "jobs.json"
SKILLS_FILE = ROOT / "docs" / "skills.txt"
UA = "Mozilla/5.0 (JTS personal job tracker)"
NOW = datetime.now(timezone.utc)
BLOCKED_HOSTS = ("linkedin.com",)
# Handmatige run met "alle bronnen": ook betaalde/beperkte bronnen buiten hun vaste uren.
FORCE_ALL = os.getenv("JTS_FORCE_ALL") == "true"

session = requests.Session()
session.headers["User-Agent"] = UA
request_log = []


def http(method, url, **kw):
    host = urlparse(url).hostname or ""
    if any(host.endswith(b) for b in BLOCKED_HOSTS):
        raise RuntimeError(f"Geblokkeerd: {host} wordt nooit gescraped")
    kw.setdefault("timeout", 25)
    request_log.append(f"{method} {host}")
    r = session.request(method, url, **kw)
    r.raise_for_status()
    time.sleep(CFG["requests_delay_s"])
    return r


# ---------- tekst-hulpjes ----------

def strip_html(s):
    if not s:
        return ""
    text = BeautifulSoup(html.unescape(s), "html.parser").get_text(" ")
    return re.sub(r"\s+", " ", text).strip()


def term_re(terms):
    parts = [re.escape(t.lower()) for t in sorted(terms, key=len, reverse=True)]
    return re.compile(r"(?<![a-z0-9])(" + "|".join(parts) + r")(?![a-z0-9#+])")


JUNIOR_RE = term_re(CFG["junior_terms"])
EXCLUDE_RE = term_re(CFG["exclude_title_terms"])
TRAINEE_RE = term_re(CFG["trainee_terms"])
IT_RE = term_re(CFG["it_terms"])
NL_RE = term_re(CFG["nl_locations"])
MEDIOR_RE = term_re(["medior"])
REMOTE_OK_RE = re.compile(r"netherlands|nederland|europe|\beu\b|emea|anywhere|worldwide|\bcet\b", re.I)
# Vacature zonder niveau in de titel valt af als de tekst om een ervaren kracht vraagt. De rest beoordeelt Gemini.
SENIOR_TEXT_RE = re.compile(r"\b(senior|medior|ervaren|experienced|seasoned|expert)\b", re.I)
YEARS_RE = re.compile(r"(?<![0-9])([3-9]|1[0-9])\+?\s*(?:jaar|years?|yrs)\b[^.]{0,40}(?:ervaring|experience)", re.I)

NL_STOP = {"de", "het", "een", "en", "van", "je", "wij", "jij", "voor", "met", "bij", "ons", "naar"}
EN_STOP = {"the", "and", "you", "we", "for", "with", "our", "your", "to", "of", "in"}

BENEFITS = {
    "Thuiswerken": r"thuiswerk|hybride|hybrid|remote|work from home",
    "Opleidingsbudget": r"opleidingsbudget|training budget|learning budget|cursussen|certificering|academy|opleidingen",
    "Leaseauto": r"lease ?auto|leaseauto|company car|lease car",
    "Pensioen": r"pensioen|pension",
    "32-36 uur": r"\b3[2-6] ?(?:uur|hours)\b|4[- ]daagse|four-day",
    "Laptop": r"laptop|macbook",
    "Bonus": r"bonus|winstdeling|profit sharing",
    "Reiskosten": r"reiskosten|ns[- ]business|travel allowance|ov-?kaart",
    "Vaste baan": r"vast contract|vaste aanstelling|permanent contract|onbepaalde tijd",
    "Coaching": r"coach|mentor|buddy",
    "Flexibele uren": r"flexibele (?:werk)?tijden|flexible hours",
}
BENEFIT_RES = {k: re.compile(v, re.I) for k, v in BENEFITS.items()}


def load_skills():
    skills = []
    for line in SKILLS_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        names = [n.strip() for n in line.split("|")]
        skills.append((names[0], term_re(names)))
    return skills


SKILLS = load_skills()


def find_skills(text):
    low = text.lower()
    return [name for name, rx in SKILLS if rx.search(low)]


def detect_lang(text):
    words = re.findall(r"[a-z]+", text.lower()[:2000])
    nl = sum(w in NL_STOP for w in words)
    en = sum(w in EN_STOP for w in words)
    return "nl" if nl >= en else "en"


def parse_date(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v, tz=timezone.utc)
    s = str(v).strip()
    for fmt in ("%a, %d %b %Y %H:%M:%S %Z", "%a, %d %b %Y %H:%M:%S %z"):
        try:
            d = datetime.strptime(s, fmt)
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def make_job(source, title, company, location, text, url, posted, remote=False, salary=None, tags=None,
             applicants=None, publisher=None):
    title = strip_html(title)
    text = strip_html(text)
    company = (company or "Onbekend").strip()
    location = (location or "").strip()
    key = re.sub(r"[^a-z0-9]", "", f"{company}{title}".lower())
    return {
        "id": hashlib.sha1(key.encode()).hexdigest()[:12],
        "source": source,
        "title": title,
        "company": company,
        "location": location or ("Remote" if remote else ""),
        "remote": bool(remote) or bool(re.search(r"remote|thuis", f"{location} {title}", re.I)),
        "posted_at": posted.isoformat() if posted else None,
        "url": url,
        "salary": salary,
        "tags": tags or [],
        "full_text": text[:6000],
        "applicants": applicants,
        "publisher": publisher or source,
    }


# ---------- bronnen ----------

def src_adzuna():
    app_id, key = os.getenv("ADZUNA_APP_ID"), os.getenv("ADZUNA_APP_KEY")
    if not (app_id and key):
        return []
    out = []
    for q in CFG["queries"]:
        r = http("GET", "https://api.adzuna.com/v1/api/jobs/nl/search/1", params={
            "app_id": app_id, "app_key": key, "what": q, "max_days_old": 3,
            "results_per_page": 50, "sort_by": "date", "content-type": "application/json"})
        for j in r.json().get("results", []):
            sal = None
            if j.get("salary_min"):
                sal = f"€{int(j['salary_min']):,}".replace(",", ".")
                if j.get("salary_max") and j["salary_max"] != j["salary_min"]:
                    sal += f" - €{int(j['salary_max']):,}".replace(",", ".")
            out.append(make_job("Adzuna", j.get("title"), (j.get("company") or {}).get("display_name"),
                                (j.get("location") or {}).get("display_name"), j.get("description"),
                                j.get("redirect_url"), parse_date(j.get("created")), salary=sal))
    return out


def src_jooble():
    key = os.getenv("JOOBLE_KEY")
    if not key:
        return []
    out = []
    for q in CFG["queries"]:
        r = http("POST", f"https://jooble.org/api/{key}", json={"keywords": q, "location": "Nederland"})
        for j in r.json().get("jobs", []):
            out.append(make_job("Jooble", j.get("title"), j.get("company"), j.get("location"), j.get("snippet"),
                                j.get("link"), parse_date(j.get("updated")), salary=j.get("salary") or None))
    return out


def src_careerjet():
    affid = os.getenv("CAREERJET_AFFID")
    if not affid:
        return []
    out = []
    for q in CFG["queries"]:
        r = http("GET", "http://public.api.careerjet.net/search", params={
            "locale_code": "nl_NL", "keywords": q, "affid": affid, "sort": "date", "pagesize": 50,
            "user_ip": "1.1.1.1", "user_agent": UA, "url": "https://github.com"},
            headers={"Referer": "https://github.com"})
        for j in r.json().get("jobs", []):
            out.append(make_job("Careerjet", j.get("title"), j.get("company"), j.get("locations"),
                                j.get("description"), j.get("url"), parse_date(j.get("date")),
                                salary=j.get("salary") or None))
    return out


def src_arbeitnow():
    out = []
    for page in (1, 2, 3):
        r = http("GET", "https://www.arbeitnow.com/api/job-board-api", params={"page": page})
        for j in r.json().get("data", []):
            out.append(make_job("Arbeitnow", j.get("title"), j.get("company_name"), j.get("location"),
                                j.get("description"), j.get("url"), parse_date(j.get("created_at")),
                                remote=j.get("remote"), tags=j.get("tags")))
    return out


def src_remotive():
    out = []
    for cat in ("software-dev", "data", "devops", "qa"):
        r = http("GET", "https://remotive.com/api/remote-jobs", params={"category": cat, "limit": 100})
        for j in r.json().get("jobs", []):
            loc = j.get("candidate_required_location") or ""
            if not re.search(r"worldwide|europe|emea|netherlands|anywhere|cet", loc, re.I):
                continue
            out.append(make_job("Remotive", j.get("title"), j.get("company_name"), f"Remote ({loc})",
                                j.get("description"), j.get("url"), parse_date(j.get("publication_date")),
                                remote=True, salary=j.get("salary") or None, tags=j.get("tags")))
    return out


def src_himalayas():
    out = []
    r = http("GET", "https://himalayas.app/jobs/api", params={"limit": 100})
    for j in r.json().get("jobs", []):
        locs = j.get("locationRestrictions") or []
        if locs and not any(re.search(r"netherlands|europe|worldwide", str(l), re.I) for l in locs):
            continue
        out.append(make_job("Himalayas", j.get("title"), j.get("companyName"),
                            "Remote" + (f" ({', '.join(map(str, locs))})" if locs else ""),
                            j.get("description"), j.get("applicationLink") or j.get("guid"),
                            parse_date(j.get("pubDate")), remote=True, tags=j.get("categories")))
    return out


def src_jobicy():
    out = []
    for geo in ("netherlands", "europe"):
        r = http("GET", "https://jobicy.com/api/v2/remote-jobs", params={"count": 100, "geo": geo})
        for j in r.json().get("jobs", []):
            out.append(make_job("Jobicy", j.get("jobTitle"), j.get("companyName"), f"Remote ({j.get('jobGeo')})",
                                j.get("jobDescription") or j.get("jobExcerpt"), j.get("url"),
                                parse_date(j.get("pubDate")), remote=True,
                                tags=[j.get("jobLevel")] + list(j.get("jobIndustry") or [])))
    return out


def src_jobspy():
    """Indeed en Glassdoor (NL) via de open-source JobSpy-scraper, zonder account of key."""
    js = CFG["jobspy"]
    try:
        from jobspy import scrape_jobs
    except ImportError:
        print("python-jobspy niet geïnstalleerd (vereist Python 3.10+), JobSpy overgeslagen", file=sys.stderr)
        return []
    sites = list(js["sites"])
    searches = [(q, "Netherlands", None) for q in js["queries"]]
    miles = round(js.get("city_distance_km", 25) / 1.609)
    searches += [(q, city, miles) for city in js.get("cities", []) for q in js.get("city_queries", [])]
    out = []
    for q, where, distance in searches:
        try:
            extra = {"distance": distance} if distance else {}
            df = scrape_jobs(site_name=sites, search_term=q, location=where, country_indeed="netherlands",
                             results_wanted=js["results_per_query"], hours_old=CFG["max_age_hours"],
                             description_format="html", verbose=0, **extra)
        except Exception as e:
            print(f"[jobspy] '{q}' in {where}: {e}", file=sys.stderr)
            continue
        request_log.append(f"JOBSPY {','.join(sites)}")
        for row in df.fillna("").to_dict("records"):
            sal = None
            if row.get("min_amount"):
                sal = f"€{int(row['min_amount'])}"
                if row.get("max_amount"):
                    sal += f" - €{int(row['max_amount'])}"
                if row.get("interval"):
                    per = {"yearly": "jaar", "monthly": "maand", "weekly": "week", "daily": "dag", "hourly": "uur"}
                    sal += f" per {per.get(row['interval'], row['interval'])}"
            posted = parse_date(str(row.get("date_posted") or ""))
            site = str(row.get("site") or "").capitalize()
            out.append(make_job("JobSpy", row.get("title"), row.get("company"), row.get("location"),
                                row.get("description"), row.get("job_url"), posted,
                                remote=bool(row.get("is_remote")), salary=sal,
                                tags=[row.get("job_level"), row.get("job_type")], publisher=site))
        time.sleep(CFG["requests_delay_s"])
    return out


def parse_applicants(v):
    m = re.search(r"\d+", str(v or ""))
    return int(m.group()) if m else None


def src_linkedin_apify():
    """LinkedIn-vacatures via een Apify-actor. Apify scrapet de publieke LinkedIn-pagina's op hun servers."""
    token = os.getenv("APIFY_TOKEN")
    li = CFG["linkedin_apify"]
    if not token or (NOW.hour % li["every_hours"] != 0 and not FORCE_ALL):
        return []
    actor = li["actor"].replace("/", "~")
    r = http("POST", f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items",
             headers={"Authorization": f"Bearer {token}"}, timeout=300,
             json={"urls": li["search_urls"], "limitPerSource": li["limit_per_search"], "scrapeCompany": False})
    out = []
    for j in r.json():
        posted = parse_date(j.get("postedAt") or j.get("postedAtTimestamp") and j["postedAtTimestamp"] / 1000)
        sal = " - ".join(map(str, j.get("salaryInfo") or [])) or None
        out.append(make_job("LinkedIn", j.get("title"), j.get("companyName"), j.get("location"),
                            j.get("descriptionText") or j.get("descriptionHtml"), j.get("link"), posted,
                            salary=sal, tags=[j.get("seniorityLevel"), j.get("industries")],
                            applicants=parse_applicants(j.get("applicantsCount")), publisher="LinkedIn"))
    return out


def src_jsearch():
    """Google for Jobs via JSearch (RapidAPI): bevat ook LinkedIn-, Indeed- en Glassdoor-vacatures."""
    key = os.getenv("JSEARCH_KEY")
    js = CFG["jsearch"]
    if not key or (NOW.hour % js["every_hours"] != 0 and not FORCE_ALL):
        return []
    q = js["queries"][(NOW.timetuple().tm_yday * 24 + NOW.hour) // js["every_hours"] % len(js["queries"])]
    r = http("GET", "https://jsearch.p.rapidapi.com/search",
             headers={"X-RapidAPI-Key": key, "X-RapidAPI-Host": "jsearch.p.rapidapi.com"},
             params={"query": q, "country": "nl", "date_posted": "3days", "num_pages": 1})
    out = []
    for j in r.json().get("data", []):
        links = {o.get("publisher"): o.get("apply_link") for o in j.get("apply_options") or []}
        url = links.get("LinkedIn") or j.get("job_apply_link")
        loc = ", ".join(x for x in (j.get("job_city"), j.get("job_country")) if x)
        sal = None
        if j.get("job_min_salary"):
            sal = f"{int(j['job_min_salary'])} - {int(j.get('job_max_salary') or j['job_min_salary'])} {j.get('job_salary_period') or ''}".strip()
        out.append(make_job("JSearch", j.get("job_title"), j.get("employer_name"), loc, j.get("job_description"),
                            url, parse_date(j.get("job_posted_at_datetime_utc")), remote=j.get("job_is_remote"),
                            salary=sal, publisher=j.get("job_publisher")))
    return out


SOURCES = [src_linkedin_apify, src_jsearch, src_jobspy, src_jobicy, src_adzuna, src_jooble, src_careerjet, src_arbeitnow, src_remotive, src_himalayas]


# ---------- filters en verrijking ----------

def classify(job):
    """Geeft (keep, reden) terug en zet categorie-velden."""
    title = job["title"].lower()
    text = job["full_text"].lower()
    if EXCLUDE_RE.search(title) or (MEDIOR_RE.search(title) and not JUNIOR_RE.search(title)):
        return False, "uitgesloten titel"
    if not IT_RE.search(title):
        return False, "geen IT"
    nl_source = job["source"] in ("Adzuna", "Jooble", "Careerjet", "LinkedIn", "JSearch", "JobSpy")
    is_nl = nl_source or bool(NL_RE.search(job["location"].lower()))
    remote_ok = job["remote"] and bool(REMOTE_OK_RE.search(job["location"]))
    if not (is_nl or remote_ok):
        return False, "buiten NL en niet remote"
    # Internationale bronnen: alleen als de titel echt junior/entry is.
    if not nl_source and not JUNIOR_RE.search(title):
        return False, "niet junior"
    entry_tag = any(re.search(r"entry|starter|associate", str(t), re.I) for t in job["tags"])
    title_junior = bool(JUNIOR_RE.search(title)) or entry_tag
    if not title_junior and YEARS_RE.search(text):
        return False, "vraagt 3+ jaar ervaring"
    if not title_junior and SENIOR_TEXT_RE.search(text[:2500]):
        return False, "niet junior"
    job["title_junior"] = title_junior
    job["traineeship"] = bool(TRAINEE_RE.search(title) or TRAINEE_RE.search(text[:1500]))
    return True, ""


def enrich(job):
    text = job["full_text"]
    clean = re.sub(r"[*_#`>|]+|-{3,}|={3,}|\\", " ", text)   # markdown-resten weg
    clean = re.sub(r"\s+", " ", clean).strip()
    job["short_desc"] = (clean[:300].rsplit(" ", 1)[0] + "...") if len(clean) > 300 else clean
    job["benefits"] = [k for k, rx in BENEFIT_RES.items() if rx.search(text)]
    job["skills"] = find_skills(f"{job['title']} {text} {' '.join(map(str, job['tags']))}")
    job["lang"] = detect_lang(text)
    job["linkedin"] = "linkedin.com" in (job["url"] or "") or job.get("publisher") == "LinkedIn"
    job["unrealistic_hint"] = bool(YEARS_RE.search(text)) and job.get("title_junior", False)
    return job


def main():
    old = {}
    if OUT.exists():
        try:
            old = {j["id"]: j for j in json.loads(OUT.read_text()).get("jobs", [])}
        except (ValueError, KeyError):
            old = {}

    fetched, stats = [], {}
    for src in SOURCES:
        try:
            jobs = src()
            stats[src.__name__[4:]] = len(jobs)
            fetched += jobs
        except Exception as e:  # een kapotte bron mag de run niet stoppen
            stats[src.__name__[4:]] = f"fout: {e.__class__.__name__}"
            print(f"[{src.__name__}] {e}", file=sys.stderr)

    max_age = NOW - timedelta(hours=CFG["max_age_hours"])
    reasons = {}
    merged = {}
    for job in fetched:
        posted = parse_date(job["posted_at"])
        if posted and posted < max_age:
            reasons["te oud"] = reasons.get("te oud", 0) + 1
            continue
        keep, why = classify(job)
        if not keep:
            reasons[why] = reasons.get(why, 0) + 1
            if os.getenv("JTS_DEBUG"):
                print(f"  weg [{why}] {job['source']}/{job['publisher']}: {job['title']}", file=sys.stderr)
            continue
        job = enrich(job)
        prev = old.get(job["id"]) or merged.get(job["id"])
        job["first_seen"] = prev["first_seen"] if prev else NOW.isoformat()
        if prev and prev.get("match"):
            job["match"] = prev["match"]
        merged[job["id"]] = job

    cutoff = NOW - timedelta(days=CFG["history_days"])
    for jid, job in old.items():
        if jid not in merged and parse_date(job.get("first_seen")) and parse_date(job["first_seen"]) > cutoff:
            # Oude vacatures gaan opnieuw door het filter, zodat nieuwe filterregels ook voor hen gelden.
            if classify(job)[0]:
                merged[jid] = enrich(job)
            else:
                reasons["oud, nu uitgefilterd"] = reasons.get("oud, nu uitgefilterd", 0) + 1

    jobs = sorted(merged.values(), key=lambda j: j.get("posted_at") or j["first_seen"], reverse=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "updated_at": NOW.isoformat(),
        "sources": stats,
        "count": len(jobs),
        "jobs": jobs,
    }, ensure_ascii=False, indent=1))

    print(f"Opgehaald per bron: {stats}")
    print(f"Weggefilterd: {reasons}")
    print(f"In jobs.json: {len(jobs)}")
    hosts = sorted(set(l.split(' ')[1] for l in request_log))
    print(f"Benaderde hosts ({len(request_log)} requests): {', '.join(hosts)}")


if __name__ == "__main__":
    main()
