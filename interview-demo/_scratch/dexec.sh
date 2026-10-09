#!/bin/bash
# Retry docker exec because the Docker Desktop API flaps (500 on /containers/<name>/json)
# while the containers themselves stay healthy.
# Usage: bash dexec.sh <container> <args...>
set -u
NAME="$1"; shift
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  OUT=$(docker exec "$NAME" "$@" 2>&1)
  case "$OUT" in
    *"500 Internal Server Error"*|*"cannot find the file specified"*)
      # transient engine failure -> retry
      if [ "$i" = "12" ]; then echo "!! gave up after 12 tries"; echo "$OUT"; exit 1; fi
      ;;
    *)
      echo "$OUT"; exit 0;;
  esac
done
