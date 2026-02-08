#!/usr/bin/env python3
"""
Instagram media extraction via instagrapi (mobile private API).
Called from extract.ts as a child process for Instagram URLs.

Usage:
  python3 insta_extract.py --url <instagram_url> --mode <video|audio|meta> --output-dir <dir>
  python3 insta_extract.py --login  # Interactive first-time login

Outputs JSON to stdout for extract.ts to parse.
"""

import os
import sys
import json
import re
import subprocess
import argparse
import getpass
from pathlib import Path

SESSION_DIR = os.path.join(os.path.expanduser('~'), '.claudegram', 'instagrapi')
SESSION_FILE = os.path.join(SESSION_DIR, 'session.json')
CREDS_FILE = os.path.join(SESSION_DIR, 'credentials.json')

DELAY_RANGE = [2, 5]


def output_json(data: dict):
    """Print JSON result to stdout and exit."""
    print(json.dumps(data))
    sys.exit(0)


def output_error(msg: str, code: str = 'UNKNOWN'):
    """Print JSON error to stdout and exit with code 1."""
    print(json.dumps({'error': msg, 'code': code}))
    sys.exit(1)


def load_credentials() -> tuple[str, str]:
    """Load saved credentials."""
    if not os.path.exists(CREDS_FILE):
        output_error(
            'No credentials found. Run: python3 insta_extract.py --login',
            'NO_CREDENTIALS'
        )
    with open(CREDS_FILE, 'r') as f:
        creds = json.load(f)
    return creds['username'], creds['password']


def get_client():
    """Create and authenticate an instagrapi client with session reuse."""
    from instagrapi import Client
    from instagrapi.exceptions import LoginRequired

    if not os.path.exists(SESSION_FILE):
        output_error(
            'No session found. Run: python3 insta_extract.py --import-session /path/to/cookies.txt',
            'NO_SESSION'
        )

    cl = Client()
    cl.delay_range = DELAY_RANGE
    cl.load_settings(SESSION_FILE)

    # Check if we have real credentials for re-login
    creds_data = {}
    if os.path.exists(CREDS_FILE):
        with open(CREDS_FILE, 'r') as f:
            creds_data = json.load(f)

    has_password = bool(creds_data.get('password'))

    if has_password:
        # Full credential login with session reuse
        cl.login(creds_data['username'], creds_data['password'])
    else:
        # Imported session — just set the session, no login call
        if not cl.user_id and creds_data.get('ds_user_id'):
            cl.user_id = int(creds_data['ds_user_id'])

    return cl


def extract_shortcode(url: str) -> str:
    """Extract the media shortcode from an Instagram URL."""
    m = re.search(r'(?:reel|p|tv)/([A-Za-z0-9_-]+)', url)
    if m:
        return m.group(1)
    output_error(f'Could not parse Instagram URL: {url}', 'BAD_URL')


