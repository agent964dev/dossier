#!/bin/sh
set -eu

usage() {
  cat >&2 <<'USAGE'
Usage: apps/web/scripts/setup.sh --env dev|production --key-file <path>

Applies remote D1 migrations, then calls POST /api/setup with the bootstrap key.
USAGE
  exit 2
}

environment=''
key_file=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env)
      [ "$#" -ge 2 ] || usage
      environment=$2
      shift 2
      ;;
    --key-file)
      [ "$#" -ge 2 ] || usage
      key_file=$2
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

[ -n "$environment" ] || usage
[ -n "$key_file" ] || usage
[ -f "$key_file" ] || {
  printf 'setup: key file not found: %s\n' "$key_file" >&2
  exit 2
}

case "$environment" in
  dev)
    database='dossier-development'
    origin='https://dossier-dev.tech964.workers.dev'
    wrangler_env='dev'
    ;;
  production)
    database='dossier-production'
    origin='https://dossier.agent964.com'
    wrangler_env=''
    ;;
  *)
    usage
    ;;
esac

key=$(tr -d '\r\n' < "$key_file")
[ -n "$key" ] || {
  printf 'setup: key file is empty: %s\n' "$key_file" >&2
  exit 2
}

web_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$web_dir"

if [ -n "$wrangler_env" ]; then
  bunx wrangler d1 migrations apply "$database" --remote --env "$wrangler_env"
else
  bunx wrangler d1 migrations apply "$database" --remote
fi

header_file=$(mktemp "${TMPDIR:-/tmp}/dossier-setup-header.XXXXXX")
trap 'rm -f "$header_file"' EXIT HUP INT TERM
chmod 600 "$header_file"
printf 'Authorization: Bearer %s\n' "$key" > "$header_file"
unset key

curl --fail-with-body --silent --show-error \
  --request POST \
  --header "@$header_file" \
  --header 'accept: application/json' \
  "$origin/api/setup"
printf '\n'
