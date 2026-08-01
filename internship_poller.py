#!/usr/bin/env python3
"""
Internship poller. Covers Greenhouse, Lever, Ashby, Workday.

    pip install aiohttp
    python internship_poller.py verify              # check every board is live
    python internship_poller.py list --us           # all open US internships
    python internship_poller.py list --sector finance
    python internship_poller.py list --category swe
    python internship_poller.py sweep               # store + print what's new
    python internship_poller.py watch               # every 15 min until Ctrl-C
    python internship_poller.py stats
    python internship_poller.py llm-diff            # compare regex vs Gemini on stored rows
    python internship_poller.py sweep --llm         # classify new postings with Gemini

    export GEMINI_API_KEY=...               # required for --llm
    export GEMINI_MODEL=gemini-3.5-flash-lite   # or gemini-3.6-flash
    export GEMINI_RPM=10 GEMINI_RPD=200     # match your AI Studio dashboard
    python internship_poller.py discover            # mine + validate ~2k boards -> boards.json
    python internship_poller.py discover --yc       # + probe YC's 6k company dataset (slow)
    python internship_poller.py prune --dry-run     # see what the retention rule removes

Rows older than 30 days are deleted from `postings` on every sweep. A separate
`seen` table keeps every id forever, so pruned roles are never re-announced.

Sectors: tech, finance, healthcare, defense, industrial, retail, energy.

WORKDAY NOTE
  Workday needs a (tenant, wd-instance, site) triple, not a single slug, and the
  site path is NOT guessable — brute-forcing common names ("External", "Careers")
  resolves ~0%. Harvest it from the company's careers URL:
      https://capitalone.wd1.myworkdayjobs.com/Capital_One_Careers
                ^tenant   ^wd            ^site
  Its postedOn field is human text ("Posted 4 Days Ago"), so lag resolution is
  day-level. Fine for detection, useless for measuring minutes.
"""

import argparse
import asyncio
import hashlib
import html
import os
import json
import re
import sqlite3
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import aiohttp

# All data files live next to this script, never in the CWD — the Discord bot
# imports this module from client/ and must see the same DB and board registry
# as the CLI.
_HERE = os.path.dirname(os.path.abspath(__file__))

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(_HERE, ".env"), override=True)
except ImportError:
    pass  # .env loading is optional; plain env vars still work

DB_PATH = os.path.join(_HERE, "postings.db")
CONCURRENCY = 20
TIMEOUT = aiohttp.ClientTimeout(total=30)
UA = "internship-poller/0.4 (personal project; contact: you@example.com)"
MAX_AGE_DAYS = 30   # postings older than this are ignored; override with --max-age
PRUNE_DAYS = 30     # rows older than this are deleted from `postings` on each sweep
SCHEMA_VERSION = 2

# --------------------------------------------------------------------------
# Board registry. Every entry below was probed live on 2026-07-31.
# Format: (platform, slug, display name, sector)
# Workday slug format: "tenant/wdN/SitePath"
# --------------------------------------------------------------------------

SEED_BOARDS = [
    # ---- quant / trading ----
    ("greenhouse", "jumptrading",        "Jump Trading",         "finance"),
    ("greenhouse", "point72",            "Point72",              "finance"),
    ("greenhouse", "imc",                "IMC Trading",          "finance"),
    ("greenhouse", "virtu",              "Virtu Financial",      "finance"),
    ("greenhouse", "akunacapital",       "Akuna Capital",        "finance"),
    ("greenhouse", "schonfeld",          "Schonfeld",            "finance"),
    ("greenhouse", "squarepointcapital", "Squarepoint Capital",  "finance"),
    ("greenhouse", "flowtraders",        "Flow Traders",         "finance"),
    ("lever",      "voleon",             "Voleon",               "finance"),
    # ---- banks / insurance / fintech (Workday) ----
    ("workday",    "statestreet/wd1/Global",                "State Street",  "finance"),
    ("greenhouse", "robinhood",          "Robinhood",            "finance"),
    ("greenhouse", "coinbase",           "Coinbase",             "finance"),
    ("ashby",      "ramp",               "Ramp",                 "finance"),
    # ---- healthcare / bio ----
    ("workday",    "cvshealth/wd1/CVS_Health_Careers",      "CVS Health",    "healthcare"),
    ("workday",    "humana/wd5/Humana_External_Career_Site", "Humana",       "healthcare"),
    ("greenhouse", "truveta",            "Truveta",              "healthcare"),
    ("greenhouse", "pathai",             "PathAI",               "healthcare"),
    ("greenhouse", "ginkgobioworks",     "Ginkgo Bioworks",      "healthcare"),
    ("ashby",      "nabla",              "Nabla",                "healthcare"),
    # ---- defense / aerospace ----
    ("workday",    "boeing/wd1/EXTERNAL_CAREERS",           "Boeing",        "defense"),
    ("greenhouse", "spacex",             "SpaceX",               "defense"),
    ("greenhouse", "rocketlab",          "Rocket Lab",           "defense"),
    ("greenhouse", "astranis",           "Astranis",             "defense"),
    ("greenhouse", "vast",               "Vast",                 "defense"),
    ("lever",      "shieldai",           "Shield AI",            "defense"),
    ("lever",      "palantir",           "Palantir",             "defense"),
    # ---- industrial / auto / energy ----
    ("workday",    "cat/wd5/CaterpillarCareers",            "Caterpillar",   "industrial"),
    ("greenhouse", "lucidmotors",        "Lucid Motors",         "industrial"),
    ("greenhouse", "nuro",               "Nuro",                 "industrial"),
    ("greenhouse", "waymo",              "Waymo",                "industrial"),
    ("lever",      "weride",             "WeRide",               "industrial"),
    ("greenhouse", "solidpower",         "Solid Power",          "energy"),
    ("greenhouse", "redwoodmaterials",   "Redwood Materials",    "energy"),
    # ---- retail / consumer ----
    ("workday",    "target/wd5/targetcareers",              "Target",        "retail"),
    ("greenhouse", "tripadvisor",        "Tripadvisor",          "retail"),
    ("lever",      "matchgroup",         "Match Group",          "retail"),
    ("greenhouse", "flexport",           "Flexport",             "retail"),
    # ---- tech ----
    ("greenhouse", "cloudflare",         "Cloudflare",           "tech"),
    ("greenhouse", "zscaler",            "Zscaler",              "tech"),
    ("greenhouse", "databricks",         "Databricks",           "tech"),
    ("greenhouse", "stripe",             "Stripe",               "tech"),
    ("greenhouse", "verkada",            "Verkada",              "tech"),
    ("greenhouse", "scaleai",            "Scale AI",             "tech"),
    ("greenhouse", "samsara",            "Samsara",              "tech"),
    ("greenhouse", "figma",              "Figma",                "tech"),
    ("greenhouse", "airtable",           "Airtable",             "tech"),
    ("greenhouse", "gitlab",             "GitLab",               "tech"),
    ("greenhouse", "cribl",              "Cribl",                "tech"),
    ("greenhouse", "braze",              "Braze",                "tech"),
    ("greenhouse", "chainguard",         "Chainguard",           "tech"),
    ("ashby",      "perplexity",         "Perplexity",           "tech"),
    ("ashby",      "notion",             "Notion",               "tech"),
    ("ashby",      "replit",             "Replit",               "tech"),
    ("ashby",      "modal",              "Modal",                "tech"),
    ("ashby",      "cursor",             "Cursor",               "tech"),
    ("ashby",      "linear",             "Linear",               "tech"),
    ("ashby",      "supabase",           "Supabase",             "tech"),
    ("ashby",      "vanta",              "Vanta",                "tech"),
    ("ashby",      "posthog",            "PostHog",              "tech"),
    ("ashby",      "sierra",             "Sierra",               "tech"),
    ("ashby",      "cognition",          "Cognition",            "tech"),
    ("ashby",      "harvey",             "Harvey",               "tech"),
    ("ashby",      "weaviate",           "Weaviate",             "tech"),
]

# Discovered boards live in boards.json (written by `discover`). The seed list
# above is the hand-curated fallback so the tool works with no setup.
BOARDS_FILE = os.path.join(_HERE, "boards.json")


def load_boards():
    try:
        with open(BOARDS_FILE) as f:
            rows = [tuple(r) for r in json.load(f)]
        seen = {(r[0], r[1]) for r in rows}
        rows += [b for b in SEED_BOARDS if (b[0], b[1]) not in seen]
        return rows
    except FileNotFoundError:
        return list(SEED_BOARDS)


