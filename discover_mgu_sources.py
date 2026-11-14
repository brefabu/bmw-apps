#!/usr/bin/env python3
"""
Discover GitHub repositories that can be added as sources in the MGU Store
(robertnisipeanu/mgu-store), and check which source layout each one offers.

The Store reads a GitHub source in one of three layouts (docs/PUBLISHING.md):
  * Repo tree  - mgu-repo.json at the repository root (followed on a branch or on x.y.z tags)
  * Catalog    - a catalog.json attached to a GitHub release named "catalog"
  * Releases   - <id>@<semver>.tgz / .mgu packages attached to GitHub releases

How it works
  1. Collect candidates: GitHub code search (manifest files the Store reads),
     GitHub repository search (keywords) and the links in the community list
     FidelisClayton/awesome-bmw-mgu.
  2. Verify each candidate without the per-repo REST API:
       - `git ls-remote` for the default branch and tags (a "catalog" tag means a catalog release),
       - raw.githubusercontent.com for mgu-repo.json / a committed catalog.json,
       - the public release download URL for releases/download/catalog/catalog.json.
  3. Write results.json and results.csv.

Needs: python3, git, and a GitHub token for the search API (GH_TOKEN / GITHUB_TOKEN,
or the `gh` CLI logged in). Code search is rate-limited to 10 requests/minute.

Usage:  python3 discover_mgu_sources.py [--out DIR] [--extra owner/repo ...]
"""
import argparse, collections, concurrent.futures as cf, csv, json, os, re, subprocess, sys, time, urllib.request, urllib.error

UA = {"User-Agent": "mgu-source-discovery"}

CODE_QUERIES = [
    "filename:mgu-repo.json",
    "filename:mgu-app.json",
    "mguHmi filename:component.json",
    "mguHmi filename:catalog.json",
    "mguHmi filename:package.json",
    "mguHmi filename:app.json",
    "mgu-store filename:README.md",
]
REPO_QUERIES = [
    "mgu store", "mgu-store", "mgu-apps", "mgu apps bmw", "mgu bmw",
    "idrive 7", "idrive7", "idrive 8", "idrive8", "iDrive MGU", "id7 apps", "id8 apps",
    "topic:mgu-store", "topic:idrive7", "topic:idrive", "topic:bmw-mgu",
]
AWESOME = "FidelisClayton/awesome-bmw-mgu"
SEMVER_TAG = re.compile(r"^(?:v|[A-Za-z0-9_.-]+@)?(\d+)\.(\d+)\.(\d+)$")


# ---------- GitHub search API ----------
def _token():
    for k in ("GH_TOKEN", "GITHUB_TOKEN"):
        if os.environ.get(k):
            return os.environ[k]
    try:
        return subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=10).stdout.strip() or None
    except Exception:
        return None


def gh_search(kind, q, per_page=100, max_pages=3):
    """kind: 'code' or 'repositories'. Uses `gh api` when available (handles proxies/auth), else urllib."""
    items, page = [], 1
    while page <= max_pages:
        for attempt in range(4):
            try:
                out = subprocess.run(
                    ["gh", "api", "-X", "GET", f"search/{kind}", "-f", f"q={q}",
                     "-f", f"per_page={per_page}", "-f", f"page={page}"],
                    capture_output=True, text=True, timeout=60)
                data = json.loads(out.stdout) if out.stdout.strip().startswith("{") else {}
            except FileNotFoundError:
                req = urllib.request.Request(
                    f"https://api.github.com/search/{kind}?" + urllib.parse.urlencode(
                        {"q": q, "per_page": per_page, "page": page}),
                    headers={**UA, **({"Authorization": f"Bearer {_token()}"} if _token() else {})})
                try:
                    data = json.load(urllib.request.urlopen(req, timeout=60))
                except urllib.error.HTTPError as e:
                    data = {"message": str(e)}
            if "items" in data:
                break
            msg = data.get("message", "")
            if "rate limit" in msg.lower() or "secondary" in msg.lower():
                time.sleep(65)
                continue
            print(f"  ! search failed ({kind}: {q}): {msg[:120]}", file=sys.stderr)
            return items
        else:
            return items
        items += data["items"]
        if len(data["items"]) < per_page or len(items) >= data.get("total_count", 0):
            break
        page += 1
        time.sleep(7 if kind == "code" else 2.5)
    return items


