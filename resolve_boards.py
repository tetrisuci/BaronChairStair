#!/usr/bin/env python3
"""
Resolve a company's careers page to a POLLABLE job board, with validation.

Guessing ATS slugs does not work (~1 in 20 hit rate), and asking an LLM for
them is worse — it returns confident, well-formed, entirely fabricated URLs
(0 of 13 validated). So this tool never guesses: you paste the careers URLs you
actually see in a browser, and it does the mechanical part — follow redirects,
fingerprint the ATS, find the JSON endpoint, and CONFIRM it returns real jobs.
Only validated entries are emitted.

    # one URL
    python resolve_boards.py https://careers.rivian.com

    # many, from a file (one per line; blank lines and #comments ignored;
    # optional "Company Name = url" to override the detected name)
    python resolve_boards.py --file careers_urls.txt

    # emit registry rows ready to paste into BENNXT_BOARDS
    python resolve_boards.py --file careers_urls.txt --emit

Supported: greenhouse, lever, ashby, workday (already pollable today) and
icims (needs the adapter in internship_poller.fetch_icims).
"""
import argparse
import asyncio
import json
import re
import sys
from urllib.parse import urlparse

import aiohttp

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
HEADERS = {"User-Agent": UA,
           "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"}

# ATS fingerprints, checked against the final URL and the page HTML.
FINGERPRINTS = [
    ("greenhouse", r"(?:boards|job-boards)\.greenhouse\.io/([a-z0-9_-]+)"),
    ("lever",      r"jobs\.lever\.co/([a-z0-9_-]+)"),
    ("ashby",      r"jobs\.ashbyhq\.com/([^/?#\"']+)"),
    ("workday",    r"([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/"
                   r"(?:[a-z]{2}-[A-Z]{2}/)?([A-Za-z0-9_-]+)"),
    ("icims",      r"([a-z0-9-]+)\.icims\.com"),
    ("taleo",      r"([a-z0-9-]+)\.taleo\.net"),
    ("successfactors", r"([a-z0-9-]+)\.(?:successfactors|sapsf)\.com"),
    ("eightfold",  r"([a-z0-9.-]+)\.eightfold\.ai"),
    ("phenom",     r"([a-z0-9.-]+)\.phenompeople\.com"),
    ("smartrecruiters", r"smartrecruiters\.com/([A-Za-z0-9_-]+)"),
    ("avature",    r"([a-z0-9-]+)\.avature\.net"),
    ("oracle",     r"([a-z0-9-]+)\.oraclecloud\.com"),
]

# Where each ATS actually serves JSON, relative to the careers host.
ICIMS_API = "{origin}/api/jobs?page=1&limit={n}"


async def _get(sess, url, as_json=False):
    try:
        async with sess.get(url, allow_redirects=True) as r:
            body = await r.text()
            return r.status, str(r.url), body
    except Exception as e:
        return None, url, f"__ERROR__{type(e).__name__}"


def _fingerprint(final_url, body):
    """Return (ats, identifier) or (None, None)."""
    hay = f"{final_url}\n{body[:400000]}"
    for ats, pat in FINGERPRINTS:
        m = re.search(pat, hay, re.I)
        if not m:
            continue
        if ats == "workday":
            return ats, f"{m.group(1)}/{m.group(2)}/{m.group(3)}"
        return ats, m.group(1)
    return None, None


async def _validate(sess, ats, ident, origin):
    """Confirm the board really serves jobs. Returns (ok, n_jobs, detail)."""
    if ats == "greenhouse":
        st, _, body = await _get(
            sess, f"https://boards-api.greenhouse.io/v1/boards/{ident}/jobs")
        if st == 200:
            n = len(json.loads(body).get("jobs", []))
            return n > 0, n, f"greenhouse:{ident}"
    elif ats == "lever":
        st, _, body = await _get(
            sess, f"https://api.lever.co/v0/postings/{ident}?mode=json")
        if st == 200:
            n = len(json.loads(body))
            return n > 0, n, f"lever:{ident}"
    elif ats == "ashby":
        st, _, body = await _get(
            sess, f"https://api.ashbyhq.com/posting-api/job-board/{ident}")
        if st == 200:
            n = len(json.loads(body).get("jobs", []))
            return n > 0, n, f"ashby:{ident}"
    elif ats == "workday":
        try:
            tenant, wd, site = ident.split("/")
        except ValueError:
            return False, 0, ident
        url = (f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/"
               f"{tenant}/{site}/jobs")
        try:
            async with sess.post(url, json={"appliedFacets": {}, "limit": 5,
                                            "offset": 0, "searchText": ""},
                                 headers={"Accept": "application/json"}) as r:
                if r.status == 200:
                    d = await r.json(content_type=None)
                    n = d.get("total") or len(d.get("jobPostings", []))
                    return n > 0, n, f"workday:{ident}"
        except Exception:
            pass
    elif ats == "icims":
        # The JSON API sits on the company's careers host, not *.icims.com.
        st, _, body = await _get(sess, ICIMS_API.format(origin=origin, n=5))
        if st == 200 and body.lstrip().startswith("{"):
            try:
                d = json.loads(body)
            except Exception:
                return False, 0, origin
            n = d.get("count") or len(d.get("jobs", []))
            if n:
                return True, n, f"icims:{origin}"
    return False, 0, ident


