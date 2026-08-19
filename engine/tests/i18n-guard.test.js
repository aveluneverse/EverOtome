// 守門：字典同鍵集合（跨 SUPPORTED_LOCALES）／英文品質＋HTML 標鍵／零 CJK
// （engine/js 全檔，逐行＋全檔雙掃）／JS 端 t()/tEl()/tAttr() 字面值鍵存在性
// ／tour 子集／示範相冊 mock JSON 多語（album＋manage 兩檔 name／desc 對
// SUPPORTED_LOCALES 每個語系都有值）。
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import zhHant from "../js/locales/zh-Hant.js";
import { SUPPORTED_LOCALES, SOURCE_LOCALE } from "../js/i18n.js";
import zhLines from "../demo/tour-lines.zh-Hant.js";
import enLines from "../demo/tour-lines.en.js";

const CJK = /[一-鿿　-〿＀-￯]/;
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const HTMLS = ["index.html", "demo/tour.html", "demo/expression-lab.html"];
// 非源語系清單：跑迴圈用 SUPPORTED_LOCALES 動態決定，不寫死 en——新語系只要
// 在 i18n.js 註冊＋補 locales/<code>.js，下面的字典守門與 JS 端鍵存在性
// 守門就自動納管，不必回來加新的 describe 區塊。
const OTHER_LOCALES = SUPPORTED_LOCALES.filter((l) => l !== SOURCE_LOCALE);

// ── 共用：剝註解＋抓字串字面值（Task 8 先定義，Task 9 也會重用）───────────
// stripComments 把 // 與 /* */ 註解換成空白，但字串／模板字面值內容原樣保留
// （逐字元掃描、追蹤目前是否在引號內，遇到 \ 跳過下一字元避免誤判跳脫的引號
// 結束字串）。⚠️ 這條路徑對含 console. 的行不放行——若原始碼裡有
// console.* 中文訊息，字串字面值一樣會被抓出來，得改成英文或移除。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((line) => {
    let out = "", q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { out += c; if (c === "\\") { out += line[i + 1] || ""; i++; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; out += c; continue; }
      if (line.startsWith("//", i)) break;
      out += c;
    }
    return out;
  }).join("\n");
}
function cjkLiterals(src) {
  const lits = stripComments(src).match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [];
  return lits.filter((l) => CJK.test(l));
}

describe("i18n dictionaries", () => {
  it("zh-Hant (source locale) has no empty values", () => {
    for (const [k, v] of Object.entries(zhHant)) expect(v, k).not.toBe("");
  });

  // 跨 SUPPORTED_LOCALES 動態 import：改動前這裡是寫死的「en has exactly the
  // zh-Hant key set」等四顆 it，只認得 en。現在對每個非源語系都跑同一組檢查
  // ——目前 OTHER_LOCALES 只有 en 一個，行為與改動前等價，但下次加語系不必
  // 回來改這個檔案。
  describe.each(OTHER_LOCALES)("locale dictionary: %s", (locale) => {
    let dict;
    beforeAll(async () => {
      dict = (await import(`../js/locales/${locale}.js`)).default;
    });

    it("has exactly the zh-Hant key set", () => {
      expect(Object.keys(dict).sort()).toEqual(Object.keys(zhHant).sort());
    });
    it("no empty values", () => {
      for (const [k, v] of Object.entries(dict)) expect(v, k).not.toBe("");
    });
    it("placeholders match zh-Hant", () => {
      const ph = (s) => (s.match(/\{\w+\}/g) || []).sort();
      for (const k of Object.keys(zhHant)) expect(ph(dict[k]), k).toEqual(ph(zhHant[k]));
    });
    // 沿用改動前「en 品質檢查」的邏輯，套用到每個非源語系（目前只有 en，
    // 日後加語系一併吃到）：非 CJK／無破折號／無 he-she 系代名詞。
    it("values carry no CJK, no em/en dash, no he/she pronouns", () => {
      for (const [k, v] of Object.entries(dict)) {
        expect(CJK.test(v), `${k}: ${v}`).toBe(false);
        expect(/[—–]/.test(v), `${k}: ${v}`).toBe(false);
        expect(/\b(he|she|his|him|her|hers)\b/i.test(v), `${k}: ${v}`).toBe(false);
      }
    });
  });

  it("fixture: the sorted-key-set comparison above actually fails on a mismatched dict", () => {
    // 上面「has exactly the zh-Hant key set」全綠可能有兩種原因：真的零缺鍵，
    // 或比對機制本身失效（例如手滑打錯 toEqual 的方向）。這裡直接餵一組刻意
    // 缺鍵的假字典進同一種比對手法，證明比對機制真的會抓到不一致。
    const source = { "a.b": "1", "c.d": "2" };
    const missingKey = { "a.b": "1" };
    expect(() => expect(Object.keys(missingKey).sort()).toEqual(Object.keys(source).sort())).toThrow();
  });
});

