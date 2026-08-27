#!/usr/bin/env bash
# release-mac.sh — DSH Box macOS(arm64)发布会话一体化脚本。
#
# 固化 0.1.2 手工验证通过的完整链路,一次跑完:
#   打包(不签) → 全目录 Mach-O 扫描签名 → 主 app 密封 → 代码签名校验
#   → 公证(notarytool) → stapler 装订 → ditto zip → hdiutil dmg
#   → 生成 latest-mac.yml(feed)→ spctl 终验。
#
# 关键点(0.1.2 踩坑沉淀):
#   - electron-builder 的 dmg 目标与新版 hdiutil 不兼容(plistlib 解析失败),
#     故 dmg 用手工 hdiutil create;
#   - hardenedRuntime:false 的开发配置 → 公证必须手工 codesign `--options runtime`
#     + Electron 豁免 entitlements(allow-jit 等),否则公证报
#     "does not have the hardened runtime enabled";
#   - `codesign --deep` 不可靠(漏签 node_modules 原生二进制),须全目录
#     Mach-O 扫描逐个签名 + 各 .framework/.app 整签 + 主 app 最后密封;
#   - 私有仓库 feed 认证:构建时用 -c.publish.token=<GH_TOKEN> 把 token 烤进
#     app-update.yml(electron-builder 不会自动注入);**公开仓库绝不写 token**:
#     无 token 时 electron-updater 走匿名 GitHubProvider(github.com 的 atom feed
#     + releases/download),公开仓库无需认证。若公开仓库的包里仍内嵌 PAT,
#     任何下载 release 资产的人都能拿到 → 转公开前必须发布无 token 版本并轮换旧 PAT;
#   - 磁盘产物名带空格("DSH Box-...")而 latest-mac.yml 引用连字符名,
#     上传前必须把 zip 复制成连字符名。
#
# 用法: scripts/release-mac.sh [版本号]   # 省略版本号则取 package.json
# 前置: gh 已登录(私有仓库取 token 烤进 app-update.yml;公开仓库匿名 feed);
#       签名资产目录 /tmp/dshbox-dev-id/(verify.keychain/entitlements.plist/AuthKey_*.p8);
#       需 danger-full-access(codesign/notarytool/stapler/hdiutil/security)。
#
# 转公开仓库前自查(详见 docs/REQUIREMENTS.md「需求 8.5」):
#   1. 发布一版不带 token 的新包(本脚本按仓库可见性自动切换,无需手动);
#   2. 吊销 0.1.4~0.1.6 旧包内嵌的 PAT(它们随旧 release 资产公开);
#   3. 本机签名/公证资产(id/ 下的 .p8、密码文件)确认被 .gitignore 覆盖。

set -euo pipefail

# ---------- 配置 ----------
ASSETS=/tmp/dshbox-dev-id
KEYCHAIN="$ASSETS/verify.keychain"          # 含 identity + DeveloperIDG2CA.cer
KEYCHAIN_PW="${DSH_KEYCHAIN_PW:-verify}"    # 解锁密码:env 覆盖,默认 verify(本地资产,勿提交)
IDENTITY="Developer ID Application: zhuoyu feng (36AK6V339P)"
ENTITLEMENTS="$ASSETS/entitlements.plist"
NOTARY_KEY="$ASSETS/AuthKey_4PT6QW63W7.p8"
NOTARY_KEY_ID=4PT6QW63W7
NOTARY_ISSUER=842def84-89e7-4425-9371-a79b42d41277
VOLNAME="DSH Box"

VER="${1:-$(node -e "console.log(require('./package.json').version)")}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
DIST="$ROOT/dist"
APP_DIR="$DIST/mac-arm64"
APP="$APP_DIR/DSH Box.app"
ZIP_DISK="$DIST/DSH Box-$VER-arm64-mac.zip"          # 磁盘名(带空格,仅本地)
ZIP_UPLOAD="$DIST/DSH-Box-$VER-arm64-mac.zip"        # 上传名(连字符,与 yml 引用一致)
DMG="$DIST/DSH-Box-$VER-arm64.dmg"
YML="$DIST/latest-mac.yml"

log() { echo "==> $*"; }

# ---------- 前置检查 ----------
[ -f "$KEYCHAIN" ] || { echo "缺少 keychain: $KEYCHAIN"; exit 1; }
[ -f "$ENTITLEMENTS" ] || { echo "缺少 entitlements: $ENTITLEMENTS"; exit 1; }
[ -f "$NOTARY_KEY" ] || { echo "缺少 notary key: $NOTARY_KEY"; exit 1; }
command -v gh >/dev/null || { echo "缺少 gh CLI"; exit 1; }

