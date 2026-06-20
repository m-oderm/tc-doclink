#!/usr/bin/env bash
# Build-Schritt fuer Cloudflare Pages: schreibt version.json mit dem Commit-Hash.
# Cloudflare stellt CF_PAGES_COMMIT_SHA beim Build bereit. Fehlt die Variable, gilt "dev".
# Das Skript endet immer mit Code 0, damit der Deploy nicht abbricht.
#
# Im Cloudflare-Dashboard unter Settings, Build and deployments setzen:
#   Build command:      bash build.sh
#   Output-Verzeichnis: .

SHA="${CF_PAGES_COMMIT_SHA:-dev}"
printf '{"version":"%s","builtAt":"%s"}\n' "${SHA:0:7}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > version.json

exit 0
