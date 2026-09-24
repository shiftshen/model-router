#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
BUILD="$ROOT/build"
APP="$BUILD/Model Router.app"
NODE_VERSION="24.20.0"
# 显式指定部署目标：不给 -target 的话 swiftc 会按本机 SDK 写 minos。
# 之前在 macOS 26 的机器上构建，二进制里写的就是「最低要求 26.0」——
# Info.plist 写 14.0 也没用，老系统上根本加载不起来。
DEPLOYMENT_TARGET="12.0"
SDK_PATH="${MACOS_SDK_PATH:-$(xcrun --show-sdk-path)}"

mkdir -p "$BUILD/slices" "$APP/Contents/MacOS" "$APP/Contents/Resources/runtime"

if [[ ! -f "$ROOT/Resources/ModelRouter.icns" ]]; then
  "$ROOT/scripts/make-icon.sh"
fi

# 构建产物落在仓库的 build/ 里，会被 Spotlight / LaunchServices 一起收录，
# 结果 Launchpad 里出现两个「Model Router」（一个是 /Applications 里的正主，
# 一个是这里的构建产物）。放一个 .metadata_never_index 并主动注销，别让它再冒出来。
touch "$BUILD/.metadata_never_index"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true

# 两个架构各编一份再合并：同一份 dmg 在 Apple Silicon 和 Intel 上都能直接跑。
SLICES=()
for ARCH in arm64 x86_64; do
  OUT="$BUILD/slices/CodexModelAssistant-$ARCH"
  if swiftc \
      -sdk "$SDK_PATH" \
      -target "$ARCH-apple-macos$DEPLOYMENT_TARGET" \
      -parse-as-library -O \
      -framework SwiftUI -framework AppKit \
      "$ROOT"/Sources/*.swift -o "$OUT" 2>"$BUILD/slices/$ARCH.log"; then
    SLICES+=("$OUT")
    echo "已编译 $ARCH（最低 macOS $DEPLOYMENT_TARGET）"
  else
    echo "跳过 $ARCH：$(tail -2 "$BUILD/slices/$ARCH.log" | tr '\n' ' ')" >&2
  fi
done
[[ ${#SLICES[@]} -eq 2 ]] || { echo "Universal 构建必须两个架构都成功，检查 $BUILD/slices/*.log" >&2; exit 1; }
lipo -create -output "$APP/Contents/MacOS/CodexModelAssistant" "${SLICES[@]}"
lipo "$APP/Contents/MacOS/CodexModelAssistant" -verify_arch arm64
lipo "$APP/Contents/MacOS/CodexModelAssistant" -verify_arch x86_64
echo "主程序架构：$(lipo -archs "$APP/Contents/MacOS/CodexModelAssistant")"

cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
rsync -a --delete "$ROOT"/src/ "$APP/Contents/Resources/runtime/"
[[ -f "$ROOT/vendor/model-router-engine/node_modules/@typesafe-ai/sdk/package.json" ]] || {
  echo "缺少模型路由引擎依赖（先运行 npm ci --prefix vendor/model-router-engine --omit=dev）" >&2
  exit 1
}
rsync -a --delete "$ROOT"/vendor/model-router-engine/ "$APP/Contents/Resources/model-router-engine/"

# 单个 Universal Node：包内不再留 Intel-only helper，避免 Apple Silicon 的兼容性提示。
NODE_SLICES=()
for ARCH in arm64 x64; do
  NODE_ROOT="$ROOT/.runtime-cache/node-v$NODE_VERSION-darwin-$ARCH"
  if [[ -x "$NODE_ROOT/bin/node" ]]; then
    NODE_SLICES+=("$NODE_ROOT/bin/node")
    cp "$NODE_ROOT/LICENSE" "$APP/Contents/Resources/Node-LICENSE"
  else
    echo "缺少 $ARCH 的 node 运行时（先跑 scripts/fetch-runtime.sh）" >&2
    exit 1
  fi
done
lipo -create "${NODE_SLICES[@]}" -output "$APP/Contents/Resources/node"
lipo "$APP/Contents/Resources/node" -verify_arch arm64
lipo "$APP/Contents/Resources/node" -verify_arch x86_64
# 保留既有 LaunchAgent / Swift 调用路径，两个别名都由系统选择原生架构。
for ARCH in arm64 x64; do
  rm -f "$APP/Contents/Resources/node-$ARCH"
  ln -s node "$APP/Contents/Resources/node-$ARCH"
done

cp "$ROOT/Resources/ModelRouter.icns" "$APP/Contents/Resources/ModelRouter.icns"
chmod 755 "$APP/Contents/MacOS/CodexModelAssistant"

IDENTITY="${CODE_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1)}"
NODE_BINS=("$APP/Contents/Resources/node")
if [[ -n "$IDENTITY" ]]; then
  # node 是独立可执行文件，必须单独签（带自己的 entitlements），否则主程序签了它也起不来。
  for NODE_BIN in "${NODE_BINS[@]}"; do
    [[ -x "$NODE_BIN" ]] || continue
    codesign --force --options runtime --timestamp --entitlements "$ROOT/Resources/node-entitlements.plist" --sign "$IDENTITY" "$NODE_BIN"
  done
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
else
  for NODE_BIN in "${NODE_BINS[@]}"; do
    [[ -x "$NODE_BIN" ]] && codesign --force --sign - "$NODE_BIN"
  done
  codesign --force --deep --sign - "$APP"
fi
echo "$APP"
