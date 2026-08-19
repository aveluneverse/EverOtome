import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SOURCE_LOCALE, SUPPORTED_LOCALES, STORAGE_KEY, LOCALE_NAMES,
  normalizeLocale, resolveLocale, initI18n, applyConfigLocale, getLocale, getStoredChoice,
  setLocale, t, pickLabel, applyDom, tEl, tAttr, onLocaleChange, localeOptions,
} from "../js/i18n.js";
import zhHant from "../js/locales/zh-Hant.js";
import en from "../js/locales/en.js";

describe("normalizeLocale", () => {
  it("maps traditional-Chinese tags to zh-Hant", () => {
    for (const s of ["zh-Hant", "zh-TW", "zh_tw", "ZH-HK", "zh-MO", "zh-Hant-TW"]) expect(normalizeLocale(s)).toBe("zh-Hant");
  });
  it("maps simplified / bare zh to zh-Hant while zh-Hans is unsupported", () => {
    for (const s of ["zh", "zh-CN", "zh-Hans", "zh-SG"]) expect(normalizeLocale(s)).toBe("zh-Hant");
  });
  it("accepts extended BCP 47 subtags (extension / private-use) on the bare regional tags too", () => {
    // 之前只有 zh-Hant-TW／zh-Hans 這種「先有 script 子標籤」的形式接得住延伸
    // 子標籤——zh-TW／zh-CN 這種沒有 script 子標籤、直接接 region 的形式是
    // 精確比對，帶了任何延伸子標籤就整階落空、誤判成「這階沒給值」。
    expect(normalizeLocale("zh-TW-x-private")).toBe("zh-Hant");
    expect(normalizeLocale("zh-CN-u-ca-chinese")).toBe("zh-Hant"); // zh-Hans 未支援時落回 zh-Hant
  });
  it("maps English tags to en and rejects unknown", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("fr")).toBeNull();
    expect(normalizeLocale("")).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
  });
});

describe("resolveLocale priority", () => {
  it("url > stored > config > browser > fallback", () => {
    expect(resolveLocale({ url: "en", stored: "zh-Hant", config: { locale: "zh-Hant" }, languages: ["zh-TW"] })).toEqual({ locale: "en", source: "url" });
    expect(resolveLocale({ stored: "en", config: { locale: "zh-Hant" }, languages: ["zh-TW"] })).toEqual({ locale: "en", source: "stored" });
    expect(resolveLocale({ config: { locale: "en" }, languages: ["zh-TW"] })).toEqual({ locale: "en", source: "config" });
    expect(resolveLocale({ config: { locale: "auto" }, languages: ["ja", "zh-TW"] })).toEqual({ locale: "zh-Hant", source: "browser" });
    expect(resolveLocale({ languages: ["ja"] })).toEqual({ locale: "en", source: "fallback" });
    expect(resolveLocale({})).toEqual({ locale: "en", source: "fallback" });
  });
  it("ignores unknown values at every level", () => {
    expect(resolveLocale({ url: "fr", stored: "xx", config: { locale: "yy" }, languages: ["de", "en-US"] })).toEqual({ locale: "en", source: "browser" });
  });
});

describe("t()", () => {
  beforeEach(() => setLocale("zh-Hant", { persist: false }));
  it("returns zh-Hant by default and en after switching", () => {
    expect(t("menu.clear")).toBe(zhHant["menu.clear"]);
    setLocale("en", { persist: false });
    expect(t("menu.clear")).toBe(en["menu.clear"]);
  });
  it("interpolates {params} and leaves unknown placeholders", () => {
    setLocale("en", { persist: false });
    expect(t("photo.sendingN", { i: 2, n: 5 })).toBe("Sending (2/5)...");
    expect(t("photo.sendingN", { i: 2 })).toBe("Sending (2/{n})...");
  });
  it("falls back to zh-Hant then to the key", () => {
    setLocale("en", { persist: false });
    expect(t("nope.missing")).toBe("nope.missing");
  });
});

