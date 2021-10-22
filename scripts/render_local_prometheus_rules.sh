#!/usr/bin/env bash

set -a

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_DIR="${SCRIPT_DIR}/.."
PROMETHEUS_DIR="${PROJECT_DIR}/prometheus"

source "${PROJECT_DIR}/.env"
export labels="\$labels"

cat "${PROMETHEUS_DIR}/rules.yml" | envsubst > "${PROMETHEUS_DIR}/rules.local.yml"
