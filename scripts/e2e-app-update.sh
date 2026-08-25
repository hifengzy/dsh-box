#!/usr/bin/env bash
# e2e-app-update.sh — 应用自更新「完整流程」端到端(旧版 → 查/download/装 → Squirrel 替换 → 重启 → 新版)
#
# 流程:
#   1) package.json version 临时改 0.2.0 → electron-builder --mac dir 构建(未签名)
#      → 手工 codesign 自签(--force --deep,自签证书;Squirrel 校验只查签名完整性)
#      → ditto 打包 zip + 实时算 sha512 写 latest-mac.yml(fake repo)
#   2) 还原 version 0.1.0 → 同法构建+自签旧版 app(含 DSH_E2E_APP_UPDATE 钩子)
#   3) python3 http.server 起 fake repo(0.2.0 的 latest-mac.yml + zip)
#   4) userData 预置 marker;启动旧版 app(DSH_E2E_APP_UPDATE=1 + DSH_APP_UPDATE_FEED=本地)
#      → 自动[检查→下载→安装(quitAndInstall)]
#   5) Squirrel 用 0.2.0 zip 替换旧版 .app 并重启
#   6) 轮询:Info.plist CFBundleShortVersionString=0.2.0 且进程存活 → 断言数据保留(marker) → PASS
#
# 需要:环境变量 DSH_E2E_CERT_KEYCHAIN(自签证书 keychain)+ DSH_E2E_CERT_IDENTITY(证书名);
# 可写 ~/Library/Caches(electron-updater/Squirrel 硬编码)+ 构建(几 GB node_modules)。
set -euo pipefail

E2E_DIR="${E2E_DIR:-/tmp/dshbox-e2e}"
REPO_DIR="$E2E_DIR/repo"
OLDAPP_DIR="$E2E_DIR/app-install"
FEED_PORT="${E2E_FEED_PORT:-43998}"
APP_PORT="${E2E_APP_PORT:-3281}"
NEW_VER="${E2E_NEW_VER:-0.2.0}"
OLD_VER="0.1.0"
APP_PKG="package.json"
APP_DIR_PATH="dist/mac-arm64/DSH Box.app"
BIN_PATH="$OLDAPP_DIR/DSH Box.app/Contents/MacOS/DSH Box"
ZIP_NAME="DSH-Box-$NEW_VER-arm64-mac.zip"

echo "== e2e app-update: $OLD_VER -> $NEW_VER =="
rm -rf "$E2E_DIR"; mkdir -p "$REPO_DIR" "$OLDAPP_DIR" "$E2E_DIR/user"

# 签名:必须提供 DSH_E2E_CERT_KEYCHAIN(自签证书 keychain)+ DSH_E2E_CERT_IDENTITY;
# 缺省退化为未签名(此时 Squirrel 校验会拦截替换,断言停在 downloaded/install)。
IDENTITY="${DSH_E2E_CERT_IDENTITY:-}"
KEYCHAIN="${DSH_E2E_CERT_KEYCHAIN:-}"
sign_app() {
  local app="$1"
  if [ -n "$IDENTITY" ] && [ -n "$KEYCHAIN" ]; then
    security unlock-keychain -p "${DSH_E2E_CERT_PASS:-dshbox}" "$KEYCHAIN" >/dev/null 2>&1 || true
    codesign --force --deep --sign "$IDENTITY" --keychain "$KEYCHAIN" "$app"
  else
    echo "  (未签名模式)"
  fi
}
if [ -n "$IDENTITY" ]; then echo "  签名模式: $IDENTITY"; else echo "  未签名模式(退化)"; fi

# 1) 构建新版本 dir → 自签 → zip + latest-mac.yml
cp "$APP_PKG" /tmp/pkg-e2e.bak.json
node -e "const p=require('./package.json');p.version='$NEW_VER';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir >/dev/null 2>&1
sign_app "$APP_DIR_PATH"
ditto -c -k --keepParent "dist/mac-arm64/DSH Box.app" "$REPO_DIR/$ZIP_NAME"
ZIP_SHA="$(shasum -a 512 "$REPO_DIR/$ZIP_NAME" | awk '{print $1}' | xxd -r -p | base64)"
ZIP_SIZE="$(stat -f%z "$REPO_DIR/$ZIP_NAME")"
cat > "$REPO_DIR/latest-mac.yml" <<EOF
version: $NEW_VER
files:
  - url: $ZIP_NAME
    sha512: $ZIP_SHA
    size: $ZIP_SIZE