// ── engine/js 零硬編 CJK 字面值 ──────────────────────────────────────────
// i18n.js 例外整檔不掃：LOCALE_NAMES 的各語系自稱（如「繁體中文」）依設計
// 就是 CJK 字面值，不是漏翻。console.* 那行例外：除錯訊息不走 t()，允許中文。
//
// 兩種掃法都跑，理由不同：
// - 逐行掃（cjkLineOffenders）：貼近「人眼看單行」的直覺，訊息裡的行號／
//   上下文最好讀。
// - 全檔掃（cjkWholeFileOffenders）：逐行掃看不到跨行的 template literal
//   ——反引號字串開頭那行若沒有中文，逐行掃就漏了中間或結尾行藏的中文。
//   這裡重用 cjkLiterals()（上面 tour.js 那組守門已經在用的同一份規則），
//   只是重用前先把 console.* 那整行內容挖掉，讓 cjkLiterals 掃不到它，
//   達成跟逐行版一樣的「console 行豁免」效果（cjkLiterals 本身不知道
//   console 是什麼，也不需要知道）。
const CONSOLE_LINE = /console\.(warn|error|log|info|debug)\(/;

function cjkLineOffenders(src) {
  const offenders = [];
  for (const line of stripComments(src).split("\n")) {
    if (CONSOLE_LINE.test(line)) continue;
    const lits = line.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g) || [];
    for (const l of lits) if (CJK.test(l)) offenders.push(l.slice(0, 60));
  }
  return offenders;
}

function cjkWholeFileOffenders(src) {
  const clean = stripComments(src);
  const withoutConsoleLines = clean.split("\n").map((line) => (CONSOLE_LINE.test(line) ? "" : line)).join("\n");
  return cjkLiterals(withoutConsoleLines).map((l) => l.slice(0, 60));
}

describe("no hardcoded CJK string literals in engine/js (outside locales/) or the three HTML files' inline scripts", () => {
  const files = fs.readdirSync(path.join(ROOT, "js"))
    .filter((f) => f.endsWith(".js") && f !== "i18n.js")
    .map((f) => path.join(ROOT, "js", f));
  // engine/js 檔案讀真檔路徑；三支 HTML 改讀 inlineScriptsOf() 剝出來的 inline
  // <script> 內容（外部 src= 版的 script 本檔內容是空字串，inlineScriptsOf 已經
  // 濾掉，見該函式定義處註解）——兩種來源共用同一份 offender 收集邏輯，標籤統一
  // 用「檔名/相對路徑: 違規片段」格式，跟下面 HTML data-i18n 那組 describe 同款。
  const sources = [
    ...files.map((f) => ({ label: path.basename(f), src: fs.readFileSync(f, "utf8") })),
    ...HTMLS.map((file) => ({ label: file, src: inlineScriptsOf(read(file)) })),
  ];

  it("every js module and HTML inline script is clean — line scan (console.* lines exempt)", () => {
    const offenders = [];
    for (const { label, src } of sources) {
      for (const off of cjkLineOffenders(src)) offenders.push(`${label}: ${off}`);
    }
    expect(offenders).toEqual([]);
  });

  it("every js module and HTML inline script is clean — whole-file scan (catches multi-line template literals; console.* lines exempt)", () => {
    const offenders = [];
    for (const { label, src } of sources) {
      for (const off of cjkWholeFileOffenders(src)) offenders.push(`${label}: ${off}`);
    }
    expect(offenders).toEqual([]);
  });

  it("fixture: both scans catch a planted CJK literal; whole-file scan also catches a multi-line one; console lines stay exempt in both", () => {
    // 假原始碼，不是真檔案、不會被 commit：單行違規＋console 行（該豁免）＋
    // 一顆跨兩行的 template literal（逐行掃看不到，全檔掃看得到）。
    const bogus = [
      'const label = "壞掉的中文字面值";',
      'console.warn("除錯用中文，不該被算違規", x);',
      "const multi = `first line",
      "第二行藏中文`;",
    ].join("\n");

    expect(cjkLineOffenders(bogus)).toEqual(['"壞掉的中文字面值"']);

    const wholeFile = cjkWholeFileOffenders(bogus);
    expect(wholeFile).toContain('"壞掉的中文字面值"');
    expect(wholeFile.some((o) => o.includes("第二行藏中文"))).toBe(true); // 跨行 template literal，逐行掃抓不到
    expect(wholeFile.some((o) => o.includes("除錯用中文"))).toBe(false); // console 行兩種掃法都豁免
  });

  it("fixture: the HTML inline-script path actually gets scanned, not just engine/js files", () => {
    // 證明擴大後的 sources 清單真的把 HTML inline script 納入掃描——不是只有
    // engine/js 那組路徑在跑、HTML 那組形同虛設。用一段假 HTML（帶 inline
    // <script>，非 src=）過 inlineScriptsOf() 剝出腳本內容，餵進兩種掃法。
    const bogusHtml = '<!doctype html><html><body><script>\n  const oops = "混進 inline script 的中文";\n</script></body></html>';
    const extracted = inlineScriptsOf(bogusHtml);
    expect(cjkLineOffenders(extracted)).toEqual(['"混進 inline script 的中文"']);
    expect(cjkWholeFileOffenders(extracted)).toContain('"混進 inline script 的中文"');
  });
});

