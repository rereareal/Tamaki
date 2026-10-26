#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.."

while true; do
  node --env-file=.env --import tsx src/index.ts
  code=$?
  echo "[run] tamaki exited with $code; restarting in 5s" >&2
  sleep 5
done
