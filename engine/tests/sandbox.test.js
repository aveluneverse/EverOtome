import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AdvPresenter } from "../js/adv.js";
import { loadHistory, renderFrame, fetchServerClearLine } from "../js/chat.js";

// 沙盒測試模式 —— app.js 黏合層邏輯：
// sandboxState／showModelOnBrand（暗號）／applySandboxUi／initSandbox／
// setSandbox／sandboxForget／MENU「sandbox_forget」分派／設定面板的
// onSandboxChange 包裝（POST＋status 行＋失敗時畫面回填）。
//
// app.js 本身自執行 main()、無 export，這個專案裡沒有 app.test.js（見
// stream-partial.test.js 檔頭說明，這是既有慣例，已搜過 tests/ 目錄確認）。
// 本檔比照該檔的作法：組一個逐行對齊 app.js 實作的本地 harness，餵真正的
// chat.js／adv.js exports（loadHistory／renderFrame／AdvPresenter 全部是真的、
// 不是替身）——驗證「積木組起來」的行為正確，而不是重新斷言 app.js 原始碼
// 字面一致。app.js 實際內容已另行人工核對過。
//
// SettingsPanel 自己的「測試模式」checkbox（confirm／取消撥回／失敗撥回／
// _refresh）是可以直接 import 的真類別，另外測在 settings.test.js（同檔既有
// 慣例：模型切換區的 radio 也是這樣分工）。
//
// 涵蓋六組斷言：
//   1. config 無 sandboxEndpoint → 全部 UI 不出現（開源殼零成本）
//   2. GET 404 → 同上（flag 未開＝功能不存在）
//   3. GET {"on":true} → body.sandbox-on＋暗號"AI Model"＋忘記暫存項可見
//   4. toggle 開/關（app.js 這一半：POST body／暗號／畫面回填三件事）
//   5. 忘記暫存：確認→POST /forget→畫面清+回填、沙盒維持 on、暗號仍 "AI Model"
//   6. 沙盒 on 時 showModelOnBrand() 恆 "AI Model"（模型切換也不洩真名）
//
// review 發現的兩個要點：
//   A. 忘記暫存成功後缺確認提示——「（沙盒暫存已銷毀）」；已補在
//      dispatchSandboxForget，且必須等 reloadProductionHistory() resolve 完
//      才渲染（同既有的順序坑教訓）。
//   B. 沙盒 UI 的五句提示原本誤用 role:"system"（永久 append 進 scrollback），
//      切換提示要走 transient status 行（被下一個 frame
//      自然蓋掉，畫面／截圖永不殘留）——已全數改回 role:"status"。以下每個
//      斷言除了驗文字內容，也驗「用的是 .status-line 不是 .sys-msg」＋至少
//      兩處額外驗「下一個 frame 抵達就把它取代／清掉」，把機制釘死，不只釘
//      文案。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_URL = "/api/v4/sandbox";
const HISTORY_URL = "/api/history";
const CLEAR_SYNC_URL = "/api/v4/chat-clear";   // 同 app.js 的同名常數
const ctx = { characterName: "Sample", assetsBase: "assets/sample/" };