BOARDS = load_boards()

# --------------------------------------------------------------------------
# Discovery — the registry is the bottleneck, not the poller. This mines ATS
# slugs out of the community internship repos' apply links, then validates each
# against the live API. ~29k links yield ~2.3k slugs at a ~90% live rate.
# --------------------------------------------------------------------------

# Repo listing files, mined for apply links. The new-grad repos are included on
# purpose: those companies hire interns too, and their apply links expose slugs
# the internship repos miss. ~11MB each, so this is a once-a-week job.
REPO_LISTINGS = [
    "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
    "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json",
    "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
    "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/.github/scripts/listings.json",
    "https://raw.githubusercontent.com/vanshb03/New-Grad-2027/dev/.github/scripts/listings.json",
    "https://raw.githubusercontent.com/zshah101/Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships/main/data/jobs.json",
]

SLUG_PATTERNS = {
    "greenhouse": r"(?:boards|job-boards)\.greenhouse\.io/([a-z0-9_-]+)",
    "lever": r"jobs\.lever\.co/([a-z0-9_-]+)",
    "ashby": r"jobs\.ashbyhq\.com/([a-z0-9_-]+)",
}
WORKDAY_PATTERN = (r"([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/"
                   r"(?:[a-z]{2}-[A-Z]{2}/)?([A-Za-z0-9_-]+)")

# Slugs that are real boards but never worth polling.
SLUG_BLOCKLIST = {"embed", "job_app", "jobs", "job", "www", "api", "static",
                  "assets", "search", "board", "boards", "error", "404"}


def extract_slugs(text):
    found = set()
    for plat, rx in SLUG_PATTERNS.items():
        for m in re.finditer(rx, text, re.I):
            slug = m.group(1).lower()
            if slug not in SLUG_BLOCKLIST and len(slug) > 1:
                found.add((plat, slug))
    for m in re.finditer(WORKDAY_PATTERN, text):
        found.add(("workday", f"{m.group(1)}/{m.group(2)}/{m.group(3)}"))
    return found


async def mine_repos(sess):
    found, nbytes = set(), 0
    for u in REPO_LISTINGS:
        label = u.split("/")[4]
        try:
            async with sess.get(u) as r:
                if r.status != 200:
                    print(f"  -- {label:<28} HTTP {r.status}")
                    continue
                raw = await r.text()
        except Exception as e:
            print(f"  -- {label:<28} {type(e).__name__}")
            continue
        nbytes += len(raw)
        f = extract_slugs(raw)
        found |= f
        print(f"  ok {label:<28} {len(raw)//1024:>6}KB  {len(f)} slugs")
    return found, nbytes


async def mine_commoncrawl(sess, max_pages=3):
    """Best-effort. CC's index service is frequently 503 — treat as a bonus,
    never a dependency. When it works it yields far more slugs than the repos."""
    try:
        async with sess.get("https://index.commoncrawl.org/collinfo.json") as r:
            if r.status != 200:
                print(f"  -- common crawl              HTTP {r.status} (index service "
                      f"is often down; skipping)")
                return set()
            idx = (await r.json(content_type=None))[0]["id"]
    except Exception as e:
        print(f"  -- common crawl              {type(e).__name__} (skipping)")
        return set()

    found = set()
    for host in ("boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com"):
        for page in range(max_pages):
            u = (f"https://index.commoncrawl.org/{idx}-index?"
                 f"url={host}/*&output=json&page={page}")
            try:
                async with sess.get(u) as r:
                    if r.status != 200:
                        break
                    text = await r.text()
            except Exception:
                break
            found |= extract_slugs(text)
        print(f"  ok common crawl {host:<26} running total {len(found)}")
    return found


@dataclass
class Posting:
    platform: str
    external_id: str
    company: str
    sector: str
    title: str
    location: str
    url: str
    published: Optional[float]
    approx_date: bool = False   # True when we only know the day, not the minute
    unbounded: bool = False     # True for Workday "30+ Days Ago" — a floor, not a date


# --------------------------------------------------------------------------
# Adapters
# --------------------------------------------------------------------------


def _ts(v) -> Optional[float]:
    if not v:
        return None
    if isinstance(v, (int, float)):
        return v / 1000 if v > 1e11 else float(v)
    try:
        dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            # Offset-less strings from the ATS APIs mean UTC; .timestamp() on a
            # naive datetime would read them as machine-local time instead.
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


POSTED_RE = re.compile(r"(\d+)\+?\s*(day|hour|month)", re.I)


def _workday_posted(text) -> tuple:
    """'Posted 4 Days Ago' -> (epoch, approx, unbounded). Day-level resolution.

    "Posted 30+ Days Ago" is Workday's terminal bucket — at least 30 days, but
    possibly 400. Recorded as 30d with unbounded=True so the age filter treats
    it as unknown rather than pretending it is fresh.
    """
    if not text:
        return None, True, False
    t = str(text).lower()
    if "today" in t:
        return time.time(), True, False
    if "yesterday" in t:
        return time.time() - 86400, True, False
    m = POSTED_RE.search(t)
    if not m:
        return None, True, False
    n, unit = int(m.group(1)), m.group(2)
    secs = {"hour": 3600, "day": 86400, "month": 2592000}[unit]
    return time.time() - n * secs, True, "+" in t


async def fetch_greenhouse(sess, slug, company, sector, etag):
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"
    h = {"If-None-Match": etag} if etag else {}
    async with sess.get(url, headers=h) as r:
        if r.status != 200:
            return r.status, [], r.headers.get("ETag")
        d = await r.json(content_type=None)
        return 200, [
            Posting("greenhouse", str(j.get("id")), company, sector,
                    j.get("title", ""), (j.get("location") or {}).get("name", ""),
                    j.get("absolute_url", ""),
                    # first_published is the true post date; updated_at moves on
                    # any edit and will lie about freshness.
                    _ts(j.get("first_published")) or _ts(j.get("updated_at")))
            for j in d.get("jobs", [])
        ], r.headers.get("ETag")


async def fetch_lever(sess, slug, company, sector, etag):
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    h = {"If-None-Match": etag} if etag else {}
    async with sess.get(url, headers=h) as r:
        if r.status != 200:
            return r.status, [], r.headers.get("ETag")
        out = []
        for j in await r.json(content_type=None):
            loc = (j.get("categories") or {}).get("location") or ""
            country = j.get("country") or ""
            if country and country.lower() not in loc.lower():
                loc = f"{loc}, {country}".strip(", ")
            out.append(Posting("lever", str(j.get("id")), company, sector,
                               j.get("text", ""), loc, j.get("hostedUrl", ""),
                               _ts(j.get("createdAt"))))
        return 200, out, r.headers.get("ETag")


async def fetch_ashby(sess, slug, company, sector, etag):
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
    h = {"If-None-Match": etag} if etag else {}
    async with sess.get(url, headers=h) as r:
        if r.status != 200:
            return r.status, [], r.headers.get("ETag")
        d = await r.json(content_type=None)
        # employmentType is unreliable — Perplexity tags its internships "FullTime".
        return 200, [
            Posting("ashby", str(j.get("id")), company, sector, j.get("title", ""),
                    j.get("location", "") or "",
                    j.get("jobUrl") or j.get("applyUrl") or "",
                    _ts(j.get("publishedAt")))
            for j in d.get("jobs", []) if j.get("isListed", True)
        ], r.headers.get("ETag")


async def fetch_workday(sess, slug, company, sector, etag):
    """slug = 'tenant/wdN/SitePath'. POST-based, paginated, no ETag support."""
    try:
        tenant, wd, site = slug.split("/")
    except ValueError:
        return 400, [], None
    base = f"https://{tenant}.{wd}.myworkdayjobs.com"
    api = f"{base}/wday/cxs/{tenant}/{site}/jobs"
    out, offset = [], 0
    # searchText is fuzzy (matches "internal", "international"); the classifier
    # filters client-side. It just cuts the payload down.
    while offset < 200:
        body = {"appliedFacets": {}, "limit": 20, "offset": offset,
                "searchText": "intern"}
        async with sess.post(api, json=body,
                             headers={"Accept": "application/json"}) as r:
            if r.status != 200:
                return (200, out, None) if out else (r.status, [], None)
            d = await r.json(content_type=None)
        posts = d.get("jobPostings", [])
        if not posts:
            break
        for j in posts:
            path = j.get("externalPath", "")
            pub, approx, unb = _workday_posted(j.get("postedOn"))
            out.append(Posting(
                "workday", f"{tenant}:{path}", company, sector,
                j.get("title", ""), j.get("locationsText", "") or "",
                f"{base}/{site}{path}", pub, approx, unb))
        offset += 20
        if offset >= (d.get("total") or 0):
            break
    return 200, out, None