describe("pickLabel", () => {
  beforeEach(() => setLocale("en", { persist: false }));
  it("passes strings through", () => expect(pickLabel("水晶天鵝")).toBe("水晶天鵝"));
  it("picks current locale, then zh-Hant, then en, then first value", () => {
    expect(pickLabel({ "zh-Hant": "水晶天鵝", en: "Crystal Swan" })).toBe("Crystal Swan");
    expect(pickLabel({ "zh-Hant": "水晶天鵝" })).toBe("水晶天鵝");
    expect(pickLabel({ ja: "クリスタル" })).toBe("クリスタル");
    setLocale("zh-Hant", { persist: false });
    expect(pickLabel({ "zh-Hant": "水晶天鵝", en: "Crystal Swan" })).toBe("水晶天鵝");
  });
  it("returns empty string for garbage", () => {
    expect(pickLabel(undefined)).toBe("");
    expect(pickLabel(42)).toBe("");
    expect(pickLabel({})).toBe("");
  });
});

describe("applyDom / tEl / tAttr", () => {
  beforeEach(() => {
    setLocale("zh-Hant", { persist: false });
    document.body.innerHTML = `
      <button data-i18n="menu.clear">清畫面</button>
      <p data-i18n-html="lab.noSpriteHint">x</p>
      <input data-i18n-attr="placeholder:input.placeholder, aria-label:input.label">
      <div id="dyn"></div>`;
  });
  it("translates text, html and attributes and re-translates on setLocale", () => {
    applyDom();
    expect(document.querySelector("button").textContent).toBe(zhHant["menu.clear"]);
    expect(document.querySelector("p").innerHTML).toBe(zhHant["lab.noSpriteHint"]);
    expect(document.querySelector("input").placeholder).toBe(zhHant["input.placeholder"]);
    expect(document.querySelector("input").getAttribute("aria-label")).toBe(zhHant["input.label"]);
    setLocale("en", { persist: false });
    expect(document.querySelector("button").textContent).toBe(en["menu.clear"]);
    expect(document.querySelector("p").innerHTML).toBe(en["lab.noSpriteHint"]);
    expect(document.querySelector("input").placeholder).toBe(en["input.placeholder"]);
  });
  it("tEl marks the key so a later applyDom re-translates; params skip the mark", () => {
    const el = document.getElementById("dyn");
    tEl(el, "appearance.inUse");
    expect(el.dataset.i18n).toBe("appearance.inUse");
    setLocale("en", { persist: false });
    expect(el.textContent).toBe("In use");
    tEl(el, "photo.sendingN", { i: 1, n: 2 });
    expect(el.dataset.i18n).toBeUndefined();
    expect(el.textContent).toBe("Sending (1/2)...");
  });
  it("tAttr records attr:key pairs and merges with existing ones", () => {
    const el = document.getElementById("dyn");
    tAttr(el, "aria-label", "side.hideSprite");
    tAttr(el, "title", "side.hideSprite");
    tAttr(el, "aria-label", "side.showSprite"); // replaces the aria-label pair
    expect(el.dataset.i18nAttr).toBe("title:side.hideSprite,aria-label:side.showSprite");
    setLocale("en", { persist: false });
    expect(el.getAttribute("aria-label")).toBe("Show sprite");
    expect(el.getAttribute("title")).toBe("Hide sprite");
  });
});

describe("applyDom(root) scoping", () => {
  beforeEach(() => setLocale("zh-Hant", { persist: false }));
  it("translates the root itself (data-i18n) and a nested descendant (data-i18n-attr) in one call", () => {
    // el 自己掛 data-i18n（textContent 賦值會把子節點整批清掉），child 掛 data-i18n-attr——
    // 兩者都要翻到；child 翻完即使被 el.textContent 從樹上摘掉，測試仍握著 child 這個參照，
    // 屬性值改了就改了，不因脫樹而失效。
    const el = document.createElement("div");
    el.dataset.i18n = "menu.clear";
    const child = document.createElement("input");
    child.dataset.i18nAttr = "placeholder:input.placeholder";
    el.appendChild(child);
    applyDom(el);
    expect(el.textContent).toBe(zhHant["menu.clear"]);
    expect(child.placeholder).toBe(zhHant["input.placeholder"]);
  });
  it("does not touch elements outside root", () => {
    const outside = document.createElement("button");
    outside.dataset.i18n = "menu.clear";
    outside.textContent = "untouched";
    const el = document.createElement("div");
    const inside = document.createElement("button");
    inside.dataset.i18n = "menu.clear";
    inside.textContent = "placeholder";
    el.appendChild(inside);
    applyDom(el);
    expect(inside.textContent).toBe(zhHant["menu.clear"]);
    expect(outside.textContent).toBe("untouched");
  });
  it("applyDom(fragment) translates a DocumentFragment's descendants without throwing (fragments have no .matches)", () => {
    const frag = document.createDocumentFragment();
    const btn = document.createElement("button");
    btn.dataset.i18n = "menu.clear";
    btn.textContent = "placeholder";
    frag.appendChild(btn);
    expect(typeof frag.matches).not.toBe("function"); // 前提：fragment 沒有 .matches，nodes() 的守門才有意義
    expect(() => applyDom(frag)).not.toThrow();
    expect(btn.textContent).toBe(zhHant["menu.clear"]);
  });
});

