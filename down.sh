#!/usr/bin/env bash
# down.sh — Quick stop: bring down all services
set -e
exec bash "$(dirname "$0")/dc.sh" down "$@"
