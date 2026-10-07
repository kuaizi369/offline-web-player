#!/usr/bin/env node
/**
 * 离线音乐与视频播放器 —— 本地服务
 * 零依赖：仅使用 Node.js 内置模块
 *
 * 能力：
 *  1. 递归扫描 config.json 中配置的媒体库目录，建立索引
 *  2. 分类：大类（音乐 / 视频）+ 文件夹专辑 + 智能关键词标签
 *  3. 以支持 Range 断点续传的流方式提供媒体文件（拖动进度条即时响应）
 *  4. 调起系统默认播放器 / 在资源管理器中定位文件
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const APP_DIR = __dirname;
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
const EXAMPLE_CONFIG_PATH = path.join(APP_DIR, 'config.example.json');

/* ────────────────────────────  应用信息  ────────────────────────────
   版本号与仓库地址的唯一来源：页面上「关于」区块从这里取，改版本只改这里。 */
const APP_NAME = '离线音乐与视频播放器';
const APP_VERSION = '0.3.1';
const APP_REPO = 'https://github.com/kuaizi369/offline-web-player';
const APP_AUTHOR = '筷子';

/* ────────────────────────────  配置  ──────────────────────────── */

const DEFAULT_CONFIG = {
  port: 8787,
  autoOpenBrowser: true,
  scanOnStart: true,
  roots: [],
  excludeDirs: ['node_modules', '.git', '.workbuddy', '$RECYCLE.BIN', 'System Volume Information'],
  minSizeKB: 30,
  tags: []
};

let CONFIG_FILE_OK = false;

/** 读取 config.example.json 作为默认值来源（全新克隆时的配置模板）。
 *  失败则退回内置最小默认值，不影响启动。 */
function readExampleConfig() {
  try {
    return JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('  ⚠ config.example.json 无法解析，改用内置默认配置：', err.message);
    }
    return {};
  }
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    CONFIG_FILE_OK = true;
    return Object.assign({}, DEFAULT_CONFIG, raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      /* config.json 尚不存在 —— 首次运行 / 全新克隆。
         用 config.example.json 补默认值，并允许 saveConfig 落盘生成。 */
      console.log('  · 未找到 config.json，使用 config.example.json 的默认配置');
      console.log('    （在页面上添加扫描目录后会自动生成 config.json）');
      CONFIG_FILE_OK = true;
      return Object.assign({}, DEFAULT_CONFIG, readExampleConfig());
    }
    /* 文件存在但读不动 / 解析失败：绝不能写回，否则会覆盖用户的原配置 */
    console.error('  ⚠ config.json 无法解析，已改用默认配置（不会覆盖该文件）：', err.message);
    return Object.assign({}, DEFAULT_CONFIG, readExampleConfig());
  }
}

const CONFIG = loadConfig();
const PORT = Number(process.env.PORT || CONFIG.port || 8787);
const HOST = '127.0.0.1';

/* ── 扫描范围 ──
   用户在页面上添加过目录 → 只扫描这些目录（不再全盘扫描）。
   一个都没添加 → 默认只扫描「播放器自身所在目录」及其子目录。 */

/** 用户显式配置的扫描目录 */
function customRoots() {
  return (Array.isArray(CONFIG.roots) ? CONFIG.roots : []).filter((r) => r && r.path);
}

const usingDefaultRoots = () => customRoots().length === 0;

/** 当前实际生效的扫描目录（含默认兜底） */
function effectiveRoots() {
  const rs = customRoots();
  if (rs.length) return rs;
  return [{ path: APP_DIR, label: '播放器目录', group: '本地' }];
}

/** 把配置写回 config.json（新增 / 移除扫描目录后调用） */
function saveConfig() {
  if (!CONFIG_FILE_OK) {
    console.error('  ⚠ config.json 当前不可解析，已跳过写入以免覆盖原文件');
    return false;
  }
  try {
    const clean = {};
    for (const [k, v] of Object.entries(CONFIG)) clean[k] = v;   // 保留 "//xxx" 注释键
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    console.error('  ⚠ 配置写入失败：', err.message);
    return false;
  }
}

/* ────────────────────────────  扩展名  ──────────────────────────── */

const AUDIO_EXT = new Set([
  'mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'ape',
  'alac', 'aiff', 'aif', 'mp2', 'mka', 'amr', 'ac3', 'dts', 'mid', 'midi'
]);

const VIDEO_EXT = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'rmvb', 'rm', 'ts',
  'm4v', 'mpg', 'mpeg', '3gp', 'vob', 'm2ts', 'f4v', 'asf', 'ogv', 'divx'
]);

/** 浏览器内置播放器可直接解码的容器（用于界面上提示） */
const NATIVE_AUDIO = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm']);
const NATIVE_VIDEO = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);

const MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wma: 'audio/x-ms-wma', ape: 'audio/x-ape', aiff: 'audio/aiff', aif: 'audio/aiff',
  mid: 'audio/midi', midi: 'audio/midi', mka: 'audio/x-matroska', amr: 'audio/amr',
  ac3: 'audio/ac3', dts: 'audio/vnd.dts', mp2: 'audio/mpeg',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime',
  flv: 'video/x-flv', wmv: 'video/x-ms-wmv', rmvb: 'video/vnd.rn-realvideo',
  rm: 'video/vnd.rn-realvideo', ts: 'video/mp2t', m2ts: 'video/mp2t',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp', vob: 'video/mpeg',
  f4v: 'video/x-f4v', asf: 'video/x-ms-asf', divx: 'video/divx'
};

/* ────────────────────────────  工具函数  ──────────────────────────── */

const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * 从文件名解析「歌手 - 歌名」。
 * 兼容 "100展展与罗罗 - 沙漠骆驼"、"邓壬鑫 - Aloha Heja He（抖音治愈版）"、
 * "Champagne Ocean_Ehrling_9277" 等命名习惯。
 */
function parseName(stem) {
  // 去掉开头的曲目序号，如 "100展展与罗罗" → "展展与罗罗"、"01. 片名" → "片名"
  let s = stem.replace(/^\s*\d{1,3}\s*[.\-_、)\]]\s*/, '');

  const seps = [' - ', ' – ', ' — ', '－', ' -', '- ', '—_', '_'];
  for (const sep of seps) {
    const i = s.indexOf(sep);
    if (i > 0 && i < s.length - sep.length) {
      const artist = s.slice(0, i).trim();
      const title = s.slice(i + sep.length).trim();
      if (artist && title && artist.length <= 40) {
        return { artist, title: title || s };
      }
    }
  }
  return { artist: '', title: s };
}

/** 语义化的文件夹名（用于专辑展示） */
function prettyFolder(name) {
  return name.replace(/^\d{1,3}\s*[.\-_]\s*/, '').trim() || name;
}

/* ────────────────────────────  曲风分类  ──────────────────────────── */

/**
 * 曲风规则表。顺序即优先级：越靠前越具体，先命中先得。
 * 匹配对象 = 相对目录 + 文件名（不区分大小写）。命中不了的交给联网补全。
 * 注意：不要把太短的词放进来当关键词（例如裸 'ost' 会命中 Lost / Most）。
 */
