#!/bin/sh
set -eu

: "${ALBIA_PORT:=8090}"
: "${ALBIA_REGISTRY_DIR:=/opt/albia/registry}"

mkdir -p "$ALBIA_REGISTRY_DIR"
touch "$ALBIA_REGISTRY_DIR/nodes.jsonl"

exec nc -lk -p "$ALBIA_PORT" -e /opt/albia/bin/register-connection.sh
