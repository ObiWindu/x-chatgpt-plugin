#!/usr/bin/env bash
set -euo pipefail

# Requires the Hostim CLI and a selected project.
# Interactive:
#   hostim login
#   hostim use YOUR_PROJECT
#
# CI/non-interactive:
#   HOSTIM_TOKEN=... HOSTIM_PROJECT=YOUR_PROJECT ./scripts/deploy-hostim.sh

if [[ -n "${HOSTIM_PROJECT:-}" ]]; then
  hostim use "$HOSTIM_PROJECT"
fi

hostim whoami
hostim templates validate -f hostim/stack.yml
hostim templates apply -f hostim/stack.yml -y
hostim overview
