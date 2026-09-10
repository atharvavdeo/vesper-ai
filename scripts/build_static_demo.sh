#!/usr/bin/env bash
# Build the public, key-free site for Cloudflare Pages: the landing page at "/" and the
# /demo console (recorded engine output + pre-rendered Rime clips + guided tour).
# No backend, no Clerk, no API keys ship in this build.
#
#   scripts/build_static_demo.sh            # build into app/.next-static
#   scripts/build_static_demo.sh deploy     # build, then deploy to vesper-ai.pages.dev
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f app/public/demo-audio/manifest.json ]; then
  echo "note: no pre-rendered Rime clips (run backend/.venv/bin/python scripts/build_demo_audio.py); demo will be silent"
fi

(cd app && rm -rf .next-static && STATIC_DEMO=1 node_modules/.bin/next build)
OUT=app/.next-static

python3 - "$OUT" <<'PY'
import pathlib, re, sys
out = pathlib.Path(sys.argv[1])
landing = (out / "landing" / "index.html").read_text()
# On the public link every "Launch App" opens the demo console instead of the signed-in app.
landing = landing.replace('href="/app"', 'href="/demo/"')
(out / "index.html").write_text(landing)
(out / "landing" / "index.html").write_text(landing)
(out / "_redirects").write_text("/app /demo/ 302\n/app/* /demo/ 302\n/sign-in* /demo/ 302\n/sign-up* /demo/ 302\n/demo /demo/ 301\n")
for junk in ("uploads",):
    p = out / junk
    if p.is_dir() and not any(p.iterdir()):
        p.rmdir()
PY

# Fail the build if anything secret-shaped slipped into the static output.
if grep -rqE "pk_(test|live)_|sk_(test|live)_|csk-[a-z0-9]{10}|gsk_[A-Za-z0-9]{10}|nvapi-|RIME_API_KEY" "$OUT"; then
  echo "refusing to ship: secret-like string found in $OUT" >&2
  exit 1
fi
echo "static site ready: $OUT ($(du -sh "$OUT" | cut -f1))"

if [ "${1:-}" = "deploy" ]; then
  npx wrangler pages deploy "$OUT" --project-name vesper-ai --branch main --commit-dirty=true
fi