path: $ZIP_NAME
sha512: $ZIP_SHA
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
EOF
echo "  1. 新版本 zip 就绪: $(du -h "$REPO_DIR/$ZIP_NAME" | cut -f1); yml: version: $NEW_VER"

# 2) 还原旧版本并构建旧版 app(dir)+ 自签
cp /tmp/pkg-e2e.bak.json "$APP_PKG" && rm -f /tmp/pkg-e2e.bak.json
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir >/dev/null 2>&1
sign_app "$APP_DIR_PATH"
cp -R "$APP_DIR_PATH" "$OLDAPP_DIR/DSH Box.app"
# electron-builder 的 dir 目标不生成 app-update.yml(仅 zip/dmg 等发布目标);electron-updater
# 启动会读 <Resources>/app-update.yml(拿 updaterCacheDirName) → 手动补一份(provider/github
# 无关紧要,真实 feed 由 DSH_APP_UPDATE_FEED 覆盖)。updaterCacheDirName 与构建产物一致。
cat > "$OLDAPP_DIR/DSH Box.app/Contents/Resources/app-update.yml" <<EOF
provider: github
owner: hifengzy
repo: dsh-box
updaterCacheDirName: dsh-box-updater
EOF
echo "  2. 旧版 app 就绪: CFBundleShortVersionString=$(plutil -p "$OLDAPP_DIR/DSH Box.app/Contents/Info.plist" | grep CFBundleShortVersionString | sed 's/.*=> "//;s/"//')"

# 3) fake repo
( cd "$REPO_DIR" && python3 -m http.server "$FEED_PORT" >/dev/null 2>&1 ) &
SRV=$!
sleep 1
curl -sf -o /dev/null "http://127.0.0.1:$FEED_PORT/latest-mac.yml" && echo "  3. fake repo 在线(latest-mac.yml 可读)" || { echo "  FAIL repo"; exit 1; }

# 4) userData marker + 启动旧版(e2e 自动序列)
MARKER="e2e-marker-$(date +%s)"
echo "$MARKER" > "$E2E_DIR/user/dsh-e2e-marker.txt"
env DSH_E2E_APP_UPDATE=1 \
  DSH_APP_UPDATE_FEED="http://127.0.0.1:$FEED_PORT" \
  DSH_USER_DATA="$E2E_DIR/user" \
  DSH_HOME="$E2E_DIR/dsh-home" \
  DSH_APP_PORT="$APP_PORT" \
  DSH_LOCK_PATH="$E2E_DIR/lock" \
  "$BIN_PATH" >"$E2E_DIR/run.log" 2>&1 &
echo "  4. 旧版 app 已启动(e2e 自动序列运行中)"

# 5) 轮询替换+重启
for i in $(seq 1 150); do
  v="$( (plutil -p "$OLDAPP_DIR/DSH Box.app/Contents/Info.plist" 2>/dev/null || true) | grep CFBundleShortVersionString | sed 's/.*=> "//;s/"//' || true )"
  procs="$(pgrep -f "$BIN_PATH" | wc -l | tr -d ' ' || true)"
  if [ "$v" = "$NEW_VER" ] && [ "${procs:-0}" -ge 1 ]; then
    got_marker="$(cat "$E2E_DIR/user/dsh-e2e-marker.txt" 2>/dev/null || echo MISSING)"
    errs="$(grep -c "APP_UPDATE_ERROR" "$E2E_DIR/run.log" 2>/dev/null || true)"
    echo "== 替换成功: app 已升级到 $NEW_VER (进程 $procs) =="
    echo "   用户数据 marker: $got_marker"
    echo "   run.log 错误计数: $errs"
    [ "$got_marker" = "$MARKER" ] && echo "PASS ✓ 数据保留" || { echo "FAIL ✗ 数据丢失"; exit 1; }
    [ "$errs" = "0" ] || { echo "FAIL ✗ 存在 APP_UPDATE_ERROR"; exit 1; }
    grep -E "app-update\]|e2e-app-update" "$E2E_DIR/run.log" | tail -8 || true
    echo "PASS ✓ 完整流程: $OLD_VER → 查/下载/安装 → Squirrel 替换 → 重启到 $NEW_VER"
    exit 0
  fi
  sleep 2
done
echo "FAIL ✗ 超时未完成替换 (plist v=${v:-none})" >&2
grep -E "app-update\]|e2e-app-update|error" "$E2E_DIR/run.log" 2>/dev/null | tail -12 >&2 || true
exit 1