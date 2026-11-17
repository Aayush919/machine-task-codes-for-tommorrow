#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Homebrew leaves OpenJDK off PATH. Firebase only runs `java -version`.
if [[ -z "${JAVA_HOME:-}" && -d "/opt/homebrew/opt/openjdk@21" ]]; then
  export JAVA_HOME="/opt/homebrew/opt/openjdk@21"
elif [[ -z "${JAVA_HOME:-}" && -d "/usr/local/opt/openjdk@21" ]]; then
  export JAVA_HOME="/usr/local/opt/openjdk@21"
fi
if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi

exec npx firebase emulators:start --only firestore --project demo-chat
