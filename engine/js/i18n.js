// engine/js/i18n.js — 殼的語系層：判定／查字典／套 DOM／切換／訂閱。
// 判定優先序：URL ?lang=（本頁有效、不記）→ localStorage v4.locale（設定頁選的）→
// config.locale（自架者釘死；"auto"／缺鍵＝略過）→ navigator.languages → en。
// 字典為 ES module 靜態 import（不 fetch、不閃未譯字）；zh-Hant 是正本，其他語系缺鍵時回退。
import zhHant from "./locales/zh-Hant.js";
import en from "./locales/en.js";

export const SOURCE_LOCALE = "zh-Hant";
export const SUPPORTED_LOCALES = ["zh-Hant", "en"]; // 加語系＝加字典檔＋這裡註冊＋LOCALE_NAMES
export const STORAGE_KEY = "v4.locale";
export const LOCALE_NAMES = { "zh-Hant": "繁體中文", en: "English" }; // 各語系自己的名字，不翻
const DICTS = { "zh-Hant": zhHant, en };

let current = SOURCE_LOCALE;
let explicitSource = null; // "url" | "stored" | null —— 比 config 更優先的來源存在時 applyConfigLocale 不動
let lastConfig = null;
const listeners = new Set();

export function normalizeLocale(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/_/g, "-").toLowerCase();
  if (!s) return null;
  // 語言子標籤除了精確相等，還要接受延伸子標籤（如 zh-TW-x-private／
  // zh-CN-u-ca-chinese）——真實 navigator.languages／URL ?lang= 偶爾夾這類
  // BCP 47 extension／private-use 子標籤，只比對 === 會讓這一階直接判「沒
  // 匹配」，錯著往下一階（config／browser 再下一輪）找，不是刻意拒絕。
  const tagIs = (tag) => s === tag || s.startsWith(tag + "-");
  if (tagIs("zh-hant") || tagIs("zh-tw") || tagIs("zh-hk") || tagIs("zh-mo")) return "zh-Hant";
  if (s === "zh" || tagIs("zh-hans") || tagIs("zh-cn") || tagIs("zh-sg")) {
    return SUPPORTED_LOCALES.includes("zh-Hans") ? "zh-Hans" : "zh-Hant";
  }
  for (const loc of SUPPORTED_LOCALES) {
    if (tagIs(loc.toLowerCase())) return loc;
  }
  return null;
}

export function resolveLocale({ url, stored, config, languages } = {}) {
  const fromUrl = normalizeLocale(url);
  if (fromUrl) return { locale: fromUrl, source: "url" };
  const fromStored = normalizeLocale(stored);
  if (fromStored) return { locale: fromStored, source: "stored" };
  const cfg = config && typeof config.locale === "string" ? config.locale : "";
  if (cfg && cfg.trim().toLowerCase() !== "auto") {
    const l = normalizeLocale(cfg);
    if (l) return { locale: l, source: "config" };
  }
  for (const lang of Array.isArray(languages) ? languages : []) {
    const l = normalizeLocale(lang);
    if (l) return { locale: l, source: "browser" };
  }
  return { locale: "en", source: "fallback" };
}

// ---- 環境讀取（無 DOM／無 storage 一律安全回 null）----
function readUrlLang() {
  try { return new URLSearchParams((globalThis.location && globalThis.location.search) || "").get("lang"); } catch (e) { return null; }
}
function readStored() {
  try { return globalThis.localStorage ? globalThis.localStorage.getItem(STORAGE_KEY) : null; } catch (e) { return null; }
}
function readLanguages() {
  const n = globalThis.navigator;
  if (!n) return [];
  if (Array.isArray(n.languages) && n.languages.length) return n.languages;
  return n.language ? [n.language] : [];
}
function doc() { return typeof document !== "undefined" ? document : null; }
function applyLang() { const d = doc(); if (d && d.documentElement) d.documentElement.lang = current; }
function emit() { for (const fn of listeners) { try { fn(current); } catch (e) { /* 訂閱者自己的錯不擋切換 */ } } }
function commit(locale) {
  if (locale === current) return current;
  current = locale;
  applyLang();
  applyDom();
  emit();
  return current;
}