const GENRES = [
  { id: 'cntrad',     name: '中国风 / 戏曲', kws: ['古风', '国风', '中国风', '戏曲', '京剧', '越剧', '黄梅戏', '豫剧', '评剧', '粤剧', '昆曲', '相声', '民乐', '古筝', '二胡', '琵琶', '笛子', '葫芦丝', '唢呐'] },
  { id: 'classical',  name: '古典',          kws: ['古典', 'classical', '交响', '奏鸣曲', '协奏曲', '序曲', '夜曲', '圆舞曲', '进行曲', '钢琴曲', '小提琴曲', '大提琴', '莫扎特', '贝多芬', '巴赫', '肖邦', '李斯特', '柴可夫斯基', '维瓦尔第', '德彪西', '舒伯特', '帕格尼尼'] },
  { id: 'folk',       name: '民谣',          kws: ['民谣', 'folk', '校园', '弹唱', '木吉他'] },
  { id: 'metal',      name: '金属 / 朋克',   kws: ['金属', 'metal', '朋克', 'punk'] },
  { id: 'rock',       name: '摇滚',          kws: ['摇滚', 'rock', 'indie', 'alternative', '另类'] },
  { id: 'hiphop',     name: '嘻哈 / 说唱',   kws: ['嘻哈', '说唱', '饶舌', 'hiphop', 'hip-hop', 'rap', 'trap'] },
  { id: 'electronic', name: '电子 / 舞曲',   kws: ['电子', '电音', 'edm', 'dj', '舞曲', '慢摇', '串烧', 'remix', '混音', '蹦迪', '夜店', '酒吧'] },
  { id: 'jazz',       name: '爵士 / 蓝调',   kws: ['爵士', 'jazz', '蓝调', 'blues', 'bossa', 'swing'] },
  { id: 'country',    name: '乡村',          kws: ['乡村', 'country'] },
  { id: 'rnb',        name: 'R&B / 灵魂',    kws: ['r&b', 'rnb', '节奏布鲁斯', '灵魂', 'soul', '放克', 'funk'] },
  { id: 'reggae',     name: '雷鬼',          kws: ['雷鬼', 'reggae'] },
  { id: 'latin',      name: '拉丁',          kws: ['拉丁', 'latin', '桑巴', '伦巴', '探戈', 'tango', 'salsa', '弗拉明戈'] },
  { id: 'world',      name: '世界 / 民族',   kws: ['草原', '天籁', '蒙古', '藏族', '西藏', '高原', '民族', '马头琴', '呼麦', '长调', '印度', '非洲', '凯尔特', 'celtic', '世界音乐'] },
  { id: 'ost',        name: '原声 / OST',    kws: ['原声', '配乐', 'soundtrack', 'bgm', '主题曲', '片头曲', '片尾曲', '插曲'] },
  { id: 'light',      name: '轻音乐 / 纯音乐', kws: ['轻音乐', '纯音乐', '新世纪', 'new age', '疗愈', '冥想', '催眠', '白噪音', '雨声', '海浪', '鸟鸣', '大自然', '轻音', 'instrumental', '伴奏', '卡拉ok', 'karaoke', '演奏', '口哨', '钢琴', '八音盒'] },
  { id: 'kids',       name: '儿歌 / 童谣',   kws: ['儿歌', '童谣', '少儿', '摇篮曲'] },
  { id: 'pop',        name: '流行',          kws: ['流行', 'pop', '情歌', '抖音', '热歌', '金曲', '经典', '老歌', '怀旧', '网络歌曲', '网红', '翻唱', '欧美', '英文歌', '华语', '精选', '合集'] }
];

/** 离线规则判定 */
function detectGenre(relDir, stem) {
  const hay = (relDir + ' ' + stem).toLowerCase();
  for (const g of GENRES) if (g.kws.some((k) => hay.includes(k))) return g.id;
  return null;
}

/* ── 联网补全缓存：key = '歌手||曲名'，value = 曲风 id 或 null（null = 查过但没查到，不重复烧请求） ── */
const GENRE_CACHE_PATH = path.join(APP_DIR, 'genre-cache.json');
const GENRE_CACHE = new Map();
let genreCacheLoaded = false;

function ensureGenreCache() {
  if (genreCacheLoaded) return;
  genreCacheLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(GENRE_CACHE_PATH, 'utf8'));
    for (const [k, v] of Object.entries(raw)) GENRE_CACHE.set(k, v);
  } catch { /* 首次运行无缓存 */ }
}

function saveGenreCache() {
  try {
    fs.writeFileSync(GENRE_CACHE_PATH, JSON.stringify(Object.fromEntries(GENRE_CACHE)), 'utf8');
  } catch (err) { console.error('  ⚠ 曲风缓存写入失败：', err.message); }
}

const genreCacheKey = (t) => `${(t.artist || '').toLowerCase()}||${(t.title || '').toLowerCase()}`;

function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { signal: ac.signal }).finally(() => clearTimeout(timer));
}

/** iTunes Search API 的流派名 → 本地曲风 id */
function mapItunesGenre(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return null;
  if (s.includes('metal') || s.includes('punk')) return 'metal';
  if (s.includes('hip-hop') || s.includes('rap') || s.includes('trap')) return 'hiphop';
  if (s.includes('electronic') || s.includes('dance') || s.includes('techno')) return 'electronic';
  if (s.includes('jazz') || s.includes('blues')) return 'jazz';
  if (s.includes('classical') || s.includes('classique')) return 'classical';
  if (s.includes('folk') || s.includes('songwriter')) return 'folk';
  if (s.includes('country')) return 'country';
  if (s.includes('r&b') || s.includes('soul') || s.includes('funk')) return 'rnb';
  if (s.includes('reggae')) return 'reggae';
  if (s.includes('latin')) return 'latin';
  if (s.includes('world') || s.includes('international') || s.includes('traditional')) return 'world';
  if (s.includes('soundtrack') || s.includes('movie') || s.includes('tv')) return 'ost';
  if (s.includes('new age') || s.includes('easy listening') || s.includes('ambient')) return 'light';
  if (s.includes('children')) return 'kids';
  if (s.includes('rock') || s.includes('alternative') || s.includes('indie')) return 'rock';
  if (s.includes('pop') || s.includes('vocal')) return 'pop';
  return null;
}