// engine/config.json 等設定檔存在磁碟上可能帶 UTF-8 BOM（既有檔案特性，
// 非本次改動引入）——瀏覽器真實路徑 fetch().json() 依 WHATWG 規範會自動剝
// BOM，不受影響；Node readFileSync+JSON.parse 不會，這裡補一支小工具剝除，
// 讓契約測試驗的是「鍵存不存在」，不是撞到跟本次改動無關的編碼技術性錯誤。
function readJsonFile(p) {
  let raw = readFileSync(p, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剝 BOM（U+FEFF），見上方註解
  return JSON.parse(raw);
}

beforeEach(() => {
  document.body.className = "";
  document.body.innerHTML = "";
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 逐行對齊 app.js 的沙盒相關函式（見檔頭說明）。DOM 骨架只重現本檔斷言需要
 * 的部分：brand-title span、MENU 內 status／sandbox_forget／new 三顆
 * 按鈕（class／data-cmd／hidden 屬性照真實 index.html cmd-pop 段的形狀）。
 */
function buildSandboxHarness(config = {}) {
  const brandTitleEl = document.createElement("span");
  brandTitleEl.id = "brand-title";
  document.body.appendChild(brandTitleEl);

  const msgsEl = document.createElement("div");
  document.body.appendChild(msgsEl);

  const advContainer = document.createElement("div");
  const adv = new AdvPresenter({ container: advContainer, characterName: "Sample" });

  const thoughtsPaneEl = document.createElement("div");
  document.body.appendChild(thoughtsPaneEl);

  const cmdPop = document.createElement("nav");
  const btnStatus = document.createElement("button");
  btnStatus.dataset.cmd = "status";
  cmdPop.appendChild(btnStatus);
  const btnForget = document.createElement("button");
  btnForget.className = "js-sandbox-forget";
  btnForget.dataset.cmd = "sandbox_forget";
  btnForget.hidden = true; // index.html 預設 hidden（見 index.html cmd-pop 段）
  cmdPop.appendChild(btnForget);
  const btnNew = document.createElement("button");
  btnNew.dataset.cmd = "new";
  cmdPop.appendChild(btnNew);
  document.body.appendChild(cmdPop);

  const modelState = { current: null };
  function modelLabelOf(id) {
    const m = (config.models || []).find((x) => x && x.id === id);
    return m ? m.label : id;
  }

  const sandboxState = { on: false, available: false };
  let serverClearLine = null; // main() 開機 await 到的既有清除線（測試用可覆寫）

  // ── 以下逐行對齊 app.js 的實作（見檔頭說明） ──────────────────────────────
  function showModelOnBrand() {
    if (!brandTitleEl) return;
    if (sandboxState.on) {
      brandTitleEl.textContent = "AI Model";
      return;
    }
    brandTitleEl.textContent = modelState.current
      ? modelLabelOf(modelState.current)
      : config.brandTitle || "";
  }

  function applySandboxUi() {
    document.body.classList.toggle("sandbox-on", sandboxState.on);
    document.querySelectorAll(".js-sandbox-forget").forEach((b) => {
      b.hidden = !sandboxState.on;
    });
    document.querySelectorAll('[data-cmd="new"]').forEach((b) => {
      b.hidden = sandboxState.on;
    });
    showModelOnBrand();
  }

  async function initSandbox() {
    if (!config.sandboxEndpoint) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let data;
      try {
        const res = await fetch(config.sandboxEndpoint, { credentials: "same-origin", signal: ctrl.signal });
        if (!res.ok) return; // 404＝flag 未開＝功能不存在
        data = await res.json();
      } finally {
        clearTimeout(timer);
      }
      sandboxState.available = true;
      sandboxState.on = !!(data && data.on);
      applySandboxUi();
    } catch (e) {
      // 斷網／逾時等：功能靜默不出現。
    }
  }

  async function setSandbox(on) {
    const res = await fetch(config.sandboxEndpoint, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on }),
    });
    if (!res.ok) throw new Error("sandbox switch failed");
    const data = await res.json();
    sandboxState.on = !!data.on;
    applySandboxUi();
  }

  async function sandboxForget() {
    const res = await fetch(config.sandboxEndpoint + "/forget", {
      method: "POST", credentials: "same-origin",
    });
    if (!res.ok) throw new Error("forget failed");
  }

  // clearedAt 取**當下重問到的** server 線（拿不到才落回
  // localStorage），不是開機那顆 `serverClearLine` 快照——在沙盒裡按過「清畫面」
  // 時，那顆 const 永遠停在開機值，沿用它會讓剛被清掉的正式對話整批復活。
  // `serverClearLine` 這個變數刻意留著（app.js 開機回填仍在用它，見 :938／:992），
  // 正是為了讓下面那條迴歸測試釘得住「reload **不可以**讀它」。
  function reloadProductionHistory(loadHistoryFn = loadHistory) {
    msgsEl.replaceChildren();
    adv.present("");
    if (thoughtsPaneEl) thoughtsPaneEl.replaceChildren();
    return fetchServerClearLine(CLEAR_SYNC_URL).then((freshClearLine) =>
      loadHistoryFn(HISTORY_URL, msgsEl, ctx, {
        clearedAt: freshClearLine || localStorage.getItem("v4.chatClearedAt"),
      }),
    );
  }

  // 對齊 SettingsPanel 建構時傳入的 onSandboxChange（app.js 沙盒列那段）。
  // 切換成功一律靜默：原本的 transient status 行在「下一個 frame 抵達前」會
  // 一直停在畫面上，切完模式接著截圖＝那行被拍進截圖裡。左上暗號（模型名／
  // 沙盒代號）本來就分辨得出模式——成功零 status 行＝畫面乾淨，只有失敗才報
  // status 行（操作失敗必須有回饋，否則使用者以為沒按到會連按）。
  function onSandboxChange(on, loadHistoryFn) {
    return setSandbox(on).then(
      async () => {
        if (!on) await reloadProductionHistory(loadHistoryFn);
      },
      (err) => {
        renderFrame({ role: "status", text: "（切換失敗，再試一次）" }, msgsEl, ctx);
        throw err;
      },
    );
  }

  // 對齊 MENU cmd-pop 分派的 sandbox_forget 分支。同機制鐵則：role:"status"。
  // 成功銷毀後有確認提示
  // 「（沙盒暫存已銷毀）」——必須等 reloadProductionHistory() resolve 完才渲染
  // （同上一段的順序鐵則：reload 內部的 replaceChildren() 會沖掉先畫的行）。
  // 實測：server 端 forget 排在途輪後面時零回饋（三連發
  // POST 實錄）——確認當下立刻渲「（沙盒暫存銷毀中）」＋ pending 防重入。
  // 確認窗改自刻 confirmDialog（async）——harness 的 confirmImpl 走
  // Promise.resolve 包裝＝同步假件與 async 真件都吃（app.js 真實碼用
  // confirmDialog，行為對齊見 confirm.test.js）。
  let sandboxForgetPending = false;
  function dispatchSandboxForget(confirmImpl, loadHistoryFn) {
    if (sandboxForgetPending) return Promise.resolve();
    return Promise.resolve(confirmImpl("這段沙盒對話將永遠消失，確定？")).then((ok) => {
      if (!ok || sandboxForgetPending) return;
      sandboxForgetPending = true;
      renderFrame({ role: "status", text: "（沙盒暫存銷毀中）" }, msgsEl, ctx);
      return sandboxForget()
        .then(() => reloadProductionHistory(loadHistoryFn))
        .then(() => {
          renderFrame({ role: "status", text: "（沙盒暫存已銷毀）" }, msgsEl, ctx);
        })
        .catch(() => {
          renderFrame({ role: "status", text: "（銷毀失敗，再試一次）" }, msgsEl, ctx);
        })
        .finally(() => {
          sandboxForgetPending = false;
        });
    });
  }

  // 對齊 app.js onFrame 的 sandbox_state 廣播 case（跨裝置同步）：
  // 另一台裝置按了忘記暫存／切沙盒，server 廣播給所有在線分頁——本分頁切
  // UI＋（forgot 時）清畫面重回填。settingsPanel 用可選注入（app.js 有 null
  // guard 同款）。切換靜默：關沙盒（on:false）不再渲「已回到正式模式」——回填
  // ＋暗號變化本身就是提示；忘記暫存（on:true）的「沙盒暫存已銷毀」是銷毀操
  // 作的回饋、照舊保留。
  function handleSandboxFrame(frame, loadHistoryFn, settingsPanel) {
    const on = !!frame.on;
    sandboxState.on = on;
    applySandboxUi();
    if (settingsPanel && settingsPanel.setSandboxChecked) settingsPanel.setSandboxChecked(on);
    if (frame.forgot) {
      return reloadProductionHistory(loadHistoryFn).then(() => {
        if (on) {
          renderFrame({ role: "status", text: "（沙盒暫存已銷毀）" }, msgsEl, ctx);
        }
      });
    }
    return Promise.resolve();
  }

  return {
    brandTitleEl, msgsEl, adv, thoughtsPaneEl, btnForget, btnNew, btnStatus,
    modelState, sandboxState,
    showModelOnBrand, applySandboxUi, initSandbox, setSandbox, sandboxForget,
    reloadProductionHistory, onSandboxChange, dispatchSandboxForget, handleSandboxFrame,
    setServerClearLine: (v) => { serverClearLine = v; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// config.example.json 契約：開源殼公開樹刻意不給 sandboxEndpoint 這把鑰匙——
// 這是 assertion 1「config 無 sandboxEndpoint」的真實情境來源，鎖死這個裁決。
// ─────────────────────────────────────────────────────────────────────────────
describe("config.example.json 契約 — sandboxEndpoint 鍵", () => {
  it("config.example.json（開源殼公開樹）刻意沒有這個鍵——assertion 1 的真實情境", () => {
    const cfg = readJsonFile(path.join(__dirname, "../config.example.json"));
    expect(cfg.sandboxEndpoint).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertion 1／2：兩道閘門（config 鍵缺席／後端 flag 未開），缺一律視為功能
// 不存在——MENU 忘記暫存項維持 hidden、body 不掛 sandbox-on。
// ─────────────────────────────────────────────────────────────────────────────
describe("沙盒可用性探測 — initSandbox", () => {
  it("config 沒有 sandboxEndpoint 鍵 → 完全不打 fetch，忘記暫存項維持 hidden、available 仍 false", async () => {
    const h = buildSandboxHarness({});
    global.fetch = vi.fn();
    await h.initSandbox();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(h.sandboxState.available).toBe(false);
    expect(h.btnForget.hidden).toBe(true);
    expect(document.body.classList.contains("sandbox-on")).toBe(false);
  });

  it("GET 回 404（有鍵但後端 flag 未開）→ available 仍 false、忘記暫存項維持 hidden", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    global.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    await h.initSandbox();
    expect(global.fetch).toHaveBeenCalledWith(SANDBOX_URL, expect.objectContaining({ credentials: "same-origin" }));
    expect(h.sandboxState.available).toBe(false);
    expect(h.btnForget.hidden).toBe(true);
    expect(document.body.classList.contains("sandbox-on")).toBe(false);
  });

  it("網路錯誤／逾時 → 同樣靜默不出現，initSandbox 不拋錯", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    global.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(h.initSandbox()).resolves.toBeUndefined();
    expect(h.sandboxState.available).toBe(false);
    expect(h.btnForget.hidden).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertion 3：GET 回 {"on":true} → body.sandbox-on 掛上、暗號 "AI Model"、
// 忘記暫存項可見；順帶驗 new 藏起來。
// ─────────────────────────────────────────────────────────────────────────────
describe("沙盒 ON 探測成功", () => {
  it("GET 回 {on:true} → body.sandbox-on＋暗號'AI Model'＋忘記暫存項可見＋new 藏起來", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ on: true }) }));
    await h.initSandbox();
    expect(document.body.classList.contains("sandbox-on")).toBe(true);
    expect(h.brandTitleEl.textContent).toBe("AI Model");
    expect(h.btnForget.hidden).toBe(false);
    expect(h.btnNew.hidden).toBe(true);
    expect(h.sandboxState.available).toBe(true);
  });

  it("GET 回 {on:false}（flag 開但目前沒在測）→ available true，但忘記暫存項仍 hidden、new 仍可見", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ on: false }) }));
    await h.initSandbox();
    expect(document.body.classList.contains("sandbox-on")).toBe(false);
    expect(h.sandboxState.available).toBe(true);
    expect(h.btnForget.hidden).toBe(true);
    expect(h.btnNew.hidden).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertion 4（app.js 那一半）：setSandbox 的 POST body／暗號；onSandboxChange
