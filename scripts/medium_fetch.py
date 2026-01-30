#!/usr/bin/env python3
"""Medium fetcher: Playwright → cleaned Markdown/JSON/text with local images."""
import argparse
import base64
import json
import os
import random
import re
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse

import html2text
import requests
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
try:
    from curl_cffi import requests as cffi_requests
except Exception:
    cffi_requests = None

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def slugify(url: str) -> str:
    path = urlparse(url).path.strip("/")
    slug = path.split("/")[-1] or "article"
    slug = re.sub(r"[^a-zA-Z0-9-_]+", "-", slug).strip("-")
    return slug[:80] or "article"


def meta_content(soup: BeautifulSoup, *, name: str | None = None, prop: str | None = None) -> str | None:
    if name:
        tag = soup.find("meta", attrs={"name": name})
        return tag.get("content") if tag and tag.has_attr("content") else None
    if prop:
        tag = soup.find("meta", attrs={"property": prop})
        return tag.get("content") if tag and tag.has_attr("content") else None
    return None


def extract_article(soup: BeautifulSoup) -> BeautifulSoup:
    article = soup.find("article")
    if article:
        return BeautifulSoup(str(article), "html.parser")
    main = soup.find("main")
    if main:
        return BeautifulSoup(str(main), "html.parser")
    body = soup.find("body")
    return BeautifulSoup(str(body), "html.parser") if body else soup


def clean_html(article_soup: BeautifulSoup) -> None:
    # Remove common UI elements
    for selector in [
        "header",
        "nav",
        "footer",
        "aside",
        "form",
        "button",
        "svg",
        "script",
        "style",
        "noscript",
        "iframe",
        "dialog",
    ]:
        for el in article_soup.select(selector):
            el.decompose()

    # Remove elements with noisy aria labels
    aria_pattern = re.compile(r"share|listen|follow|bookmark|clap|sign in|sign up|subscribe", re.I)
    for el in article_soup.find_all(attrs={"aria-label": aria_pattern}):
        el.decompose()

    # Remove obvious UI-only links
    for el in article_soup.find_all("a"):
        href = el.get("href", "")
        if "/m/signin" in href:
            el.decompose()


def normalize_proxy_value(proxy: str | None) -> str | None:
    if not proxy:
        return None
    value = proxy.strip()
    if not value:
        return None
    if value.startswith("socks5h://"):
        value = "socks5://" + value[len("socks5h://"):]
    if "://" not in value and value.count(":") >= 3:
        parts = value.split(":")
        scheme = parts[0].lower()
        if scheme in {"http", "https", "socks5", "socks5h"} and len(parts) >= 5:
            username = parts[1]
            password = ":".join(parts[2:-2])
            host = parts[-2]
            port = parts[-1]
            return f"{scheme}://{username}:{password}@{host}:{port}"
        host = parts[0]
        port = parts[1]
        username = parts[2]
        password = ":".join(parts[3:])
        return f"http://{username}:{password}@{host}:{port}"
    return value


def parse_proxy(proxy: str | None) -> dict | None:
    normalized = normalize_proxy_value(proxy)
    if not normalized:
        return None
    parsed = urlparse(normalized if "://" in normalized else f"http://{normalized}")
    if not parsed.hostname:
        return None
    config = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        config["username"] = parsed.username
    if parsed.password:
        config["password"] = parsed.password
    return config