/** 单曲联网查曲风；'ERR' = 请求本身失败（限流/断网，不应写入缓存） */
async function lookupGenreOnline(t) {
  const term = [t.artist, t.title].filter(Boolean).join(' ').trim();
  if (!term) return null;
  const url = (country) =>
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=1&country=${country}`;
  for (const country of ['CN', 'US']) {
    try {
      const r = await fetchWithTimeout(url(country), 8000);
      if (!r.ok) return 'ERR';
      const j = await r.json();
      if (j.results && j.results[0]) return mapItunesGenre(j.results[0].primaryGenreName);
      if (j.resultCount === 0) continue;      // CN 区没有 → 试试美区
    } catch { return 'ERR'; }
  }
  return null;
}

/** 刷新整个库的曲风聚合（genres 列表 + 专辑主导曲风） */
function recomputeGenreAggregates(lib) {
  const counts = new Map();
  let unknown = 0;
  for (const t of lib.tracks) {
    if (t.kind !== 'audio') continue;
    if (t.genre) counts.set(t.genre, (counts.get(t.genre) || 0) + 1);
    else unknown++;
  }
  lib.genres = GENRES.filter((g) => counts.has(g.id))
    .map((g) => ({ id: g.id, name: g.name, count: counts.get(g.id) }))
    .sort((a, b) => b.count - a.count);
  if (unknown) lib.genres.push({ id: '__unknown', name: '未识别', count: unknown });

  const byAlbum = new Map();
  for (const a of lib.albums) a.genre = null;
  for (const t of lib.tracks) {
    if (t.kind !== 'audio' || !t.genre) continue;
    let m = byAlbum.get(t.albumId);
    if (!m) { m = new Map(); byAlbum.set(t.albumId, m); }
    m.set(t.genre, (m.get(t.genre) || 0) + 1);
  }
  for (const [aid, m] of byAlbum) {
    const a = lib.albums.find((x) => x.id === aid);
    if (a) a.genre = [...m.entries()].sort((x, y) => y[1] - x[1])[0][0];
  }
}

/* ────────────────────────────  扫描与分类  ──────────────────────────── */

let LIBRARY = null;           // 当前索引
let ID_INDEX = new Map();     // trackId -> 绝对路径（仅媒体库内，用于安全校验）
let lastScan = 0;

/** 扫描进度：供前端轮询。扫描改成异步非阻塞，添加大目录时页面不会卡死。 */
const SCAN = {
  running: false, phase: 'idle', startedAt: 0, finishedAt: 0, ms: 0,
  rootsTotal: 0, rootsDone: 0, currentRoot: '',
  dirs: 0, files: 0, indexed: 0, error: null, reason: '',
  pending: ''            // 扫描途中又被要求重扫时，记下原因，结束后补扫
};

function scanState() {
  return {
    running: SCAN.running,
    phase: SCAN.phase,
    reason: SCAN.reason,
    currentRoot: SCAN.currentRoot,
    rootsTotal: SCAN.rootsTotal,
    rootsDone: SCAN.rootsDone,
    dirs: SCAN.dirs,
    files: SCAN.files,
    indexed: LIBRARY ? LIBRARY.stats.total : 0,
    scanMs: SCAN.running ? Date.now() - SCAN.startedAt : SCAN.ms,
    error: SCAN.error
  };
}

/**
 * 递归收集媒体文件（异步）。
 * 之所以用 fs.promises：单线程同步 readdir 在扫描大目录时会把事件循环彻底堵死，
 * 页面拿不到进度、也发不出任何请求，看起来就像卡死了。
 */
async function walk(dir, out, excludeSet, depth = 0) {
  if (depth > 14) return;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 权限不足或目录消失，静默跳过
  }
  SCAN.dirs++;
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (excludeSet.has(ent.name.toLowerCase())) continue;
      if (ent.name.startsWith('$') || ent.name.startsWith('.')) continue;
      await walk(full, out, excludeSet, depth + 1);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      if (AUDIO_EXT.has(ext) || VIDEO_EXT.has(ext)) { out.push(full); SCAN.files++; }
    }
  }
}

async function buildLibrary() {
  const t0 = Date.now();
  ensureGenreCache();
  const excludeSet = new Set((CONFIG.excludeDirs || []).map((d) => d.toLowerCase()));
  const minBytes = Math.max(0, Number(CONFIG.minSizeKB || 0)) * 1024;

  const roots = effectiveRoots();
  SCAN.phase = 'walking';
  SCAN.rootsTotal = roots.length;
  SCAN.rootsDone = 0;
  SCAN.dirs = 0;
  SCAN.files = 0;

  const tracks = [];
  const albums = new Map();
  const groups = new Map();
  const tagStats = new Map();
  const idIndex = new Map();
  const seen = new Set();          // 同一文件被多个根目录覆盖时去重
  const rootStats = [];

  for (const root of roots) {
    const rootPath = path.resolve(root.path);
    const rootLabel = root.label || path.basename(rootPath) || rootPath;
    const rootGroup = root.group || '媒体';

    const stat = {
      path: rootPath.replace(/\\/g, '/'),
      label: rootLabel,
      group: rootGroup,
      exists: false,
      isDefault: usingDefaultRoots(),
      files: 0, audio: 0, video: 0, bytes: 0, sizeText: '0 B'
    };
    rootStats.push(stat);
    SCAN.currentRoot = rootLabel;

    if (!fs.existsSync(rootPath)) { SCAN.rootsDone++; continue; }
    stat.exists = true;

    const files = [];
    await walk(rootPath, files, excludeSet);
    SCAN.phase = 'indexing';

    let processed = 0;
    for (const abs of files) {
      const key = norm(abs);
      if (seen.has(key)) continue;
      seen.add(key);

      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (minBytes && st.size < minBytes) continue;

      const ext = path.extname(abs).slice(1).toLowerCase();
      const kind = AUDIO_EXT.has(ext) ? 'audio' : 'video';
      const stem = path.basename(abs, path.extname(abs));
      const relDir = path.relative(rootPath, path.dirname(abs)).replace(/\\/g, '/');

      // ── 专辑：取相对路径的最后一段；根目录直接归入「根目录」
      const albumName = relDir ? prettyFolder(relDir.split('/').pop()) : `${rootLabel}（根目录）`;
      const albumKey = `${rootLabel}::${relDir}`;
      let album = albums.get(albumKey);
      if (!album) {
        album = {
          id: md5(albumKey).slice(0, 12),
          name: albumName,
          fullPath: relDir || '根目录',
          rootLabel,
          group: rootGroup,
          kind,
          count: 0,
          bytes: 0,
          tags: new Set()
        };
        albums.set(albumKey, album);
      }

      const relPath = path.relative(rootPath, abs).replace(/\\/g, '/');
      const absNorm = abs.replace(/\\/g, '/');

      // ── 智能标签：路径 + 文件名 全文本匹配
      const haystack = (relDir + '/' + stem + ' ' + relPath).toLowerCase();
      const tags = [];
      for (const rule of CONFIG.tags || []) {
        if (!rule || !rule.name) continue;
        if ((rule.keywords || []).some((k) => k && haystack.includes(String(k).toLowerCase()))) {
          tags.push(rule.name);
        }
      }

      const { artist, title } = parseName(stem);

      // ── 曲风：联网缓存（最准）→ 离线关键词规则 → 未识别
      let genre = null;
      if (kind === 'audio') {
        const ck = `${artist.toLowerCase()}||${title.toLowerCase()}`;
        genre = GENRE_CACHE.has(ck) ? GENRE_CACHE.get(ck) : detectGenre(relDir, stem);
      }

      const id = md5(absNorm).slice(0, 16);
      idIndex.set(id, abs);

      const track = {
        id,
        kind,
        ext,
        file: path.basename(abs),
        title,
        artist,
        albumId: album.id,
        album: album.name,
        albumPath: relDir || '',
        rootLabel,
        group: rootGroup,
        relPath,
        size: st.size,
        sizeText: humanSize(st.size),
        mtime: st.mtimeMs,
        native: kind === 'audio' ? NATIVE_AUDIO.has(ext) : NATIVE_VIDEO.has(ext),
        tags,
        genre
      };
      tracks.push(track);

      album.count++;
      album.bytes += st.size;
      tags.forEach((t) => album.tags.add(t));

      stat.files++;
      stat[kind === 'audio' ? 'audio' : 'video']++;
      stat.bytes += st.size;

      const g = track.group;
      if (!groups.has(g)) {
        groups.set(g, { name: g, audio: 0, video: 0, bytes: 0 });
      }
      const gv = groups.get(g);
      gv[kind === 'audio' ? 'audio' : 'video']++;
      gv.bytes += st.size;

      for (const t of tags) tagStats.set(t, (tagStats.get(t) || 0) + 1);

      // 每 400 个文件让出一次事件循环：既能让前端刷进度，也不至于拖慢整体
      if (++processed % 400 === 0) await sleep(0);
    }

    stat.sizeText = humanSize(stat.bytes);
    SCAN.rootsDone++;
    SCAN.phase = 'walking';
  }

  // 标签按出现频次排序
  const tags = [...tagStats.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  tracks.sort((a, b) => a.album.localeCompare(b.album, 'zh') || a.file.localeCompare(b.file, 'zh', { numeric: true }));

  const albumList = [...albums.values()]
    .map((a) => ({ ...a, tags: [...a.tags], sizeText: humanSize(a.bytes) }))
    .sort((a, b) => b.count - a.count);

  const groupList = [...groups.values()]
    .map((g) => ({ ...g, count: g.audio + g.video, sizeText: humanSize(g.bytes) }))
    .sort((a, b) => b.count - a.count);

  ID_INDEX = idIndex;
  lastScan = Date.now();

  const audioCount = tracks.filter((t) => t.kind === 'audio').length;

  const lib = {
    generatedAt: new Date().toISOString(),
    scanMs: Date.now() - t0,
    stats: {
      total: tracks.length,
      audio: audioCount,
      video: tracks.length - audioCount,
      albums: albumList.length,
      bytes: tracks.reduce((s, t) => s + t.size, 0)
    },
    usingDefaultRoots: usingDefaultRoots(),
    roots: rootStats,
    groups: groupList,
    tags,
    albums: albumList,
    tracks
  };
  recomputeGenreAggregates(lib);
  return lib;
}

/* ────────────────────────────  扫描调度  ──────────────────────────── */

let scanChain = null;         // 当前/最近一次扫描的 Promise

/** 扫描一次（返回 Promise）。已在扫描中则直接复用当前这一轮，不重复扫。 */
function rescanNow(reason) {
  if (SCAN.running) return scanChain || Promise.resolve(LIBRARY);

  SCAN.running = true;
  SCAN.error = null;
  SCAN.reason = reason || '';
  SCAN.startedAt = Date.now();
  SCAN.finishedAt = 0;
  SCAN.currentRoot = '';
  SCAN.rootsDone = 0;
  SCAN.rootsTotal = 0;
  SCAN.dirs = 0;
  SCAN.files = 0;

  scanChain = (async () => {
    try {
      const lib = await buildLibrary();
      LIBRARY = lib;
      SCAN.ms = Date.now() - SCAN.startedAt;
      SCAN.phase = 'idle';
      lastScan = Date.now();
      return lib;
    } catch (err) {
      SCAN.error = String((err && err.message) || err);
      SCAN.phase = 'error';
      console.error('  ✗ 扫描失败：', err);
      return LIBRARY;
    } finally {
      SCAN.running = false;
      SCAN.finishedAt = Date.now();
      if (SCAN.phase !== 'error') SCAN.phase = 'idle';
      // 扫描途中又要改扫描范围：等这一轮结束后立刻补扫一轮，
      // 否则会拿着已经过期的目录清单写完索引，用户删掉的目录还会留在列表里。
      const pend = SCAN.pending;
      if (pend) { SCAN.pending = ''; setTimeout(() => startScan(pend), 0); }
    }
  })();

  return scanChain;
}

/** 后台扫描：立刻返回，进度通过 /api/scan-status 轮询 */
function startScan(reason) {
  if (SCAN.running) { SCAN.pending = reason; return false; }
  rescanNow(reason).then((lib) => {
    if (lib) console.log(`  ↻ 扫描完成（${reason}）：${lib.stats.total} 个媒体文件 · ${lib.roots.length} 个目录 · ${lib.scanMs}ms`);
  }).catch(() => { /* 已在 rescanNow 内记录 */ });
  return true;
}

/** 扫描完再取结果（删除文件 / 曲风补全后需要立刻拿到新索引） */
async function rescanWait(reason) {
  if (SCAN.running && scanChain) { try { await scanChain; } catch { /* 忽略 */ } }
  return rescanNow(reason);
}

/* ────────────────────────────  系统集成  ──────────────────────────── */

/** 以分离进程方式启动命令，成功 spawn 即视为成功 */
function spawnDetached(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, Object.assign({ windowsHide: true, detached: true, stdio: 'ignore' }, opts || {}));
    } catch (err) { return reject(err); }
    child.on('error', reject);
    child.on('spawn', () => { child.unref(); resolve(); });
  });
}

/**
 * 用系统播放工具打开文件。
 * 策略顺序：config.json 中显式指定的播放器 → 系统默认关联程序 → 资源管理器接管。
 * 之所以把「显式指定的播放器」放第一位：Windows 上文件关联常常指向已失效的
 * 处理程序（例如指向未正确注册的旧版 Windows Media Player），此时 start 会
 * 静默失败且不返回错误码，用户点下去毫无反应。指定一个确定可用的播放器最稳。
 */
async function openWithSystem(absPath) {
  const attempts = [];
  const configured = String(CONFIG.systemPlayer || '').trim();

  if (configured && fs.existsSync(configured)) {
    const name = path.basename(configured).replace(/\.exe$/i, '');
    attempts.push({
      method: name,
      run: () => spawnDetached(configured, [absPath], { cwd: path.dirname(configured) })
    });
  }

  if (process.platform === 'win32') {
    attempts.push({
      method: '系统默认关联程序',
      run: () => spawnDetached('cmd', ['/c', 'start', '', absPath])
    });
    attempts.push({
      method: '资源管理器',
      run: () => spawnDetached('explorer', [absPath.replace(/\//g, '\\')])
    });
  } else if (process.platform === 'darwin') {
    attempts.push({ method: 'open', run: () => spawnDetached('open', [absPath]) });
  } else {
    attempts.push({ method: 'xdg-open', run: () => spawnDetached('xdg-open', [absPath]) });
  }

  let lastErr;
  for (const a of attempts) {
    try { await a.run(); return { method: a.method }; }
    catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('无法调起系统播放器');
}

/** 在资源管理器中定位并选中文件 */
function revealInExplorer(absPath) {
  if (process.platform === 'win32') {
    return spawnDetached('explorer', [`/select,${path.win32.normalize(absPath)}`]);
  }
  if (process.platform === 'darwin') return spawnDetached('open', ['-R', absPath]);
  return spawnDetached('xdg-open', [path.dirname(absPath)]);
}

/* ────────────────────────────  PowerShell 桥  ──────────────────────────── */

const b64utf8 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 以 -EncodedCommand 执行 PowerShell。
 * 用 base64 规避引号转义、中文编码与 `$` 变量注入三类问题，脚本内只出现 ASCII。
 */
function runPowerShell(script, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')];
    let out = '';
    let done = false;
    let child;
    try {
      child = spawn('powershell', args, { windowsHide: true });
    } catch { return resolve(out); }
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(out); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } finish(); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', finish);
    child.on('close', finish);
  });
}

/** 打开资源管理器窗口后，用 Shell.Application 找到该窗口并提到前台、选中文件。
 *  之所以要这一步：从后台进程 spawn 的 explorer 窗口默认不会抢占前台，
 *  用户 maximized 浏览器时窗口会默默开在浏览器后面，看起来就像「没反应」。 */
const FOCUS_PS = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FW {
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@
$dir = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@DIR@')).ToLower()
$file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@FILE@'))
$sh = New-Object -ComObject Shell.Application
$win = $null
foreach ($w in $sh.Windows()) {
  try {
    if ($w.Document -and $w.Document.Folder) {
      $p = $w.Document.Folder.Self.Path
      if ($p -and $p.ToLower() -eq $dir) { $win = $w; break }
    }
  } catch {}
}
if ($win) {
  $h = [IntPtr]$win.HWND
  [FW]::ShowWindow($h, 9) | Out-Null
  [FW]::SwitchToThisWindow($h, $true) | Out-Null
  [FW]::SetForegroundWindow($h) | Out-Null
  try { $win.Document.SelectItem($file, 1) } catch {}
  Write-Output "FOUND"
} else { Write-Output "MISS" }
`;

/** 完整定位：打开 → 提前台并选中。返回是否成功聚焦到窗口 */
async function revealAndFocus(absPath) {
  if (process.platform === 'darwin') { await spawnDetached('open', ['-R', absPath]); return { opened: true, focused: true }; }
  if (process.platform !== 'win32') { await spawnDetached('xdg-open', [path.dirname(absPath)]); return { opened: true, focused: true }; }

  await spawnDetached('explorer', [`/select,${path.win32.normalize(absPath)}`]);

  const script = FOCUS_PS
    .replace('@DIR@', b64utf8(path.dirname(absPath)))
    .replace('@FILE@', b64utf8(path.basename(absPath)));

  // explorer 建窗需要一点时间；未命中时多试一次
  for (let i = 0; i < 2; i++) {
    await sleep(i === 0 ? 1100 : 900);
    const out = await runPowerShell(script, 12000);
    if (out && out.includes('FOUND')) return { opened: true, focused: true };
  }
  // COM 枚举失败不等于窗口没开——explorer 已经 spawn 过了
  return { opened: true, focused: false };
}

/* ────────────────────────────  删除到回收站  ──────────────────────────── */

/** 播放器自身的核心文件不允许被「删除」功能波及 */
const PROTECTED_FILES = new Set([
  'server.js', 'index.html', 'config.json', 'package.json', 'package-lock.json',
  'readme.md', '启动播放器.bat', 'genre-cache.json'
]);

/** 将一批文件移入回收站。返回逐个结果（以「文件已从原位置消失」为成功依据，
 *  不依赖 PowerShell 的返回值——VB FileIO 偶发「假异常但实际已删除」） */
async function moveToRecycleBin(absPaths) {
  if (!absPaths.length) return [];
  const items = absPaths.map((p, i) => `  @{i=${i}; b='${b64utf8(p)}'}`).join('\n');
  const script = `
Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null
$items = @(
${items}
)
foreach ($it in $items) {
  $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($it.b))
  try {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    Write-Output ("OK " + $it.i)
  } catch { Write-Output ("ER " + $it.i) }
}`;
  await runPowerShell(script, 20000 + absPaths.length * 8000);
  return absPaths.map((p) => ({ path: p, deleted: !fs.existsSync(p) }));
}

/* ────────────────────────────  扫描目录管理  ──────────────────────────── */

/** 加进扫描范围前给出提醒的系统目录（不禁止，只提示别扫） */
const SYS_DIRS = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'recovery',
  'perflogs', 'msocache', '$recycle.bin', 'system volume information',
  'appdata', 'application data', 'node_modules', '.git', '$windows.~bt',
  'intel', 'amd', 'nvidia', 'drivers', 'temp', 'tmp', 'cache'
]);