describe("setLocale / persistence / <html lang> / listeners", () => {
  beforeEach(() => { localStorage.clear(); setLocale("zh-Hant", { persist: false }); });
  it("persists explicit choice, updates <html lang>, notifies once per change", () => {
    const fn = vi.fn();
    const off = onLocaleChange(fn);
    setLocale("en");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(getLocale()).toBe("en");
    expect(getStoredChoice()).toBe("en");
    setLocale("en"); // idempotent
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    setLocale("zh-Hant");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("'auto' clears the stored choice and re-resolves from config/browser", () => {
    setLocale("en");
    setLocale("auto");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getStoredChoice()).toBe("auto");
    // jsdom navigator.language is en-US → resolves to en
    expect(getLocale()).toBe("en");
  });
  it("'auto' with persist:false still clears explicitSource, so applyConfigLocale is not locked out afterward", () => {
    setLocale("en"); // 明確選擇、persist:true → explicitSource = "stored"
    const resolved = setLocale("auto", { persist: false }); // jsdom browser = en-US → 新鮮解析 = en
    expect(resolved).toBe("en");
    expect(getLocale()).toBe("en"); // 跟「重新解析一次」的結果一致，不是殘留舊值
    // 真正的坑：persist:false 跳過了 storage 清除那段，若 explicitSource 也一起被跳過沒清，
    // 下面這行會被誤判成「有明確來源」直接 no-op、新 config 永遠套不進來。
    expect(applyConfigLocale({ locale: "zh-Hant" })).toBe("zh-Hant");
    expect(getLocale()).toBe("zh-Hant");
  });
  it("ignores unknown locale", () => {
    expect(setLocale("fr")).toBe("zh-Hant");
  });
});

describe("initI18n / applyConfigLocale", () => {
  beforeEach(() => { localStorage.clear(); history.replaceState({}, "", "/"); });
  it("uses ?lang= without persisting", () => {
    history.replaceState({}, "", "/?lang=zh-TW");
    expect(initI18n()).toBe("zh-Hant");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    // config cannot override an explicit URL choice
    expect(applyConfigLocale({ locale: "en" })).toBe("zh-Hant");
  });
  it("uses stored choice over config, and config over browser", () => {
    localStorage.setItem(STORAGE_KEY, "zh-Hant");
    expect(initI18n()).toBe("zh-Hant");
    expect(applyConfigLocale({ locale: "en" })).toBe("zh-Hant");
    localStorage.clear();
    expect(initI18n()).toBe("en");                       // jsdom browser = en-US
    expect(applyConfigLocale({ locale: "zh-Hant" })).toBe("zh-Hant");
    expect(applyConfigLocale({ locale: "auto" })).toBe("en");
  });
});

describe("localeOptions", () => {
  it("lists auto (translated) plus every supported locale with its own name", () => {
    setLocale("en", { persist: false });
    expect(localeOptions()).toEqual([
      { value: "auto", label: "Auto (follow browser)" },
      { value: "zh-Hant", label: "繁體中文" },
      { value: "en", label: "English" },
    ]);
    expect(SUPPORTED_LOCALES).toEqual(["zh-Hant", "en"]);
    expect(SOURCE_LOCALE).toBe("zh-Hant");
    expect(LOCALE_NAMES.en).toBe("English");
  });
});
