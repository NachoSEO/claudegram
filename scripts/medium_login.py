#!/usr/bin/env python3
"""Manual Medium login to save Playwright storage state (cookies)."""
import argparse
from pathlib import Path
from urllib.parse import urlparse
import re

from playwright.sync_api import sync_playwright

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


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


def main() -> None:
    parser = argparse.ArgumentParser(description="Open Medium login in Playwright and save cookies.")
    parser.add_argument("--storage-state", default="storage_state.json", help="Output storage state JSON path")
    parser.add_argument("--proxy", default=None, help="Proxy server (http[s]://user:pass@host:port)")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    parser.add_argument("--url", default="https://medium.com/m/signin", help="Login URL")
    args = parser.parse_args()

    storage_path = Path(args.storage_state)
    if storage_path.exists() and storage_path.is_dir():
        storage_path = storage_path / "storage_state.json"
    if storage_path.is_dir():
        storage_path = storage_path / "storage_state.json"
    storage_path.parent.mkdir(parents=True, exist_ok=True)
    proxy_config = parse_proxy(args.proxy)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, proxy=proxy_config)
        context = browser.new_context(user_agent=args.user_agent)
        page = context.new_page()
        page.goto(args.url, wait_until="domcontentloaded")
        print("Log in to Medium in the opened browser.")
        input("Press Enter here once you're logged in to save cookies... ")
        context.storage_state(path=str(storage_path))
        context.close()
        browser.close()

    print(f"Saved storage state to: {storage_path}")


if __name__ == "__main__":
    main()