/** 只枚举真正存在的盘符（C: → Z:） */
function driveList() {
  const out = [];
  for (let i = 67; i <= 90; i++) {
    const d = String.fromCharCode(i) + ':/';
    try { if (fs.existsSync(d)) out.push(d); } catch { /* 忽略无权限/未就绪的盘符 */ }
  }
  return out;
}

/** 磁盘剩余空间（拿不到就返回空对象，不影响浏览） */
function diskInfo(p) {
  try {
    const st = fs.statfsSync(p);
    const total = st.bsize * st.blocks;
    const free = st.bsize * st.bavail;
    if (!total) return {};
    return {
      totalText: humanSize(total),
      freeText: humanSize(free),
      freePct: Math.round((free / total) * 100)
    };
  } catch { return {}; }
}

/** 把用户给的路径规范化成绝对路径。
 *  Windows 上 "C:" 表示「C 盘当前目录」这种相对路径，稍不留意就会解析到
 *  进程工作目录所在盘的某个位置；这里统一补成盘符根目录 "C:/"。 */
function resolveUserPath(raw) {
  const s = String(raw || '').trim().replace(/^"|"$/g, '');
  if (/^[A-Za-z]:$/.test(s)) return path.resolve(s + '/');
  return path.resolve(s);
}

/**
 * 服务端目录浏览。
 * 浏览器出于安全限制拿不到本地绝对路径（File System Access API 只给句柄），
 * 所以「添加扫描目录」必须由服务端列出目录树，用户点选。
 */