def load_proxy_list(path: str | None) -> list[str]:
    if not path:
        return []
    p = Path(path)
    if not p.exists():
        raise RuntimeError(f"Proxy list not found: {path}")
    lines = [l.strip() for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
    return lines


def fetch_pingproxies_list(
    public_key: str,
    private_key: str,
    base_url: str,
    proxy_user_id: str,
    country_id: str,
    session_type: str,
    list_count: int,
    list_format: str,
) -> list[str]:
    url = f"{base_url.rstrip('/')}/user/residential/list"
    params = {
        "proxy_user_id": proxy_user_id,
        "country_id": country_id,
        "list_session_type": session_type,
        "list_count": str(list_count),
        "list_format": list_format,
    }
    resp = requests.get(
        url,
        params=params,
        headers={
            "X-API-Public-Key": public_key,
            "X-API-Private-Key": private_key,
        },
        timeout=30,
    )
    if not resp.ok:
        try:
            payload = resp.json()
            error = payload.get("error") or "PingProxies error"
            message = payload.get("message") or "Unknown error"
            request_id = payload.get("api_request_id")
            suffix = f" (request_id={request_id})" if request_id else ""
            raise RuntimeError(f"{error}: {message}{suffix}")
        except ValueError:
            resp.raise_for_status()
    payload = resp.json()
    data = payload.get("data")
    if not isinstance(data, list) or not data:
        raise RuntimeError("PingProxies returned an empty proxy list")
    return [str(item).strip() for item in data if str(item).strip()]


def parse_int(value: str | None, default: int) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def fetch_html_decodo(
    url: str,
    api_key: str,
    advanced: bool,
    timeout_ms: int,
    endpoint: str | None = None,
    target: str | None = None,
    extra_params: dict | None = None,
) -> tuple[str, str]:
    endpoint = endpoint or os.getenv("MEDIUM_FETCH_DECODO_ENDPOINT", "https://scraper-api.decodo.com/v2/scrape")
    if api_key.startswith(("Basic ", "Bearer ")):
        pass
    elif not api_key.startswith("Basic "):
        # Accept either raw token or username:password
        if ":" in api_key and " " not in api_key:
            token = base64.b64encode(api_key.encode("utf-8")).decode("utf-8")
            api_key = f"Basic {token}"
        else:
            api_key = f"Basic {api_key}"
    payload: dict[str, object] = {
        "url": url,
        "http_method": "GET",
    }
    if target:
        payload["target"] = target
    if advanced:
        payload["headless"] = "html"
    if extra_params:
        payload.update(extra_params)
    resp = requests.post(
        endpoint,
        json=payload,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "authorization": api_key,
        },
        timeout=max(10, int(timeout_ms / 1000)),
    )
    resp.raise_for_status()
    text = resp.text
    # Some Decodo responses are JSON-wrapped; try to unwrap html if needed.
    if "application/json" in (resp.headers.get("content-type") or ""):
        try:
            data = resp.json()
            if isinstance(data, dict):
                for key in ("content", "html", "body", "data"):
                    value = data.get(key)
                    if isinstance(value, str) and value.strip():
                        text = value
                        break
                if isinstance(data.get("data"), dict):
                    for key in ("content", "html", "body"):
                        value = data["data"].get(key)
                        if isinstance(value, str) and value.strip():
                            text = value
                            break
        except Exception:
            pass
    soup = BeautifulSoup(text, "html.parser")
    title = soup.title.string.strip() if soup.title and soup.title.string else ""
    return text, title


def load_storage_state(path: str | None) -> dict | None:
    if not path:
        return None
    p = Path(path)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_netscape_cookies(path: str | None) -> list[dict]:
    if not path:
        return []
    p = Path(path)
    if not p.exists() or not p.is_file():
        return []
    cookies: list[dict] = []
    for raw in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            # #HttpOnly_ prefix is included on some lines; handled below
            if line.startswith("#HttpOnly_"):
                line = line[len("#HttpOnly_"):]
            else:
                continue
        parts = line.split("\t")
        if len(parts) < 7:
            parts = re.split(r"\s+", line)
        if len(parts) < 7:
            continue
        domain, _flag, path_val, secure, expires, name, value = parts[:7]
        http_only = False
        if domain.startswith("#HttpOnly_"):
            http_only = True
            domain = domain[len("#HttpOnly_"):]
        cookie: dict = {
            "name": name,
            "value": value,
            "domain": domain,
            "path": path_val or "/",
            "secure": secure.upper() == "TRUE",
        }
        if expires.isdigit():
            cookie["expires"] = int(expires)
        if http_only:
            cookie["httpOnly"] = True
        cookies.append(cookie)
    return cookies


def apply_storage_state_to_requests(session: requests.Session, state: dict | None) -> None:
    if not state:
        return
    cookies = state.get("cookies", [])
    for cookie in cookies:
        try:
            session.cookies.set(
                cookie.get("name", ""),
                cookie.get("value", ""),
                domain=cookie.get("domain"),
                path=cookie.get("path", "/"),
            )
        except Exception:
            continue


def cookies_from_storage_state(state: dict | None) -> dict:
    if not state:
        return {}
    cookies = state.get("cookies", [])
    jar: dict[str, str] = {}
    for cookie in cookies:
        name = cookie.get("name")
        value = cookie.get("value")
        if name and value:
            jar[name] = value
    return jar