async def resolve(sess, url, name=None):
    if not url.startswith("http"):
        url = "https://" + url
    st, final, body = await _get(sess, url)
    if st != 200:
        return {"input": url, "ok": False, "why": f"HTTP {st}", "name": name}
    origin = f"{urlparse(final).scheme}://{urlparse(final).netloc}"
    ats, ident = _fingerprint(final, body)
    if not ats:
        # Some careers sites only reveal the ATS on a job-listing subpage.
        for path in ("/jobs", "/search", "/jobs/search", "/careers/jobs"):
            st2, final2, body2 = await _get(sess, origin + path)
            if st2 == 200:
                ats, ident = _fingerprint(final2, body2)
                if ats:
                    break
    if not ats:
        return {"input": url, "ok": False, "why": "no ATS fingerprint found",
                "name": name, "origin": origin}
    ok, n, detail = await _validate(sess, ats, ident, origin)
    return {"input": url, "ok": ok, "ats": ats, "ident": ident, "jobs": n,
            "detail": detail, "name": name or urlparse(final).netloc,
            "origin": origin,
            "why": "" if ok else f"{ats} detected but no jobs returned"}


def _read_targets(path):
    out = []
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line and not line.split("=", 1)[1].strip().startswith("//"):
            name, url = line.split("=", 1)
            out.append((url.strip(), name.strip()))
        else:
            out.append((line, None))
    return out


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("urls", nargs="*", help="careers URLs to resolve")
    ap.add_argument("--file", help="file of careers URLs, one per line")
    ap.add_argument("--emit", action="store_true",
                    help="print BENNXT_BOARDS rows for validated boards")
    ap.add_argument("--sector", default="aec")
    a = ap.parse_args()

    targets = [(u, None) for u in a.urls]
    if a.file:
        targets += _read_targets(a.file)
    if not targets:
        print(__doc__.strip(), file=sys.stderr)
        sys.exit(2)

    conn = aiohttp.TCPConnector(limit=6)
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=40),
                                     connector=conn, headers=HEADERS) as sess:
        sem = asyncio.Semaphore(6)

        async def one(u, n):
            async with sem:
                return await resolve(sess, u, n)

        results = await asyncio.gather(*(one(u, n) for u, n in targets))

    good = [r for r in results if r["ok"]]
    for r in results:
        if r["ok"]:
            print(f"  ok  {r['name'][:26]:<28} {r['ats']:<15} "
                  f"{str(r['ident'])[:40]:<42} {r['jobs']} jobs")
        else:
            print(f"  --  {(r.get('name') or r['input'])[:26]:<28} "
                  f"{r.get('ats') or '?':<15} {r['why']}")
    print(f"\n{len(good)}/{len(results)} resolved to a validated, pollable board")

    if a.emit and good:
        print("\n# paste into BENNXT_BOARDS in internship_poller.py")
        for r in good:
            if r["ats"] == "icims":
                print(f'    ("icims", "{r["origin"]}",'.ljust(58) +
                      f'"{r["name"]}", "{a.sector}"),')
            elif r["ats"] in ("greenhouse", "lever", "ashby", "workday"):
                print(f'    ("{r["ats"]}", "{r["ident"]}",'.ljust(58) +
                      f'"{r["name"]}", "{a.sector}"),')
        unsupported = {r["ats"] for r in good
                       if r["ats"] not in ("greenhouse", "lever", "ashby",
                                           "workday", "icims")}
        if unsupported:
            print(f"\n# needs a new adapter: {', '.join(sorted(unsupported))}")


if __name__ == "__main__":
    asyncio.run(main())