function browseDirs(rawPath) {
  const added = new Set(customRoots().map((r) => norm(path.resolve(r.path))));

  // 空路径 = 盘符视图
  if (!rawPath) {
    return {
      ok: true,
      path: '',
      parent: null,
      isDriveRoot: false,
      drives: driveList().map((d) => Object.assign({
        name: d.replace(/\/$/, ''),
        path: d,
        isDrive: true
      }, diskInfo(d))),
      dirs: [],
      addedRoots: [...added]
    };
  }

  const abs = resolveUserPath(rawPath);
  let st;
  try { st = fs.statSync(abs); }
  catch { return { ok: false, error: `目录不存在或无法访问：${abs}` }; }
  if (!st.isDirectory()) return { ok: false, error: `这不是一个目录：${abs}` };

  const parentAbs = path.dirname(abs);
  const atDriveRoot = norm(parentAbs) === norm(abs);
  const here = abs.replace(/\\/g, '/');

  let dirs = [];
  try {
    dirs = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('$') && !e.name.startsWith('.'))
      .map((e) => {
        const p = path.join(abs, e.name);
        return {
          name: prettyFolder(e.name),
          raw: e.name,
          path: p.replace(/\\/g, '/'),
          isSystem: SYS_DIRS.has(e.name.toLowerCase()),
          added: added.has(norm(p))
        };
      })
      .sort((a, b) => a.raw.localeCompare(b.raw, 'zh', { numeric: true }));
  } catch (err) {
    return { ok: false, error: `无法读取该目录（权限不足）：${abs}` };
  }

  const truncated = dirs.length > 1500;
  if (truncated) dirs = dirs.slice(0, 1500);

  return Object.assign({
    ok: true,
    path: here,
    parent: atDriveRoot ? '' : parentAbs.replace(/\\/g, '/'),
    isDriveRoot: atDriveRoot,
    isSystem: SYS_DIRS.has(path.basename(abs).toLowerCase()),
    added: added.has(norm(abs)),
    truncated,
    dirs,
    addedRoots: [...added]
  }, diskInfo(abs));
}