# ---------- 仓库可见性(决定 feed 是否带 token)----------
# private:electron-updater 需要 token(PrivateGitHubProvider → api.github.com);
# public:匿名 GitHubProvider(github.com atom feed + releases/download),**绝不写 token**
# —— 包里一旦内嵌 PAT,仓库公开后任何下载 release 资产的人都能拿到。
# DSH_REPO_VISIBILITY 可覆盖(测试用),默认真实查询。
REPO_VISIBILITY="${DSH_REPO_VISIBILITY:-$(gh repo view --json visibility -q .visibility 2>/dev/null || echo private)}"
FEED_AUTH=""
if [ "$REPO_VISIBILITY" = "public" ]; then
  log "仓库可见性: public(公开) → feed 匿名访问,不写 token"
else
  FEED_AUTH="$(gh auth token)"
  log "仓库可见性: private(私有) → feed 带 token 认证"
  log "⚠ 包内将内嵌 GitHub PAT —— 仓库转公开前必须先发布无 token 版本并轮换旧 PAT!"
fi

log "发布版本: v$VER"
log "签名身份: $IDENTITY"

# ---------- 0. keychain 解锁 + identity 校验 ----------
# codesign 需要访问 keychain 里的私钥;未解锁(non-UI 会话)会报 errSecInternalComponent。
log "解锁签名 keychain + 校验 identity"
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "$IDENTITY" \
  || { echo "keychain 中未找到 identity: $IDENTITY"; security find-identity -v -p codesigning "$KEYCHAIN"; exit 1; }

# ---------- 1. 清旧产物 + 打包(不签名,dir) ----------
rm -rf "$APP_DIR" "$ZIP_DISK" "$ZIP_UPLOAD" "$DMG" "$YML"
log "electron-builder --mac dir(不签名,CSC_IDENTITY_AUTO_DISCOVERY=false)"
PUBLISH_ARGS=()
[ -n "$FEED_AUTH" ] && PUBLISH_ARGS=(-c.publish.token="$FEED_AUTH")
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --arm64 "${PUBLISH_ARGS[@]}" \
  2>&1 | grep -Ev "^\s*$" | tail -8
[ -d "$APP" ] || { echo "打包失败:未生成 $APP"; exit 1; }

# ---------- 1.5. 手动写入 app-update.yml(签名前!) ----------
# electron-builder 仅在 isPublish 生效(--publish always/tag 触发/CI)时才生成
# app-update.yml;裸 --mac dir 不生成(0.1.3 事故根因:产物缺此文件 →
# electron-updater 无私有 token → feed 404 → 启动检查 error「重试」)。
# 手动写必须发生在签名之前,否则 Resources 内容变更会破坏 codesign seal。
# 内容与 0.1.2 一致(owner/repo/provider[/token]/updaterCacheDirName);
# public 仓库省略 token 行 → electron-updater 匿名 GitHubProvider。
log "写入 app-update.yml(签名前,${REPO_VISIBILITY} 模式)"
if [ -n "$FEED_AUTH" ]; then
  cat > "$APP/Contents/Resources/app-update.yml" <<EOF
owner: hifengzy
repo: dsh-box
provider: github
token: $FEED_AUTH
updaterCacheDirName: dsh-box-updater
EOF
else
  cat > "$APP/Contents/Resources/app-update.yml" <<EOF
owner: hifengzy
repo: dsh-box
provider: github
updaterCacheDirName: dsh-box-updater
EOF
fi
ls -la "$APP/Contents/Resources/app-update.yml"

# ---------- 2. 全目录签名(自底向上) ----------
log "扫描 Mach-O 逐个签名(hardened runtime + entitlements + timestamp)"
find "$APP/Contents" -type f -print0 | while IFS= read -r -d '' f; do
  if file "$f" | grep -q "Mach-O"; then
    codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" \
      --keychain "$KEYCHAIN" -s "$IDENTITY" "$f" || { echo "签名失败: $f"; exit 1; }
  fi
done
log "整签全部 .framework"
find "$APP/Contents" -type d -name "*.framework" -print0 | while IFS= read -r -d '' fw; do
  codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" \
    --keychain "$KEYCHAIN" -s "$IDENTITY" "$fw" || { echo "签名失败: $fw"; exit 1; }
done
log "整签全部嵌套 .app(helper/plugin 等)"
find "$APP/Contents" -type d -name "*.app" -print0 | while IFS= read -r -d '' a; do
  codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" \
    --keychain "$KEYCHAIN" -s "$IDENTITY" "$a" || { echo "签名失败: $a"; exit 1; }