def requests_proxies_from_value(proxy_value: str | None) -> dict | None:
    if not proxy_value:
        return None
    normalized = normalize_proxy_value(proxy_value)
    if not normalized:
        return None
    if normalized.startswith("socks5://"):
        return None
    return {"http": normalized, "https": normalized}


def download_image(url: str, out_path: Path, user_agent: str, proxies: dict | None) -> bool:
    try:
        resp = requests.get(
            url,
            headers={"User-Agent": user_agent},
            timeout=30,
            stream=True,
            proxies=proxies,
        )
        resp.raise_for_status()
        with out_path.open("wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        return True
    except Exception:
        return False


def clean_markdown(md: str) -> str:
    lines = md.splitlines()
    cleaned: list[str] = []

    drop_exact = {
        "follow",
        "share",
        "listen",
        "sign in",
        "sign up",
        "write",
        "subscribe",
        "clap",
        "comments",
        "bookmark",
        "press enter or click to view image in full size",
    }

    for line in lines:
        stripped = line.strip()
        lower = stripped.lower()

        if not stripped:
            cleaned.append("")
            continue

        if lower in drop_exact:
            continue

        if "m/signin" in stripped:
            continue

        # Drop avatar-style inline image links
        if re.match(r"^\[!\[.*\]\(.*\)\]\(.*\)$", stripped):
            continue

        # Drop short lines that are just UI tokens
        if len(stripped) <= 3 and stripped.isdigit():
            continue

        cleaned.append(line)

    # Collapse excessive blank lines
    result = "\n".join(cleaned)
    result = re.sub(r"\n{3,}", "\n\n", result).strip()
    return result


def is_cloudflare_page(html: str, title: str) -> bool:
    lower_title = title.lower()
    if "just a moment" in lower_title:
        return True
    lower_html = html.lower()
    # Only match actual Cloudflare challenge page elements, NOT generic
    # CDN/analytics refs like cloudflareinsights.com or challenge-platform/scripts/
    challenge_markers = (
        "cf-browser-verification",
        "cf-challenge-running",
        "cf_chl_opt",
        "cf-turnstile",
        '<div id="challenge-error-title"',
    )
    return any(marker in lower_html for marker in challenge_markers)


def fetch_html(
    url: str,
    user_agent: str,
    timeout_ms: int,
    headless: bool,
    proxy: dict | None,
    storage_state: dict | str | None,
    save_storage_state_path: str | None,
) -> tuple[str, str]:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, proxy=proxy)
        context = browser.new_context(
            user_agent=user_agent,
            storage_state=storage_state if storage_state else None,
        )
        page = context.new_page()
        last_error: Exception | None = None
        for wait_until in ("networkidle", "domcontentloaded"):
            try:
                page.goto(url, wait_until=wait_until, timeout=timeout_ms)
                last_error = None
                break
            except PlaywrightTimeoutError:
                last_error = None
                continue
            except Exception as exc:
                last_error = exc
                try:
                    page.close()
                    page = context.new_page()
                except Exception:
                    pass
                continue

        if last_error is not None:
            raise last_error

        # Allow time for Cloudflare challenges or lazy-loads
        for _ in range(3):
            try:
                if page.locator("article, main").count() > 0:
                    break
            except Exception:
                pass
            try:
                page.wait_for_timeout(4000)
            except Exception:
                pass

        html = page.content()
        title = page.title()
        if save_storage_state_path:
            try:
                context.storage_state(path=save_storage_state_path)
            except Exception:
                pass
        context.close()
        browser.close()

    if is_cloudflare_page(html, title):
        raise RuntimeError("Cloudflare challenge blocked the request")

    return html, title


def fetch_html_curl_cffi(
    url: str,
    timeout_ms: int,
    user_agent: str,
    proxy_value: str | None,
    storage_state: dict | None,
    impersonate: str = "chrome",
) -> tuple[str, str]:
    if cffi_requests is None:
        raise RuntimeError("curl_cffi not installed")
    proxies = requests_proxies_from_value(proxy_value)
    cookies = cookies_from_storage_state(storage_state)
    headers = {"User-Agent": user_agent}
    resp = cffi_requests.get(
        url,
        headers=headers,
        cookies=cookies or None,
        proxies=proxies or None,
        timeout=max(10, int(timeout_ms / 1000)),
        impersonate=impersonate,
        verify=False,
    )
    resp.raise_for_status()
    html = resp.text
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.string.strip() if soup.title and soup.title.string else ""
    if is_cloudflare_page(html, title):
        raise RuntimeError("Cloudflare challenge blocked the request")
    return html, title


