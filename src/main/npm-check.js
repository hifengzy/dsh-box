"use strict";

/**
 * npm-check.js — 查询 npm registry 上 @deepseek-ai/dsh 的版本信息。
 *
 * 数据源:registry JSON API(不是 npmjs.com 网页,那是前端渲染的页面,抓不了):
 *   GET https://registry.npmjs.org/@deepseek-ai/dsh
 *   → { "dist-tags": { latest }, "time": { "<version>": "<ISO 发布时间>" }, versions }
 *
 * 用途:
 *   - 每次启动应用静默查一次 → 有新版则顶栏入口亮红点;
 *   - 每次进入「dsh 服务与版本」页面再查一次,刷新列表。
 *
 * 离线降级:查询失败时回退到上次成功缓存(userData/cache),并标记 fromCache。
 * 超时 10s;启动路径完全非阻塞(失败不抛到启动流程)。
 *
 * 版本比较:semver.gt(候选, 当前) —— 天然处理预发布版:
 *   0.1.0 > 0.1.0-rc.6、0.2.0-rc.1 > 0.1.0-rc.6,都算「更新」。
 */

const fs = require("node:fs");
const path = require("node:path");
const semver = require("semver");

/**
 * registry 根地址,惰性读取:可用 DSH_NPM_REGISTRY 切换镜像(如 npmmirror),
 * 也方便回归测试把环境变量指向本地 fixture 服务器(在调用前设置即可)。
 */
function registryBase() {
  return (process.env.DSH_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
}

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_FILE = "dsh-registry.json";

/** 缓存目录(userData/cache),由 init() 设置 */
let cacheDir = null;

function init(dir) {
  cacheDir = dir;
}

function cachePath() {
  return cacheDir ? path.join(cacheDir, CACHE_FILE) : null;
}

/** 归一化 registry 响应:按发布时间倒序的版本行列表 */
function normalize(data) {
  const distTags = data["dist-tags"] || {};
  const time = data.time || {};
  const versions = data.versions || {};
  const list = Object.keys(time)
    .filter((v) => versions[v])
    .map((v) => ({
      version: v,
      publishedAt: time[v] || null,
      tarball: versions[v].dist?.tarball ?? null,
      integrity: versions[v].dist?.integrity ?? null,
    }));
  // time 里缺失但 versions 里存在的(少见):补进列表
  const seen = new Set(list.map((r) => r.version));
  for (const v of Object.keys(versions)) {
    if (!seen.has(v)) {
      list.push({
        version: v,
        publishedAt: null,
        tarball: versions[v].dist?.tarball ?? null,
        integrity: versions[v].dist?.integrity ?? null,
      });
    }
  }
  list.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    if (ta !== tb) return tb - ta;
    return semver.rcompare(a.version, b.version);
  });
  return { distTags, list, fetchedAt: new Date().toISOString() };
}

async function fetchRegistry() {
  const url = `${registryBase()}/@deepseek-ai/dsh`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`npm registry 请求失败 (HTTP ${res.status})`);
  return normalize(await res.json());
}

function readCache() {
  const p = cachePath();
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(data) {
  const p = cachePath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  } catch {
    /* 缓存写失败不致命 */
  }
}

/**
 * 查一次 registry;失败回退缓存。
 * @returns {Promise<{ data: object, fromCache: boolean }>}
 */
async function checkOnce() {
  try {
    const data = await fetchRegistry();
    writeCache(data);
    return { data, fromCache: false };
  } catch (error) {
    const cached = readCache();
    if (cached) return { data: cached, fromCache: true };
    throw error;
  }
}

/**
 * 给版本行打标:isLatest / isCurrent / hasUpdate(比当前运行版本新)。
 * @param {object} data normalize() 的返回值
 * @param {string|null} runtimeVersion 当前运行中的 dsh 版本
 */
function decorate(data, runtimeVersion) {
  const latest = data.distTags.latest || null;
  const rows = data.list.map((row) => ({
    ...row,
    isLatest: latest != null && row.version === latest,
    isCurrent: runtimeVersion != null && row.version === runtimeVersion,
    hasUpdate: runtimeVersion != null && semver.valid(row.version) && semver.gt(row.version, runtimeVersion),
  }));
  const hasUpdate =
    runtimeVersion != null &&
    latest != null &&
    semver.valid(latest) &&
    semver.gt(latest, runtimeVersion);
  return { latest, runtime: runtimeVersion, hasUpdate, rows, fetchedAt: data.fetchedAt };
}

module.exports = { init, checkOnce, decorate, normalize, registryBase, cachePath };