done
log "主 app 密封"
codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" \
  --keychain "$KEYCHAIN" -s "$IDENTITY" "$APP"
log "签名校验(--verify --deep --strict)"
codesign --verify --deep --strict "$APP"

# ---------- 3. 公证(notarytool,--wait 等终态) ----------
log "ditto 制作公证用 zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP_DISK"
log "notarytool submit --wait(可能数分钟)"
NOTARY_OUT="$(xcrun notarytool submit "$ZIP_DISK" \
  --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait 2>&1)" \
  || { echo "$NOTARY_OUT"; echo "公证失败(见上);可用 notarytool log 取详情"; exit 1; }
echo "$NOTARY_OUT"
echo "$NOTARY_OUT" | grep -q "Accepted" || { echo "公证未 Accepted"; exit 1; }

# ---------- 4. stapler 装订(票内嵌,离线可用) ----------
log "stapler staple"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

# ---------- 5. 产物:上传名 zip + dmg + feed yml ----------
log "复制为上传名 zip(连字符,与 yml 引用一致)"
cp "$ZIP_DISK" "$ZIP_UPLOAD"

# ---------- 5.5. dmg(electron-builder 自带 dmgbuild,含 Applications 快捷方式+引导背景) ----------
# 0.1.7 教训:手工 `hdiutil create -srcfolder "$APP"` 只打包 .app,丢了
# build.dmg.contents 的 Applications 快捷方式与背景图(用户实报:dmg 打开只有
# App icon)。改用 electron-builder 同源的 dmgbuild CLI(自包含 python bundle),
# 输入**已签名** APP + settings.json(两图标槽位 + 背景图 + 窗口尺寸),
# 产出自带 .DS_Store(图标布局 + 背景)的正确 dmg。
DMGBUILD_DIR="${DMGBUILD_DIR:-$(ls -d "$HOME/Library/Caches/electron-builder/dmg-builder@1.2.5"/dmgbuild-bundle-* 2>/dev/null | head -1)}"
if [ -z "$DMGBUILD_DIR" ] || [ ! -x "$DMGBUILD_DIR/dmgbuild" ]; then
  echo "缺少 dmgbuild bundle(首次使用先跑一次: CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg 触发下载)"
  exit 1
fi
DMGBUILD="$DMGBUILD_DIR/dmgbuild"
DMG_SETTINGS="$DIST/dmg-settings-$VER.json"
log "dmgbuild 制作 dmg(Applications 快捷方式 + 背景图 + 图标布局)"
cat > "$DMG_SETTINGS" <<EOF
{
  "title": "$VOLNAME",
  "icon-size": 80,
  "background": "$ROOT/assets/dmg-background.png",
  "window": { "position": { "x": 400, "y": 200 }, "size": { "width": 540, "height": 380 } },
  "contents": [
    { "path": "$APP", "x": 130, "y": 220, "name": "DSH Box.app", "type": "file" },
    { "path": "/Applications", "x": 410, "y": 220, "name": "Applications", "type": "link" }
  ],
  "format": "UDZO",
  "compression-level": 9,
  "filesystem": "HFS+"
}
EOF
"$DMGBUILD" -s "$DMG_SETTINGS" "$VOLNAME" "$DMG"

log "生成 latest-mac.yml"
SHA512="$(shasum -a 512 "$ZIP_UPLOAD" | awk '{print $1}' | xxd -r -p | base64)"
SIZE="$(stat -f %z "$ZIP_UPLOAD")"
RELDATE="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
ZIP_NAME="$(basename "$ZIP_UPLOAD")"   # yml 须用纯文件名(electron-updater 相对 feed 拼接 URL)
cat > "$YML" <<EOF
version: $VER
files:
  - url: $ZIP_NAME
    sha512: $SHA512
    size: $SIZE
path: $ZIP_NAME
sha512: $SHA512
releaseDate: '$RELDATE'
EOF

# ---------- 6. Gatekeeper 终验 ----------
log "spctl 终验"
spctl -a -t exec -vv "$APP" 2>&1 || { echo "spctl 未 accepted(见上)"; exit 1; }

log "==== 发布产物就绪 ===="
echo "  版本:   v$VER"
echo "  zip:    $ZIP_UPLOAD($(stat -f %z "$ZIP_UPLOAD") B)"
echo "  dmg:    $DMG($(stat -f %z "$DMG") B)"
echo "  yml:    $YML(sha512 $SHA512)"
echo "  下一步: gh release create v$VER $ZIP_UPLOAD $DMG $YML --latest"