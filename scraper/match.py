"""JTS - valideert elke vacature tegen het cv (CV_TEXT) met Gemini en een lokale skills-check.

Schrijft per vacature een `match`-object in docs/jobs.json. Het cv zelf komt nooit in de output.
"""
import hashlib
import json
import os
import sys
import time

import requests

from fetch_jobs import CFG, OUT, ROOT, find_skills

CACHE = ROOT / "scraper" / "match_cache.json"
API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

PROMPT = """Je bent een eerlijke recruiter die junior IT-vacatures beoordeelt voor één kandidaat.

CV VAN DE KANDIDAAT:
<<<
{cv}
>>>

Beoordeel elke vacature hieronder. Regels:
- is_junior: true als de rol echt geschikt is voor een starter of junior (ook traineeships). False bij medior/senior werk, ook als de titel junior zegt maar de inhoud senior is.
- Onrealistische eisen voor een junior (bijv. 3+ jaar ervaring, een lange rij van 10+ tools, expert-niveau in iets) zet je in ignored_unrealistic en tellen NIET mee in de score.
- score 0-100: hoe goed past de kandidaat op de realistische eisen. Bij traineeships weegt opleiding, leervermogen en motivatie zwaarder dan bestaande skills.
- matched_skills: skills/kennis uit het cv die de vacature vraagt.
- missing_realistic: realistische eisen die de kandidaat mist.
- reason: één korte zin in het Nederlands in de je-vorm (bijv. "Je Laravel-ervaring past goed..."), zonder persoonlijke gegevens uit het cv.
Verzin niets dat niet in het cv staat.

VACATURES:
{jobs}
"""

SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "id": {"type": "STRING"},
            "is_junior": {"type": "BOOLEAN"},
            "score": {"type": "INTEGER"},
            "matched_skills": {"type": "ARRAY", "items": {"type": "STRING"}},
            "missing_realistic": {"type": "ARRAY", "items": {"type": "STRING"}},
            "ignored_unrealistic": {"type": "ARRAY", "items": {"type": "STRING"}},
            "reason": {"type": "STRING"},
        },
        "required": ["id", "is_junior", "score", "matched_skills", "missing_realistic",
                     "ignored_unrealistic", "reason"],
    },
}


LANG_SKILLS = {"Engels", "Nederlands"}


def local_score(job, cv_skills):
    job_skills = set(job.get("skills") or []) - LANG_SKILLS
    if not job_skills:
        return 50
    overlap = len(job_skills & cv_skills) / len(job_skills)
    score = 30 + 70 * overlap
    if job.get("traineeship"):
        score = max(score, 60)
    return round(min(score, 100))


def ask_gemini(key, cv, batch):
    jobs_txt = "\n\n".join(
        f"[id={j['id']}] {j['title']} bij {j['company']} ({j['location']})\n{j['full_text'][:1500]}" for j in batch)
    body = {
        "contents": [{"parts": [{"text": PROMPT.format(cv=cv[:8000], jobs=jobs_txt)}]}],
        "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json",
                             "responseSchema": SCHEMA},
    }
    for attempt in range(4):
        try:
            r = requests.post(API.format(model=CFG["gemini_model"]), params={"key": key}, json=body, timeout=120)
        except requests.Timeout:
            time.sleep(10)
            continue
        if r.status_code in (429, 500, 503):  # rate limit of drukte bij Google: even wachten en opnieuw
            time.sleep(20 * (attempt + 1))
            continue
        r.raise_for_status()
        text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
        return {item["id"]: item for item in json.loads(text)}
    raise RuntimeError("Gemini bleef niet beschikbaar (429/503/timeout)")


def main():
    cv = os.getenv("CV_TEXT", "").strip()
    key = os.getenv("GEMINI_API_KEY", "").strip()
    data = json.loads(OUT.read_text())
    jobs = data["jobs"]
    if not cv:
        print("Geen CV_TEXT ingesteld, matching overgeslagen.")
        return

    cv_hash = hashlib.sha256(cv.encode()).hexdigest()[:16]
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    if cache.get("cv_hash") != cv_hash:
        print("CV gewijzigd of eerste run: alle scores worden opnieuw berekend.")
        cache = {"cv_hash": cv_hash, "results": {}}
    results = cache["results"]
    cv_skills = set(find_skills(cv))

    todo = [j for j in jobs if j["id"] not in results][: CFG["max_jobs_ai_per_run"]]
    if key and todo:
        for i in range(0, len(todo), 8):
            batch = todo[i:i + 8]
            try:
                got = ask_gemini(key, cv, batch)
            except Exception as e:
                print(f"Gemini-fout bij batch {i // 8 + 1}, overgeslagen: {e}", file=sys.stderr)
                continue
            for j in batch:
                if j["id"] in got:
                    item = got[j["id"]]
                    item.pop("id", None)
                    item["score"] = max(0, min(100, int(item["score"])))
                    results[j["id"]] = item
            time.sleep(5)  # gratis tier: ruim onder de limiet per minuut
    elif not key:
        print("Geen GEMINI_API_KEY: alleen lokale score.")

    valid_ids = {j["id"] for j in jobs}
    cache["results"] = {k: v for k, v in results.items() if k in valid_ids}
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1))

    for j in jobs:
        loc = local_score(j, cv_skills)
        ai = cache["results"].get(j["id"])
        if ai:
            m = dict(ai, local_score=loc, ai=True)
            m["check"] = abs(ai["score"] - loc) > 40
        else:
            m = {"score": loc, "local_score": loc, "ai": False, "check": False,
                 "is_junior": j.get("title_junior", False),
                 "matched_skills": sorted(set(j.get("skills", [])) & cv_skills),
                 "missing_realistic": sorted(set(j.get("skills", [])) - cv_skills),
                 "ignored_unrealistic": [], "reason": "Alleen lokale skills-match (nog geen AI-check)."}
        m["visible"] = (bool(m["is_junior"]) or not m["ai"]) and m["score"] >= CFG["min_score"]
        j["match"] = m

    data["min_score"] = CFG["min_score"]
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    ai_done = sum(1 for j in jobs if j["match"]["ai"])
    print(f"Gematcht: {len(jobs)} vacatures, {ai_done} met AI, {sum(j['match']['visible'] for j in jobs)} zichtbaar.")


if __name__ == "__main__":
    main()
