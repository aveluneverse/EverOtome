import { describe, it, expect, beforeEach } from "vitest";
import { initThemes } from "../js/theme.js";

// 色系主題系統：config.themes 驅動的變數注入／別名寫入／還原／記憶——
// vars 注入 chat.css 底層 token（--primary/--panel-bg/--veil-rgb 等）＝
// 全站元件跟色；frameBg/fill 填色制已退役（框中間要維持透明）。

const CONFIG = {
  ui: { path: "skin/ui/", name: "Sample" },
  themes: [
    { id: "default", label: "預設主題" },
    {
      id: "crystal-swan",
      label: "水晶天鵝",
      vars: {
        line: "rgba(190,218,255,.88)",
        primary: "#7d9bd4",
        primarySoft: "#c6d7f0",
        hover: "#a9c2e8",
        panelBg: "rgba(28,43,78,.40)",
        veilRgb: "35, 51, 90",
        btnBg: "#2b3f6b",
        btnBgHover: "#3d5488",
        mBarBg: "#131a2c",
        bubbleSent: "#a9bfe2ed",
        onBubbleSent: "#182743",
        bubbleSentRing: "#d5e4fa",
        bubbleReply: "#203765f2",
      },
      assets: {
        bgRoom: "themes/crystal-swan/bg-room.webp",
        compass: "themes/crystal-swan/compass.webp",
        chatlogFrame: "themes/crystal-swan/chatlog-frame.svg",
      },
    },
    {
      id: "rose-vow",
      label: "薔薇暮誓",
      vars: { line: "rgba(255,164,207,.86)", btnBg: "#5c2a4a" },
      assets: { bgRoom: "themes/rose-vow/bg-room.webp" },
    },
  ],
};

function rootStyle() {
  return document.documentElement.style;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  delete document.body.dataset.theme;
  // has-theme-assets 現在隨每次 apply()／冷開機由 injectAssets() 的 toggle
  // 重新計算；仍手動清一次是防呆——themes 清單為空時 initThemes() 完全不會
  // 呼叫 injectAssets，class 不會被重算，留著清乾淨避免跨 test 殘留舊狀態。
  document.body.classList.remove("has-theme-assets");
});

describe("initThemes 基本形狀", () => {
  it("config 無 themes → 空清單、apply 安全 no-op", () => {
    const mgr = initThemes({ ui: { path: "x/" } });
    expect(mgr.list).toEqual([]);
    expect(() => mgr.apply("whatever")).not.toThrow();
    expect(document.body.dataset.theme).toBeUndefined();
  });

  it("預設（首項）＝零覆寫：無 data-theme、無 token 注入", () => {
    const mgr = initThemes(CONFIG);
    expect(mgr.current).toBe("default");
    expect(document.body.dataset.theme).toBeUndefined();
    expect(rootStyle().getPropertyValue("--th-line")).toBe("");
    expect(rootStyle().getPropertyValue("--btn-bg")).toBe("");
    expect(rootStyle().getPropertyValue("--primary")).toBe("");
    expect(rootStyle().getPropertyValue("--panel-bg")).toBe("");
  });
});

