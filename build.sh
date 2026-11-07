#!/bin/bash
# Build, align and sign the Neon Skyway APK with the standalone Android tools.
# No Gradle, Android Studio, or network access is required.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
SDK="${ANDROID_SDK_ROOT:-$ROOT/.toolchain/android-sdk}"
BUILD_TOOLS="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
APP="$ROOT/android/app/src/main"
BUILD="$ROOT/build"
DIST="$ROOT/dist"
KEYSTORE="$ROOT/keystore/neonskyway.jks"
KEY_ALIAS="${KEY_ALIAS:-neonskyway}"
STORE_PASS="${KEYSTORE_PASSWORD:-neonskyway-local}"
KEY_PASS="${KEY_PASSWORD:-neonskyway-local}"
VERSION_NAME="1.1.0"
VERSION_CODE="2"
APK_NAME="NeonSkyway-v${VERSION_NAME}.apk"

for tool in aapt2 d8 zipalign apksigner; do
  if [ ! -x "$BUILD_TOOLS/$tool" ]; then
    echo "missing $BUILD_TOOLS/$tool" >&2
    exit 1
  fi
done
if [ ! -f "$PLATFORM" ]; then
  echo "missing $PLATFORM" >&2
  exit 1
fi
command -v javac >/dev/null || { echo "javac not found (install a JDK 8+)" >&2; exit 1; }
command -v keytool >/dev/null || { echo "keytool not found" >&2; exit 1; }
command -v zip >/dev/null || { echo "zip not found" >&2; exit 1; }

rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$DIST" "$ROOT/keystore"

echo "[1/7] compiling Android resources"
"$BUILD_TOOLS/aapt2" compile --dir "$APP/res" -o "$BUILD/res.zip"

echo "[2/7] linking APK resources and assets"
"$BUILD_TOOLS/aapt2" link \
  -o "$BUILD/app-unsigned.apk" \
  -I "$PLATFORM" \
  --manifest "$APP/AndroidManifest.xml" \
  -R "$BUILD/res.zip" \
  -A "$APP/assets" \
  --java "$BUILD/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  --auto-add-overlay

echo "[3/7] compiling Java"
# shellcheck disable=SC2046
javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$PLATFORM:$BUILD_TOOLS/core-lambda-stubs.jar" \
  -Xlint:-options -d "$BUILD/classes" \
  $(find "$BUILD/gen" "$APP/java" -name '*.java' -print)

echo "[4/7] dexing"
"$BUILD_TOOLS/d8" --lib "$PLATFORM" --min-api 24 --output "$BUILD/dex" \
  $(find "$BUILD/classes" -name '*.class' -print)

echo "[5/7] packaging classes.dex"
(cd "$BUILD/dex" && zip -q -j "$BUILD/app-unsigned.apk" classes.dex)

echo "[6/7] aligning"
"$BUILD_TOOLS/zipalign" -f -p 4 "$BUILD/app-unsigned.apk" "$BUILD/app-aligned.apk"

if [ ! -f "$KEYSTORE" ]; then
  echo "[sign] creating local release keystore (not for Play Store)"
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" \
    -storepass "$STORE_PASS" \
    -keypass "$KEY_PASS" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Neon Skyway, OU=Local Build, O=Neon Skyway, L=Shanghai, ST=Shanghai, C=CN"
fi

echo "[7/7] signing"
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$STORE_PASS" \
  --key-pass "pass:$KEY_PASS" \
  --out "$DIST/$APK_NAME" \
  "$BUILD/app-aligned.apk"

"$BUILD_TOOLS/apksigner" verify --verbose "$DIST/$APK_NAME"
"$BUILD_TOOLS/aapt2" dump badging "$DIST/$APK_NAME" | head -8

ls -lh "$DIST/$APK_NAME"
echo "APK: $DIST/$APK_NAME"
