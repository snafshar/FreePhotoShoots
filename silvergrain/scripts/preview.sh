#!/bin/sh
set -eu

host=127.0.0.1
port=${PORT:-8000}
while [ "$#" -gt 0 ]; do
    case "$1" in
        --host) host=$2; shift 2 ;;
        --port) port=$2; shift 2 ;;
        --strictPort) shift ;;
        *) echo "Unknown preview option: $1" >&2; exit 2 ;;
    esac
done
python=python3
if [ -x .venv/bin/python ]; then
    python=.venv/bin/python
fi
exec "$python" -m uvicorn journal.app:app --host "$host" --port "$port"