describe("套用與還原", () => {
  it("apply 非預設 → data-theme＋底層 token 注入＋素材變數絕對 URL", () => {
    const mgr = initThemes(CONFIG);
    mgr.apply("crystal-swan");
    expect(document.body.dataset.theme).toBe("crystal-swan");
    expect(rootStyle().getPropertyValue("--th-line")).toBe("rgba(190,218,255,.88)");
    expect(rootStyle().getPropertyValue("--primary")).toBe("#7d9bd4");
    expect(rootStyle().getPropertyValue("--panel-bg")).toBe("rgba(28,43,78,.40)");
    expect(rootStyle().getPropertyValue("--veil-rgb")).toBe("35, 51, 90");
    expect(rootStyle().getPropertyValue("--btn-bg")).toBe("#2b3f6b");
    expect(rootStyle().getPropertyValue("--btn-bg-hover")).toBe("#3d5488");
    expect(rootStyle().getPropertyValue("--m-bar-bg")).toBe("#131a2c");
    const bg = rootStyle().getPropertyValue("--ui-bg-room");
    expect(bg).toContain("themes/crystal-swan/bg-room.webp");
    expect(bg).toContain("url(");
    expect(rootStyle().getPropertyValue("--ui-brand-ornament")).toContain(
      "themes/crystal-swan/compass.webp");
    expect(rootStyle().getPropertyValue("--ui-chatlog-frame")).toContain(
      "themes/crystal-swan/chatlog-frame.svg");
  });

  it("別名一鍵多寫：hover 同步 --status-accent、primarySoft 同步 --sub-accent", () => {
    const mgr = initThemes(CONFIG);
    mgr.apply("crystal-swan");
    expect(rootStyle().getPropertyValue("--hover")).toBe("#a9c2e8");
    expect(rootStyle().getPropertyValue("--status-accent")).toBe("#a9c2e8");
    expect(rootStyle().getPropertyValue("--primary-soft")).toBe("#c6d7f0");
    expect(rootStyle().getPropertyValue("--sub-accent")).toBe("#c6d7f0");
  });

  it("泡泡色票注入（乙女聊天泡泡色票）；未給的 ring 鍵不注入＝回 :root transparent", () => {
    const mgr = initThemes(CONFIG);
    mgr.apply("crystal-swan");
    expect(rootStyle().getPropertyValue("--bubble-sent")).toBe("#a9bfe2ed");
    expect(rootStyle().getPropertyValue("--on-bubble-sent")).toBe("#182743");
    expect(rootStyle().getPropertyValue("--bubble-sent-ring")).toBe("#d5e4fa");
    expect(rootStyle().getPropertyValue("--bubble-reply")).toBe("#203765f2");
    expect(rootStyle().getPropertyValue("--bubble-reply-ring")).toBe(""); // fixture 未給
    mgr.apply("default");
    expect(rootStyle().getPropertyValue("--bubble-sent")).toBe(""); // 預設主題＝沿用 :root 既有色號
    expect(rootStyle().getPropertyValue("--bubble-sent-ring")).toBe("");
  });

  it("切回預設 → 全清（data-theme 移除、token／別名歸零、素材回 baseline）", () => {
    // 模擬 applyUiSkin 已注入的 baseline
    rootStyle().setProperty("--ui-bg-room", 'url("http://x/base-room.webp")');
    rootStyle().setProperty("--ui-chatlog-frame", 'url("http://x/base-frame.svg")');
    const mgr = initThemes(CONFIG);
    mgr.apply("crystal-swan");
    mgr.apply("default");
    expect(document.body.dataset.theme).toBeUndefined();
    expect(rootStyle().getPropertyValue("--th-line")).toBe("");
    expect(rootStyle().getPropertyValue("--btn-bg")).toBe("");
    expect(rootStyle().getPropertyValue("--primary")).toBe("");
    expect(rootStyle().getPropertyValue("--status-accent")).toBe("");
    expect(rootStyle().getPropertyValue("--sub-accent")).toBe("");
    expect(rootStyle().getPropertyValue("--ui-bg-room")).toBe('url("http://x/base-room.webp")');
    expect(rootStyle().getPropertyValue("--ui-chatlog-frame")).toBe('url("http://x/base-frame.svg")');
  });

  it("主題間切換不殘留上一套的變數（A 有 panelBg、B 沒有 → B 下必空）", () => {
    const mgr = initThemes(CONFIG);
    mgr.apply("crystal-swan");
    expect(rootStyle().getPropertyValue("--panel-bg")).not.toBe("");
    mgr.apply("rose-vow");
    expect(document.body.dataset.theme).toBe("rose-vow");
    expect(rootStyle().getPropertyValue("--th-line")).toBe("rgba(255,164,207,.86)");
    expect(rootStyle().getPropertyValue("--panel-bg")).toBe("");     // A 的殘留清掉
    expect(rootStyle().getPropertyValue("--btn-bg-hover")).toBe(""); // A 的 hover 也清掉
    expect(rootStyle().getPropertyValue("--status-accent")).toBe(""); // A 的別名也清掉
  });

  it("rose-vow 無 compass／chatlogFrame 素材 → 對應變數不被寫入主題值", () => {
    const mgr = initThemes(CONFIG);
    mgr.apply("rose-vow");
    expect(rootStyle().getPropertyValue("--ui-brand-ornament")).toBe("");
    expect(rootStyle().getPropertyValue("--ui-chatlog-frame")).toBe("");
  });
});