def parse_feed(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    ns = {
        "content": "http://purl.org/rss/1.0/modules/content/",
        "dc": "http://purl.org/dc/elements/1.1/",
    }
    items = []
    for item in root.findall(".//item"):
        get_text = lambda tag: (item.findtext(tag) or "").strip()
        link = get_text("link")
        content = item.find("content:encoded", ns)
        items.append({
            "title": get_text("title"),
            "link": link,
            "description": get_text("description"),
            "content": (content.text or "").strip() if content is not None else "",
            "author": item.findtext("dc:creator", default="", namespaces=ns).strip(),
            "pubDate": get_text("pubDate"),
        })
    return items


def fetch_rss_fallback(url: str, proxies: dict | None, storage_state: dict | None) -> dict | None:
    parsed = urlparse(url)
    path = parsed.path.strip("/")
    if not path:
        return None

    feed_url = None
    if path.startswith("@"):
        handle = path.split("/")[0]
        feed_url = f"{parsed.scheme}://{parsed.netloc}/feed/{handle}"
    else:
        parts = path.split("/")
        if parts:
            feed_url = f"{parsed.scheme}://{parsed.netloc}/feed/{parts[0]}"

    if not feed_url:
        return None

    session = requests.Session()
    apply_storage_state_to_requests(session, storage_state)
    try:
        resp = session.get(feed_url, headers={"User-Agent": DEFAULT_USER_AGENT}, timeout=30, proxies=proxies)
        resp.raise_for_status()
    except Exception:
        return None

    items = parse_feed(resp.text)
    if not items:
        return None

    # Try to find matching item by URL slug
    slug = slugify(url)
    match = None
    for item in items:
        if slug in item.get("link", ""):
            match = item
            break
    match = match or items[0]

    return {
        "title": match.get("title"),
        "author": match.get("author"),
        "published": match.get("pubDate"),
        "content_html": match.get("content") or match.get("description"),
        "feed_url": feed_url,
    }


def build_markdown(meta: dict, body_md: str, image_map: list[tuple[str, str]]) -> str:
    header_lines = [f"# {meta.get('title', 'Medium Article')}", "", f"Source: {meta.get('url', '')}"]
    if meta.get("author"):
        header_lines.append(f"Author: {meta['author']}")
    if meta.get("published"):
        header_lines.append(f"Published: {meta['published']}")
    if meta.get("description"):
        header_lines.append("")
        header_lines.append(f"> {meta['description']}")

    markdown = "\n".join(header_lines) + "\n\n---\n\n" + body_md

    if image_map:
        markdown += "\n\n---\n\n## Image References\n"
        for local_path, remote_url in image_map:
            markdown += f"- `{local_path}` — {remote_url}\n"

    return markdown.strip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch a Medium article via Playwright and output Markdown/JSON.")
    parser.add_argument("url", help="Medium article URL")
    parser.add_argument("--format", choices=["markdown", "json", "text"], default="markdown")
    parser.add_argument("--out-dir", default=None, help="Output directory (default: ./output/<slug>)")
    parser.add_argument("--no-images", action="store_true", help="Skip image downloads")
    parser.add_argument("--no-clean", action="store_true", help="Skip markdown cleanup")
    parser.add_argument("--timeout", type=int, default=60000, help="Playwright timeout in ms")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    parser.add_argument("--headful", action="store_true", help="Run browser in headful mode (debug)")
    parser.add_argument("--proxy", default=None, help="Proxy server (http[s]://user:pass@host:port)")
    parser.add_argument("--proxy-list", default=None, help="Path to proxy list file")
    parser.add_argument("--proxy-rotate", choices=["round_robin", "random"], default=None)
    parser.add_argument("--proxy-retries", type=int, default=None, help="Number of proxy attempts before failing")
    parser.add_argument("--proxy-api-provider", default=None, help="Proxy API provider (e.g., pingproxies)")
    parser.add_argument("--proxy-api-public-key", default=None, help="Proxy API public key")
    parser.add_argument("--proxy-api-private-key", default=None, help="Proxy API private key")
    parser.add_argument("--proxy-api-user-id", default=None, help="Proxy API user ID")
    parser.add_argument("--proxy-api-country", default=None, help="Proxy API country (default: us)")
    parser.add_argument("--proxy-api-session-type", default=None, help="Proxy API session type (sticky|random)")
    parser.add_argument("--proxy-api-count", type=int, default=None, help="Proxy API list count")
    parser.add_argument("--proxy-api-format", default=None, help="Proxy API list format (http|socks5|socks5h)")
    parser.add_argument("--proxy-api-base-url", default=None, help="Proxy API base URL")
    parser.add_argument("--decodo-api-key", default=None, help="Decodo Scraper API key")
    parser.add_argument("--decodo-advanced", action="store_true", help="Use Decodo Advanced (headless rendering)")
    parser.add_argument("--decodo-endpoint", default=None, help="Decodo Scraper API endpoint URL")
    parser.add_argument("--decodo-target", default=None, help="Decodo target (e.g., universal)")
    parser.add_argument("--decodo-extra", default=None, help="Extra Decodo JSON params (stringified JSON)")
    parser.add_argument("--force-playwright", action="store_true", help="Force Playwright even if Decodo key is set")
    parser.add_argument("--storage-state", default=None, help="Playwright storage state JSON")
    parser.add_argument("--netscape-cookies", default=None, help="Netscape cookie file (txt)")
    parser.add_argument("--save-storage-state", default=None, help="Save Playwright storage state JSON")
    parser.add_argument("--curl-cffi-first", action="store_true", help="Try curl_cffi before Playwright")
    parser.add_argument("--curl-cffi-impersonate", default=None, help="curl_cffi impersonate profile (default: chrome)")
    parser.add_argument("--rss-fallback", action="store_true", help="Use RSS fallback if blocked")
    parser.add_argument("--verbose", action="store_true", help="Verbose logging")
    parser.add_argument("--quiet", action="store_true", help="Do not print to stdout")
    args = parser.parse_args()

    verbose = args.verbose or parse_bool(os.getenv("MEDIUM_FETCH_VERBOSE"), False)

    def log(message: str) -> None:
        if verbose:
            print(f"[medium_fetch] {message}")

    url = args.url
    slug = slugify(url)
    base_out = Path(args.out_dir) if args.out_dir else Path("output") / slug
    base_out.mkdir(parents=True, exist_ok=True)
    images_dir = base_out / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    decodo_api_key = (
        args.decodo_api_key
        or os.getenv("MEDIUM_FETCH_DECODO_API_KEY")
        or os.getenv("DECODO_API_KEY")
    )
    force_playwright = args.force_playwright or parse_bool(os.getenv("MEDIUM_FETCH_FORCE_PLAYWRIGHT"), False)
    if not decodo_api_key:
        decodo_user = os.getenv("MEDIUM_FETCH_DECODO_USER") or os.getenv("DECODO_USER")
        decodo_pass = os.getenv("MEDIUM_FETCH_DECODO_PASS") or os.getenv("DECODO_PASS")
        if decodo_user and decodo_pass:
            decodo_api_key = f"{decodo_user}:{decodo_pass}"
    if decodo_api_key:
        decodo_api_key = decodo_api_key.strip().strip('"').strip("'")
    if force_playwright:
        decodo_api_key = None
    decodo_endpoint = args.decodo_endpoint or os.getenv("MEDIUM_FETCH_DECODO_ENDPOINT")
    decodo_advanced = args.decodo_advanced or parse_bool(os.getenv("MEDIUM_FETCH_DECODO_ADVANCED"), False)
    decodo_target = args.decodo_target or os.getenv("MEDIUM_FETCH_DECODO_TARGET") or "universal"
    decodo_extra_raw = args.decodo_extra or os.getenv("MEDIUM_FETCH_DECODO_EXTRA_JSON")
    decodo_extra = None
    if decodo_extra_raw:
        try:
            decodo_extra = json.loads(decodo_extra_raw)
        except Exception:
            decodo_extra = None

    proxy_value = args.proxy or os.getenv("MEDIUM_FETCH_PROXY")
    # Proxy list takes precedence over single proxy when set — enables rotation
    proxy_list = args.proxy_list or os.getenv("MEDIUM_FETCH_PROXY_LIST")
    proxy_rotate = args.proxy_rotate or os.getenv("MEDIUM_FETCH_PROXY_ROTATE") or "round_robin"
    proxy_retries = args.proxy_retries or parse_int(os.getenv("MEDIUM_FETCH_PROXY_RETRIES"), 3)
    curl_cffi_first = args.curl_cffi_first or parse_bool(os.getenv("MEDIUM_FETCH_CURL_CFFI_FIRST"), False)
    curl_cffi_impersonate = args.curl_cffi_impersonate or os.getenv("MEDIUM_FETCH_CURL_CFFI_IMPERSONATE") or "chrome"

    proxy_list_entries: list[str] = []
    if proxy_list:
        proxy_list_entries = load_proxy_list(proxy_list)
        if proxy_list_entries:
            proxy_value = proxy_list_entries[0] if proxy_rotate == "round_robin" else random.choice(proxy_list_entries)
    elif not proxy_value and not decodo_api_key:
        provider = (
            args.proxy_api_provider
            or os.getenv("MEDIUM_FETCH_PROXY_API_PROVIDER")
            or os.getenv("PROXY_API_PROVIDER")
        )
        public_key = args.proxy_api_public_key or os.getenv("PROXY_API_PUBLIC_KEY")
        private_key = args.proxy_api_private_key or os.getenv("PROXY_API_PRIVATE_KEY")
        proxy_user_id = args.proxy_api_user_id or os.getenv("MEDIUM_FETCH_PROXY_API_USER_ID") or os.getenv("PROXY_API_PROXY_USER_ID")
        country_id = (
            args.proxy_api_country
            or os.getenv("MEDIUM_FETCH_PROXY_API_COUNTRY")
            or os.getenv("PROXY_API_COUNTRY_ID")
            or "us"
        )
        session_type = (
            args.proxy_api_session_type
            or os.getenv("MEDIUM_FETCH_PROXY_API_SESSION_TYPE")
            or os.getenv("PROXY_API_LIST_SESSION_TYPE")
            or "sticky"
        )
        list_count = args.proxy_api_count or parse_int(
            os.getenv("MEDIUM_FETCH_PROXY_API_COUNT") or os.getenv("PROXY_API_LIST_COUNT"),
            10,
        )
        list_format = (
            args.proxy_api_format
            or os.getenv("MEDIUM_FETCH_PROXY_API_FORMAT")
            or os.getenv("PROXY_API_LIST_FORMAT")
            or "http"
        )
        base_url = (
            args.proxy_api_base_url
            or os.getenv("MEDIUM_FETCH_PROXY_API_BASE_URL")
            or os.getenv("PROXY_API_BASE_URL")
            or "https://api.pingproxies.com/1.0/public"
        )

        if public_key and private_key and proxy_user_id:
            provider_name = (provider or "pingproxies").lower()
            if provider_name == "pingproxies":
                proxies = fetch_pingproxies_list(
                    public_key,
                    private_key,
                    base_url,
                    proxy_user_id,
                    country_id,
                    session_type,
                    list_count,
                    list_format,
                )
                if proxies:
                    proxy_value = proxies[0] if proxy_rotate == "round_robin" else random.choice(proxies)
                    proxy_list_entries = proxies

    storage_state = load_storage_state(args.storage_state)
    netscape_path = args.netscape_cookies or os.getenv("MEDIUM_FETCH_NETSCAPE_COOKIES")
    netscape_cookies = load_netscape_cookies(netscape_path)
    if netscape_cookies:
        if not storage_state:
            storage_state = {"cookies": []}
        existing = storage_state.get("cookies", [])
        storage_state["cookies"] = existing + netscape_cookies
        log(f"Loaded Netscape cookies: {len(netscape_cookies)}")
    elif storage_state:
        log("Loaded Playwright storage state")

    if decodo_api_key:
        log("Using Decodo Scraper API mode")
    else:
        log("Using Playwright mode")
    if proxy_value:
        log(f"Proxy configured (list={bool(proxy_list_entries)}, rotate={proxy_rotate}, retries={proxy_retries})")
    if curl_cffi_first:
        log(f"curl_cffi enabled (impersonate={curl_cffi_impersonate})")

    html = ""
    title = ""
    last_error: Exception | None = None
    attempts = max(1, int(proxy_retries))
    for attempt in range(attempts):
        current_proxy = proxy_value
        if proxy_list_entries:
            if proxy_rotate == "random":
                current_proxy = random.choice(proxy_list_entries)
            else:
                current_proxy = proxy_list_entries[min(attempt, len(proxy_list_entries) - 1)]
        current_proxy = normalize_proxy_value(current_proxy)
        proxy_config = parse_proxy(current_proxy)
        if current_proxy:
            log(f"Attempt {attempt + 1}/{attempts} with proxy: {current_proxy}")
        else:
            log(f"Attempt {attempt + 1}/{attempts} without proxy")
        try:
            if decodo_api_key:
                html, title = fetch_html_decodo(
                    url,
                    decodo_api_key,
                    decodo_advanced,
                    args.timeout,
                    decodo_endpoint,
                    decodo_target,
                    decodo_extra,
                )
                if is_cloudflare_page(html, title):
                    raise RuntimeError("Cloudflare challenge blocked the request")
            else:
                if curl_cffi_first:
                    try:
                        html, title = fetch_html_curl_cffi(
                            url,
                            args.timeout,
                            args.user_agent,
                            current_proxy,
                            storage_state,
                            impersonate=curl_cffi_impersonate,
                        )
                    except Exception as exc:
                        log(f"curl_cffi failed, falling back to Playwright: {exc}")
                        html, title = fetch_html(
                            url,
                            args.user_agent,
                            args.timeout,
                            not args.headful,
                            proxy_config,
                            storage_state,
                            args.save_storage_state,
                        )
                else:
                    html, title = fetch_html(
                        url,
                        args.user_agent,
                        args.timeout,
                        not args.headful,
                        proxy_config,
                        storage_state,
                        args.save_storage_state,
                    )
            last_error = None
            break
        except Exception as exc:
            last_error = exc
            log(f"Attempt {attempt + 1} failed: {exc}")
            continue

    if last_error is not None:
        if not isinstance(last_error, RuntimeError):
            raise last_error
        if not args.rss_fallback:
            raise last_error

    if last_error is not None:
        if not args.rss_fallback:
            raise last_error
        fallback = fetch_rss_fallback(url, requests_proxies_from_value(proxy_value), storage_state)
        if not fallback:
            raise last_error
        log("RSS fallback succeeded")
        soup = BeautifulSoup(fallback["content_html"], "html.parser")
        article_soup = extract_article(soup)
        meta = {
            "url": url,
            "title": fallback.get("title"),
            "description": None,
            "author": fallback.get("author"),
            "published": fallback.get("published"),
            "section": None,
            "og_image": None,
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "fallback": "rss",
            "feed_url": fallback.get("feed_url"),
        }
        clean_html(article_soup)
        image_map: list[tuple[str, str]] = []
        if not args.no_images:
            image_tags = article_soup.select("figure img")
            if not image_tags:
                image_tags = article_soup.select("img")
            for idx, tag in enumerate(image_tags, start=1):
                src = tag.get("src") or tag.get("data-src")
                # Medium uses <picture><source srcset="..."/><img/></picture>
                # where <img> has no src — pull from sibling <source> srcset
                if not src and tag.parent and tag.parent.name == "picture":
                    source = tag.parent.find("source", attrs={"data-testid": "og"})
                    if not source:
                        source = tag.parent.find("source")
                    if source and source.get("srcset"):
                        # Pick the largest image from srcset (last entry)
                        srcset = source["srcset"]
                        parts = [s.strip().split()[0] for s in srcset.split(",") if s.strip()]
                        src = parts[-1] if parts else None
                if not src or src.startswith("data:"):
                    continue
                ext = Path(urlparse(src).path).suffix
                if not ext or len(ext) > 5:
                    ext = ".jpg"
                local_name = f"image_{idx:02d}{ext}"
                local_path = images_dir / local_name
                if download_image(src, local_path, args.user_agent, requests_proxies_from_value(proxy_value)):
                    tag["src"] = f"images/{local_name}"
                    image_map.append((f"images/{local_name}", src))
        h = html2text.HTML2Text()
        h.ignore_links = False
        h.body_width = 0
        markdown_body = h.handle(str(article_soup)).strip()
        if not args.no_clean:
            markdown_body = clean_markdown(markdown_body)
        markdown = build_markdown(meta, markdown_body, image_map)
        md_path = base_out / "article.md"
        md_path.write_text(markdown, encoding="utf-8")
        meta_path = base_out / "metadata.json"
        meta_path.write_text(
            json.dumps(
                {
                    **meta,
                    "image_count": len(image_map),
                    "images": [dict(local=lp, remote=ru) for lp, ru in image_map],
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        if not args.quiet:
            if args.format == "markdown":
                print(markdown)
            elif args.format == "json":
                print(json.dumps({"meta": meta, "markdown": markdown, "text": article_soup.get_text(strip=True)}, indent=2))
            else:
                print(article_soup.get_text(separator="\\n", strip=True))
        return
    soup = BeautifulSoup(html, "html.parser")
    article_soup = extract_article(soup)

    meta = {
        "url": url,
        "title": meta_content(soup, prop="og:title") or title,
        "description": meta_content(soup, prop="og:description"),
        "author": meta_content(soup, name="author"),
        "published": meta_content(soup, name="parsely-pub-date"),
        "section": meta_content(soup, name="parsely-section"),
        "og_image": meta_content(soup, prop="og:image"),
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fetch_mode": "decodo_api" if decodo_api_key else "playwright",
    }

    clean_html(article_soup)

    image_map: list[tuple[str, str]] = []
    if not args.no_images:
        image_tags = article_soup.select("figure img")
        if not image_tags:
            image_tags = article_soup.select("img")
        log(f"Found {len(image_tags)} image tags (no_images={args.no_images})")

        for idx, tag in enumerate(image_tags, start=1):
            src = tag.get("src") or tag.get("data-src")
            # Medium uses <picture><source srcset="..."/><img/></picture>
            if not src and tag.parent and tag.parent.name == "picture":
                source = tag.parent.find("source", attrs={"data-testid": "og"})
                if not source:
                    source = tag.parent.find("source")
                if source and source.get("srcset"):
                    srcset = source["srcset"]
                    parts = [s.strip().split()[0] for s in srcset.split(",") if s.strip()]
                    src = parts[-1] if parts else None
                    log(f"  img[{idx}]: extracted from <picture><source srcset>: {src[:80] if src else 'None'}...")
                else:
                    log(f"  img[{idx}]: <picture> parent but no <source srcset> found")
            elif src:
                log(f"  img[{idx}]: direct src={src[:80]}...")
            if not src or src.startswith("data:"):
                log(f"  img[{idx}]: SKIPPED (src={'None' if not src else 'data:...'})")
                continue
            ext = Path(urlparse(src).path).suffix
            if not ext or len(ext) > 5:
                ext = ".jpg"
            local_name = f"image_{idx:02d}{ext}"
            local_path = images_dir / local_name
            ok = download_image(src, local_path, args.user_agent, requests_proxies_from_value(proxy_value))
            if ok:
                tag["src"] = f"images/{local_name}"
                image_map.append((f"images/{local_name}", src))
                log(f"  img[{idx}]: DOWNLOADED -> {local_name}")
            else:
                log(f"  img[{idx}]: DOWNLOAD FAILED for {src[:80]}")
        log(f"Image extraction complete: {len(image_map)} downloaded")

    article_html_path = base_out / "article.html"
    article_html_path.write_text(str(article_soup), encoding="utf-8")

    # Convert HTML to markdown
    h = html2text.HTML2Text()
    h.ignore_links = False
    h.body_width = 0
    markdown_body = h.handle(str(article_soup)).strip()

    if not args.no_clean:
        markdown_body = clean_markdown(markdown_body)

    markdown = build_markdown(meta, markdown_body, image_map)
    md_path = base_out / "article.md"
    md_path.write_text(markdown, encoding="utf-8")

    text_content = article_soup.get_text(separator="\n", strip=True)
    text_path = base_out / "article.txt"
    text_path.write_text(text_content, encoding="utf-8")

    meta_out = {**meta, "image_count": len(image_map), "images": [dict(local=lp, remote=ru) for lp, ru in image_map]}
    meta_path = base_out / "metadata.json"
    meta_path.write_text(json.dumps(meta_out, indent=2), encoding="utf-8")

    if not args.quiet:
        if args.format == "markdown":
            print(markdown)
        elif args.format == "json":
            print(json.dumps({"meta": meta_out, "markdown": markdown, "text": text_content}, indent=2))
        else:
            print(text_content)


if __name__ == "__main__":
    main()