# ---------- plain HTTPS / git reads ----------
def http_get(url, limit=4_000_000):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
            return r.read(limit)
    except Exception:
        return None


def ls_remote(repo):
    try:
        out = subprocess.run(["git", "ls-remote", "--symref", f"https://github.com/{repo}"],
                             capture_output=True, text=True, timeout=90,
                             env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    except subprocess.TimeoutExpired:
        return None
    if out.returncode != 0:
        return None
    default, tags = None, set()
    for line in out.stdout.splitlines():
        if line.startswith("ref: ") and line.endswith("\tHEAD"):
            default = line[5:].split("\t")[0].removeprefix("refs/heads/")
        elif "\trefs/tags/" in line:
            tags.add(line.split("\trefs/tags/")[1].removesuffix("^{}"))
    return {"default_branch": default, "tags": sorted(tags)}


def _hmi(obj, acc):
    """Collect every mguHmi value found anywhere in a manifest."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "mguHmi":
                for h in (v if isinstance(v, list) else [v]):
                    acc.add(str(h))
            else:
                _hmi(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            _hmi(v, acc)
    return acc


MANIFESTS = ("mgu-app.json", "app.json", "package.json", "package/package.json", "component.json")
CLONES = os.environ.get("MGU_DISCOVERY_CLONES", "clones")


def _readjson(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _title(m):
    for k in ("title", "displayName", "name"):
        v = m.get(k)
        if isinstance(v, str) and v:
            return v
        if isinstance(v, dict):  # localized titles
            return v.get("en") or v.get("en_GB") or next(iter(v.values()), "")
    return ""


def _item_from_dir(d, cid, kind, entry, manifest_name=None):
    """Read a component's own manifest(s) for title and mguHmi; the mgu-repo.json entry wins."""
    names = ([manifest_name] if manifest_name else []) + list(MANIFESTS)
    hmi, title, version = set(), "", ""
    for n in names:
        m = _readjson(os.path.join(d, n))
        if isinstance(m, dict):
            _hmi(m, hmi)
            title = title or _title(m)
            version = version or str(m.get("version", ""))
            cid = cid or m.get("id")
    if isinstance(entry, dict):
        _hmi(entry, hmi)
        title = entry.get("title") or title
    return {"id": cid or os.path.basename(d), "kind": kind, "title": title, "version": version, "hmi": sorted(hmi)}


def repo_tree_items(repo, manifest):
    """Blobless shallow clone + sparse checkout of the manifests only, then expand every component."""
    d = os.path.join(CLONES, repo.replace("/", "__"))
    if not os.path.isdir(d):
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1"}
        try:
            subprocess.run(["git", "clone", "-q", "--depth", "1", "--filter=blob:none", "--no-checkout",
                            f"https://github.com/{repo}", d], check=True, capture_output=True, timeout=180, env=env)
            subprocess.run(["git", "-C", d, "sparse-checkout", "set", "--no-cone", "/mgu-repo.json",
                            *[f"**/{n}" for n in MANIFESTS]], check=True, capture_output=True, timeout=60, env=env)
            subprocess.run(["git", "-C", d, "checkout", "-q"], check=True, capture_output=True, timeout=300, env=env)
        except Exception:
            return None
    items, base_hmi = [], _hmi({k: v for k, v in manifest.items() if k not in ("components", "tools", "apps")}, set())
    for c in manifest.get("components") or []:
        if isinstance(c, dict):
            items.append(_item_from_dir(os.path.join(d, c.get("path", "")), c.get("id"), c.get("kind", "app"), c))
    apps = manifest.get("apps")
    if isinstance(apps, dict) and apps.get("path"):
        parent = os.path.join(d, apps["path"].rstrip("*").rstrip("/"))
        excl = set(apps.get("exclude") or [])
        mname = apps.get("manifest")
        if os.path.isdir(parent):
            for sub in sorted(os.listdir(parent)):
                p = os.path.join(parent, sub)
                if sub in excl or not os.path.isdir(p):
                    continue
                if mname and not os.path.exists(os.path.join(p, mname)):
                    continue
                it = _item_from_dir(p, sub, "app", None, mname)
                it["hmi"] = sorted(set(it["hmi"]) | set(_hmi(apps, set())))
                items.append(it)
    for t in manifest.get("tools") or []:
        if isinstance(t, dict):
            items.append(_item_from_dir(os.path.join(d, t.get("path", "")), t.get("id"), "tool", t))
    for it in items:
        if not it["hmi"] and base_hmi:
            it["hmi"] = sorted(base_hmi)
    return items


def verify(repo):
    r = {"repo": repo, "url": f"https://github.com/{repo}", "reachable": False, "layouts": [],
         "channel_to_add": "", "mguHmi": "", "components": "", "n_components": 0,
         "highest_semver_tag": "", "default_branch": "", "notes": "", "n_apps": 0, "n_tools": 0,
         "n_for_ID7": 0, "n_for_ID8": 0, "n_unspecified": 0, "items": []}
    refs = ls_remote(repo)
    if not refs:
        r["notes"] = "not reachable (private, renamed or deleted)"
        return r
    r["reachable"] = True
    r["default_branch"] = refs["default_branch"] or ""
    semver = sorted((tuple(map(int, m.groups())), t) for t in refs["tags"] if (m := SEMVER_TAG.match(t)))
    if semver:
        r["highest_semver_tag"] = semver[-1][1]
    items, notes = {}, []  # id -> {id, kind, title, version, hmi}

    branch = refs["default_branch"] or "HEAD"
    raw = http_get(f"https://raw.githubusercontent.com/{repo}/{branch}/mgu-repo.json")
    if raw:
        try:
            m = json.loads(raw)
            r["layouts"].append("repo-tree")
            tree_items = repo_tree_items(repo, m)
            if tree_items is None:
                notes.append("could not clone to read per-app manifests")
                tree_items = [{"id": c.get("id"), "kind": c.get("kind", "app"), "title": c.get("title", ""),
                               "version": "", "hmi": sorted(_hmi(c, set()))}
                              for c in (m.get("components") or []) + (m.get("tools") or []) if isinstance(c, dict)]
            for it in tree_items:
                items[it["id"]] = it
        except Exception:
            notes.append("mgu-repo.json present but not valid JSON")

    has_catalog_release = "catalog" in refs["tags"]
    cat = None
    if has_catalog_release:
        cat = http_get(f"https://github.com/{repo}/releases/download/catalog/catalog.json")
        if cat:
            r["layouts"].append("catalog-release")
        else:
            notes.append("'catalog' tag but no catalog.json asset readable")
    if not cat:
        committed = http_get(f"https://raw.githubusercontent.com/{repo}/{branch}/catalog.json")
        if committed:
            cat = committed
            notes.append("catalog.json committed in the tree (the Store reads it only from a 'catalog' release or an https URL)")
    if cat:
        try:
            c = json.loads(cat)
            for comp in c.get("components", []) or c.get("packages", []):
                if comp.get("id"):
                    prev = items.get(comp["id"], {})
                    items[comp["id"]] = {"id": comp["id"], "kind": comp.get("kind", "app"),
                                         "title": comp.get("title") or prev.get("title", ""),
                                         "version": str(comp.get("version", "")) or prev.get("version", ""),
                                         "hmi": sorted(_hmi(comp, set()) or set(prev.get("hmi", [])))}
        except Exception:
            notes.append("catalog.json not valid JSON")

    if not r["layouts"] and semver:
        # Releases layout: the per-repo API is not needed. The optional mgu-store.json release asset
        # (titles/icons for the Store) proves it; a README pointing at the Store makes it likely.
        tag = semver[-1][1]
        ms = http_get(f"https://github.com/{repo}/releases/download/{tag}/mgu-store.json")
        try:
            ms = json.loads(ms) if ms else None
        except Exception:
            ms = None
        if isinstance(ms, dict) and isinstance(ms.get("apps"), dict):
            r["layouts"].append("releases")
            for aid, a in ms["apps"].items():
                items[aid] = {"id": aid, "kind": "app", "title": (a or {}).get("title", ""), "version": "",
                              "hmi": sorted(_hmi(a or {}, set()))}
        else:
            readme = (http_get(f"https://raw.githubusercontent.com/{repo}/{branch}/README.md") or b"").decode("utf-8", "replace")
            pkg_tag = re.fullmatch(r"[A-Za-z0-9_.-]+@\d+\.\d+\.\d+", tag)
            if pkg_tag or re.search(r"(?i)add (it as a |as a )?source|as a source in|Settings\s*(→|->|>)\s*\**Add source", readme):
                r["layouts"].append("releases?")
                notes.append("x.y.z release tags and the README/tag names point at the Store; assets not listed (no mgu-store.json)")
            else:
                notes.append("has x.y.z tags but nothing points at the Store (probably not a source)")

    if "catalog-release" in r["layouts"]:
        r["channel_to_add"] = "Releases"
    elif "repo-tree" in r["layouts"]:
        r["channel_to_add"] = "Tags" if semver else f"branch ({branch})"
    elif "releases" in r["layouts"]:
        r["channel_to_add"] = "Releases"
    elif "releases?" in r["layouts"]:
        r["channel_to_add"] = "Releases (unconfirmed)"

    its = list(items.values())
    hmi = set().union(*[set(i["hmi"]) for i in its]) if its else set()
    r["mguHmi"] = ",".join(sorted(hmi)) or ("unspecified" if r["layouts"] else "")
    r["n_apps"] = sum(i["kind"] == "app" for i in its)
    r["n_tools"] = sum(i["kind"] != "app" for i in its)
    r["n_for_ID7"] = sum("ID7" in i["hmi"] for i in its)
    r["n_for_ID8"] = sum("ID8" in i["hmi"] for i in its)
    r["n_unspecified"] = sum(not i["hmi"] for i in its)
    r["n_components"] = len(its)

    def label(i):
        t = i["title"] if i["title"] and i["title"] != i["id"] else ""
        tag = "/".join(h.replace("ID", "") for h in i["hmi"]) or "?"
        return f"{t + ' ' if t else ''}({i['id']}{', tool' if i['kind'] != 'app' else ''}; ID{tag})"
    r["components"] = "; ".join(label(i) for i in its[:60]) + (" …" if len(its) > 60 else "")
    r["items"] = its
    r["notes"] = "; ".join(notes)
    return r


# ---------- candidate collection ----------
def collect(extra):
    meta = {}  # full_name -> repo metadata from search

    def add(full, item=None, via=""):
        full = full.strip().strip("/")
        if not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+", full):
            return
        key = full.lower()
        e = meta.setdefault(key, {"repo": full, "found_via": set()})
        e["found_via"].add(via)
        if item:
            for k in ("description", "stargazers_count", "pushed_at", "fork", "archived", "language"):
                if k in item:
                    e[k] = item[k]

    for q in CODE_QUERIES:
        print(f"code search: {q}", file=sys.stderr)
        for it in gh_search("code", q):
            add(it["repository"]["full_name"], None, "code:" + q.split()[-1])
        time.sleep(7)
    for q in REPO_QUERIES:
        print(f"repo search: {q}", file=sys.stderr)
        for it in gh_search("repositories", q, max_pages=2):
            add(it["full_name"], it, "repo-search")
        time.sleep(2.5)
    readme = http_get(f"https://raw.githubusercontent.com/{AWESOME}/HEAD/README.md")
    if readme:
        for m in re.finditer(r"https://github\.com/([A-Za-z0-9-]+/[A-Za-z0-9._-]+?)(?:[/#)\s]|\.git)", readme.decode("utf-8", "replace")):
            add(m.group(1), None, "awesome-bmw-mgu")
    for x in extra:
        add(x, None, "extra")
    return meta


def fill_metadata(meta):
    """Repos found only via code search / the list have no stars or dates: look them up in batches."""
    missing = [e["repo"] for e in meta.values() if "stargazers_count" not in e]
    for i in range(0, len(missing), 6):
        q = " ".join(f"repo:{r}" for r in missing[i:i + 6]) + " fork:true"
        for it in gh_search("repositories", q, max_pages=1):
            e = meta.get(it["full_name"].lower())
            if e:
                for k in ("description", "stargazers_count", "pushed_at", "fork", "archived", "language"):
                    e[k] = it.get(k)
        time.sleep(2.5)


def awesome_labels():
    """repo -> the safety labels FidelisClayton/awesome-bmw-mgu gives it (`🚗 car-tested` `🔓 root tool` …)."""
    out = {}
    readme = http_get(f"https://raw.githubusercontent.com/{AWESOME}/HEAD/README.md")
    if not readme:
        return out
    for line in readme.decode("utf-8", "replace").splitlines():
        m = re.match(r"\s*- \[[^\]]*\]\(https://github\.com/([A-Za-z0-9-]+/[A-Za-z0-9._-]+?)(?:[/#][^)]*)?\)", line)
        if m:
            tags = re.findall(r"`([^`]+)`", line)
            tags = [t for t in tags if any(ch in t for ch in "📱🔓✍🌐🚗🧪❓📦") or t in ("ID7", "ID8")]
            extra = re.findall(r"`(?:🚗 car-tested|🧪 not car-tested)` \(([^)]+)\)", line)
            val = " ".join(tags) + (f" [{'; '.join(extra)}]" if extra else "")
            # a repo can be linked twice (e.g. again under "App development" with no labels): keep the labelled entry
            if val or m.group(1).lower() not in out:
                out[m.group(1).lower()] = val or out.get(m.group(1).lower(), "")
    return out


def classify(results):
    """status: verified / likely / store-fork / empty / not a source; copy_of: mostly repeats a bigger source."""
    seen = {}  # app id -> first (most-starred) repo that has it
    for r in results:
        ids = [i["id"] for i in r.get("items", []) if i["kind"] == "app"]
        ids_all = [i["id"] for i in r.get("items", [])]
        earlier = collections.Counter(seen[i] for i in ids if i in seen)
        r["copy_of"] = ""
        if ids and earlier:
            top, n = earlier.most_common(1)[0]
            if n / len(ids) >= 0.5 and top.split("/")[0].lower() != r["repo"].split("/")[0].lower():
                r["copy_of"] = f"{top} ({n}/{len(ids)} app ids)"
        for i in ids:
            seen.setdefault(i, r["repo"])
        if not r["layouts"]:
            r["status"] = "not a source"
        elif set(ids_all) <= {"robertn_store"} and ids_all:
            r["status"] = "store fork"
        elif not ids_all and "releases?" not in r["layouts"]:
            r["status"] = "empty"
        elif "releases?" in r["layouts"]:
            r["status"] = "likely"
        else:
            r["status"] = "verified"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out")
    ap.add_argument("--extra", nargs="*", default=[])
    ap.add_argument("--cached", action="store_true", help="reuse OUT/candidates.json instead of searching again")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    global CLONES
    CLONES = os.path.join(a.out, "clones")
    cpath = os.path.join(a.out, "candidates.json")

    if a.cached and os.path.exists(cpath):
        meta = {k: {**v, "found_via": set(v["found_via"])} for k, v in json.load(open(cpath)).items()}
        for x in a.extra:
            meta.setdefault(x.lower(), {"repo": x, "found_via": {"extra"}})
    else:
        meta = collect(a.extra)
        print(f"{len(meta)} candidates; filling metadata…", file=sys.stderr)
        fill_metadata(meta)
        json.dump({k: {**v, "found_via": sorted(v["found_via"])} for k, v in meta.items()}, open(cpath, "w"), indent=1)
    print("verifying…", file=sys.stderr)
    with cf.ThreadPoolExecutor(12) as ex:
        results = list(ex.map(verify, [e["repo"] for e in meta.values()]))
    labels = awesome_labels()
    for r in results:
        e = meta[r["repo"].lower()]
        r["awesome_labels"] = labels.get(r["repo"].lower(), "")
        r.update({
            "stars": e.get("stargazers_count", ""), "last_push": (e.get("pushed_at") or "")[:10],
            "fork": e.get("fork", ""), "archived": e.get("archived", ""),
            "description": (e.get("description") or "").replace("\n", " "),
            "found_via": ", ".join(sorted(e["found_via"])),
        })
    results.sort(key=lambda r: (not r["layouts"], -(r["stars"] or 0) if isinstance(r["stars"], int) else 0))
    classify(results)
    with open(os.path.join(a.out, "results.json"), "w") as f:
        json.dump(results, f, indent=1, default=list)
    cols = ["repo", "url", "status", "layouts", "channel_to_add", "mguHmi", "n_apps", "n_tools", "n_for_ID7", "n_for_ID8",
            "n_unspecified", "components",
            "highest_semver_tag", "default_branch", "stars", "last_push", "fork", "archived",
            "copy_of", "awesome_labels", "description", "found_via", "reachable", "notes"]
    with open(os.path.join(a.out, "results.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in results:
            w.writerow({k: (" + ".join(r[k]) if isinstance(r[k], list) else r[k]) for k in cols})
    st = collections.Counter(r["status"] for r in results)
    print(f"done: {len(results)} candidates: {dict(st)} -> {a.out}/results.csv", file=sys.stderr)


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (used by the urllib fallback)
    main()