ADAPTERS = {"greenhouse": fetch_greenhouse, "lever": fetch_lever,
            "ashby": fetch_ashby, "workday": fetch_workday}

# --------------------------------------------------------------------------
# Detail fetch — salary + full description for ONE posting, on demand. The
# sweep never stores these (they would bloat the DB and the list endpoints
# mostly omit them); frontends call this when a user asks about a role.
# --------------------------------------------------------------------------

GH_JOB_URL_RE = re.compile(r"greenhouse\.io/([a-z0-9_-]+)/jobs/(\d+)", re.I)
LEVER_JOB_URL_RE = re.compile(r"jobs\.lever\.co/([a-z0-9_-]+)/([0-9a-f-]{16,})", re.I)
ASHBY_JOB_URL_RE = re.compile(r"jobs\.ashbyhq\.com/([^/?#]+)/", re.I)
WD_JOB_URL_RE = re.compile(
    r"https://([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/([^/]+)(/job/.+)$", re.I)

SALARY_TEXT_RE = re.compile(
    r"(?:\$|USD\s?|€|£)\s?\d{1,3}(?:[,.]\d{3})*(?:\.\d{2})?\s?(?:k\b)?"
    r"(?:\s*(?:[-–—]|to\s)\s*(?:\$|USD\s?|€|£)?\s?\d{1,3}(?:[,.]\d{3})*"
    r"(?:\.\d{2})?\s?(?:k\b)?)?"
    r"(?:\s*(?:per|/)\s*(?:hour|hr|year|yr|annum|month|week))?", re.I)


def strip_html(s: str) -> str:
    """Best-effort HTML -> readable plain text, no external deps."""
    s = html.unescape(s or "")  # Greenhouse escapes its whole content field
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s, flags=re.S | re.I)
    s = re.sub(r"</?(?:p|br|li|ul|ol|div|h[1-6]|tr|table)[^>]*>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"[ \t\f\v]+", " ", s)
    s = re.sub(r"\s*\n\s*", "\n", s)
    return s.strip()


def find_salary_in_text(text) -> Optional[str]:
    """Fallback for boards without structured pay data: first believable
    money figure in the description. Demands a range, a 'k', a per-period,
    or a 5+ digit amount so a bare '$5' can't match."""
    for m in SALARY_TEXT_RE.finditer(text or ""):
        s = m.group(0).strip()
        if (re.search(r"[-–—]|\bto\s", s) or re.search(r"\dk\b", s, re.I)
                or re.search(r"per|/", s) or re.search(r"\d[\d,]{4,}", s)):
            return s
    return None


async def fetch_details(platform, url, external_id) -> dict:
    """{'salary': str|None, 'description': str|None} for one posting.

    Best-effort by design: any HTTP failure, unrecognized URL, or missing
    field just leaves the value None — callers treat both as optional.
    """
    out = {"salary": None, "description": None}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20),
                                     headers={"User-Agent": UA}) as sess:
        if platform == "greenhouse":
            m = GH_JOB_URL_RE.search(url or "")
            if not m:
                return out
            slug, jid = m.groups()
            async with sess.get("https://boards-api.greenhouse.io/v1/boards/"
                                f"{slug}/jobs/{jid}") as r:
                if r.status != 200:
                    return out
                d = await r.json(content_type=None)
            out["description"] = strip_html(d.get("content") or "")
            parts = []
            for pr in d.get("pay_input_ranges") or []:
                lo, hi = pr.get("min_cents"), pr.get("max_cents")
                if lo is None or hi is None:
                    continue
                sym = "$" if (pr.get("currency_type") or "USD") == "USD" \
                    else f"{pr['currency_type']} "
                rng = f"{sym}{lo / 100:,.0f}–{sym}{hi / 100:,.0f}"
                if pr.get("title"):
                    rng += f" ({pr['title']})"
                parts.append(rng)
            out["salary"] = "; ".join(parts) or None

        elif platform == "lever":
            m = LEVER_JOB_URL_RE.search(url or "")
            if not m:
                return out
            slug, pid = m.groups()
            async with sess.get(
                    f"https://api.lever.co/v0/postings/{slug}/{pid}") as r:
                if r.status != 200:
                    return out
                d = await r.json(content_type=None)
            pieces = [d.get("descriptionPlain")
                      or strip_html(d.get("description") or "")]
            for sec in d.get("lists") or []:
                pieces.append(f"{sec.get('text', '')}\n"
                              f"{strip_html(sec.get('content') or '')}")
            out["description"] = "\n".join(x for x in pieces if x).strip()
            sr = d.get("salaryRange") or {}
            if sr.get("min") is not None and sr.get("max") is not None:
                sym = "$" if (sr.get("currency") or "USD") == "USD" \
                    else f"{sr['currency']} "
                iv = (sr.get("interval") or "").replace("-", " ")
                out["salary"] = (f"{sym}{sr['min']:,}–{sym}{sr['max']:,}"
                                 + (f" {iv}" if iv else ""))

        elif platform == "ashby":
            m = ASHBY_JOB_URL_RE.search(url or "")
            if not m:
                return out
            async with sess.get("https://api.ashbyhq.com/posting-api/job-board/"
                                f"{m.group(1)}?includeCompensation=true") as r:
                if r.status != 200:
                    return out
                d = await r.json(content_type=None)
            job = next((j for j in d.get("jobs", [])
                        if str(j.get("id")) == str(external_id)), None)
            if not job:
                return out
            out["description"] = strip_html(job.get("descriptionHtml")
                                            or job.get("descriptionPlain") or "")
            comp = job.get("compensation") or {}
            out["salary"] = (job.get("compensationTierSummary")
                             or comp.get("compensationTierSummary")
                             or comp.get("scrapeableCompensationSalarySummary"))

        elif platform == "workday":
            m = WD_JOB_URL_RE.match(url or "")
            if not m:
                return out
            tenant, wd, site, path = m.groups()
            api = (f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/"
                   f"{tenant}/{site}{path}")
            async with sess.get(api, headers={"Accept": "application/json"}) as r:
                if r.status != 200:
                    return out
                d = await r.json(content_type=None)
            info = d.get("jobPostingInfo") or {}
            out["description"] = strip_html(info.get("jobDescription") or "")

    if not out["salary"] and out["description"]:
        out["salary"] = find_salary_in_text(out["description"])
    return out

# --------------------------------------------------------------------------
# Classifier — pure function
# --------------------------------------------------------------------------

INTERN_RE = re.compile(r"\b(intern|interns|internship|interning|co-?op)\b", re.I)
EXCLUDE_RE = re.compile(
    r"\binternal\b|\binternational\b|\binternist\b|"
    r"\bintern(ship)?\s+(manager|coordinator|recruiter|program manager)\b|"
    r"\b(medical|nursing|clinical|pharmacy|physician|resident)\s+intern", re.I)
TERM_RE = re.compile(r"\b(summer|fall|autumn|winter|spring)\s*'?\s*(20\d{2})\b", re.I)
YEAR_RE = re.compile(r"\b(20\d{2})\b")

# Only surface tech-flavoured roles — matters because the registry includes
# CVS, Target and Caterpillar, which post hundreds of non-tech interns.
TECHY_RE = re.compile(
    r"\b(software|engineer|engineering|developer|\bswe\b|backend|back-end|frontend|"
    r"front-end|full.?stack|infra|infrastructure|platform|security|cyber|systems|"
    r"compiler|distributed|\bapi\b|mobile|ios|android|\bweb\b|cloud|devops|\bsre\b|"
    r"data|analytics|machine learning|\bml\b|\bai\b|\bnlp\b|computer vision|"
    r"quant|quantitative|research|technology|technical|\bit\b|information systems|"
    r"hardware|asic|fpga|rtl|silicon|embedded|electrical|mechanical|robotics|"
    r"avionics|propulsion|aerospace|product manage|program manage)\b", re.I)

US_HINT = re.compile(
    r"\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|"
    r"MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|"
    r"WV|WI|WY|DC)\b|\b(united states|\bUSA\b|u\.s\.|remote|san francisco|new york|"
    r"seattle|austin|boston|chicago|los angeles|palo alto|mountain view|"
    r"sunnyvale|bellevue|denver|atlanta|washington|minneapolis|peoria)\b", re.I)
