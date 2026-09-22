#!/usr/bin/env bash
# setup-keystore.sh — decode + verify the production keystore from repo
# secrets, then write android/keystore.properties for Gradle.
#
# Shared by both CI pipelines (android-build.yml APK, android-aab.yml AAB).
# Expects 4 env vars: ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD,
# ANDROID_KEYSTORE_ALIAS, ANDROID_KEY_PASSWORD.
#
# Diagnostics-first: every failure prints WHICH check failed and the actual
# keytool output (the previous inline version silenced stderr with >/dev/null
# 2>&1, so a CI failure was unexplainable). Also sanitizes the secrets: values
# pasted from an editor can carry \r (CRLF paste), trailing whitespace or
# newlines — each a silent killer of keytool verification.
set -euo pipefail

fail() { echo "❌ $1" >&2; exit 1; }

: "${ANDROID_KEYSTORE_BASE64:?ANDROID_KEYSTORE_BASE64 kosong}"
: "${ANDROID_KEYSTORE_PASSWORD:?ANDROID_KEYSTORE_PASSWORD kosong}"
: "${ANDROID_KEYSTORE_ALIAS:?ANDROID_KEYSTORE_ALIAS kosong}"
: "${ANDROID_KEY_PASSWORD:?ANDROID_KEY_PASSWORD kosong}"

KS_FILE="android/app/upload-keystore.keystore"
PROPS_FILE="android/keystore.properties"

# ── 1) Sanitize: strip CR/newlines + surrounding whitespace ─────────────────
clean() { printf '%s' "$1" | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }
B64=$(clean "$ANDROID_KEYSTORE_BASE64")
STORE_PASS=$(clean "$ANDROID_KEYSTORE_PASSWORD")
ALIAS=$(clean "$ANDROID_KEYSTORE_ALIAS")
KEY_PASS=$(clean "$ANDROID_KEY_PASSWORD")
echo "Panjang secret (disanitasi): base64=${#B64} storePass=${#STORE_PASS} alias=${#ALIAS} keyPass=${#KEY_PASS}"

# ── 2) Decode base64 → .keystore + sanity checks ─────────────────────────────
mkdir -p android/app
printf '%s' "$B64" | base64 -d > "$KS_FILE" 2>/tmp/b64.err \
  || fail "base64 decode gagal: $(cat /tmp/b64.err) — pastikan secret berisi base64 MURNI (satu baris)."
SIZE=$(wc -c < "$KS_FILE")
MAGIC=$(head -c4 "$KS_FILE" | od -An -tx1 | tr -d ' \n')
echo "Keystore decoded: $SIZE bytes, magic: $MAGIC (JKS=feedfeed, PKCS12=504b0304)"
[ "$SIZE" -gt 100 ] || fail "File keystore hanya $SIZE bytes — secret BASE64 salah (terpotong/berisi karakter asing)."

# ── 3) Locate keytool ────────────────────────────────────────────────────────
if command -v keytool >/dev/null 2>&1; then KEYTOOL=keytool
elif [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ]; then KEYTOOL="$JAVA_HOME/bin/keytool"
elif [ -n "${JAVA_HOME_17_X64:-}" ]; then KEYTOOL=$(find "$JAVA_HOME_17_X64" -name keytool 2>/dev/null | head -1)
fi
[ -n "${KEYTOOL:-}" ] || fail "keytool tidak ditemukan — JDK belum ter-setup di environment ini."
echo "keytool: $KEYTOOL"

# ── 4) Verify keystore + store password + alias (keytool -list) ──────────────
"$KEYTOOL" -list -keystore "$KS_FILE" -storepass "$STORE_PASS" -alias "$ALIAS" > /tmp/kt.out 2>/tmp/kt.err \
  || { sed 's/\r$//' /tmp/kt.out /tmp/kt.err 2>/dev/null; fail "keytool -list gagal — kombinasi BASE64 / STORE PASSWORD / ALIAS salah (lihat pesan keytool di atas)."; }
echo "✅ Keystore valid + alias '$ALIAS' ditemukan (store password benar)"

# ── 5) Verify KEY password (certreq actually recovers the key entry) ────────
"$KEYTOOL" -certreq -keystore "$KS_FILE" -storepass "$STORE_PASS" -keypass "$KEY_PASS" \
  -alias "$ALIAS" -file /dev/null > /dev/null 2>/tmp/kt2.err \
  || { sed 's/\r$//' /tmp/kt2.err; fail "KEY PASSWORD salah (keytool: cannot recover key) — cek secret ANDROID_KEY_PASSWORD."; }
echo "✅ Key password valid (key entry berhasil direcover)"

# ── 6) Write keystore.properties (echo-based; heredoc indentation corrupts) ─
{
  echo "storeFile=upload-keystore.keystore"
  echo "storePassword=$STORE_PASS"
  echo "keyAlias=$ALIAS"
  echo "keyPassword=$KEY_PASS"
} > "$PROPS_FILE"
echo "✅ Keystore siap — $PROPS_FILE ditulis (alias: $ALIAS)"