def extract_audio_from_video(video_path: str, output_dir: str) -> str | None:
    """Use ffmpeg subprocess to extract audio from video."""
    audio_path = os.path.join(output_dir, 'audio.mp3')
    try:
        subprocess.run(
            ['ffmpeg', '-y', '-i', video_path, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', audio_path],
            capture_output=True, timeout=120
        )
        if os.path.exists(audio_path) and os.path.getsize(audio_path) > 0:
            return audio_path
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return None


def do_import_session(cookies_path: str):
    """Import session from browser cookies.txt — no login API call needed."""
    from instagrapi import Client

    os.makedirs(SESSION_DIR, exist_ok=True)

    # Parse Instagram cookies from Netscape cookies file
    ig_cookies = {}
    with open(cookies_path, 'r') as f:
        for line in f:
            line = line.strip()
            if line.startswith('#') or not line:
                continue
            parts = line.split('\t')
            if len(parts) >= 7 and '.instagram.com' in parts[0]:
                ig_cookies[parts[5]] = parts[6]

    sessionid = ig_cookies.get('sessionid')
    if not sessionid:
        print('Error: No Instagram sessionid found in cookies file.')
        print(f'Searched: {cookies_path}')
        sys.exit(1)

    ds_user_id = ig_cookies.get('ds_user_id', '')
    csrftoken = ig_cookies.get('csrftoken', '')
    mid = ig_cookies.get('mid', '')
    ig_did = ig_cookies.get('ig_did', '')
    rur = ig_cookies.get('rur', '')
    datr = ig_cookies.get('datr', '')

    print(f'Found Instagram session in {cookies_path}')
    print(f'  sessionid: ...{sessionid[-8:]}')
    print(f'  ds_user_id: {ds_user_id}')
    print(f'  csrftoken: {csrftoken[:8]}...')

    # Build session settings directly — bypass login_by_sessionid API call
    import uuid
    settings = {
        "uuids": {
            "phone_id": str(uuid.uuid4()),
            "uuid": str(uuid.uuid4()),
            "client_session_id": str(uuid.uuid4()),
            "advertising_id": str(uuid.uuid4()),
            "android_device_id": f"android-{uuid.uuid4().hex[:16]}",
            "request_id": str(uuid.uuid4()),
            "tray_session_id": str(uuid.uuid4()),
        },
        "cookies": {
            "sessionid": sessionid,
            "ds_user_id": ds_user_id,
            "csrftoken": csrftoken,
            "mid": mid,
            "ig_did": ig_did,
            "rur": rur,
            "datr": datr,
        },
        "authorization_data": {
            "ds_user_id": ds_user_id,
            "sessionid": sessionid,
        },
        "mid": mid,
        "ig_u_rur": None,
        "ig_www_claim": None,
        "last_login": None,
        "device_settings": {
            "app_version": "269.0.0.18.75",
            "android_version": 26,
            "android_release": "8.0.0",
            "dpi": "480dpi",
            "resolution": "1080x1920",
            "manufacturer": "OnePlus",
            "device": "devitron",
            "model": "6T Dev",
            "cpu": "qcom",
            "version_code": "314665256",
        },
        "user_agent": "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; OnePlus; 6T Dev; devitron; qcom; en_US; 314665256)",
        "country": "US",
        "country_code": 1,
        "locale": "en_US",
        "timezone_offset": -18000,
    }

    # Write session file directly
    with open(SESSION_FILE, 'w') as f:
        json.dump(settings, f, indent=2)

    print('Session file written.')

    # Save credentials reference
    with open(CREDS_FILE, 'w') as f:
        json.dump({'username': '', 'password': '', 'ds_user_id': ds_user_id, 'imported': True}, f)
    os.chmod(CREDS_FILE, 0o600)

    print()
    print(f'Session saved to: {SESSION_FILE}')
    print(f'User ID: {ds_user_id}')
    print('Ready to use. Test with:')
    print('  python3 ~/claudegram/insta_extract.py --session-check')


def do_login(cli_username: str = None, cli_password: str = None, proxy: str = None):
    """Interactive first-time login flow."""
    from instagrapi import Client
    from instagrapi.exceptions import (
        TwoFactorRequired, ChallengeRequired,
        BadPassword, RecaptchaChallengeForm,
    )

    os.makedirs(SESSION_DIR, exist_ok=True)

    print('=== Instagram Login (instagrapi) ===')
    print('This creates a mobile API session that lasts 60-90 days.')
    print()

    if cli_username and cli_password:
        username = cli_username
        password = cli_password
        print(f'Using provided credentials for: {username}')
    else:
        print('NOTE: If this is a brand new account, log into it from the')
        print('Instagram app or browser first, do some normal activity,')
        print('then come back here. New unused accounts get flagged.')
        print()
        username = input('Username: ').strip()
        password = getpass.getpass('Password: ')

    if not username or not password:
        print('Error: username and password required.')
        sys.exit(1)

    cl = Client()
    cl.delay_range = DELAY_RANGE

    if proxy:
        cl.set_proxy(proxy)
        print(f'Using proxy: {proxy.split("@")[-1] if "@" in proxy else proxy}')

    try:
        cl.login(username, password)
    except TwoFactorRequired:
        code = input('2FA code: ').strip()
        cl.two_factor_login(code)
    except ChallengeRequired:
        print()
        print('Instagram triggered a verification challenge.')
        print('This usually means:')
        print('  1. New account that hasn\'t been used from a real device yet')
        print('  2. Instagram wants email/SMS verification')
        print()
        print('FIX: Log into this account from the Instagram app or browser,')
        print('     complete any verification prompts, browse for a minute,')
        print('     then re-run this login command.')
        if cl.last_json:
            print(f'\nDebug response: {json.dumps(cl.last_json, indent=2)[:500]}')
        sys.exit(1)
    except BadPassword as e:
        print(f'Error: bad password (or Instagram rejected login).')
        print(f'Detail: {e}')
        if cl.last_json:
            print(f'Instagram response: {json.dumps(cl.last_json, indent=2)[:500]}')
        sys.exit(1)
    except RecaptchaChallengeForm:
        print('Error: CAPTCHA required. Log in from the app first, then retry.')
        sys.exit(1)
    except Exception as e:
        print(f'Login failed: {type(e).__name__}: {e}')
        if cl.last_json:
            print(f'Instagram response: {json.dumps(cl.last_json, indent=2)[:500]}')
        sys.exit(1)

    cl.dump_settings(SESSION_FILE)

    with open(CREDS_FILE, 'w') as f:
        json.dump({'username': username, 'password': password}, f)
    os.chmod(CREDS_FILE, 0o600)

    print()
    print(f'Session saved to: {SESSION_FILE}')
    print(f'Credentials saved to: {CREDS_FILE} (mode 600)')
    print('Session will last 60-90 days before needing refresh.')


def do_extract(url: str, mode: str, output_dir: str):
    """Extract media from an Instagram URL."""
    from instagrapi.exceptions import (
        MediaNotFound, FeedbackRequired, PleaseWaitFewMinutes,
        SentryBlock, LoginRequired, ClientError,
    )

    cl = get_client()
    shortcode = extract_shortcode(url)

    try:
        media_pk = cl.media_pk_from_code(shortcode)
        media_info = cl.media_info(media_pk)
    except MediaNotFound:
        output_error('Post not found or deleted.', 'NOT_FOUND')
    except FeedbackRequired:
        output_error('Action blocked by Instagram. Try again in 12 hours.', 'FEEDBACK_REQUIRED')
    except PleaseWaitFewMinutes:
        output_error('Rate limited. Try again in a few minutes.', 'RATE_LIMITED')
    except SentryBlock:
        output_error('IP blocked by Instagram.', 'SENTRY_BLOCK')
    except LoginRequired:
        if os.path.exists(SESSION_FILE):
            os.remove(SESSION_FILE)
        output_error('Session expired. Run: python3 insta_extract.py --login', 'SESSION_EXPIRED')
    except ClientError as e:
        output_error(f'Instagram API error: {e}', 'CLIENT_ERROR')

    title = media_info.caption_text[:100] if media_info.caption_text else f'Post by {media_info.user.username}'
    duration = None
    if media_info.video_duration:
        duration = media_info.video_duration

    result = {
        'title': title,
        'duration': duration,
        'username': media_info.user.username,
    }

    os.makedirs(output_dir, exist_ok=True)

    if mode == 'meta':
        output_json(result)
        return

    if mode in ('video', 'all'):
        if media_info.video_url:
            video_path = os.path.join(output_dir, 'video.mp4')
            cl.video_download_by_url(str(media_info.video_url), video_path)
            if os.path.exists(video_path):
                result['video_path'] = video_path
            else:
                result['video_warning'] = 'Video download produced no file'
        elif media_info.thumbnail_url:
            result['video_warning'] = 'Post is an image, not a video'
        else:
            result['video_warning'] = 'No video URL available'

    if mode in ('audio', 'all'):
        src = result.get('video_path')
        if not src and media_info.video_url:
            src = os.path.join(output_dir, 'video_tmp.mp4')
            cl.video_download_by_url(str(media_info.video_url), src)

        if src and os.path.exists(src):
            audio_path = extract_audio_from_video(src, output_dir)
            if audio_path:
                result['audio_path'] = audio_path
            else:
                result['audio_warning'] = 'Audio extraction failed'

            if mode == 'audio' and 'video_tmp' in (src or ''):
                try:
                    os.remove(src)
                except OSError:
                    pass
        else:
            result['audio_warning'] = 'No video source for audio extraction'

    output_json(result)


def main():
    parser = argparse.ArgumentParser(description='Instagram extraction via instagrapi')
    parser.add_argument('--login', action='store_true', help='First-time login')
    parser.add_argument('--username', help='Instagram username (for --login)')
    parser.add_argument('--password', help='Instagram password (for --login)')
    parser.add_argument('--proxy', help='Proxy URL for login (e.g. http://user:pass@host:port)')
    parser.add_argument('--import-session', metavar='COOKIES_PATH',
                        help='Import session from browser cookies.txt (skips login API entirely)')
    parser.add_argument('--url', help='Instagram URL to extract')
    parser.add_argument('--mode', choices=['video', 'audio', 'meta', 'all'], default='video')
    parser.add_argument('--output-dir', help='Directory for downloaded files')
    parser.add_argument('--session-check', action='store_true', help='Check if session is valid')

    args = parser.parse_args()

    if args.import_session:
        do_import_session(args.import_session)
        return

    if args.login:
        do_login(args.username, args.password, args.proxy)
        return

    if args.session_check:
        try:
            cl = get_client()
            output_json({'valid': True, 'username': cl.username})
        except Exception as e:
            output_json({'valid': False, 'error': str(e)})
        return

    if not args.url:
        parser.error('--url is required for extraction')
    if not args.output_dir:
        parser.error('--output-dir is required for extraction')

    do_extract(args.url, args.mode, args.output_dir)


if __name__ == '__main__':
    main()