NON_US = re.compile(
    r"\b(london|dublin|berlin|paris|amsterdam|zurich|geneva|bangalore|bengaluru|"
    r"hyderabad|pune|chennai|gurgaon|noida|tokyo|osaka|singapore|sydney|melbourne|"
    r"tel aviv|haifa|toronto|vancouver|montreal|ottawa|munich|hamburg|stockholm|"
    r"oslo|copenhagen|helsinki|warsaw|krakow|gdansk|prague|lisbon|porto|madrid|"
    r"barcelona|milan|rome|belgrade|bucharest|sofia|budapest|vienna|brussels|"
    r"bristol|manchester|edinburgh|s[a\u00e3]o paulo|mexico city|bogot[a\u00e1]|"
    r"buenos aires|santiago|lagos|nairobi|cairo|dubai|abu dhabi|riyadh|seoul|"
    r"taipei|hong kong|shanghai|beijing|shenzhen|kuala lumpur|jakarta|manila|"
    r"bangkok|ho chi minh|hanoi|auckland|wellington|united kingdom|england|"
    r"scotland|ireland|india|germany|france|netherlands|switzerland|japan|"
    r"australia|israel|canada|china|poland|spain|italy|sweden|norway|denmark|"
    r"serbia|romania|brazil|mexico|korea|taiwan)\b|\b(POL|DEU|GBR|IND|CAN|AUS)\s*-",
    re.I)

CATEGORIES = [(name, re.compile(pat, re.I)) for name, pat in [
    ("quant",    r"\b(quant|quantitative|trading|trader|systematic|market mak)"),
    ("hardware", r"\b(hardware|asic|fpga|rtl|silicon|analog|rf\b|antenna|avionics|"
                 r"electrical|mechanical|embedded|thermal|propulsion|structures|"
                 r"manufactur|integration and test|dsp|robotic)"),
    ("data-ml",  r"\b(machine learning|\bml\b|deep learning|data scien|data engineer|"
                 r"analytics|research scien|research engineer|\bai\b|\bnlp\b|"
                 r"computer vision|perception)"),
    ("pm",       r"\b(product manage|product management|\bpm\b|program manage|"
                 r"business analyst|strategy)"),
    ("swe",      r"\b(software|engineer|developer|\bswe\b|backend|back-end|frontend|"
                 r"front-end|full.?stack|infra|platform|security|cyber|systems|"
                 r"compiler|distributed|api|mobile|ios|android|web|cloud|devops)"),
]]


def classify(p: "Posting") -> dict:
    t = p.title
    is_intern = bool(INTERN_RE.search(t)) and not EXCLUDE_RE.search(t)
    is_tech = bool(TECHY_RE.search(t))

    term = None
    m = TERM_RE.search(t)
    if m:
        term = f"{m.group(1).title()} {m.group(2)}"
    else:
        y = YEAR_RE.search(t)
        if y:
            term = y.group(1)

    category = "other"
    for name, rx in CATEGORIES:
        if rx.search(t):
            category = name
            break

    loc = p.location or ""
    if NON_US.search(loc):
        region = "non-us"
    elif US_HINT.search(loc) or not loc:
        region = "us"
    else:
        region = "unknown"

    return {"is_intern": is_intern, "is_tech": is_tech, "term": term,
            "category": category, "region": region}


# --------------------------------------------------------------------------
# LLM classifier. Replaces the regex heuristics where it can, falls back to
# them where it can't. Three rules make this safe on a rate-limited free tier:
#
#   1. Fail open. Any error, timeout, missing key, or exhausted quota falls
#      back to the regex classifier. The digest ships regardless.
#   2. Cache by content hash. Same title+location is never classified twice,
#      so re-runs and crashes cost nothing and results are deterministic.
#   3. Batch + budget. 25 postings per call, with a token-bucket RPM limiter
#      and a persisted daily counter. A busy day is ~20 calls, not 500.
#
# Model ids (verified 2026-07-31): gemini-3.5-flash-lite is the cheap
# high-throughput tier and the right default for classification;
# gemini-3.6-flash is the stronger workhorse. Note the mixed versioning —
# Flash-Lite stayed on the 3.5 line in the same release. Free-tier RPM/RPD
# vary by project; check your own AI Studio rate-limit view and set the env
# vars below to match, since the published tables go stale.
# --------------------------------------------------------------------------

GEMINI_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
GEMINI_URL = ("https://generativelanguage.googleapis.com/v1beta/models/"
              "{model}:generateContent")
LLM_BATCH = int(os.environ.get("GEMINI_BATCH", "25"))
LLM_RPM = int(os.environ.get("GEMINI_RPM", "10"))
LLM_RPD = int(os.environ.get("GEMINI_RPD", "200"))

LLM_PROMPT = """You classify job postings for a tech-internship alert bot.

For each numbered posting, return one object with these fields:
  i          the posting number
  is_intern  true only for internships/co-ops for current students. False for
             full-time, new-grad, contractor, or fellowship roles.
  is_tech    true if the work is software, data/ML, hardware, IT, quant,
             security, robotics, or technical product/program management.
             False for retail, nursing, pharmacy, marketing, finance-ops,
             clinical, or administrative roles.
  category   one of: swe, data-ml, hardware, quant, pm, other
  term       the season and year if stated, e.g. "Summer 2027", "Fall 2026".
             Use null if the posting does not say.
  region     "us" if the location is in the United States or fully remote-US,
             "non-us" for anywhere else, "unknown" if you cannot tell.

Judge from the title and location only. Be inclusive on is_intern when a
posting is plausibly a student internship under an unusual title (e.g.
"Campus Engineer", "Technology Analyst Program", "Founding Engineer, Student").

Return ONLY a JSON array. No markdown fences, no commentary.

Postings:
"""

LLM_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "i": {"type": "INTEGER"},
            "is_intern": {"type": "BOOLEAN"},
            "is_tech": {"type": "BOOLEAN"},
            "category": {"type": "STRING",
                         "enum": ["swe", "data-ml", "hardware", "quant", "pm", "other"]},
            "term": {"type": "STRING", "nullable": True},
            "region": {"type": "STRING", "enum": ["us", "non-us", "unknown"]},
        },
        "required": ["i", "is_intern", "is_tech", "category", "region"],
    },
}


# High-recall pre-filter. The LLM is a PRECISION layer, not a replacement for
# the whole pass — sending every posting on every board would be ~16k rows per
# sweep. This pattern is deliberately over-inclusive: it must catch the odd
# titles the strict regex misses ("Campus Engineer", "Technology Analyst
# Program", "Founding Engineer, Student") while discarding the obvious
# full-time roles. False positives here are cheap; false negatives are not.
LLM_CANDIDATE_RE = re.compile(
    r"\b(intern|interns|internship|interning|co-?op|campus|student|students|"
    r"university|undergrad|undergraduate|graduate|new\s?grad|early\s?career|"
    r"apprentice|apprenticeship|trainee|analyst\s+program|rotational|"
    r"summer|fall|spring|winter|20\d{2})\b", re.I)


def llm_candidates(posts):
    return [p for p in posts if LLM_CANDIDATE_RE.search(p.title or "")]


def posting_hash(p):
    return hashlib.sha256(
        f"{p.title}|{p.location}".encode("utf-8")).hexdigest()[:32]


class LlmBudget:
    """Token-bucket RPM limiter plus a daily counter persisted in sqlite."""

    def __init__(self, conn, rpm=LLM_RPM, rpd=LLM_RPD):
        self.conn, self.rpm, self.rpd = conn, rpm, rpd
        self.calls = []
        self.day = datetime.now().strftime("%Y-%m-%d")
        row = conn.execute("SELECT n FROM llm_usage WHERE day=?",
                           (self.day,)).fetchone()
        self.used = row[0] if row else 0

    def remaining(self):
        return max(0, self.rpd - self.used)

    async def acquire(self):
        if self.used >= self.rpd:
            return False
        now = time.time()
        self.calls = [t for t in self.calls if now - t < 60]
        if len(self.calls) >= self.rpm:
            wait = 60 - (now - self.calls[0]) + 0.5
            await asyncio.sleep(max(0, wait))
            self.calls = [t for t in self.calls if time.time() - t < 60]
        self.calls.append(time.time())
        self.used += 1
        self.conn.execute(
            "INSERT INTO llm_usage VALUES(?,?) ON CONFLICT(day) "
            "DO UPDATE SET n=excluded.n", (self.day, self.used))
        self.conn.commit()
        return True