/** 扫描目录清单（优先用索引里的实测统计） */
function rootsPayload() {
  if (LIBRARY && Array.isArray(LIBRARY.roots)) {
    return { ok: true, usingDefault: usingDefaultRoots(), roots: LIBRARY.roots, stats: LIBRARY.stats };
  }
  return {
    ok: true,
    usingDefault: usingDefaultRoots(),
    roots: effectiveRoots().map((r) => {
      const rp = path.resolve(r.path);
      return {
        path: rp.replace(/\\/g, '/'),
        label: r.label || path.basename(rp) || rp,
        group: r.group || '媒体',
        exists: fs.existsSync(rp),
        isDefault: usingDefaultRoots(),
        files: 0, audio: 0, video: 0, bytes: 0, sizeText: '—'
      };
    })
  };
}

/* ────────────────────────────  HTTP  ──────────────────────────── */

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function sendHTML(res, code, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* ────────────────────────────  独立视频播放页  ──────────────────────────── */

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 按 id 在索引里反查曲目（索引未就绪时返回 null，页面退回文件名） */
function findTrack(id) {
  if (!LIBRARY || !id) return null;
  return LIBRARY.tracks.find((t) => t.id === id) || null;
}

/**
 * 视频播放页。由首页 window.open('/play?id=xxx') 在新标签页打开。
 *
 * 为什么不复用首页的弹层：独立成一页才能拿到浏览器原生播放器的全部能力
 * —— 全屏、画中画、键盘快捷键、系统音量、投屏，且不会被首页的滚动/快捷键抢事件。
 */
function playPageHTML(abs, id) {
  const t = abs ? findTrack(id) : null;
  const title = t ? t.title : (abs ? path.basename(abs) : '视频');
  const sub = t
    ? [t.artist || '', `.${String(t.ext || '').toUpperCase()}`, t.album, t.sizeText].filter(Boolean).join(' · ')
    : '';
  const streamURL = abs ? `/api/stream?id=${encodeURIComponent(id)}` : '';
  const missing = !abs;
  const native = missing ? false : !!t && !!t.native;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)}</title>