describe("記憶與恢復", () => {
  it("apply 寫 localStorage；重新 init 恢復同主題", () => {
    const mgr = initThemes(CONFIG);
    mgr.apply("rose-vow");
    expect(localStorage.getItem("v4.theme")).toBe("rose-vow");

    // 模擬重載：清 DOM 再 init
    delete document.body.dataset.theme;
    document.documentElement.removeAttribute("style");
    const mgr2 = initThemes(CONFIG);
    expect(mgr2.current).toBe("rose-vow");
    expect(document.body.dataset.theme).toBe("rose-vow");
  });

  it("存的 id 不在清單（主題被下架）→ 回預設、不炸", () => {
    localStorage.setItem("v4.theme", "retired-theme");
    const mgr = initThemes(CONFIG);
    expect(mgr.current).toBe("default");
    expect(document.body.dataset.theme).toBeUndefined();
  });
});

// 首項（預設）帶 assets 的情境（開源殼 default＝crystal-swan、無 vars 只有
// assets）：零覆寫講的是 vars／data-theme，素材是獨立一件事——首項若帶
// assets 仍要顯式注入，否則開箱背景圖／徽章／Chat Log 框全部不見。
describe("首項素材（開源殼 default 帶背景圖但零 vars 覆寫）", () => {
  const CONFIG_DEFAULT_ASSETS = {
    ui: { path: "skin/ui/", name: "Sample" },
    themes: [
      {
        id: "crystal-swan",
        label: "水晶天鵝",
        assets: {
          bgRoom: "themes/crystal-swan/bg-room.webp",
          compass: "themes/crystal-swan/compass.webp",
          chatlogFrame: "themes/crystal-swan/chatlog-frame.svg",
        },
      },
      {
        id: "rose-vow",
        label: "薔薇暮誓",
        vars: { line: "rgba(255,164,207,.86)" },
        assets: { bgRoom: "themes/rose-vow/bg-room.webp" },
      },
    ],
  };

  it("首項帶 assets → 素材變數被注入＋掛 has-theme-assets；vars／data-theme 仍零覆寫", () => {
    const mgr = initThemes(CONFIG_DEFAULT_ASSETS);
    expect(mgr.current).toBe("crystal-swan");
    expect(document.body.dataset.theme).toBeUndefined();
    expect(rootStyle().getPropertyValue("--primary")).toBe(""); // vars 零覆寫不受影響
    const bg = rootStyle().getPropertyValue("--ui-bg-room");
    expect(bg).toContain("themes/crystal-swan/bg-room.webp");
    expect(rootStyle().getPropertyValue("--ui-brand-ornament")).toContain(
      "themes/crystal-swan/compass.webp");
    expect(rootStyle().getPropertyValue("--ui-chatlog-frame")).toContain(
      "themes/crystal-swan/chatlog-frame.svg");
    expect(document.body.classList.contains("has-theme-assets")).toBe(true);
  });

  it("切到第二主題再切回首項 → 素材變數＝首項的（不是第二主題殘留）", () => {
    const mgr = initThemes(CONFIG_DEFAULT_ASSETS);
    mgr.apply("rose-vow");
    expect(rootStyle().getPropertyValue("--ui-bg-room")).toContain("themes/rose-vow/bg-room.webp");
    mgr.apply("crystal-swan");
    expect(document.body.dataset.theme).toBeUndefined();
    const bg = rootStyle().getPropertyValue("--ui-bg-room");
    expect(bg).toContain("themes/crystal-swan/bg-room.webp");
    expect(bg).not.toContain("rose-vow");
    expect(rootStyle().getPropertyValue("--ui-brand-ornament")).toContain(
      "themes/crystal-swan/compass.webp");
  });

  it("首項無 assets（CONFIG 的 default）→ has-theme-assets 不掛，現行為不變", () => {
    const mgr = initThemes(CONFIG);
    expect(mgr.current).toBe("default");
    expect(document.body.classList.contains("has-theme-assets")).toBe(false);
  });
});