async def _llm_call(sess, budget, batch):
    """One batched request. Returns {index: fields} or {} on any failure."""
    if not await budget.acquire():
        return {}
    lines = "\n".join(f'{i}. {p.title} — {p.location or "no location given"}'
                       for i, p in batch)
    body = {
        "contents": [{"parts": [{"text": LLM_PROMPT + lines}]}],
        "generationConfig": {"responseMimeType": "application/json",
                             "responseSchema": LLM_SCHEMA,
                             "temperature": 0},
    }
    url = GEMINI_URL.format(model=GEMINI_MODEL)
    for attempt in range(3):
        try:
            async with sess.post(url, json=body,
                                 headers={"x-goog-api-key": GEMINI_KEY}) as r:
                if r.status == 429:
                    await asyncio.sleep(2 ** attempt * 5)
                    continue
                if r.status != 200:
                    print(f"  llm: HTTP {r.status} — falling back to regex",
                          file=sys.stderr)
                    return {}
                d = await r.json(content_type=None)
        except Exception as e:
            print(f"  llm: {type(e).__name__} — falling back to regex",
                  file=sys.stderr)
            return {}
        try:
            text = d["candidates"][0]["content"]["parts"][0]["text"]
            rows = json.loads(text.strip().strip("`").removeprefix("json"))
            return {r["i"]: r for r in rows if isinstance(r, dict) and "i" in r}
        except Exception:
            print("  llm: unparseable response — falling back to regex",
                  file=sys.stderr)
            return {}
    return {}


async def llm_classify(conn, postings, verbose=True):
    """Return {posting_hash: classification}. Cached rows never re-requested."""
    out, todo, seen = {}, [], set()
    for p in postings:
        h = posting_hash(p)
        if h in out or h in seen:
            continue
        row = conn.execute("SELECT payload FROM llm_cache WHERE hash=?",
                           (h,)).fetchone()
        if row:
            out[h] = json.loads(row[0])
        else:
            seen.add(h)
            todo.append(p)

    if not todo:
        return out
    if not GEMINI_KEY:
        if verbose:
            print("  llm: GEMINI_API_KEY not set — using regex classifier",
                  file=sys.stderr)
        return out

    budget = LlmBudget(conn)
    batches = [todo[i:i + LLM_BATCH] for i in range(0, len(todo), LLM_BATCH)]
    need = len(batches)
    if need > budget.remaining():
        if verbose:
            print(f"  llm: {need} calls needed, {budget.remaining()} left in "
                  f"today's budget — classifying what fits, regex for the rest",
                  file=sys.stderr)
        batches = batches[:budget.remaining()]
    if verbose and batches:
        print(f"  llm: {len(todo)} uncached postings -> {len(batches)} calls "
              f"({GEMINI_MODEL})")

    fails = 0
    async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=60)) as sess:
        for batch in batches:
            # Circuit breaker: a bad key or a dead endpoint would otherwise
            # burn one daily-quota slot per batch before giving up.
            if fails >= 2:
                if verbose:
                    print("  llm: 2 consecutive failures — aborting, regex for "
                          "the rest", file=sys.stderr)
                break
            indexed = list(enumerate(batch))
            res = await _llm_call(sess, budget, indexed)
            fails = 0 if res else fails + 1
            for i, p in indexed:
                if i not in res:
                    continue
                f = res[i]
                rec = {"is_intern": bool(f.get("is_intern")),
                       "is_tech": bool(f.get("is_tech")),
                       "category": f.get("category") or "other",
                       "term": f.get("term") or None,
                       "region": f.get("region") or "unknown"}
                h = posting_hash(p)
                out[h] = rec
                conn.execute("INSERT OR REPLACE INTO llm_cache VALUES(?,?,?)",
                             (h, json.dumps(rec), time.time()))
    conn.commit()
    return out


def dedup_key(p: "Posting") -> str:
    t = re.sub(r"\s*[-\u2013\u2014]\s*(us|usa|uk|emea|apac|commercial|defense tech|"
               r"us government|uk government|aus government|intel|infrastructure|"
               r"production infrastructure|france|poland).*$", "", p.title, flags=re.I)
    t = re.sub(r"\(.*?\)", "", t)
    t = re.sub(r"[^a-z0-9]+", "", t.lower())
    return f"{p.company}|{t}"


def group_roles(items, ts=None):
    """Collapse posting tuples into distinct roles, newest first.

    `items` are tuples whose first element is a Posting (extra elements ride
    along untouched). Groups by dedup_key; each returned group is sorted
    newest-first, as is the group list itself. `ts` maps an item to its sort
    timestamp (default: published, undated last). Shared by cmd_list and the
    Discord bot so the two frontends can't drift on what a "distinct role" is.
    """
    ts = ts or (lambda item: item[0].published or 0)
    groups = defaultdict(list)
    for item in items:
        groups[dedup_key(item[0])].append(item)
    out = list(groups.values())
    for g in out:
        g.sort(key=ts, reverse=True)
    out.sort(key=lambda g: ts(g[0]), reverse=True)
    return out


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------


async def fetch_all(etags=None, on_status=None, sector=None):
    etags = etags or {}
    boards = [b for b in BOARDS if not sector or b[3] == sector]
    sem = asyncio.Semaphore(CONCURRENCY)
    out, stats = [], {"ok": 0, "not_modified": 0, "error": 0, "new_etags": {}}

    async def one(sess, plat, slug, company, sect):
        async with sem:
            try:
                st, posts, et = await ADAPTERS[plat](
                    sess, slug, company, sect, etags.get((plat, slug)))
            except Exception as e:
                stats["error"] += 1
                if on_status:
                    on_status(plat, slug, company, f"ERR {type(e).__name__}", 0)
                return
        if st == 304:
            stats["not_modified"] += 1
            if on_status:
                on_status(plat, slug, company, "304", 0)
            return
        if st != 200:
            stats["error"] += 1
            if on_status:
                on_status(plat, slug, company, f"HTTP {st}", 0)
            return
        stats["ok"] += 1
        if et:
            stats["new_etags"][(plat, slug)] = et
        out.extend(posts)
        if on_status:
            on_status(plat, slug, company, "ok", len(posts))

    async with aiohttp.ClientSession(timeout=TIMEOUT, headers={"User-Agent": UA}) as s:
        await asyncio.gather(*(one(s, *b) for b in boards))
    return out, stats


def age_str(p):
    if not p.published:
        return "unknown"
    d = (time.time() - p.published) / 86400
    s = f"{d*24:.0f}h" if d < 1 else f"{d:.0f}d"
    if p.unbounded:
        return f"{s}+"
    return f"~{s}" if p.approx_date else s


def age_days(p) -> Optional[float]:
    return None if not p.published else (time.time() - p.published) / 86400


def select(posts, us_only, category, tech_only=True,
           max_age=MAX_AGE_DAYS, keep_undated=True, llm=None):
    """Filter to the roles worth showing.

    Age rule: drop a posting only if we KNOW it is older than max_age. Undated
    postings, and Workday's unbounded "30d+" bucket, are kept by default —
    dropping a real opening is worse than showing a stale one. keep_undated=False
    (--strict) drops them instead.
    """
    out, dropped_stale, dropped_undated = [], 0, 0
    for p in posts:
        # LLM result when we have one, regex otherwise. Per-posting, so a
        # partial batch or exhausted quota degrades gracefully instead of
        # taking the whole run down.
        c = (llm or {}).get(posting_hash(p)) or classify(p)
        if not c["is_intern"]:
            continue
        if tech_only and not c["is_tech"]:
            continue
        if us_only and c["region"] not in ("us", "unknown"):
            continue
        if category and c["category"] != category:
            continue
        if max_age:
            age = age_days(p)
            if age is None or p.unbounded:
                if not keep_undated:
                    dropped_undated += 1
                    continue
            elif age > max_age:
                dropped_stale += 1
                continue
        out.append((p, c))
    return out, {"stale": dropped_stale, "undated": dropped_undated}