// ── JS 端 t()/tEl()/tAttr() 字面值鍵存在性 ──────────────────────────────
// 只認得出「鍵是雙引號字面值」的呼叫：t("a.b")／tEl(el, "a.b")／
// tAttr(el, "attr", "a.b")。三元運算式或變數鍵（如 t(key)、
// tAttr(b, "aria-label", cond ? "x.y" : "x.z")）的引數本身不是字面值，依規格
// 略過不查——這類呼叫全專案共 8 處（app.js 7 處：connText() 一顆 4-way 查表
// ＋ 6 顆二分支三元；cg.js 1 處二分支三元），都已人工核對過，實際會用到的
// 鍵（conn.* 四顆、side.* 四顆、chatlog.* 四顆、appearance.outfit* 兩顆、
// cg.group* 兩顆）全部都在字典裡（見 Task 9 交接）。
const KEY_FMT = "[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)+";
const T_KEY_RE = new RegExp(`\\bt\\(\\s*"(${KEY_FMT})"`, "g");
const TEL_KEY_RE = new RegExp(`\\btEl\\(\\s*[^,()]+\\s*,\\s*"(${KEY_FMT})"`, "g");
const TATTR_KEY_RE = new RegExp(`\\btAttr\\(\\s*[^,()]+\\s*,\\s*[^,()]+\\s*,\\s*"(${KEY_FMT})"`, "g");

function literalI18nKeys(src) {
  const clean = stripComments(src);
  const keys = new Set();
  for (const re of [T_KEY_RE, TEL_KEY_RE, TATTR_KEY_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean))) keys.add(m[1]);
  }
  return keys;
}

// 只抓沒有 src= 屬性的 <script> 區塊（有 src= 的是外部檔，本檔內容是空的、
// 抓了也白抓）——index.html／tour.html 兩顆目前都是 src= 版，expression-lab.html
// 是唯一真的有內文的一顆。
function inlineScriptsOf(html) {
  const blocks = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) blocks.push(m[1]);
  return blocks.join("\n");
}