// 回歸測試：has-theme-assets 曾經是「只加不減」——從帶 assets 的主題切到不帶
// （或只帶部分）assets 的主題時，class 卡在殘留的 true，但 --ui-* 已被
// clearOverrides() 清空，layout.css 兩條消費 selector 都吃不到、Chat Log
// 開天窗。修法＝injectAssets() 內改用 classList.toggle，這裡鎖住雙向切換。
describe("has-theme-assets 旗標雙向切換（injectAssets toggle 的回歸測試）", () => {
  const CONFIG_MIXED_ASSETS = {
    ui: { path: "skin/ui/", name: "Sample" },
    themes: [
      {
        id: "crystal-swan",
        label: "水晶天鵝",
        assets: {
          bgRoom: "themes/crystal-swan/bg-room.webp",
          compass: "themes/crystal-swan/compass.webp",
          chatlogFrame: "themes/crystal-swan/chatlog-frame.svg",
        },
      },
      {
        id: "rose-vow",
        label: "薔薇暮誓",
        vars: { line: "rgba(255,164,207,.86)" },
        assets: { bgRoom: "themes/rose-vow/bg-room.webp" }, // 只有 bgRoom，部分 assets
      },
      {
        id: "no-assets-theme",
        label: "無素材主題",
        vars: { line: "rgba(1,2,3,.5)" }, // 無 assets 鍵
      },
    ],
  };

  it("assets 主題切到無 assets 主題 → has-theme-assets 關閉、--ui-* 全部清空", () => {
    const mgr = initThemes(CONFIG_MIXED_ASSETS);
    mgr.apply("crystal-swan");
    expect(document.body.classList.contains("has-theme-assets")).toBe(true);

    mgr.apply("no-assets-theme");
    expect(document.body.classList.contains("has-theme-assets")).toBe(false);
    expect(rootStyle().getPropertyValue("--ui-bg-room")).toBe("");
    expect(rootStyle().getPropertyValue("--ui-brand-ornament")).toBe("");
    expect(rootStyle().getPropertyValue("--ui-chatlog-frame")).toBe("");
  });

  it("部分 assets 主題（僅 bgRoom）仍算「有注入」→ has-theme-assets 維持開啟", () => {
    const mgr = initThemes(CONFIG_MIXED_ASSETS);
    mgr.apply("crystal-swan");
    mgr.apply("rose-vow");
    expect(document.body.classList.contains("has-theme-assets")).toBe(true);
    expect(rootStyle().getPropertyValue("--ui-bg-room")).toContain("rose-vow/bg-room.webp");
    expect(rootStyle().getPropertyValue("--ui-brand-ornament")).toBe(""); // 沒給的鍵不注入

    mgr.apply("no-assets-theme");
    expect(document.body.classList.contains("has-theme-assets")).toBe(false);
  });

  it("無 assets 主題切回帶 assets 的主題 → has-theme-assets 重新開啟", () => {
    const mgr = initThemes(CONFIG_MIXED_ASSETS);
    mgr.apply("no-assets-theme");
    expect(document.body.classList.contains("has-theme-assets")).toBe(false);
    mgr.apply("crystal-swan");
    expect(document.body.classList.contains("has-theme-assets")).toBe(true);
    expect(rootStyle().getPropertyValue("--ui-bg-room")).toContain("crystal-swan/bg-room.webp");
  });
});

// ── 主題上報（themeEndpoint）─────────────────────────────────────────────────
// 套主題／首開＝POST themeEndpoint {"theme": id}——後端「介面現在是哪一種燈
// 色」的資料源。fire-and-forget：失敗不影響換色；config 無鍵＝零呼叫。
import { vi, afterEach } from "vitest";