# --------------------------------------------------------------------------
# YC discovery — the repos only surface companies a human already found, so
# startups posting their first internship are invisible. YC publishes an open
# dataset of every funded company; we derive slug candidates from it and probe
# directly. Measured hit rate ~13%, i.e. ~800 boards across the full 6k list.
#
# Two things this must get right:
#   1. Verification. Name-derived slugs collide with unrelated boards —
#      "agency", "juno" and "prosper" all resolve to some other company. Every
#      hit is checked against the YC record before being accepted.
#   2. Politeness. ~24k requests across the full dataset. This runs at low
#      concurrency with a permanent cache so it is a one-time overnight cost.
# --------------------------------------------------------------------------

YC_DATASET = "https://yc-oss.github.io/api/companies/all.json"
YC_CACHE = os.path.join(_HERE, "yc_cache.json")

# Slugs that are real boards but belong to somebody else. Anything short or
# dictionary-ish collides; require positive proof for these rather than
# trusting the name match.
AMBIGUOUS_SLUGS = {
    "agency", "juno", "prosper", "apex", "atlas", "orbit", "nova", "vertex",
    "summit", "pilot", "scout", "beacon", "anchor", "bridge", "compass",
    "spark", "pulse", "flow", "wave", "shift", "lattice", "prism", "cobalt",
    "onyx", "slate", "north", "found", "level", "range", "arc", "mach", "unit",
    "column", "vantage", "signal", "sonar", "radar", "helix", "quanta", "kite",
}


def _norm(x):
    return re.sub(r"[^a-z0-9]", "", (x or "").lower())


def yc_variants(c):
    out = set()
    for field in (c.get("slug") or "", c.get("name") or ""):
        b = re.sub(r"[^a-z0-9 -]", "", field.lower()).strip()
        if not b:
            continue
        out.add(b.replace(" ", ""))
        out.add(b.replace(" ", "-"))
    return {v for v in out if 2 < len(v) < 40}


YC_ENDPOINTS = {
    "greenhouse": "https://boards-api.greenhouse.io/v1/boards/{}/jobs",
    "lever": "https://api.lever.co/v0/postings/{}?mode=json",
    "ashby": "https://api.ashbyhq.com/posting-api/job-board/{}",
}


def yc_verify(company, plat, slug, jobs):
    """Return the evidence type if this board really belongs to `company`."""
    yc_name = _norm(company.get("name"))
    site = (company.get("website") or "").lower()
    site = re.sub(r"^https?://(www\.)?", "", site).split("/")[0]

    # Strongest: Greenhouse echoes the employer's own company_name per job.
    for j in jobs[:8]:
        cn = j.get("company_name") if isinstance(j, dict) else None
        if cn and _norm(cn) == yc_name:
            return "name"

    # Next: the apply/hosted URL points at the company's own domain.
    if site and "." in site:
        for j in jobs[:25]:
            u = (j.get("absolute_url") or j.get("hostedUrl")
                 or j.get("jobUrl") or j.get("applyUrl") or "")
            if site in u.lower():
                return "domain"

    # Lever and Ashby expose nothing identifying beyond the slug, but both
    # return description text, which almost always names the company.
    if len(yc_name) >= 4:
        for j in jobs[:4]:
            body = ((j.get("descriptionPlain") or "") + " " +
                    (j.get("description") or ""))[:6000]
            if body and yc_name in _norm(body):
                return "text"
            if site and "." in site and site in body.lower():
                return "text"

    # Weakest: exact match to the YC slug, and not a word that collides.
    if _norm(slug) == _norm(company.get("slug")) and len(slug) >= 6 \
            and slug.lower() not in AMBIGUOUS_SLUGS:
        return "slug"
    return None


async def mine_yc(sess, limit=None, concurrency=6, recheck=False):
    try:
        async with sess.get(YC_DATASET) as r:
            companies = await r.json(content_type=None)
    except Exception as e:
        print(f"  -- yc dataset               {type(e).__name__} (skipping)")
        return set()

    try:
        cache = {} if recheck else json.load(open(YC_CACHE))
    except (FileNotFoundError, json.JSONDecodeError):
        cache = {}

    todo = [c for c in companies if str(c.get("id")) not in cache]
    if limit:
        todo = todo[:limit]
    print(f"  {len(companies)} YC companies · {len(cache)} cached · "
          f"{len(todo)} to probe")
    if not todo:
        print("  (all cached — pass --yc-recheck to re-probe)")

    sem = asyncio.Semaphore(concurrency)
    done, rejected = [0], [0]

    async def probe(company):
        cid = str(company.get("id"))
        result = None
        for slug in sorted(yc_variants(company)):
            for plat, tmpl in YC_ENDPOINTS.items():
                async with sem:
                    try:
                        async with sess.get(tmpl.format(slug)) as r:
                            if r.status != 200:
                                continue
                            d = await r.json(content_type=None)
                    except Exception:
                        continue
                jobs = d if isinstance(d, list) else d.get("jobs", [])
                if not jobs:
                    continue
                ev = yc_verify(company, plat, slug, jobs)
                if ev:
                    result = [plat, slug, company.get("name") or slug, ev]
                    break
                rejected[0] += 1
            if result:
                break
        cache[cid] = result
        done[0] += 1
        if done[0] % 250 == 0:
            found = sum(1 for v in cache.values() if v)
            print(f"    {done[0]}/{len(todo)} probed · {found} verified boards · "
                  f"{rejected[0]} rejected by verification", flush=True)

    try:
        await asyncio.gather(*(probe(c) for c in todo))
    finally:
        with open(YC_CACHE, "w") as f:
            json.dump(cache, f)

    hits = [v for v in cache.values() if v]
    by_ev = defaultdict(int)
    for h in hits:
        by_ev[h[3]] += 1
    print(f"  {len(hits)} verified boards from YC "
          f"({', '.join(f'{k}={v}' for k, v in sorted(by_ev.items()))}) · "
          f"{rejected[0]} candidates rejected as collisions")
    return {(h[0], h[1]) for h in hits}


async def cmd_discover(min_interns, include_workday, use_cc, use_yc,
                       yc_limit=None, yc_recheck=False):
    async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=90),
            connector=aiohttp.TCPConnector(limit=25),
            headers={"User-Agent": UA}) as sess:
        print("mining slugs from repo listings...")
        cands, nbytes = await mine_repos(sess)
        if use_cc:
            print("\nquerying common crawl...")
            cands |= await mine_commoncrawl(sess)
        if use_yc:
            print("\nprobing YC companies (slow and polite; results are cached)...")
            cands |= await mine_yc(sess, yc_limit, recheck=yc_recheck)

        if not include_workday:
            cands = {c for c in cands if c[0] != "workday"}
        by_plat = defaultdict(int)
        for plat, _ in cands:
            by_plat[plat] += 1
        print(f"\n{len(cands)} unique slugs from {nbytes//1024//1024}MB: " +
              ", ".join(f"{k}={v}" for k, v in sorted(by_plat.items())))

        print("\nvalidating against live APIs (several minutes)...")
        sem = asyncio.Semaphore(25)
        keep, live, checked = [], 0, [0]

        async def check(plat, slug):
            nonlocal live
            async with sem:
                try:
                    st, posts, _ = await ADAPTERS[plat](sess, slug, slug, "unknown", None)
                except Exception:
                    return
                finally:
                    checked[0] += 1
                    if checked[0] % 500 == 0:
                        print(f"    {checked[0]}/{len(cands)} checked, "
                              f"{len(keep)} kept", flush=True)
            if st != 200 or not posts:
                return
            live += 1
            fresh = len(select(posts, False, None)[0])
            if fresh >= min_interns:
                keep.append([plat, slug, slug, "unknown", fresh])

        await asyncio.gather(*(check(p, s) for p, s in sorted(cands)))

    keep.sort(key=lambda r: -r[4])
    with open(BOARDS_FILE, "w") as f:
        json.dump([r[:4] for r in keep], f, indent=1)
    print(f"\n{live}/{len(cands)} boards live · {len(keep)} with >={min_interns} "
          f"fresh tech internship(s)")
    print(f"wrote {len(keep)} to {BOARDS_FILE} (+{len(SEED_BOARDS)} seed merged at load)")
    print("\ntop boards:")
    for plat, slug, _, _, n in keep[:20]:
        print(f"  {n:>3} fresh  {plat:<11}{slug}")
    print("\nSectors default to 'unknown' — edit boards.json to tag them.")

