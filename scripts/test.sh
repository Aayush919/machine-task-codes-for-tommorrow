#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${JAVA_HOME:-}" && -d "/opt/homebrew/opt/openjdk@21" ]]; then
  export JAVA_HOME="/opt/homebrew/opt/openjdk@21"
fi
if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi

export DATABASE_URL="${DATABASE_URL:-postgresql://chat:chat@127.0.0.1:5432/chat_test?schema=public}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379/3}"
export FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-demo-chat}"

npx prisma generate
exec npx firebase emulators:exec --only firestore --project demo-chat -- "npx vitest run"