describe("engine/js literal i18n keys resolve in the zh-Hant dictionary", () => {
  it("every t()/tEl()/tAttr() string-literal key exists (offenders reported as file: key)", () => {
    const jsDir = path.join(ROOT, "js");
    const jsFiles = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js")).map((f) => path.join(jsDir, f));
    const targets = [...jsFiles, path.join(ROOT, "demo/tour.js")];
    const offenders = [];
    for (const f of targets) {
      for (const key of literalI18nKeys(fs.readFileSync(f, "utf8"))) {
        if (typeof zhHant[key] !== "string") offenders.push(`${path.basename(f)}: ${key}`);
      }
    }
    for (const file of HTMLS) {
      for (const key of literalI18nKeys(inlineScriptsOf(read(file)))) {
        if (typeof zhHant[key] !== "string") offenders.push(`${file}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("fixture: an unknown literal key is caught; a dynamic-key call is ignored", () => {
    const bogus = [
      'tEl(el, "nope.key");', // 字面值、字典裡沒有 → 該被抓到
      "t(realKeyVar);", // 變數鍵 → 略過
      'tAttr(b, "aria-label", cond ? "a.b" : "a.c");', // 三元 → 略過（規格內已知限制）
    ].join("\n");
    expect([...literalI18nKeys(bogus)]).toEqual(["nope.key"]);
    expect(typeof zhHant["nope.key"]).not.toBe("string");
  });
});

function i18nKeysOf(html) {
  const dom = new JSDOM(html);
  const d = dom.window.document;
  const keys = new Set();
  d.querySelectorAll("[data-i18n]").forEach((el) => keys.add(el.dataset.i18n));
  d.querySelectorAll("[data-i18n-html]").forEach((el) => keys.add(el.dataset.i18nHtml));
  d.querySelectorAll("[data-i18n-attr]").forEach((el) => el.dataset.i18nAttr.split(",").forEach((p) => keys.add(p.split(":")[1].trim())));
  return { d, keys };
}

describe("static HTML is fully keyed and matches the zh-Hant dictionary", () => {
  for (const file of HTMLS) {
    it(`${file}: every data-i18n key exists and its source text equals the zh-Hant value`, () => {
      const { d, keys } = i18nKeysOf(read(file));
      for (const k of keys) expect(zhHant[k], `${file} key ${k}`).toBeTypeOf("string");
      d.querySelectorAll("[data-i18n]").forEach((el) => {
        expect(el.textContent.trim(), `${file} ${el.dataset.i18n}`).toBe(zhHant[el.dataset.i18n]);
      });
      d.querySelectorAll("[data-i18n-html]").forEach((el) => {
        const norm = (s) => s.replace(/\s+/g, " ").trim();
        expect(norm(el.innerHTML), `${file} ${el.dataset.i18nHtml}`).toBe(norm(zhHant[el.dataset.i18nHtml]));
      });
      d.querySelectorAll("[data-i18n-attr]").forEach((el) => {
        for (const pair of el.dataset.i18nAttr.split(",")) {
          const [attr, key] = pair.split(":").map((s) => s.trim());
          if (attr.startsWith("data-")) continue; // CSS attr() 掛鉤（如 data-empty-text）原檔不必預填
          expect(el.getAttribute(attr), `${file} ${attr}:${key}`).toBe(zhHant[key]);
        }
      });
    });
    it(`${file}: no CJK text node or attribute outside data-i18n management`, () => {
      const { d } = i18nKeysOf(read(file));
      const walker = d.createTreeWalker(d.body, dom_NodeFilter(d).SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (!CJK.test(n.textContent)) continue;
        const el = n.parentElement;
        if (el.closest("script,style")) continue;
        expect(!!el.closest("[data-i18n],[data-i18n-html]"), `${file} stray text: ${n.textContent.trim().slice(0, 40)}`).toBe(true);
      }
      d.querySelectorAll("*").forEach((el) => {
        for (const a of ["aria-label", "title", "placeholder", "alt"]) {
          const v = el.getAttribute(a);
          if (v && CJK.test(v)) expect((el.dataset.i18nAttr || "").includes(a + ":"), `${file} stray ${a}="${v}"`).toBe(true);
        }
      });
    });
  }
  it("tour.html keys are a subset of index.html keys", () => {
    const a = i18nKeysOf(read("index.html")).keys;
    const b = i18nKeysOf(read("demo/tour.html")).keys;
    for (const k of b) if (!k.startsWith("lab.")) expect(a.has(k), k).toBe(true);
  });
});
function dom_NodeFilter(d) { return d.defaultView.NodeFilter; }

describe("tour lines", () => {
  const shape = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.keys(v).sort()]));
  it("zh-Hant and en line files have the same shape and non-empty strings", () => {
    expect(shape(enLines)).toEqual(shape(zhLines));
    // 每段的值一律是一層字串（示範相冊卡名／描述已改由 mock JSON 自帶多語，
    // 見下方「demo CG album mock JSON」守門，台詞檔不再夾巢狀段）。
    for (const [segKey, seg] of Object.entries(enLines)) {
      for (const [k, v] of Object.entries(seg)) {
        expect(v, `${segKey}.${k}`).toBeTypeOf("string");
        expect(v.length, `${segKey}.${k}`).toBeGreaterThan(0);
        expect(CJK.test(v), `${segKey}.${k}`).toBe(false);
      }
    }
  });
  it("tour.js has no CJK string literals left", () => {
    const src = read("demo/tour.js");
    expect(cjkLiterals(src)).toEqual([]);
  });
});

// ── 示範相冊 mock JSON 多語（engine/api/v4/cg/album＋manage）────────────────
// 示範相冊由 serve.py 純靜態 GET 供應（無後端可翻譯），卡名／描述的多語直接
// 寫在資料裡：name／desc 是每語系一個的物件，殼（cg.js）用 pickLabel 依當前
// 介面語系挑——主頁 ?lang=en 與導覽頁同一份資料、同一條路，tour 端不再攔
// fetch 改寫。**示範相冊要跟上架語系齊**：對 SUPPORTED_LOCALES 每個語系都要
// 有非空字串（新語系在 i18n.js 註冊後，這裡自動要求 mock JSON 補那一格）；
// 零 CJK／零 em-en dash 只對 en 檢查（將來 zh-Hans 本來就是 CJK）。這是示範
// 資料，Rye 是男性角色，敘事用 he/his 可以：不套共用 UI 字典那條 he/she 禁令。
describe("demo CG album mock JSON (engine/api/v4/cg/album + manage) carries every supported locale", () => {
  const CG_API = "api/v4/cg";
  const album = JSON.parse(read(`${CG_API}/album`));
  const manage = JSON.parse(read(`${CG_API}/manage`));
  const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const expectAllLocales = (label, field) => {
    expect(isPlainObject(field), `${label} must be an object keyed by locale`).toBe(true);
    for (const loc of SUPPORTED_LOCALES) {
      expect(field[loc], `${label}.${loc}`).toBeTypeOf("string");
      expect(field[loc].length, `${label}.${loc}`).toBeGreaterThan(0);
    }
    expect(CJK.test(field.en), `${label}.en carries CJK: ${field.en}`).toBe(false);
    expect(/[—–]/.test(field.en), `${label}.en carries an em/en dash: ${field.en}`).toBe(false);
  };

  it("both files are { items: [...] } with the same non-empty id sequence (order included)", () => {
    for (const [name, data] of [["album", album], ["manage", manage]]) {
      expect(Array.isArray(data.items), `${name}.items`).toBe(true);
      expect(data.items.length, `${name}.items`).toBeGreaterThan(0);
    }
    expect(manage.items.map((it) => it.id)).toEqual(album.items.map((it) => it.id));
  });

  it("every name carries a non-empty string for every supported locale; en carries no CJK and no em/en dash", () => {
    for (const it of album.items) expectAllLocales(`album ${it.id}.name`, it.name);
    for (const it of manage.items) expectAllLocales(`manage ${it.id}.name`, it.name);
  });

  it("manage carries a desc per item in every supported locale; album carries no desc at all", () => {
    for (const it of manage.items) expectAllLocales(`manage ${it.id}.desc`, it.desc);
    for (const it of album.items) expect(Object.prototype.hasOwnProperty.call(it, "desc"), `album ${it.id} has desc`).toBe(false);
  });

  it("the same id has a deep-equal name in both files", () => {
    const byId = new Map(manage.items.map((it) => [it.id, it]));
    for (const it of album.items) expect(byId.get(it.id).name, it.id).toEqual(it.name);
  });

  it("every id has a same-name file under api/v4/cg/file/", () => {
    for (const it of album.items) {
      expect(fs.existsSync(path.join(ROOT, CG_API, "file", it.id)), `${CG_API}/file/${it.id}`).toBe(true);
    }
  });

  it("fixture: a card missing one supported locale is caught (the guard really keys on SUPPORTED_LOCALES)", () => {
    // 證明上面的守門是真的逐 SUPPORTED_LOCALES 要求，不是只認得 zh-Hant／en 兩個
    // 寫死的鍵：餵一張只有第一個語系的假卡進同一支檢查，必須拋。
    const onlyFirst = { [SUPPORTED_LOCALES[0]]: "x" };
    expect(SUPPORTED_LOCALES.length).toBeGreaterThan(1);
    expect(() => expectAllLocales("bogus.name", onlyFirst)).toThrow();
  });
});