export function initI18n({ config = null, root } = {}) {
  lastConfig = config;
  const r = resolveLocale({ url: readUrlLang(), stored: readStored(), config, languages: readLanguages() });
  explicitSource = r.source === "url" || r.source === "stored" ? r.source : null;
  current = r.locale;
  applyLang();
  applyDom(root);
  return current;
}

export function applyConfigLocale(config) {
  lastConfig = config;
  if (explicitSource) return current;
  const r = resolveLocale({ config, languages: readLanguages() });
  return commit(r.locale);
}

export function getLocale() { return current; }
export function getStoredChoice() { return normalizeLocale(readStored()) || "auto"; }

export function setLocale(locale, { persist = true } = {}) {
  if (locale === "auto") {
    if (persist) {
      try { globalThis.localStorage && globalThis.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 無痕等 */ }
    }
    // "auto" 一律清 explicitSource（不只有 persist 時才清），否則 setLocale("auto", { persist:false })
    // 後 getLocale() 仍被舊的 explicitSource 鎖住，applyConfigLocale 也會誤判成「有明確來源」而 no-op。
    explicitSource = null;
    const r = resolveLocale({ config: lastConfig, languages: readLanguages() });
    return commit(r.locale);
  }
  const l = normalizeLocale(locale);
  if (!l) return current;
  if (persist) {
    try { globalThis.localStorage && globalThis.localStorage.setItem(STORAGE_KEY, l); } catch (e) { /* 無痕等 */ }
    explicitSource = "stored";
  }
  return commit(l);
}

export function t(key, params) {
  const dict = DICTS[current] || {};
  let s = dict[key];
  if (typeof s !== "string") s = DICTS[SOURCE_LOCALE][key];
  if (typeof s !== "string") return key;
  if (params && typeof params === "object") {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));
  }
  return s;
}

export function pickLabel(label) {
  if (typeof label === "string") return label;
  if (label && typeof label === "object") {
    for (const k of [current, SOURCE_LOCALE, "en"]) {
      if (typeof label[k] === "string" && label[k]) return label[k];
    }
    for (const v of Object.values(label)) if (typeof v === "string" && v) return v;
  }
  return "";
}

export function applyDom(root) {
  const scope = root || doc();
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  const nodes = (sel) => {
    const list = Array.from(scope.querySelectorAll(sel));
    if (typeof scope.matches === "function" && scope.matches(sel)) list.unshift(scope);
    return list;
  };
  // 三種選擇器全部先查完（這時 DOM 還沒被任何一種賦值動過）才開始套用——
  // data-i18n／data-i18n-html 對某節點設 textContent／innerHTML 會把它當下的子節點整批清掉；
  // 若邊查邊套，一顆帶 data-i18n 的容器可能在被翻譯的同時，把還沒輪到的 data-i18n-attr
  // 子節點從樹上摘掉，後面那輪 querySelectorAll 就查無此節點、屬性永遠翻不到。先在原始、
  // 完整的樹上把三份清單都拿到手，再依序套用，於是即使套用順序造成節點脫樹，脫樹前
  // 就已經拿到的參照仍然翻得到（DOM 節點脫樹只影響它在畫面上的位置，不影響它本身可操作）。
  const i18nNodes = nodes("[data-i18n]");
  const htmlNodes = nodes("[data-i18n-html]");
  const attrNodes = nodes("[data-i18n-attr]");
  for (const el of i18nNodes) el.textContent = t(el.dataset.i18n);
  for (const el of htmlNodes) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of attrNodes) {
    for (const pair of el.dataset.i18nAttr.split(",")) {
      const i = pair.indexOf(":");
      if (i < 0) continue;
      const attr = pair.slice(0, i).trim();
      const key = pair.slice(i + 1).trim();
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
}

export function tEl(el, key, params) {
  if (!el) return;
  el.textContent = t(key, params);
  if (params) delete el.dataset.i18n; else el.dataset.i18n = key;
}

export function tAttr(el, attr, key) {
  if (!el) return;
  el.setAttribute(attr, t(key));
  const pairs = (el.dataset.i18nAttr || "").split(",").map((s) => s.trim()).filter(Boolean)
    .filter((p) => !p.startsWith(attr + ":"));
  pairs.push(attr + ":" + key);
  el.dataset.i18nAttr = pairs.join(",");
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function localeOptions() {
  return [{ value: "auto", label: t("settings.langAuto") }]
    .concat(SUPPORTED_LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] || l })));
}