<style>
  :root{--bg:#0B0D11;--panel:#11141A;--line:rgba(255,255,255,.075);--line-strong:rgba(255,255,255,.14);
        --text:#E9ECF3;--text-2:#A6AEC0;--muted:#6C7488;--accent:#7C5CFF;--warm:#FFB26B}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{background:var(--bg);color:var(--text);display:flex;flex-direction:column;overflow:hidden;
       font-family:"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif;font-size:14px}
  .bar{display:flex;align-items:center;gap:16px;padding:10px 16px;background:var(--panel);
       border-bottom:1px solid var(--line);flex:none}
  .meta{min-width:0;flex:1}
  .ttl{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sub{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
  .acts{display:flex;gap:8px;flex:none}
  .btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;
       border:1px solid var(--line-strong);background:var(--panel);color:var(--text-2);
       font-size:12.5px;cursor:pointer;transition:background .16s,color .16s,border-color .16s}
  .btn:hover{background:#1E232D;color:var(--text)}
  .btn.primary{border-color:transparent;background:var(--accent);color:#fff}
  .btn.primary:hover{background:#8A6DFF}
  .stage{position:relative;flex:1;min-height:0;display:flex}
  video{width:100%;height:100%;object-fit:contain;background:#000;outline:none}
  .err{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;
       gap:14px;text-align:center;padding:32px;background:var(--bg)}
  .err.on{display:flex}
  .err h2{font-size:17px;font-weight:600}
  .err p{color:var(--muted);font-size:13px;line-height:1.9;max-width:560px}
  .err b{color:var(--text);font-weight:600}
  .hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:var(--muted);font-size:13px}
</style>
</head>
<body>
  <div class="bar">
    <div class="meta">
      <div class="ttl">${escapeHTML(title)}</div>
      <div class="sub">${escapeHTML(missing ? '文件不存在或不在媒体库范围内' : sub)}</div>
    </div>
    <div class="acts">
      <button class="btn primary" id="bSys">用系统播放器打开</button>
      <button class="btn" id="bReveal">在资源管理器中定位</button>
      <button class="btn" id="bClose">关闭标签页</button>
    </div>
  </div>
  <div class="stage">
    ${missing || !native ? '' : `<video id="v" controls playsinline autoplay preload="metadata" src="${escapeHTML(streamURL)}"></video>`}
    <div class="err${missing || !native ? ' on' : ''}" id="err">
      <h2>${missing ? '找不到这个文件' : '浏览器无法播放这个文件'}</h2>
      <p>${missing
        ? '它可能已被移动或删除，请在播放器主页面重新扫描后再试。'
        : `浏览器解不了 <b>.${escapeHTML(String((t && t.ext) || '').toUpperCase())}</b> 这类容器（常见于 MKV / RMVB / AVI / WMV）。
           点上方 <b>用系统播放器打开</b>，交给本机播放器处理，字幕与多音轨都会正常。`}
      </p>
      <button class="btn primary" id="eSys">用系统播放器打开</button>
    </div>
  </div>
<script>
(function () {
  var ID = ${JSON.stringify(id || '')};
  var v = document.getElementById('v');
  var err = document.getElementById('err');

  function post(path, done) {
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ID }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { done && done(j); })
      .catch(function () { done && done({ ok: false }); });
  }
  function sys() { post('/api/open'); }
  function reveal() { post('/api/reveal'); }
  function closeTab() { window.close(); setTimeout(function () { history.back(); }, 120); }

  document.getElementById('bSys').onclick = sys;
  document.getElementById('bReveal').onclick = reveal;
  document.getElementById('bClose').onclick = closeTab;
  document.getElementById('eSys').onclick = sys;

  if (v) {
    // 自动播放可能被浏览器策略拦下（新标签页仍算用户手势发起，通常放行）；
    // 万一被拦，原生控件就在下面，点一下即可，不做多余打扰。
    v.addEventListener('error', function () { err.classList.add('on'); });
    var p = v.play();
    if (p && p.catch) p.catch(function () {});
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeTab();
  });
})();
</script>
</body>
</html>`;
}

/** 将请求解析为媒体库内的绝对路径，拒绝越权访问 */
function resolveMediaPath(idOrPath) {
  if (!idOrPath) return null;
  if (ID_INDEX.has(idOrPath)) return ID_INDEX.get(idOrPath);

  // 允许直接传绝对路径，但必须位于某个已配置的根目录之内
  const abs = path.resolve(String(idOrPath));
  const absNorm = norm(abs);
  const allowed = effectiveRoots().some((r) => {
    const rn = norm(path.resolve(r.path));
    return absNorm === rn || absNorm.startsWith(rn.endsWith('/') ? rn : rn + '/');
  });
  if (!allowed) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

/** 支持 Range 的媒体流 */
function streamMedia(req, res, absPath) {
  let st;
  try { st = fs.statSync(absPath); } catch {
    res.writeHead(404); return res.end('未找到文件');
  }
  if (!st.isFile()) { res.writeHead(404); return res.end('不是文件'); }

  const ext = path.extname(absPath).slice(1).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const total = st.size;

  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(absPath))}`
  };

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1
      });
      fs.createReadStream(absPath, { start, end }).on('error', () => res.end()).pipe(res);
      return;
    }
  }

  res.writeHead(200, { ...headers, 'Content-Length': total });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(absPath).on('error', () => res.end()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = u.pathname;

  // 允许本机任意来源（含以 file:// 打开的页面）调用
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    /* ---- 首页 ---- */
    if (p === '/' || p === '/index.html') {
      const file = path.join(APP_DIR, 'index.html');
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('index.html 缺失'); }
      const buf = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      return res.end(buf);
    }

    /* ---- 视频播放页（首页点视频 → 新标签页打开） ---- */
    if (p === '/play' || p === '/play/') {
      const id = u.searchParams.get('id') || '';
      return sendHTML(res, 200, playPageHTML(resolveMediaPath(id), id));
    }

    /* ---- 媒体库索引（首次访问时若尚无索引，则启动后台扫描并告知前端轮询） ---- */
    if (p === '/api/library') {
      if (!LIBRARY) {
        if (!SCAN.running) startScan('first-visit');
        return sendJSON(res, 202, { ok: false, scanning: true, state: scanState() });
      }
      return sendJSON(res, 200, LIBRARY);
    }

    /* ---- 扫描进度 ---- */
    if (p === '/api/scan-status') {
      return sendJSON(res, 200, Object.assign({ ok: true }, scanState()));
    }

    /* ---- 重新扫描（后台执行，立即返回） ---- */
    if (p === '/api/rescan') {
      if (SCAN.running) return sendJSON(res, 200, { ok: true, alreadyRunning: true, state: scanState() });
      startScan('manual');
      console.log('  ↻ 手动触发扫描…');
      return sendJSON(res, 200, { ok: true, started: true, state: scanState() });
    }

    /* ---- 扫描目录清单 ---- */
    if (p === '/api/roots' && req.method === 'GET') {
      return sendJSON(res, 200, rootsPayload());
    }

    /* ---- 浏览磁盘目录（用于添加扫描目录） ---- */
    if (p === '/api/browse') {
      return sendJSON(res, 200, browseDirs(u.searchParams.get('path') || ''));
    }

    /* ---- 添加扫描目录 ---- */
    if (p === '/api/roots/add' && req.method === 'POST') {
      const body = await readBody(req);
      const raw = String(body.path || '').trim();
      if (!raw) return sendJSON(res, 400, { ok: false, error: '请指定要扫描的目录' });

      const abs = resolveUserPath(raw);
      let st;
      try { st = fs.statSync(abs); }
      catch { return sendJSON(res, 400, { ok: false, error: `目录不存在或无法访问：${abs}` }); }
      if (!st.isDirectory()) return sendJSON(res, 400, { ok: false, error: `这不是一个目录：${abs}` });

      // 整个磁盘根目录 = 全盘扫描，必须由用户显式确认
      const isDriveRoot = norm(path.dirname(abs)) === norm(abs);
      if (isDriveRoot && !body.force) {
        return sendJSON(res, 409, {
          ok: false, code: 'DRIVE_ROOT', path: abs.replace(/\\/g, '/'),
          error: `${abs.replace(/\\/g, '/')} 是整个磁盘，扫描会非常慢，且会索引到系统文件。建议改成具体的子目录。`
        });
      }

      // 当前是「未配置任何目录 → 默认扫播放器目录」的状态时，把默认目录固化下来，
      // 否则用户添加第一个目录后，原本在播放器目录里的文件会突然消失。
      let keptDefault = false;
      let list = customRoots().slice();
      if (!list.length) {
        list = [{ path: APP_DIR.replace(/\\/g, '/'), label: '播放器目录', group: '本地' }];
        keptDefault = true;
      }

      if (list.some((r) => norm(path.resolve(r.path)) === norm(abs))) {
        return sendJSON(res, 200, { ok: true, added: false, message: '该目录已在扫描范围内', ...rootsPayload() });
      }

      const label = String(body.label || '').trim() || path.basename(abs) || abs.replace(/\\/g, '/');
      const group = String(body.group || '').trim() || '媒体';
      list.push({ path: abs.replace(/\\/g, '/'), label, group });
      CONFIG.roots = list;

      const saved = saveConfig();
      startScan('roots-add');
      console.log(`  ＋ 添加扫描目录：${abs.replace(/\\/g, '/')}（${label} · ${group}）`);
      return sendJSON(res, 200, {
        ok: true, added: true, keptDefault, saved,
        path: abs.replace(/\\/g, '/'), label, group,
        scanStarted: true,
        state: scanState()
      });
    }

    /* ---- 移除扫描目录 ---- */
    if (p === '/api/roots/remove' && req.method === 'POST') {
      const body = await readBody(req);
      const key = body.path ? norm(path.resolve(String(body.path))) : '';
      if (!key) return sendJSON(res, 400, { ok: false, error: '请指定要移除的目录' });

      const list = customRoots();
      const next = list.filter((r) => norm(path.resolve(r.path)) !== key);
      if (next.length === list.length) {
        return sendJSON(res, 404, { ok: false, error: '该目录不在扫描范围内' });
      }
      CONFIG.roots = next;
      const saved = saveConfig();
      startScan('roots-remove');
      const gone = list.find((r) => norm(path.resolve(r.path)) === key);
      console.log(`  － 移除扫描目录：${gone ? gone.path : key}`);
      return sendJSON(res, 200, {
        ok: true, saved, scanStarted: true,
        emptied: next.length === 0,       // 清空后会回到「默认只扫播放器目录」
        state: scanState()
      });
    }

    /* ---- 恢复默认：清空全部扫描目录 ---- */
    if (p === '/api/roots/reset' && req.method === 'POST') {
      CONFIG.roots = [];
      const saved = saveConfig();
      startScan('roots-reset');
      console.log('  ↺ 已清空扫描目录，恢复为「仅扫描播放器所在目录」');
      return sendJSON(res, 200, { ok: true, saved, scanStarted: true, ...rootsPayload() });
    }

    /* ---- 健康检查（供前端判断是否运行在服务模式） ---- */
    if (p === '/api/ping') {
      const sp = String(CONFIG.systemPlayer || '').trim();
      return sendJSON(res, 200, {
        ok: true,
        app: APP_NAME,
        version: APP_VERSION,
        repo: APP_REPO,
        author: APP_AUTHOR,
        platform: process.platform,
        node: process.version,
        indexed: LIBRARY ? LIBRARY.stats.total : 0,
        scanning: SCAN.running,
        usingDefaultRoots: usingDefaultRoots(),
        rootCount: effectiveRoots().length,
        systemPlayer: sp && fs.existsSync(sp) ? path.basename(sp) : '系统默认关联程序',
        lastScan
      });
    }

    /* ---- 媒体流 ---- */
    if (p === '/api/stream') {
      const abs = resolveMediaPath(u.searchParams.get('id'));
      if (!abs) { res.writeHead(404); return res.end('媒体不存在或不在媒体库范围内'); }
      return streamMedia(req, res, abs);
    }

    /* ---- 用系统默认播放器打开 ---- */
    if (p === '/api/open' && req.method === 'POST') {
      const body = await readBody(req);
      const abs = resolveMediaPath(body.id);
      if (!abs) return sendJSON(res, 404, { ok: false, error: '媒体不存在或不在媒体库范围内' });
      const res2 = await openWithSystem(abs);
      return sendJSON(res, 200, { ok: true, opened: abs, via: res2.method });
    }

    /* ---- 在资源管理器中定位 ---- */
    if (p === '/api/reveal' && req.method === 'POST') {
      const body = await readBody(req);
      const abs = resolveMediaPath(body.id);
      if (!abs) return sendJSON(res, 404, { ok: false, error: '文件不存在' });
      const r = await revealAndFocus(abs);
      return sendJSON(res, 200, { ok: true, revealed: abs, focused: r.focused });
    }

    /* ---- 删除到回收站 ---- */
    if (p === '/api/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (!ids.length) return sendJSON(res, 400, { ok: false, error: '未指定要删除的文件' });

      const targets = [];
      for (const id of ids) {
        const abs = resolveMediaPath(id);
        if (!abs) return sendJSON(res, 404, { ok: false, error: '有文件不在媒体库范围内，已中止' });
        // 保护播放器自身的核心文件
        if (norm(path.dirname(abs)) === norm(APP_DIR) &&
            PROTECTED_FILES.has(path.basename(abs).toLowerCase())) {
          return sendJSON(res, 403, { ok: false, error: `${path.basename(abs)} 是播放器核心文件，拒绝删除` });
        }
        targets.push(abs);
      }

      const results = await moveToRecycleBin(targets);
      const deleted = results.filter((r) => r.deleted).length;
      if (deleted) {
        await rescanWait('after-delete');      // 重新索引（被删文件的 id 会自然失效）
        console.log(`  ✎ 已移入回收站 ${deleted}/${targets.length} 个文件，媒体库现有 ${LIBRARY.stats.total} 个`);
      }
      return sendJSON(res, 200, {
        ok: true,
        deleted,
        failed: results.length - deleted,
        results: results.map((r) => ({ file: path.basename(r.path), deleted: r.deleted })),
        stats: LIBRARY.stats
      });
    }

    /* ---- 联网补全曲风（每批处理 limit 首，前端循环调用并展示进度） ---- */
    if (p === '/api/genre-online' && req.method === 'POST') {
      const body = await readBody(req);
      const limit = Math.min(80, Math.max(1, Number(body.limit) || 40));
      if (!LIBRARY) await rescanWait('genre-online');

      const pending = LIBRARY.tracks.filter(
        (t) => t.kind === 'audio' && !t.genre && !GENRE_CACHE.has(genreCacheKey(t))
      );

      // 联网探测：不通就直接告知，前端保持离线规则结果
      let online = true;
      try {
        const probe = await fetchWithTimeout('https://itunes.apple.com/search?term=ping&limit=1&country=CN', 5000);
        online = probe.ok;
      } catch { online = false; }
      if (!online) {
        return sendJSON(res, 200, { ok: true, online: false, processed: 0, updated: 0, remaining: pending.length });
      }

      const batch = pending.slice(0, limit);
      let updated = 0;
      let httpErr = 0;

      // 简易并发池：3 路并发 + 每次请求间隔 ≥120ms，避免触发 iTunes 限流
      let cursor = 0;
      async function worker() {
        while (cursor < batch.length) {
          const t = batch[cursor++];
          const r = await lookupGenreOnline(t);
          if (r === 'ERR') { httpErr++; continue; }
          GENRE_CACHE.set(genreCacheKey(t), r);
          if (r) { t.genre = r; updated++; }
          await sleep(120);
        }
      }
      await Promise.all([worker(), worker(), worker()]);

      // 半数以上请求都失败 → 判定为限流/网络异常，丢弃本批以免把「没查到」错误固化进缓存
      if (batch.length && httpErr > batch.length * 0.5) {
        return sendJSON(res, 200, { ok: false, online: true, error: '查询被限流或网络不稳，请稍后再试', processed: 0, updated: 0, remaining: pending.length });
      }

      saveGenreCache();
      recomputeGenreAggregates(LIBRARY);
      const remaining = LIBRARY.tracks.filter(
        (t) => t.kind === 'audio' && !t.genre && !GENRE_CACHE.has(genreCacheKey(t))
      ).length;
      console.log(`  ☁ 曲风补全：本批 ${batch.length} 首，命中 ${updated}，剩余 ${remaining}`);
      return sendJSON(res, 200, { ok: true, online: true, processed: batch.length, updated, remaining });
    }

    /* ---- 导出播放列表 ---- */
    if (p === '/api/export' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const lines = ids
        .map((id) => ID_INDEX.get(id))
        .filter(Boolean)
        .map((abs) => (process.platform === 'win32' ? path.win32.normalize(abs) : abs));
      const name = (body.name || 'playlist').replace(/[\\/:*?"<>|]/g, '_');
      const out = path.join(APP_DIR, '播放列表导出', `${name}.m3u8`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, '\ufeff#EXTM3U\n' + lines.join('\n'), 'utf8');
      return sendJSON(res, 200, { ok: true, file: out, count: lines.length });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (err) {
    console.error('  ✗ 请求处理出错：', err);
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: String(err && err.message || err) });
    else res.end();
  }
});