describe("主題上報（themeEndpoint）", () => {
  const EP_CONFIG = { ...CONFIG, themeEndpoint: "/api/v4/theme" };
  let calls;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ ok: true });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("apply → POST {theme: id}（credentials same-origin）", () => {
    const mgr = initThemes(EP_CONFIG);
    calls.length = 0; // init 期的首開上報不算在這條斷言裡
    mgr.apply("crystal-swan");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("/api/v4/theme");
    expect(calls[0].opts.method).toBe("POST");
    expect(calls[0].opts.credentials).toBe("same-origin");
    expect(JSON.parse(calls[0].opts.body)).toEqual({ theme: "crystal-swan" });
  });

  it("首開（無 saved）→ 上報預設主題：後端的「最後上報者」跟上眼前的燈色", () => {
    initThemes(EP_CONFIG);
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].opts.body)).toEqual({ theme: "default" });
  });

  it("開機恢復 saved → 走 apply 上報 saved 主題（不重複報）", () => {
    localStorage.setItem("v4.theme", "rose-vow");
    initThemes(EP_CONFIG);
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].opts.body)).toEqual({ theme: "rose-vow" });
  });

  it("config 無 themeEndpoint → 零呼叫（開源殼零成本）", () => {
    const mgr = initThemes(CONFIG);
    mgr.apply("crystal-swan");
    expect(calls.length).toBe(0);
  });

  it("fetch reject（斷網／後端 flag 未開）→ 換色照常、不炸", () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const mgr = initThemes(EP_CONFIG);
    expect(() => mgr.apply("crystal-swan")).not.toThrow();
    expect(document.body.dataset.theme).toBe("crystal-swan");
  });
});

// ── 外部指令出口：initThemes 回傳 handle，供 room_state frame handler 用後端
// 推來的值換色——applyById／currentId。list／current／apply（既有公開介面）不
// 受影響，純加法。
describe("initThemes 回傳 handle：applyById／currentId", () => {
  it("applyById 套用有效 id 回 true、同步 currentId／DOM；未知 id 回 false 不動現狀", () => {
    const h = initThemes(CONFIG);
    expect(h.applyById("crystal-swan")).toBe(true);
    expect(h.currentId()).toBe("crystal-swan");
    expect(document.body.dataset.theme).toBe("crystal-swan");

    expect(h.applyById("no-such-theme")).toBe(false);
    expect(h.currentId()).toBe("crystal-swan"); // 未知 id 不改變現狀
    expect(document.body.dataset.theme).toBe("crystal-swan");
  });

  it("currentId()：localStorage 有 saved 值優先；從未套用過時 fallback 首主題 id", () => {
    const h = initThemes(CONFIG); // CONFIG 無 themeEndpoint，首開無 saved
    expect(h.currentId()).toBe("default");
    h.applyById("rose-vow");
    expect(h.currentId()).toBe("rose-vow");
    expect(localStorage.getItem("v4.theme")).toBe("rose-vow");
  });

  it("既有 list／current／apply 不受影響（純加法、零破壞）", () => {
    const h = initThemes(CONFIG);
    expect(h.list.length).toBe(3);
    h.apply("rose-vow");
    expect(h.current).toBe("rose-vow");
    expect(typeof h.applyById).toBe("function");
    expect(typeof h.currentId).toBe("function");
  });
});