async def cmd_verify(sector):
    boards = [b for b in BOARDS if not sector or b[3] == sector]
    print(f"probing {len(boards)} boards...\n")
    rows = []
    posts, stats = await fetch_all(
        on_status=lambda p, s, c, st, n: rows.append((p, s, c, st, n)), sector=sector)

    interns = defaultdict(int)
    for p, _ in select(posts, False, None)[0]:
        interns[(p.platform, p.company)] += 1

    for plat, slug, company, status, n in sorted(rows, key=lambda r: (r[0], r[1])):
        i = interns.get((plat, company), 0)
        mark = "ok " if status == "ok" and i else ("-- " if status == "ok" else "!! ")
        print(f" {mark}{plat:<11}{slug[:30]:<32}{status:<9}{n:>5} jobs {i:>4} tech-intern")
    dead = [r for r in rows if r[3] not in ("ok", "304")]
    print(f"\n{stats['ok']} live · {len(dead)} failed · "
          f"{sum(interns.values())} tech internships posted in the last "
          f"{MAX_AGE_DAYS} days")


async def cmd_list(us_only, show_dupes, category, sector, all_roles,
                   max_age, strict, use_llm=False):
    posts, stats = await fetch_all(sector=sector)
    llm = (await llm_classify(db_init(), llm_candidates(posts))
           if use_llm else None)
    sel, drops = select(posts, us_only, category, tech_only=not all_roles,
                        max_age=max_age, keep_undated=not strict, llm=llm)

    by_sector = defaultdict(lambda: defaultdict(list))
    for items in group_roles(sel):
        by_sector[items[0][0].sector][items[0][0].company].append(items)

    total = 0
    for sect in sorted(by_sector):
        print(f"\n{'='*60}\n{sect.upper()}\n{'='*60}")
        for company in sorted(by_sector[sect]):
            print(f"\n{company}")
            for items in sorted(by_sector[sect][company],
                                key=lambda g: -(g[0][0].published or 0)):
                p, c = items[0]
                total += 1
                extra = f"  (+{len(items)-1} more)" if len(items) > 1 else ""
                term = f" · {c['term']}" if c["term"] else ""
                print(f"  {p.title}")
                print(f"    {p.location} · {c['category']}{term} · {c['region']} · "
                      f"posted {age_str(p)} ago{extra}")
                print(f"    {p.url}")
                if show_dupes:
                    for q, _ in items[1:]:
                        print(f"      + {q.location}  {q.url}")

    note = f" · ignored {drops['stale']} older than {max_age}d" if max_age else ""
    if drops["undated"]:
        note += f" · ignored {drops['undated']} undated"
    print(f"\n{total} distinct roles ({len(sel)} postings pre-dedup) "
          f"from {stats['ok']} boards · {stats['error']} errors{note}")


class SchemaMismatch(RuntimeError):
    """postings.db was created by a different SCHEMA_VERSION."""


def db_init():
    c = sqlite3.connect(DB_PATH)
    ver = c.execute("PRAGMA user_version").fetchone()[0]
    if ver and ver != SCHEMA_VERSION:
        # Raise instead of sys.exit: the CLI turns this into exit(1), while the
        # Discord bot disables the tracker rather than dying at import.
        raise SchemaMismatch(
            f"db schema v{ver} != v{SCHEMA_VERSION}. Delete {DB_PATH} and re-sweep.")
    c.executescript(f"""
        -- Permanent dedup ledger. Never pruned. ~40 bytes/row, so a decade of
        -- postings costs a few MB. This is what makes pruning safe: `postings`
        -- can be emptied without a single role being re-announced.
        CREATE TABLE IF NOT EXISTS seen(
          platform TEXT, external_id TEXT, first_seen REAL,
          PRIMARY KEY(platform, external_id));

        -- Prunable detail table. Only holds rows inside the retention window.
        CREATE TABLE IF NOT EXISTS postings(
          platform TEXT, external_id TEXT, company TEXT, sector TEXT, title TEXT,
          location TEXT, url TEXT, category TEXT, term TEXT, region TEXT,
          is_intern INT, is_tech INT, published REAL, unbounded INT,
          first_seen REAL, PRIMARY KEY(platform, external_id));
        CREATE INDEX IF NOT EXISTS idx_pub ON postings(published);

        CREATE TABLE IF NOT EXISTS llm_cache(
          hash TEXT PRIMARY KEY, payload TEXT, created REAL);
        CREATE TABLE IF NOT EXISTS llm_usage(day TEXT PRIMARY KEY, n INT);
        CREATE TABLE IF NOT EXISTS etags(
          platform TEXT, slug TEXT, etag TEXT, PRIMARY KEY(platform, slug));
        CREATE TABLE IF NOT EXISTS sweeps(
          started REAL, duration REAL, not_modified INT, errors INT,
          new_rows INT, pruned INT);
        PRAGMA user_version = {SCHEMA_VERSION};
    """)
    c.commit()
    return c


def prune(conn, days=PRUNE_DAYS, dry_run=False):
    """Delete rows older than `days` from `postings`.

    Never touches `seen`, so pruned roles stay deduped. Rows with no date, and
    Workday's unbounded "30d+" bucket, are left alone — we can't prove they're
    old, and deleting them would only lose data we already have.
    """
    cutoff = time.time() - days * 86400
    q = ("published IS NOT NULL AND unbounded=0 AND published < ?", (cutoff,))
    n = conn.execute(f"SELECT COUNT(*) FROM postings WHERE {q[0]}", q[1]).fetchone()[0]
    if not dry_run and n:
        conn.execute(f"DELETE FROM postings WHERE {q[0]}", q[1])
        conn.commit()
    return n