/* ────────────────────────────  启动  ──────────────────────────── */

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 忽略：用户可手动打开链接 */ }
}

function banner() {
  const line = '─'.repeat(58);
  console.log('\n' + line);
  console.log('  🎵  ' + APP_NAME + '   v' + APP_VERSION + '   已启动');
  console.log(line);
  if (LIBRARY) {
    const s = LIBRARY.stats;
    console.log(`  已索引   ${s.total} 个媒体文件   （音频 ${s.audio} · 视频 ${s.video}）`);
    console.log(`  专辑     ${s.albums} 个        耗时 ${LIBRARY.scanMs}ms`);
    console.log('  分类     ' + LIBRARY.groups.map((g) => `${g.name} ${g.count}`).join('  ·  '));
  } else {
    console.log('  索引正在后台建立，进度可在页面上查看');
  }
  console.log(`  扫描范围 ${effectiveRoots().length} 个目录` +
    (usingDefaultRoots() ? '（默认：播放器所在目录）' : ''));
  console.log(line);
  console.log(`  访问地址  http://${HOST}:${PORT}`);
  console.log('  停止服务  在此窗口按 Ctrl + C');
  console.log(line + '\n');
}

/** 探测该端口上跑的是不是本播放器的另一个实例 */
function probeExisting(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/ping', timeout: 1500 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 8192) req.destroy(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data).app === APP_NAME); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    // 双击启动时最常见的场景：播放器已经开着，别再报错了，直接把浏览器指过去
    if (await probeExisting(PORT)) {
      console.log(`\n  播放器已在运行，正在打开 http://${HOST}:${PORT}\n`);
      openBrowser(`http://${HOST}:${PORT}`);
      process.exit(0);
    }
    console.error(`\n  ✗ 端口 ${PORT} 被其他程序占用，无法启动。`);
    console.error('    请修改 config.json 中的 port 换一个端口后重试。\n');
  } else {
    console.error('\n  ✗ 服务启动失败：', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  banner();
  const noOpen = process.env.PLAYER_NO_OPEN === '1';
  if (CONFIG.autoOpenBrowser !== false && !noOpen) openBrowser(`http://${HOST}:${PORT}`);

  // 先开监听、再后台扫描：扫描大目录时页面能立刻打开并显示进度，不会白屏等待
  if (CONFIG.scanOnStart !== false) {
    const roots = effectiveRoots();
    console.log(`  正在扫描 ${roots.length} 个目录…`);
    roots.forEach((r) => console.log(`    · ${r.label || path.basename(r.path)}  →  ${path.resolve(r.path).replace(/\\/g, '/')}`));
    if (usingDefaultRoots()) {
      console.log('    （未添加自定义目录，默认只扫描播放器所在目录；可在页面上添加其它目录）');
    }
    startScan('startup');
  } else {
    console.log('  已按配置跳过启动扫描，首次访问页面时再建立索引');
  }
});

process.on('SIGINT', () => {
  console.log('\n  已停止播放器服务，再见。\n');
  process.exit(0);
});