// ── applyById 防回音契約：後端發起的換色（room_state frame）絕不可回報
// themeEndpoint，否則「後端推 → 前端套 → 前端又報回後端」形成回音圈。只有使
// 用者透過既有面板換色的路徑（opts.report:true）才回報。
describe("applyById 防回音契約（後端發起換色不可回報 themeEndpoint）", () => {
  const EP_CONFIG = { ...CONFIG, themeEndpoint: "/api/v4/theme" };
  let calls;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ ok: true });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("預設（無 opts）＝不回報，但畫面真的換了", () => {
    const h = initThemes(EP_CONFIG);
    calls.length = 0; // 清掉開機首報
    expect(h.applyById("crystal-swan")).toBe(true);
    expect(calls.length).toBe(0);
    expect(document.body.dataset.theme).toBe("crystal-swan");
  });

  it("opts.report 非 true（缺鍵／false）＝不回報", () => {
    const h = initThemes(EP_CONFIG);
    calls.length = 0;
    h.applyById("crystal-swan", {});
    h.applyById("rose-vow", { report: false });
    expect(calls.length).toBe(0);
  });

  it("opts.report === true＝回報一次（不因 apply 內部既有回報疊加而雙報）", () => {
    const h = initThemes(EP_CONFIG);
    calls.length = 0;
    expect(h.applyById("crystal-swan", { report: true })).toBe(true);
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].opts.body)).toEqual({ theme: "crystal-swan" });
  });

  it("既有 mgr.apply(id) 直接呼叫（面板換色的既有路徑）行為零回歸＝照常回報", () => {
    const h = initThemes(EP_CONFIG);
    calls.length = 0;
    h.apply("crystal-swan");
    expect(calls.length).toBe(1);
  });
});

// ── 全域房間模式（config.roomEndpoint）下開機恢復零 theme POST ──────────────
// 舊行為：initThemes 開機時 apply(saved)（內建上報）＋首開 reportTheme(currentId)
// 補報。全域房間模式下這會把這台裝置的 stale localStorage 舊主題 POST 到後端，
// 蓋掉另一側剛換好的全域值（隨後 app.js 的房間 GET 回讀因「已經是自己剛蓋的舊
// 值」冪等跳過，舊值就此定案）。修法：config.roomEndpoint 存在時，開機恢復改
// apply(saved, false)（零上報）、首開也不補報 reportTheme(currentId)；全域現值
// 同步交給 app.js 的房間 GET 回讀接手。無 roomEndpoint（預設殼／per-device 配
// 置）＝行為完全照舊（既有兩則「首開」／「開機恢復 saved」測試已釘住，本區塊
// 只加 roomEndpoint 存在時的新分支＋一則不存在時的回歸釘對照）。
describe("全域房間模式（config.roomEndpoint）：開機恢復零 theme POST", () => {
  const ROOM_EP_CONFIG = {
    ...CONFIG,
    themeEndpoint: "/api/v4/theme",
    roomEndpoint: "/api/v4/room",
  };
  let calls;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ ok: true });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("roomEndpoint 存在＋開機（localStorage 有 saved theme）→ 畫面照套、零 theme POST", () => {
    localStorage.setItem("v4.theme", "rose-vow");
    const mgr = initThemes(ROOM_EP_CONFIG);
    expect(mgr.current).toBe("rose-vow"); // 畫面真的換了（apply 仍執行，只是 shouldReport=false）
    expect(document.body.dataset.theme).toBe("rose-vow");
    expect(calls.length).toBe(0); // 但零上報——不蓋掉後端的全域值
  });

  it("roomEndpoint 存在＋首開（無 saved）→ 不補報 currentId，零 theme POST", () => {
    const mgr = initThemes(ROOM_EP_CONFIG);
    expect(mgr.current).toBe("default");
    expect(calls.length).toBe(0);
  });

  it("roomEndpoint 不存在（既有 per-device 模式）→ 開機補報行為完全照舊（回歸釘）", () => {
    const EP_CONFIG = { ...CONFIG, themeEndpoint: "/api/v4/theme" }; // 無 roomEndpoint
    initThemes(EP_CONFIG);
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].opts.body)).toEqual({ theme: "default" });
  });

  it("roomEndpoint 存在時，面板點卡路徑（mgr.apply(id) 單參數）不受影響＝照常上報", () => {
    const mgr = initThemes(ROOM_EP_CONFIG);
    calls.length = 0; // 清掉開機（此模式下開機本就零上報，這裡純粹保險）
    mgr.apply("crystal-swan");
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].opts.body)).toEqual({ theme: "crystal-swan" });
  });
});