// 包裝的 status 行與「關」方向的畫面回填。settings.js 自己的 confirm／取消撥回
// ／失敗撥回是另一半，測在 settings.test.js。
// ─────────────────────────────────────────────────────────────────────────────
describe("切換沙盒 — setSandbox／onSandboxChange", () => {
  it("開：POST body {on:true}，成功後暗號亮＝'AI Model'", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ on: true }) }));
    await h.setSandbox(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe(SANDBOX_URL);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ on: true });
    expect(h.brandTitleEl.textContent).toBe("AI Model");
    expect(h.sandboxState.on).toBe(true);
  });

  it("關：POST body {on:false}，成功後暗號恢復模型真名（不是空字串、不是沙盒暗號）", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL, models: [{ id: "opus", label: "Opus 5" }] });
    h.sandboxState.on = true;
    h.modelState.current = "opus";
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ on: false }) }));
    await h.setSandbox(false);
    const [, opts] = global.fetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ on: false });
    expect(h.brandTitleEl.textContent).toBe("Opus 5");
    expect(h.sandboxState.on).toBe(false);
  });

  it("非 2xx → 拋錯，狀態與 UI 皆不變（呼叫端負責撥回視覺，這支不碰 DOM）", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    h.sandboxState.on = false;
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    await expect(h.setSandbox(true)).rejects.toThrow();
    expect(h.sandboxState.on).toBe(false);
    expect(document.body.classList.contains("sandbox-on")).toBe(false);
  });

  it("onSandboxChange(true) 成功：POST 後全靜默——零 status 行（暗號＋body class 就是可見變化），不觸發畫面回填", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ on: true }) }));
    const loadHistorySpy = vi.fn().mockResolvedValue([]);
    await h.onSandboxChange(true, loadHistorySpy);
    // 切換提示連 transient 都不留——status 行在「下一個 frame 抵達前」會一直停
    // 在畫面上，切完模式接著截圖＝那行被拍進去。左上暗號本來就分辨得出模式，
    // 提示歸零。
    expect(h.msgsEl.querySelector(".status-line")).toBeNull();
    expect(h.msgsEl.querySelector(".sys-msg")).toBeNull(); // 機制鐵則照舊：不佔 scrollback
    expect(loadHistorySpy).not.toHaveBeenCalled();
    expect(h.sandboxState.on).toBe(true); // 切換本身要真的生效
    expect(document.body.classList.contains("sandbox-on")).toBe(true);
  });

  it("onSandboxChange(false) 成功：POST＋畫面重回填（loadHistory 被呼叫，帶既有 clearedAt）——回填後零 status 行（切換全靜默）", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    // server 線由 GET /api/v4/chat-clear 當場回答（reload 會
    // 重問一次，不再沿用開機快照）。
    global.fetch = vi.fn(async (url) => {
      if (url === CLEAR_SYNC_URL) {
        return { ok: true, json: async () => ({ cleared_at: "2026-08-08T00:00:00Z" }) };
      }
      return { ok: true, json: async () => ({ on: false }) };
    });
    const loadHistorySpy = vi.fn().mockResolvedValue([]);
    await h.onSandboxChange(false, loadHistorySpy);
    // 關沙盒後的「（已回到正式模式）」是最容易被截圖拍進去的那行——切換提示
    // 歸零，回填後畫面只剩正式對話，截圖永遠乾淨。
    expect(h.msgsEl.querySelector(".status-line")).toBeNull();
    expect(h.msgsEl.querySelector(".sys-msg")).toBeNull(); // 機制鐵則照舊：不佔 scrollback
    expect(loadHistorySpy).toHaveBeenCalledTimes(1);
    const [url, listEl, ctxArg, opts] = loadHistorySpy.mock.calls[0];
    expect(url).toBe(HISTORY_URL);
    expect(listEl).toBe(h.msgsEl);
    expect(ctxArg).toBe(ctx);
    expect(opts).toEqual({ clearedAt: "2026-08-08T00:00:00Z" });
  });

  it("onSandboxChange(false) 成功、沒有既有清除線 → clearedAt 落回 localStorage 的值（同開機那條既有慣例）", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    localStorage.setItem("v4.chatClearedAt", "2026-08-01T00:00:00Z");
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ on: false }) }));
    const loadHistorySpy = vi.fn().mockResolvedValue([]);
    await h.onSandboxChange(false, loadHistorySpy);
    const [, , , opts] = loadHistorySpy.mock.calls[0];
    expect(opts).toEqual({ clearedAt: "2026-08-01T00:00:00Z" });
  });

  // ── 清除線在開機之後才更新 → reload 必須用新值 ───────────────
  it("開機後按過清畫面（清除線已更新）→ reload 用的是**當下重問到的**新線，不是開機快照（否則被清掉的正式對話會整批復活到 F5 為止）", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    // 開機當時的快照：那時還沒清畫面。
    h.setServerClearLine("2026-08-01T00:00:00Z");
    // 之後在沙盒裡按了「清畫面」——clearChatView 只會更新 server 線與
    // localStorage，開機那顆 const 不會跟著動。
    localStorage.setItem("v4.chatClearedAt", "2026-08-09T12:00:00Z");
    global.fetch = vi.fn(async (url) => {
      if (url === CLEAR_SYNC_URL) {
        return { ok: true, json: async () => ({ cleared_at: "2026-08-09T12:00:00Z" }) };
      }
      return { ok: true, json: async () => ({ on: false }) };
    });
    const loadHistorySpy = vi.fn().mockResolvedValue([]);

    await h.onSandboxChange(false, loadHistorySpy);

    const [, , , opts] = loadHistorySpy.mock.calls[0];
    expect(opts).toEqual({ clearedAt: "2026-08-09T12:00:00Z" });
    expect(global.fetch).toHaveBeenCalledWith(CLEAR_SYNC_URL, expect.anything());
  });

  it("重問 server 線失敗／flag 未開（404）→ 落回 localStorage 的**當下值**（仍非開機快照）", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    h.setServerClearLine("2026-08-01T00:00:00Z");           // 開機快照（陳舊）
    localStorage.setItem("v4.chatClearedAt", "2026-08-09T12:00:00Z");
    global.fetch = vi.fn(async (url) => {
      if (url === CLEAR_SYNC_URL) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ on: false }) };
    });
    const loadHistorySpy = vi.fn().mockResolvedValue([]);

    await h.onSandboxChange(false, loadHistorySpy);

    const [, , , opts] = loadHistorySpy.mock.calls[0];
    expect(opts).toEqual({ clearedAt: "2026-08-09T12:00:00Z" });
  });

  it("onSandboxChange 失敗（POST 非 2xx）：transient status 行「（切換失敗，再試一次）」（非永久 system 行），promise 仍 reject（settings.js 靠這個撥回 checkbox）", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    await expect(h.onSandboxChange(true)).rejects.toThrow();
    expect(h.msgsEl.querySelector(".status-line").textContent).toBe("（切換失敗，再試一次）");
    expect(h.msgsEl.querySelector(".sys-msg")).toBeNull(); // 機制鐵則：不可永久佔用 scrollback
  });

  it("關方向 onSandboxChange 真的用真 loadHistory（不注入 spy）：mock /api/history → msgsEl 被實際重新渲染", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    h.msgsEl.appendChild(document.createElement("div")); // 模擬畫面上有殘留內容
    global.fetch = vi.fn(async (url) => {
      if (url === SANDBOX_URL) return { ok: true, json: async () => ({ on: false }) };
      if (url === CLEAR_SYNC_URL) return { ok: true, json: async () => ({ cleared_at: null }) };
      if (url === HISTORY_URL) {
        return {
          ok: true,
          json: async () => ({ entries: [{ ts: "2026-08-08T01:00:00Z", speaker: "Assistant", text: "回來了" }] }),
        };
      }
      throw new Error("unexpected url " + url);
    });
    await h.onSandboxChange(false); // 不傳 loadHistoryFn，走真正的 loadHistory
    expect(h.msgsEl.querySelector(".bubble.reply").textContent).toBe("回來了");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertion 5：忘記暫存——確認→POST /forget→msgs/adv 清＋重回填、沙盒維持 on、
// 暗號仍 "AI Model"。
// ─────────────────────────────────────────────────────────────────────────────
describe("忘記暫存 — dispatchSandboxForget", () => {
  it("confirm 取消 → 不呼叫 forget API", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    global.fetch = vi.fn();
    const confirmNo = vi.fn(() => false);
    await h.dispatchSandboxForget(confirmNo);
    expect(confirmNo).toHaveBeenCalledWith("這段沙盒對話將永遠消失，確定？");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("confirm 確認 → POST /forget 成功 → msgs/adv 清空並重回填、沙盒維持 on、暗號仍 'AI Model'、確認提示「（沙盒暫存已銷毀）」", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL, models: [{ id: "opus", label: "Opus 5" }] });
    h.sandboxState.on = true;
    h.sandboxState.available = true;
    h.modelState.current = "opus";
    h.applySandboxUi(); // 模擬已經在沙盒裡（暗號已經是 "AI Model"）
    expect(h.brandTitleEl.textContent).toBe("AI Model");
    h.msgsEl.appendChild(document.createElement("div")); // 畫面上有殘留的沙盒訊息

    const loadHistorySpy = vi.fn().mockResolvedValue([]);
    global.fetch = vi.fn(async (url, opts) => {
      // reload 會另外 GET 一次 server 清除線——那是第二通。
      if (url === CLEAR_SYNC_URL) return { ok: true, json: async () => ({ cleared_at: null }) };
      expect(url).toBe(SANDBOX_URL + "/forget");
      expect(opts.method).toBe("POST");
      return { ok: true, json: async () => ({ forgotten: true, turns: 3 }) };
    });
    await h.dispatchSandboxForget(() => true, loadHistorySpy);

    expect(global.fetch).toHaveBeenCalledTimes(2); // POST /forget ＋ GET 清除線
    expect(loadHistorySpy).toHaveBeenCalledTimes(1);
    expect(h.sandboxState.on).toBe(true); // 忘記暫存不改變 on/off
    expect(h.brandTitleEl.textContent).toBe("AI Model"); // 暗號沒被動過，仍是沙盒字
    // 成功銷毀後必須有確認提示；機制走
    // transient status 行（同款理由），非永久 system 行。
    expect(h.msgsEl.querySelector(".status-line").textContent).toBe("（沙盒暫存已銷毀）");
    expect(h.msgsEl.querySelector(".sys-msg")).toBeNull();
  });

  it("忘記暫存成功確認行在 reloadProductionHistory resolve 後才渲染（順序鐵則，同 onSandboxChange 順序坑）", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    h.sandboxState.on = true;
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ forgotten: true, turns: 1 }) }));
    const loadHistorySpy = vi.fn(() => {
      // reload 進行中：確認行還不該存在——證明渲染真的排在 reload 之後，不是
      // 「先畫再被 replaceChildren 沖掉」那種順序坑。
      expect(h.msgsEl.querySelector(".status-line")).toBeNull();
      return Promise.resolve([]);
    });
    await h.dispatchSandboxForget(() => true, loadHistorySpy);
    expect(h.msgsEl.querySelector(".status-line").textContent).toBe("（沙盒暫存已銷毀）");
  });

  it("confirm 確認但 POST /forget 失敗 → transient status 行「（銷毀失敗，再試一次）」（非永久 system 行）、不呼叫 loadHistory", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    const loadHistorySpy = vi.fn();
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    await h.dispatchSandboxForget(() => true, loadHistorySpy);
    expect(loadHistorySpy).not.toHaveBeenCalled();
    expect(h.msgsEl.querySelector(".status-line").textContent).toBe("（銷毀失敗，再試一次）");
    expect(h.msgsEl.querySelector(".sys-msg")).toBeNull();
  });

  it("忘記暫存清空的是 msgsEl／ADV／思緒串三處（同 clearChatView 語意，帳本零觸碰只清畫面）", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    h.msgsEl.appendChild(document.createElement("div"));
    h.thoughtsPaneEl.appendChild(document.createElement("div"));
    h.adv.present("殘留的一句話", { instant: true });
    expect(h.adv.textEl.textContent).toBe("殘留的一句話");

    const loadHistorySpy = vi.fn().mockResolvedValue([]);
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ forgotten: true, turns: 1 }) }));
    await h.dispatchSandboxForget(() => true, loadHistorySpy);

    expect(h.thoughtsPaneEl.children.length).toBe(0);
    expect(h.adv.textEl.textContent).toBe("");
  });

  // 實測：forget 在 server 端與對話輪共用同一把序列化鎖、在途輪沒
  // 走完前安靜排隊（可長達一整輪 15-60s）——期間畫面零回饋，容易誤以為沒反應而連按
  // 三發 POST。修＝確認當下立即渲「（沙盒暫存銷毀中）」＋
  // pending 防重入。以下兩測把「立即」與「防重入」都釘死在機制層。
  it("確認後立即渲「（沙盒暫存銷毀中）」——POST 還沒 resolve 前就看得到（排隊零回饋根治）", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    let resolvePost;
    global.fetch = vi.fn((url) => {
      if (url === CLEAR_SYNC_URL) return Promise.resolve({ ok: true, json: async () => ({ cleared_at: null }) });
      return new Promise((res) => { resolvePost = res; }); // POST 懸著＝模擬排隊在途輪後面
    });
    const loadHistorySpy = vi.fn().mockResolvedValue([]);
    const p = h.dispatchSandboxForget(() => true, loadHistorySpy);
    await Promise.resolve(); await Promise.resolve(); // confirm（async 彈窗）resolve 的微任務
    // POST 仍懸著：銷毀中提示已經在畫面上（transient status 行，非永久 system 行）
    expect(h.msgsEl.querySelector(".status-line").textContent).toBe("（沙盒暫存銷毀中）");
    expect(h.msgsEl.querySelector(".sys-msg")).toBeNull();
    resolvePost({ ok: true, json: async () => ({ forgotten: true, turns: 2 }) });
    await p;
    // 完成後被「已銷毀」取代（status 取代制，畫面上永遠只有一條）
    expect(h.msgsEl.querySelectorAll(".status-line").length).toBe(1);
    expect(h.msgsEl.querySelector(".status-line").textContent).toBe("（沙盒暫存已銷毀）");
  });

  it("pending 防重入：POST 在途（排隊中）再點＝不開 confirm 也不疊 POST；完成後歸零可再按", async () => {
    // 註：兩發「同時都還沒過確認窗」的情境由 confirmDialog 單例守門擋（見
    // confirm.test.js「開著時再呼叫＝false」）——這裡測的是 pending 階段
    // （按了確定、POST 排隊在途）的防重入。
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    let resolvePost;
    global.fetch = vi.fn((url) => {
      if (url === CLEAR_SYNC_URL) return Promise.resolve({ ok: true, json: async () => ({ cleared_at: null }) });
      return new Promise((res) => { resolvePost = res; });
    });
    const loadHistorySpy = vi.fn().mockResolvedValue([]);
    const p1 = h.dispatchSandboxForget(() => true, loadHistorySpy);
    await Promise.resolve(); await Promise.resolve(); // 確認窗過、pending=true、POST 懸著
    const confirmSpy = vi.fn(() => true);
    await h.dispatchSandboxForget(confirmSpy, loadHistorySpy); // 排隊期間又點了一次
    expect(confirmSpy).not.toHaveBeenCalled(); // pending 短路在 confirm 之前＝連視窗都不開
    expect(global.fetch.mock.calls.filter(([u]) => String(u).endsWith("/forget")).length).toBe(1);
    resolvePost({ ok: true, json: async () => ({ forgotten: true, turns: 2 }) });
    await p1;
    // 完成後 pending 歸零：再點＝正常開 confirm、再發第二通 POST
    global.fetch = vi.fn(async (url) => {
      if (url === CLEAR_SYNC_URL) return { ok: true, json: async () => ({ cleared_at: null }) };
      return { ok: true, json: async () => ({ forgotten: true, turns: 0 }) };
    });
    const confirmAgain = vi.fn(() => true);
    await h.dispatchSandboxForget(confirmAgain, loadHistorySpy);
    expect(confirmAgain).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertion 6：沙盒 on 時 showModelOnBrand() 恆 "AI Model"（模型切換也不洩真名）。
// ─────────────────────────────────────────────────────────────────────────────
describe("暗號優先序 — showModelOnBrand", () => {
  it("sandboxState.on=true 時，不論 modelState.current 是什麼，brandTitle 恆為 'AI Model'", () => {
    const h = buildSandboxHarness({ models: [{ id: "opus", label: "Opus 5" }, { id: "fable", label: "Fable 5" }] });
    h.sandboxState.on = true;
    h.modelState.current = "opus";
    h.showModelOnBrand();
    expect(h.brandTitleEl.textContent).toBe("AI Model");

    h.modelState.current = "fable"; // 模擬沙盒中切換模型
    h.showModelOnBrand();
    expect(h.brandTitleEl.textContent).toBe("AI Model"); // 仍不洩真名

    h.modelState.current = null; // 連「還沒選模型」的狀態也一樣不洩
    h.showModelOnBrand();
    expect(h.brandTitleEl.textContent).toBe("AI Model");
  });

  it("sandboxState.on=false 時行為不變：顯示模型名或品牌字 fallback（既有行為零改變）", () => {
    const h = buildSandboxHarness({ brandTitle: "EverOtome", models: [{ id: "opus", label: "Opus 5" }] });
    h.showModelOnBrand();
    expect(h.brandTitleEl.textContent).toBe("EverOtome"); // 尚未選模型＝品牌字 fallback
    h.modelState.current = "opus";
    h.showModelOnBrand();
    expect(h.brandTitleEl.textContent).toBe("Opus 5");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 沙盒跨裝置同步（「按一下哪邊的暫存都要忘光光」）：server 對所有
// 在線分頁廣播 {role:"sandbox_state", on, forgot}——本分頁的接收行為。
// ─────────────────────────────────────────────────────────────────────────────
describe("sandbox_state 廣播 — handleSandboxFrame（跨裝置同步）", () => {
  it("另一台按了忘記暫存（on:true, forgot:true）→ 本分頁清畫面重回填＋status 行＋暗號維持沙盒字", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL, models: [{ id: "opus", label: "Opus 5" }] });
    h.sandboxState.on = true;
    h.sandboxState.available = true;
    h.applySandboxUi();
    h.msgsEl.appendChild(document.createElement("div")); // 本分頁畫面殘留的暫存對話
    const loadHistorySpy = vi.fn().mockResolvedValue([]);
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ cleared_at: null }) }));

    await h.handleSandboxFrame({ role: "sandbox_state", on: true, forgot: true }, loadHistorySpy);

    expect(loadHistorySpy).toHaveBeenCalledTimes(1); // 畫面真的重回填
    expect(h.sandboxState.on).toBe(true);            // 沙盒維持 on
    expect(h.brandTitleEl.textContent).toBe("AI Model");
    expect(h.msgsEl.querySelector(".status-line").textContent).toBe("（沙盒暫存已銷毀）");
    expect(h.msgsEl.querySelector(".sys-msg")).toBeNull(); // 機制鐵則照舊
  });

  it("另一台關了沙盒（on:false, forgot:true）→ 本分頁回正式（暗號回真名＋回填＋零 status 行）＋settings toggle 同步", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL, models: [{ id: "opus", label: "Opus 5" }] });
    h.sandboxState.on = true;
    h.modelState.current = "opus";
    h.applySandboxUi();
    const loadHistorySpy = vi.fn().mockResolvedValue([]);
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ cleared_at: null }) }));
    const fakeSettings = { setSandboxChecked: vi.fn() };

    await h.handleSandboxFrame({ role: "sandbox_state", on: false, forgot: true }, loadHistorySpy, fakeSettings);

    expect(h.sandboxState.on).toBe(false);
    expect(h.brandTitleEl.textContent).toBe("Opus 5"); // 暗號回真名
    expect(fakeSettings.setSandboxChecked).toHaveBeenCalledWith(false);
    expect(loadHistorySpy).toHaveBeenCalledTimes(1); // 回填仍要發生（畫面回正式歷史）
    // 切換全靜默：模式切換不再渲任何 status 行（忘記暫存那句銷毀回饋是操作回
    // 饋、另一條測試保留照舊）——回填＋暗號變化本身就是提示。
    expect(h.msgsEl.querySelector(".status-line")).toBeNull();
  });

  it("另一台開了沙盒（on:true, forgot:false）→ 只切 UI，畫面不動（1.43 開沙盒不清畫面設計）", async () => {
    const h = buildSandboxHarness({ sandboxEndpoint: SANDBOX_URL });
    h.sandboxState.available = true;
    const residue = document.createElement("div");
    h.msgsEl.appendChild(residue);
    const loadHistorySpy = vi.fn();

    await h.handleSandboxFrame({ role: "sandbox_state", on: true, forgot: false }, loadHistorySpy);

    expect(loadHistorySpy).not.toHaveBeenCalled();      // 不回填
    expect(h.msgsEl.contains(residue)).toBe(true);      // 畫面原封
    expect(h.sandboxState.on).toBe(true);
    expect(h.brandTitleEl.textContent).toBe("AI Model"); // 暗號切了
  });
});