async def cmd_sweep(conn, quiet=False, use_llm=False):
    t0 = time.time()
    etags = {(r[0], r[1]): r[2] for r in conn.execute("SELECT * FROM etags")}
    posts, stats = await fetch_all(etags)

    # Dedup against `seen`, never against `postings` — postings gets pruned.
    # One ledger read instead of a SELECT per posting: this loop runs on the
    # Discord bot's event loop, so per-row round-trips add up fast.
    seen_ids = set(conn.execute("SELECT platform, external_id FROM seen"))

    # Classify the delta only — postings we have never seen. That is what keeps
    # this inside a free-tier budget: a busy day is tens of new rows, not
    # thousands of re-classified ones.
    llm = {}
    if use_llm:
        cand = llm_candidates(
            [p for p in posts if (p.platform, p.external_id) not in seen_ids])
        if cand:
            llm = await llm_classify(conn, cand, verbose=not quiet)

    for (plat, slug), et in stats["new_etags"].items():
        conn.execute("INSERT INTO etags VALUES(?,?,?) ON CONFLICT(platform,slug) "
                     "DO UPDATE SET etag=excluded.etag", (plat, slug, et))

    now, fresh, seen_rows, posting_rows = time.time(), [], [], []
    for p in posts:
        key = (p.platform, p.external_id)
        if key in seen_ids:
            continue
        seen_ids.add(key)   # also dedups repeats within this batch
        c = llm.get(posting_hash(p)) or classify(p)
        seen_rows.append((p.platform, p.external_id, now))
        posting_rows.append(
            (p.platform, p.external_id, p.company, p.sector, p.title,
             p.location, p.url, c["category"], c["term"], c["region"],
             int(c["is_intern"]), int(c["is_tech"]), p.published,
             int(p.unbounded), now))
        # Always store — the seen-set must cover stale rows too, or they'd
        # re-trigger as "new" on every sweep. Age only gates what we announce.
        age = age_days(p)
        if (c["is_intern"] and c["is_tech"]
                and (age is None or p.unbounded or age <= MAX_AGE_DAYS)):
            fresh.append((p, c))
    # OR IGNORE: a concurrent CLI/bot sweep racing on the same DB loses the
    # duplicate row instead of aborting the whole sweep with IntegrityError.
    conn.executemany("INSERT OR IGNORE INTO seen VALUES(?,?,?)", seen_rows)
    conn.executemany(
        "INSERT OR IGNORE INTO postings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        posting_rows)
    pruned = prune(conn)
    conn.execute("INSERT INTO sweeps VALUES(?,?,?,?,?,?)",
                 (t0, now - t0, stats["not_modified"], stats["error"],
                  len(fresh), pruned))
    conn.commit()

    if not quiet:
        pr = f" · pruned {pruned}" if pruned else ""
        print(f"[{datetime.now():%H:%M:%S}] {stats['ok']} fetched · "
              f"{stats['not_modified']} unchanged · {stats['error']} errors · "
              f"{len(fresh)} new{pr} · {now-t0:.1f}s")
        for p, c in fresh:
            print(f"  [{p.sector}] {p.company} — {p.title}")
            print(f"    {p.location} · {c['category']} · {c['region']} · "
                  f"posted {age_str(p)} ago")
            print(f"    {p.url}")
    return fresh


def cmd_stats(conn):
    tot, ints = conn.execute(
        "SELECT COUNT(*), SUM(is_intern AND is_tech) FROM postings").fetchone()
    ledger = conn.execute("SELECT COUNT(*) FROM seen").fetchone()[0]
    print(f"retained: {tot} postings · {ints or 0} tech internships")
    print(f"dedup ledger: {ledger} ids (never pruned)\n")
    print("by sector:")
    for row in conn.execute("SELECT sector, COUNT(*) FROM postings "
                            "WHERE is_intern=1 AND is_tech=1 GROUP BY 1 ORDER BY 2 DESC"):
        print(f"  {row[0]:<12} {row[1]}")
    print("\nby category / region:")
    for row in conn.execute("SELECT category, region, COUNT(*) FROM postings "
                            "WHERE is_intern=1 AND is_tech=1 GROUP BY 1,2 ORDER BY 3 DESC"):
        print(f"  {row[0]:<10} {row[1]:<9} {row[2]}")
    lags = sorted((r[0] - r[1]) / 60 for r in conn.execute(
        "SELECT first_seen, published FROM postings WHERE is_intern=1 AND is_tech=1 "
        "AND published IS NOT NULL AND platform != 'workday'") if r[0] > r[1])
    print("\ndetection lag, minutes (Workday excluded — day-level only):")
    if lags:
        print(f"  n={len(lags)} median={lags[len(lags)//2]:.0f} "
              f"min={lags[0]:.0f} max={lags[-1]:.0f}")
    else:
        print("  no data yet")
    print(f"\nage of retained internships (pruned at {PRUNE_DAYS}d):")
    for label, lo, hi in [("<3d", 0, 3), ("3-7d", 3, 7), ("7-14d", 7, 14),
                          ("14-30d", 14, 30)]:
        n = conn.execute(
            "SELECT COUNT(*) FROM postings WHERE is_intern=1 AND is_tech=1 "
            "AND published IS NOT NULL AND (?-published)/86400 >= ? "
            "AND (?-published)/86400 < ?",
            (time.time(), lo, time.time(), hi)).fetchone()[0]
        print(f"  {label:<16} {n}")

    cached = conn.execute("SELECT COUNT(*) FROM llm_cache").fetchone()[0]
    if cached:
        today = conn.execute("SELECT n FROM llm_usage WHERE day=?",
                             (datetime.now().strftime("%Y-%m-%d"),)).fetchone()
        print(f"\nllm cache: {cached} classified · {today[0] if today else 0} "
              f"api calls today (budget {LLM_RPD})")

    print("\nrecent sweeps:")
    for s in conn.execute("SELECT * FROM sweeps ORDER BY started DESC LIMIT 10"):
        print(f"  {datetime.fromtimestamp(s[0]):%m-%d %H:%M}  {s[1]:5.1f}s  "
              f"304s={s[2]:<3} err={s[3]:<3} new={s[4]:<4} pruned={s[5] or 0}")


async def cmd_llm_diff(conn, limit):
    """Run both classifiers over stored postings and show disagreements.

    This is how you decide whether the LLM is worth the dependency. Run it
    before switching `sweep` over to --llm."""
    rows = conn.execute(
        "SELECT platform, external_id, company, sector, title, location, url, "
        "published, unbounded FROM postings ORDER BY first_seen DESC LIMIT ?",
        (limit,)).fetchall()
    posts = [Posting(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7],
                     False, bool(r[8])) for r in rows]
    if not posts:
        print("no stored postings — run `sweep` first")
        return
    posts = llm_candidates(posts)
    print(f"comparing {len(posts)} candidate postings...\n")
    llm = await llm_classify(conn, posts)
    if not llm:
        print("no llm results (missing key or quota) — nothing to compare")
        return

    diffs = defaultdict(list)
    n = 0
    for p in posts:
        l = llm.get(posting_hash(p))
        if not l:
            continue
        n += 1
        r = classify(p)
        for field in ("is_intern", "is_tech", "category", "region", "term"):
            if r.get(field) != l.get(field):
                diffs[field].append((p, r.get(field), l.get(field)))

    print(f"{n} classified by both · "
          f"{sum(len(v) for v in diffs.values())} field disagreements\n")
    for field, items in sorted(diffs.items(), key=lambda kv: -len(kv[1])):
        print(f"{field}: {len(items)} disagreements")
        for p, rv, lv in items[:6]:
            print(f"  {p.title[:62]}")
            print(f"    {p.location[:50]}")
            print(f"    regex={rv!r}  llm={lv!r}")
        if len(items) > 6:
            print(f"  ... and {len(items)-6} more")
        print()
    print("Spot-check these by hand. Where the LLM is right, switch sweep to")
    print("--llm. Where it is wrong, tighten the prompt, not the regex.")


async def cmd_watch(conn, interval, use_llm=False):
    print(f"watching {len(BOARDS)} boards every {interval//60}m. Ctrl-C to stop.\n")
    while True:
        try:
            await cmd_sweep(conn, use_llm=use_llm)
        except Exception as e:
            print(f"sweep failed: {e}", file=sys.stderr)
        await asyncio.sleep(interval)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["verify", "list", "sweep", "watch", "stats",
                                    "prune", "discover", "llm-diff"])
    ap.add_argument("--us", action="store_true", help="US/remote only")
    ap.add_argument("--dupes", action="store_true", help="show collapsed duplicates")
    ap.add_argument("--category", help="swe|quant|hardware|data-ml|pm|other")
    ap.add_argument("--sector", help="tech|finance|healthcare|defense|industrial|retail|energy")
    ap.add_argument("--all-roles", action="store_true",
                    help="include non-technical internships")
    ap.add_argument("--max-age", type=int, default=MAX_AGE_DAYS,
                    help=f"ignore postings older than N days (default {MAX_AGE_DAYS}; 0 = no limit)")
    ap.add_argument("--strict", action="store_true",
                    help="also drop postings with unknown or unbounded dates")
    ap.add_argument("--dry-run", action="store_true", help="prune: count only")
    ap.add_argument("--min-interns", type=int, default=1,
                    help="discover: keep boards with at least N fresh internships")
    ap.add_argument("--workday", action="store_true",
                    help="discover: also validate mined Workday triples (slow)")
    ap.add_argument("--common-crawl", action="store_true",
                    help="discover: also query Common Crawl (often 503; best-effort)")
    ap.add_argument("--yc", action="store_true",
                    help="discover: probe YC's 6k open company dataset (slow, cached)")
    ap.add_argument("--yc-limit", type=int,
                    help="discover: only probe N uncached YC companies this run")
    ap.add_argument("--yc-recheck", action="store_true",
                    help="discover: ignore yc_cache.json and re-probe everything")
    ap.add_argument("--llm", action="store_true",
                    help="classify with Gemini instead of regex (needs GEMINI_API_KEY)")
    ap.add_argument("--limit", type=int, default=200,
                    help="llm-diff: how many stored postings to compare")
    ap.add_argument("--interval", type=int, default=900)
    a = ap.parse_args()

    try:
        if a.cmd == "discover":
            asyncio.run(cmd_discover(a.min_interns, a.workday, a.common_crawl,
                                     a.yc, a.yc_limit, a.yc_recheck))
        elif a.cmd == "verify":
            asyncio.run(cmd_verify(a.sector))
        elif a.cmd == "list":
            asyncio.run(cmd_list(a.us, a.dupes, a.category, a.sector, a.all_roles,
                                 a.max_age, a.strict, a.llm))
        elif a.cmd == "stats":
            cmd_stats(db_init())
        elif a.cmd == "prune":
            conn = db_init()
            n = prune(conn, a.max_age or PRUNE_DAYS, a.dry_run)
            print(f"{'would prune' if a.dry_run else 'pruned'} {n} rows older than "
                  f"{a.max_age or PRUNE_DAYS}d · dedup ledger untouched")
        elif a.cmd == "sweep":
            asyncio.run(cmd_sweep(db_init(), use_llm=a.llm))
        elif a.cmd == "llm-diff":
            asyncio.run(cmd_llm_diff(db_init(), a.limit))
        else:
            try:
                asyncio.run(cmd_watch(db_init(), a.interval, use_llm=a.llm))
            except KeyboardInterrupt:
                print("\nstopped.")
    except SchemaMismatch as e:
        print(e, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
