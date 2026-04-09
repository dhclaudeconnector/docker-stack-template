#!/usr/bin/env bash
# up.sh — Quick start: build + start all enabled services
set -e
exec bash "$(dirname "$0")/dc.sh" up -d --build --remove-orphans "$@"
