// cg-manage.test.js —— CG 相冊管理態（上傳／編輯／刪除／排序／開場景；雙軌制：
// 分組 TAB＋「<」返回鍵）。視圖態既有覆蓋在 cg-panel.test.js／cg.test.js，本檔
// 只管管理態的行為；desc 外洩防線是本檔的核心斷言（見各測試內註解）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildCgPanel } from "../js/cg.js";
import { setLocale } from "../js/i18n.js";

// fetch stub：靜態路由表，key = "METHOD url"。
function fetchStub(routes) {
  return vi.fn(async (url, opts = {}) => {
    const key = `${(opts.method || "GET").toUpperCase()} ${url}`;
    const hit = routes[key];
    if (!hit) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => hit };
  });
}

// 部分測試（reorder／上傳成功後重繪）需要 GET /manage 在不同次呼叫回不同內容
// ——靜態路由表做不到，這裡改用「照呼叫序取下一筆」的簡易假伺服器；POST
// /manage 一律回 ok（除非 postOk 覆寫）。
function sequencedManageFetch(getSequence, { postOk = true, postStatus = 200 } = {}) {
  let getIdx = 0;
  return vi.fn(async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    if (method === "GET" && url.endsWith("/manage")) {
      const items = getSequence[Math.min(getIdx, getSequence.length - 1)];
      getIdx += 1;
      return { ok: true, status: 200, json: async () => ({ items }) };
    }
    if (method === "POST" && url.endsWith("/manage")) {
      return { ok: postOk, status: postStatus, json: async () => ({ ok: postOk }) };
    }
    return { ok: false, status: 404 };
  });
}

/** 巨集任務 flush：等所有目前排隊的微任務鏈（fetch→json→重繪）跑完，不用
 * 手數 await Promise.resolve() 的次數（多層 async 呼叫鏈很容易數錯）。 */
function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

// 雙軌制：items 每張帶 target "desktop"|"mobile"（backend 契約；舊 mobile
// bool 鍵與 set_mobile op 一併退役）。預設 desktop——jsdom 無 matchMedia＝視圖
// 態走桌機分支＝列 desktop 組，管理態預設 TAB 也是桌機。
function mkItem(id, name, extra = {}) {
  return { id, name, desc: "", file: id + ".png", opening: false, target: "desktop", order: 0, ...extra };
}

function makePresenter(items) {
  return {
    items: items || [{ id: "cg-1", name: "月夜床帳", file: "a.png", opening: true, target: "desktop" }],
    fileUrl: (id) => `/api/v4/cg/file/${id}`,
    isActive: () => false,
    _currentId: null,
    init: vi.fn(async () => true),
  };
}

describe("CG 管理態", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="cg-root"></div>';
  });

  // endpointBase 缺席時完全不建立
  // `.cg-manage-btn`／`.cg-sheet-head`——不是「建了但 hidden」。原本 bug＝
  // 不論 hasManage 都包一層 `.cg-sheet-head`，layout.css 的
  // `.cg-sheet-head .settings-heading{margin:0}` 因此永遠生效，蓋掉
  // `.settings-heading` 原本的下間距，即使齒輪本身看不見，視圖態的 heading
  // 間距已經悄悄跟原本的視圖態不一樣了。這裡直接斷言兩顆元素都不存在（不是
  // 存在但 hidden），並確認 heading 直接掛在 `.cg-sheet` 下——這就是
  // `.cg-sheet-head .settings-heading` 選擇器物理上不可能命中的結構性保證。
  it("endpointBase 缺席＝完全不建立 .cg-sheet-head／.cg-manage-btn，視圖態 DOM 跟原本一致、無 desc 節點", () => {
    const presenter = makePresenter();
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, { send: () => true });
    panel.open();
    expect(document.querySelector(".cg-manage-btn")).toBe(null);
    expect(document.querySelector(".cg-sheet-head")).toBe(null);
    const heading = document.querySelector(".settings-heading");
    expect(heading.parentElement).toBe(document.querySelector(".cg-sheet")); // 直接掛在 sheet 下，同原本視圖態
    expect(document.querySelector(".cg-manage-desc")).toBe(null);
    expect(document.querySelectorAll(".cg-card").length).toBe(1); // 視圖態行為原封不動
  });

  it("endpointBase 給了＝建立 .cg-sheet-head＋齒輪可見；進管理態前仍是純視圖態、無 desc", () => {
    const presenter = makePresenter();
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => true, endpointBase: "/api/v4/cg",
    });
    panel.open();
    const gear = document.querySelector(".cg-manage-btn");
    expect(gear).not.toBe(null);
    expect(gear.hidden).toBe(false);
    expect(gear.parentElement).toBe(document.querySelector(".cg-sheet-head"));
    expect(document.querySelector(".cg-manage-desc")).toBe(null);
  });

  it("視圖態無 desc；進管理態才 fetch manage 並顯示 desc；儲存打 edit op", async () => {
    const presenter = makePresenter();
    global.fetch = fetchStub({
      "GET /api/v4/cg/manage": { items: [{ id: "cg-1", name: "月夜床帳", desc: "害羞鑰匙", file: "a.png", opening: true, target: "desktop", order: 0 }] },
      "POST /api/v4/cg/manage": { ok: true },
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    expect(document.body.textContent).not.toContain("害羞鑰匙"); // 視圖態硬保證
    await panel.enterManage();
    const desc = document.querySelector(".cg-manage-desc");
    expect(desc.value).toBe("害羞鑰匙");
    desc.value = "新的鑰匙";
    document.querySelector(".cg-manage-save").click();
    await Promise.resolve();
    const call = global.fetch.mock.calls.find(
      ([u, o]) => u === "/api/v4/cg/manage" && (o || {}).method === "POST");
    expect(JSON.parse(call[1].body)).toMatchObject({ op: "edit", id: "cg-1", desc: "新的鑰匙" });
  });

  it("齒輪鈕點擊即走 enterManage（DOM 接線本身要動，不能只有匯出函式能動）", async () => {
    const presenter = makePresenter();
    global.fetch = fetchStub({
      "GET /api/v4/cg/manage": { items: [{ id: "cg-1", name: "月夜床帳", desc: "藏在心裡", file: "a.png", opening: true, target: "desktop", order: 0 }] },
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    document.querySelector(".cg-manage-btn").click();
    await flush();
    expect(document.querySelector(".cg-manage-desc").value).toBe("藏在心裡");

    // 再點一次（管理態中）＝走 exitManage，回視圖態、desc 節點清掉。
    document.querySelector(".cg-manage-btn").click();
    await flush();
    expect(document.querySelector(".cg-manage-desc")).toBe(null);
    expect(presenter.init).toHaveBeenCalled();
  });

  // switching 防重入。兩下連點（第二下在第一下
  // 的 fetch 還沒 resolve 前就發生，同一個 tick 內連續 click）不能賽出兩個
  // 併發 GET /manage——同 app.js 外觀面板既有 switching 慣例的驗證方式。
  it("齒輪連點兩下（換態進行中）只送一次 manage fetch（switching 防重入）", async () => {
    const presenter = makePresenter();
    global.fetch = fetchStub({
      "GET /api/v4/cg/manage": { items: [mkItem("cg-1", "第一張", { opening: true })] },
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    const gear = document.querySelector(".cg-manage-btn");
    gear.click();
    gear.click(); // 換態進行中（switching===true）——這下應該被吞掉，不送第二個 fetch
    await flush();
    const getCalls = global.fetch.mock.calls.filter(([u]) => u === "/api/v4/cg/manage");
    expect(getCalls.length).toBe(1);
    expect(document.querySelector(".cg-manage-desc")).not.toBe(null); // 第一下確實成功進了管理態
  });

  it("enterManage 讀取失敗＝留在視圖態＋沿用 cg-send-hint 誠實提示", async () => {
    const presenter = makePresenter();
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    expect(document.querySelector(".cg-manage-desc")).toBe(null);
    expect(document.querySelectorAll(".cg-card").length).toBe(1); // 仍是視圖態卡片
    expect(document.querySelector(".cg-send-hint").textContent).toContain("讀取沒有成功");
  });

  it("刪除就地二段確認：一下武裝、逾時自動解除、逾時後沒有送出刪除", async () => {
    vi.useFakeTimers();
    try {
      const presenter = makePresenter();
      global.fetch = fetchStub({
        "GET /api/v4/cg/manage": { items: [
          mkItem("cg-1", "第一張", { opening: true }),
          mkItem("cg-2", "第二張"),
        ] },
        "POST /api/v4/cg/manage": { ok: true },
      });
      const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
        send: () => {}, endpointBase: "/api/v4/cg",
      });
      panel.open();
      await panel.enterManage();
      const delBtn = document.querySelectorAll(".cg-manage-delete")[0];

      delBtn.click(); // 第一下：武裝
      expect(delBtn.textContent).toBe("確定刪除？");
      expect(delBtn.classList.contains("is-armed")).toBe(true);
      expect(global.fetch.mock.calls.some(([, o]) => (o || {}).method === "POST")).toBe(false);

      vi.advanceTimersByTime(4000); // 逾時解除，不送刪除
      expect(delBtn.textContent).toBe("刪除");
      expect(delBtn.classList.contains("is-armed")).toBe(false);
      expect(global.fetch.mock.calls.some(([, o]) => (o || {}).method === "POST")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("刪除就地二段確認：武裝中再按同一顆才真的送 delete", async () => {
    const presenter = makePresenter();
    global.fetch = fetchStub({
      "GET /api/v4/cg/manage": { items: [mkItem("cg-1", "第一張", { opening: true })] },
      "POST /api/v4/cg/manage": { ok: true },
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const delBtn = document.querySelector(".cg-manage-delete");
    delBtn.click(); // 武裝
    delBtn.click(); // 武裝中再按＝確認
    const call = global.fetch.mock.calls.find(
      ([u, o]) => u === "/api/v4/cg/manage" && (o || {}).method === "POST");
    expect(JSON.parse(call[1].body)).toMatchObject({ op: "delete", id: "cg-1" });
  });

  it("武裝中點別的地方（非該刪除鈕）＝解除武裝，不誤觸發刪除", async () => {
    const presenter = makePresenter();
    global.fetch = fetchStub({
      "GET /api/v4/cg/manage": { items: [mkItem("cg-1", "第一張", { opening: true })] },
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const delBtn = document.querySelector(".cg-manage-delete");
    delBtn.click();
    expect(delBtn.classList.contains("is-armed")).toBe(true);

    document.querySelector(".cg-manage-name").click(); // 點別的欄位
    expect(delBtn.classList.contains("is-armed")).toBe(false);
    expect(delBtn.textContent).toBe("刪除");
    expect(global.fetch.mock.calls.some(([, o]) => (o || {}).method === "POST")).toBe(false);
  });

  it("↑／↓ 送 reorder op；成功後重新 fetch manage list 並依新順序重繪", async () => {
    const presenter = makePresenter();
    global.fetch = sequencedManageFetch([
      [mkItem("cg-1", "第一張", { opening: true }), mkItem("cg-2", "第二張")],
      [mkItem("cg-2", "第二張"), mkItem("cg-1", "第一張", { opening: true })],
    ]);
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const upBtns = document.querySelectorAll(".cg-manage-up");
    upBtns[1].click(); // 對第二張按上移

    const call = global.fetch.mock.calls.find(
      ([u, o]) => u === "/api/v4/cg/manage" && (o || {}).method === "POST");
    expect(JSON.parse(call[1].body)).toMatchObject({ op: "reorder", id: "cg-2", direction: "up" });

    await flush();
    const names = Array.from(document.querySelectorAll(".cg-manage-name")).map((i) => i.value);
    expect(names).toEqual(["第二張", "第一張"]); // 依重新 fetch 回來的新順序重繪

    const getCalls = global.fetch.mock.calls.filter(([u, o]) => u === "/api/v4/cg/manage" && (o || {}).method !== "POST");
    expect(getCalls.length).toBe(2); // enterManage 一次＋reorder 成功後再一次
  });

  it("↑↓ 在列首排序欄——.cg-manage-reorder＝卡片第一個子元素、動作欄只剩儲存/刪除", async () => {
    const presenter = makePresenter();
    global.fetch = fetchStub({
      "GET /api/v4/cg/manage": { items: [mkItem("cg-1", "第一張", { opening: true })] },
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const card = document.querySelector(".cg-manage-card");
    const first = card.firstElementChild;
    expect(first.className).toBe("cg-manage-reorder");
    expect(first.querySelector(".cg-manage-up")).not.toBeNull();
    expect(first.querySelector(".cg-manage-down")).not.toBeNull();
    const actions = card.querySelector(".cg-manage-actions");
    expect(actions.querySelector(".cg-manage-up")).toBeNull(); // 不再擠在儲存/刪除那欄
    expect(actions.querySelector(".cg-manage-save")).not.toBeNull();
    expect(actions.querySelector(".cg-manage-delete")).not.toBeNull();
  });

  it("開場景打 set_opening op；aria-pressed 反映當下資料、aria-label 帶組語意；「手機張」鈕已拆除（set_mobile 退役）", async () => {
    const presenter = makePresenter();
    global.fetch = fetchStub({
      "GET /api/v4/cg/manage": { items: [mkItem("cg-1", "第一張", { opening: true })] },
      "POST /api/v4/cg/manage": { ok: true },
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const openingBtn = document.querySelector(".cg-flag-opening");
    expect(openingBtn.getAttribute("aria-pressed")).toBe("true");
    // 組語意（雙軌制）：backend 對 set_opening 做同 target 組內 radio——
    // label 講明 radio 範圍。
    expect(openingBtn.getAttribute("aria-label")).toBe("設「第一張」為開場景（桌機組）");
    // set_mobile op 已退役（backend 送了回 400）——「手機張」flag 鈕物理上不存在，
    // 不是「存在但藏起來」。
    expect(document.querySelector(".cg-flag-mobile")).toBe(null);

    openingBtn.click();
    const call = global.fetch.mock.calls.find(
      ([u, o]) => u === "/api/v4/cg/manage" && (o || {}).method === "POST");
    expect(JSON.parse(call[1].body)).toMatchObject({ op: "set_opening", id: "cg-1" });
  });

  // radio 語意——set_opening 對 B 成功後，重新
  // fetch 回來的清單裡 A 的 opening 已經是 false（server 端 unset others）；
  // 重繪必須忠實反映：A 的開場景鈕 aria-pressed 落
  // false、B 落 true，兩張卡互斥、不是各自為政。用跟 reorder 測試同一支
  // sequencedManageFetch（GET 分兩輪回不同內容）。
  it("set_opening 對 B 成功後重新 fetch：A 的開場景鈕變 false、B 變 true（雙卡對照，radio 語意）", async () => {
    const presenter = makePresenter();
    global.fetch = sequencedManageFetch([
      [mkItem("cg-1", "A", { opening: true }), mkItem("cg-2", "B", { opening: false })],
      [mkItem("cg-1", "A", { opening: false }), mkItem("cg-2", "B", { opening: true })],
    ]);
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const openingBtnsBefore = document.querySelectorAll(".cg-flag-opening");
    expect(openingBtnsBefore[0].getAttribute("aria-pressed")).toBe("true");
    expect(openingBtnsBefore[1].getAttribute("aria-pressed")).toBe("false");

    openingBtnsBefore[1].click(); // 對 B 按「開場景」
    const call = global.fetch.mock.calls.find(
      ([u, o]) => u === "/api/v4/cg/manage" && (o || {}).method === "POST");
    expect(JSON.parse(call[1].body)).toMatchObject({ op: "set_opening", id: "cg-2" });

    await flush();
    const openingBtnsAfter = document.querySelectorAll(".cg-flag-opening");
    expect(openingBtnsAfter[0].getAttribute("aria-pressed")).toBe("false"); // A 卸下
    expect(openingBtnsAfter[1].getAttribute("aria-pressed")).toBe("true");  // B 頂上
  });

  it("上傳：格式不符（400）誠實提示，不清欄位、不動既有清單", async () => {
    const presenter = makePresenter();
    global.fetch = vi.fn(async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (method === "GET" && url.endsWith("/manage")) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      if (method === "POST" && url.endsWith("/upload")) return { ok: false, status: 400 };
      return { ok: false, status: 404 };
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const fileInput = document.querySelector(".cg-manage-upload-file");
    const file = new File([new Uint8Array(4)], "bad.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    document.querySelector(".cg-manage-upload-name").value = "新場景";
    document.querySelector(".cg-manage-upload-btn").click();
    await flush();
    expect(document.querySelector(".cg-send-hint").textContent).toBe("（只收 png / jpg / webp）");
    expect(document.querySelector(".cg-manage-upload-name").value).toBe("新場景"); // 失敗不清欄位
  });

  it("自刻選檔鈕（原生鈕吃不到主題 CSS）：label 隱式關聯包 sr-only 原生 input、選檔後檔名上屏", async () => {
    const presenter = makePresenter();
    global.fetch = vi.fn(async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (method === "GET" && url.endsWith("/manage")) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      return { ok: false, status: 404 };
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const pick = document.querySelector(".cg-manage-upload-pick");
    expect(pick).not.toBeNull();
    expect(pick.tagName).toBe("LABEL"); // 隱式關聯＝點 label 原生轉發開選擇器（1.7 設定開關同課，不用 JS click 合成）
    const fileInput = pick.querySelector(".cg-manage-upload-file");
    expect(fileInput).not.toBeNull(); // 原生 input 收在 label 內（sr-only 藏法，功能與 tab 序都在）
    expect(fileInput.type).toBe("file");
    expect(pick.querySelector(".cg-manage-upload-pick-text").textContent).toBe("選擇圖片");
    // 選檔 → 檔名上屏（原生鈕的「未選擇任何檔案」資訊不因自刻而丟失）
    const nameEl = document.querySelector(".cg-manage-upload-pick-name");
    expect(nameEl.textContent).toBe("（未選擇）");
    const file = new File([new Uint8Array(4)], "shiny.webp", { type: "image/webp" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    expect(nameEl.textContent).toBe("shiny.webp");
  });

  it("上傳：檔案過大（413）誠實提示", async () => {
    const presenter = makePresenter();
    global.fetch = vi.fn(async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (method === "GET" && url.endsWith("/manage")) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      if (method === "POST" && url.endsWith("/upload")) return { ok: false, status: 413 };
      return { ok: false, status: 404 };
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const fileInput = document.querySelector(".cg-manage-upload-file");
    const file = new File([new Uint8Array(4)], "huge.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    document.querySelector(".cg-manage-upload-btn").click();
    await flush();
    expect(document.querySelector(".cg-send-hint").textContent).toBe("（檔案超過 20MB）");
  });

  it("上傳：其他失敗（斷網／5xx）誠實提示「稍後再試一次」", async () => {
    const presenter = makePresenter();
    global.fetch = vi.fn(async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (method === "GET" && url.endsWith("/manage")) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      if (method === "POST" && url.endsWith("/upload")) throw new TypeError("network down");
      return { ok: false, status: 404 };
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const fileInput = document.querySelector(".cg-manage-upload-file");
    const file = new File([new Uint8Array(4)], "ok.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    document.querySelector(".cg-manage-upload-btn").click();
    await flush();
    expect(document.querySelector(".cg-send-hint").textContent).toBe("（上傳沒有成功，稍後再試一次）");
  });

  it("上傳：沒選檔案就按上傳＝誠實提示，完全不打 fetch", async () => {
    const presenter = makePresenter();
    global.fetch = fetchStub({
      "GET /api/v4/cg/manage": { items: [] },
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const callsBefore = global.fetch.mock.calls.length;
    document.querySelector(".cg-manage-upload-btn").click();
    await flush();
    expect(document.querySelector(".cg-send-hint").textContent).toBe("（請先選一張圖片）");
    expect(global.fetch.mock.calls.length).toBe(callsBefore);
  });

  it("上傳成功：FormData 帶 file/name/desc（同源憑證），成功後整團重繪＝欄位天然清空", async () => {
    const presenter = makePresenter();
    let uploadCall = null;
    global.fetch = vi.fn(async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      if (method === "GET" && url.endsWith("/manage")) return { ok: true, status: 200, json: async () => ({ items: [mkItem("cg-9", "新場景")] }) };
      if (method === "POST" && url.endsWith("/upload")) {
        uploadCall = opts;
        return { ok: true, status: 200, json: async () => ({ item: { id: "cg-9", name: "新場景", file: "cg-9.png", opening: false, target: "desktop" } }) };
      }
      return { ok: false, status: 404 };
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const fileInput = document.querySelector(".cg-manage-upload-file");
    const file = new File([new Uint8Array(4)], "new.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    document.querySelector(".cg-manage-upload-name").value = "新場景";
    document.querySelector(".cg-manage-upload-desc").value = "新描述";
    document.querySelector(".cg-manage-upload-btn").click();
    await flush();

    expect(uploadCall.method).toBe("POST");
    expect(uploadCall.credentials).toBe("same-origin");
    expect(uploadCall.body).toBeInstanceOf(FormData);
    // jsdom 的 FormData.get() 對 File 值回傳的物件跟原始 append 進去的不是同一個
    // 參照（序列化內容相同，Object.is 不相同）——同 photo-upload.test.js 既有
    // 慣例，改核對 .name 而非物件本身。
    expect(uploadCall.body.get("file").name).toBe("new.png");
    expect(uploadCall.body.get("name")).toBe("新場景");
    expect(uploadCall.body.get("desc")).toBe("新描述");
    expect(uploadCall.body.get("target")).toBe("desktop"); // 預設 TAB＝桌機組（雙軌制）
    // 成功後 refreshManage() 整團重繪：上傳列被重建＝欄位天然清空，清單也反映新項目。
    expect(document.querySelector(".cg-manage-upload-name").value).toBe("");
    expect(document.querySelector(".cg-manage-name").value).toBe("新場景");
  });

  it("exitManage：await presenter.init() 後回視圖態，desc 節點從 DOM 完全移除", async () => {
    const presenter = makePresenter();
    global.fetch = fetchStub({
      "GET /api/v4/cg/manage": { items: [{ id: "cg-1", name: "月夜床帳", desc: "只有管理態看得到", file: "a.png", opening: true, target: "desktop", order: 0 }] },
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    expect(document.querySelector(".cg-manage-desc")).not.toBe(null);

    await panel.exitManage();
    // 2 次＝open() 背景重抓＋exitManage 的 await 重抓
    expect(presenter.init).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".cg-manage-desc")).toBe(null);
    expect(document.body.textContent).not.toContain("只有管理態看得到");
    expect(document.querySelectorAll(".cg-card").length).toBe(presenter.items.length); // 回到視圖態卡片
  });

  it("open() 一律強制回視圖態——即使上次是在管理態被點暗幕關掉", async () => {
    const presenter = makePresenter();
    global.fetch = fetchStub({
      "GET /api/v4/cg/manage": { items: [{ id: "cg-1", name: "月夜床帳", desc: "上一輪管理態的殘留", file: "a.png", opening: true, target: "desktop", order: 0 }] },
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    expect(document.querySelector(".cg-manage-desc")).not.toBe(null);

    panel.el.click(); // 點暗幕直接關（沒有先走 exitManage）
    panel.open();      // 重開
    expect(document.querySelector(".cg-manage-desc")).toBe(null);
    expect(document.querySelectorAll(".cg-card").length).toBe(1);
  });

  // ── open() 背景重抓相冊 ────────────────────────────────────────────────────
  // 已知洞：管理態排序／刪除 → 點暗幕直接關（不走「<」的 exitManage）→ 重開
  // → 相冊還停在頁面載入時的舊快照（舊順序、已刪的還在）。exitManage 有
  // re-fetch、open() 沒有——修法＝open() 先用手上資料即時重繪（不等網路），再
  // 背景 presenter.init() 落地後以 server 新真相重繪一次。
  it("管理態改完點暗幕關掉再重開：open() 背景重抓相冊，排序／刪除以 server 新真相重繪", async () => {
    const albumBefore = [
      { id: "cg-a", name: "甲", file: "a.png", opening: true, target: "desktop" },
      { id: "cg-b", name: "乙", file: "b.png", opening: false, target: "desktop" },
      { id: "cg-c", name: "丙", file: "c.png", opening: false, target: "desktop" },
    ];
    // server 端已發生：乙移到最前＋丙被刪除
    const albumAfter = [albumBefore[1], albumBefore[0]];
    const presenter = makePresenter(albumBefore.slice());
    // deferred mock：resolve 前不碰 items——「新順序上屏」只能來自背景落地後
    // 的重繪，不能是 open() 既有的同步重繪撿到被同步污染的 items（async 函式
    // 體無 await＝呼叫瞬間同步跑完，那種寫法測不到重繪機制本身）。
    let resolveInit = null;
    presenter.init = vi.fn(() => new Promise((r) => {
      resolveInit = () => { presenter.items = albumAfter; r(true); };
    }));
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();
    panel.el.click(); // 點暗幕直接關（沒走 exitManage）
    panel.open();      // 重開
    const namesOf = () => Array.from(document.querySelectorAll(".cg-card-name")).map((n) => n.textContent);
    expect(namesOf()).toEqual(["甲", "乙", "丙"]); // 背景還沒落地＝先畫手上的舊資料，開面板不等網路
    resolveInit();     // 背景 re-fetch 落地
    await flush();
    expect(namesOf()).toEqual(["乙", "甲"]); // 落地後以 server 新真相重繪：新順序＋丙已消失
    expect(presenter.init).toHaveBeenCalled();
  });

  it("open() 背景重抓落地時已在管理態＝不覆蓋管理畫面（mode guard）", async () => {
    const presenter = makePresenter();
    let resolveInit = null;
    presenter.init = vi.fn(() => new Promise((r) => { resolveInit = () => r(true); }));
    global.fetch = fetchStub({
      "GET /api/v4/cg/manage": { items: [mkItem("cg-1", "月夜床帳", { opening: true })] },
    });
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => {}, endpointBase: "/api/v4/cg",
    });
    panel.open();               // 背景 init 掛起中
    await panel.enterManage();  // 背景 re-fetch 還沒回來就先進了管理態
    resolveInit();              // 這時背景 re-fetch 才落地
    await flush();
    expect(document.querySelector(".cg-manage-card")).not.toBe(null); // 管理畫面還在
    expect(document.querySelector(".cg-card")).toBe(null);            // 沒被視圖態蓋掉
  });

  // ── 管理操作按鈕回饋 ──────────────────────────────────────────────────────
  // server-confirm 設計（POST＋GET 兩趟往返）下按鈕零回饋，部署遠端時看起來
  // 像按了沒反應。觸發鈕 disabled＋is-busy＋aria-busy 直到操作結束；資料流
  // 不動（不做樂觀 UI）。附帶單飛（opBusy）：一次一單，busy 中點其他操作鈕
  // 忽略——防兩單併發賽出交錯的 refreshManage。
  describe("管理操作按鈕回饋", () => {
    // POST 可手動放行的假伺服器：驗「進行中」的按鈕態需要卡住 POST 不讓它秒回。
    function deferredPostFetch(items) {
      let resolvePost = null;
      const fn = vi.fn(async (url, opts = {}) => {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET" && url.endsWith("/manage")) {
          return { ok: true, status: 200, json: async () => ({ items }) };
        }
        if (method === "POST" && url.endsWith("/manage")) {
          return new Promise((r) => {
            resolvePost = () => r({ ok: true, status: 200, json: async () => ({ ok: true }) });
          });
        }
        return { ok: false, status: 404 };
      });
      return { fn, resolve: () => resolvePost && resolvePost() };
    }

    async function openManageWith(fetchImpl) {
      const presenter = makePresenter();
      global.fetch = fetchImpl;
      const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
        send: () => {}, endpointBase: "/api/v4/cg",
      });
      panel.open();
      await panel.enterManage();
      return panel;
    }

    it("排序進行中：觸發鈕 disabled＋is-busy＋aria-busy；成功後整團重繪、新鈕復原", async () => {
      const d = deferredPostFetch([mkItem("cg-1", "月夜床帳", { opening: true }), mkItem("cg-2", "窗邊", { order: 1 })]);
      await openManageWith(d.fn);
      const downBtn = document.querySelectorAll(".cg-manage-down")[0];
      downBtn.click();
      expect(downBtn.disabled).toBe(true);
      expect(downBtn.classList.contains("is-busy")).toBe(true);
      expect(downBtn.getAttribute("aria-busy")).toBe("true");
      d.resolve();
      await flush();
      const fresh = document.querySelectorAll(".cg-manage-down")[0];
      expect(fresh.disabled).toBe(false);
      expect(fresh.classList.contains("is-busy")).toBe(false);
    });

    it("操作單飛：busy 中點其他操作鈕＝忽略，整輪只發一單 POST", async () => {
      const d = deferredPostFetch([mkItem("cg-1", "月夜床帳", { opening: true }), mkItem("cg-2", "窗邊", { order: 1 })]);
      await openManageWith(d.fn);
      document.querySelectorAll(".cg-manage-down")[0].click();
      document.querySelectorAll(".cg-manage-up")[1].click();     // busy 中＝忽略
      document.querySelector(".cg-flag-opening").click();         // busy 中＝忽略
      const postCalls = d.fn.mock.calls.filter(([, o]) => o && o.method === "POST");
      expect(postCalls.length).toBe(1);
      d.resolve();
      await flush();
    });

    it("操作失敗：同一顆鈕復原 enabled、is-busy／aria-busy 移除＋誠實提示", async () => {
      await openManageWith(sequencedManageFetch(
        [[mkItem("cg-1", "月夜床帳", { opening: true }), mkItem("cg-2", "窗邊", { order: 1 })]],
        { postOk: false, postStatus: 500 },
      ));
      const downBtn = document.querySelectorAll(".cg-manage-down")[0];
      downBtn.click();
      await flush();
      expect(downBtn.disabled).toBe(false);            // 失敗不重繪＝還是同一節點
      expect(downBtn.classList.contains("is-busy")).toBe(false);
      expect(downBtn.getAttribute("aria-busy")).toBe(null);
      expect(document.querySelector(".cg-send-hint").textContent).not.toBe("");
    });

    it("上傳進行中：上傳鈕 disabled＋is-busy；成功後整列重建復原", async () => {
      let resolveUpload = null;
      const items = [mkItem("cg-1", "月夜床帳", { opening: true })];
      const fetchImpl = vi.fn(async (url, opts = {}) => {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET" && url.endsWith("/manage")) {
          return { ok: true, status: 200, json: async () => ({ items }) };
        }
        if (method === "POST" && url.endsWith("/upload")) {
          return new Promise((r) => {
            resolveUpload = () => r({ ok: true, status: 200, json: async () => ({ ok: true }) });
          });
        }
        return { ok: false, status: 404 };
      });
      await openManageWith(fetchImpl);
      const fileInput = document.querySelector(".cg-manage-upload-file");
      const file = new File([new Uint8Array(4)], "m.png", { type: "image/png" });
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      const uploadBtn = document.querySelector(".cg-manage-upload-btn");
      uploadBtn.click();
      await Promise.resolve(); // 讓 handler 走進 fetch await
      expect(uploadBtn.disabled).toBe(true);
      expect(uploadBtn.classList.contains("is-busy")).toBe(true);
      resolveUpload();
      await flush();
      const fresh = document.querySelector(".cg-manage-upload-btn");
      expect(fresh.disabled).toBe(false);
      expect(fresh.classList.contains("is-busy")).toBe(false);
    });

    it("操作進行中按「<」回視圖態：落地的 refreshManage 不把畫面蓋回管理態（mode guard）", async () => {
      const d = deferredPostFetch([mkItem("cg-1", "月夜床帳", { opening: true })]);
      const panel = await openManageWith(d.fn);
      document.querySelector(".cg-manage-down").click(); // POST 掛起中
      await panel.exitManage();                          // 先回視圖態
      expect(document.querySelector(".cg-card")).not.toBe(null);
      d.resolve();                                       // POST 才落地，接著重抓清單也落地
      await flush();
      expect(document.querySelector(".cg-manage-card")).toBe(null); // 沒被蓋回管理畫面
      expect(document.querySelector(".cg-card")).not.toBe(null);    // 視圖態卡片還在
    });

    it("POST 成功但重抓清單失敗：按鈕復原＋鍵盤焦點還回原鈕＋照實提示（不謊報沒成功）", async () => {
      let postSeen = false;
      const fetchImpl = vi.fn(async (url, opts = {}) => {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET" && url.endsWith("/manage")) {
          if (postSeen) return { ok: false, status: 500 }; // POST 之後的重抓失敗
          return { ok: true, status: 200, json: async () => ({ items: [mkItem("cg-1", "月夜床帳", { opening: true })] }) };
        }
        if (method === "POST" && url.endsWith("/manage")) {
          postSeen = true;
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: false, status: 404 };
      });
      await openManageWith(fetchImpl);
      const downBtn = document.querySelector(".cg-manage-down");
      downBtn.click();
      await flush();
      expect(downBtn.disabled).toBe(false);                       // 操作已成功、只是畫面沒跟上＝不重繪，同一節點復原
      expect(downBtn.classList.contains("is-busy")).toBe(false);
      expect(document.activeElement).toBe(downBtn);               // 焦點還回原鈕
      expect(document.querySelector(".cg-send-hint").textContent)
        .toBe("（改好了，但畫面更新沒跟上——關掉重開面板看最新）"); // 全字串釘住：不可與「沒有成功」訊息互換
    });
  });

  // ── 多語卡名／描述（backend 契約：name／desc 是字串，或每語系一個的物件；同
  // config 主題／造型／家具 label 的既有做法）。殼用 pickLabel 依當前介面語系
  // 挑來顯示；儲存時保形送回——物件形＝原物件展開＋當前語系換新值（其他語系
  // 不遺失），字串形＝照舊送字串。 ────────────────────────────────────────────
  describe("多語卡名／描述（name／desc 物件形）", () => {
    const i18nItem = () => mkItem("cg-1", { "zh-Hant": "月夜床帳", en: "Moonlit Canopy" }, {
      opening: true,
      desc: { "zh-Hant": "害羞鑰匙", en: "A shy key" },
    });

    async function openManage(items) {
      const presenter = makePresenter();
      global.fetch = fetchStub({
        "GET /api/v4/cg/manage": { items },
        "POST /api/v4/cg/manage": { ok: true },
      });
      const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
        send: () => {}, endpointBase: "/api/v4/cg",
      });
      panel.open();
      await panel.enterManage();
      return panel;
    }

    function postedBody() {
      const call = global.fetch.mock.calls.find(
        ([u, o]) => u === "/api/v4/cg/manage" && (o || {}).method === "POST");
      return JSON.parse(call[1].body);
    }

    it("zh-Hant：輸入框預填 zh-Hant 值；↑↓／儲存／刪除／開場景的 aria-label 帶 zh-Hant 名字", async () => {
      await openManage([i18nItem()]);
      expect(document.querySelector(".cg-manage-name").value).toBe("月夜床帳");
      expect(document.querySelector(".cg-manage-desc").value).toBe("害羞鑰匙");
      expect(document.querySelector(".cg-manage-up").getAttribute("aria-label")).toBe("上移「月夜床帳」");
      expect(document.querySelector(".cg-manage-down").getAttribute("aria-label")).toBe("下移「月夜床帳」");
      expect(document.querySelector(".cg-manage-save").getAttribute("aria-label")).toBe("儲存「月夜床帳」");
      expect(document.querySelector(".cg-manage-delete").getAttribute("aria-label")).toBe("刪除「月夜床帳」");
      expect(document.querySelector(".cg-flag-opening").getAttribute("aria-label")).toBe("設「月夜床帳」為開場景（桌機組）");
    });

    it("en：輸入框預填 en 值；↑ 鈕 aria-label 帶 en 名字", async () => {
      setLocale("en", { persist: false });
      await openManage([i18nItem()]);
      expect(document.querySelector(".cg-manage-name").value).toBe("Moonlit Canopy");
      expect(document.querySelector(".cg-manage-desc").value).toBe("A shy key");
      expect(document.querySelector(".cg-manage-up").getAttribute("aria-label")).toBe('Move "Moonlit Canopy" up');
    });

    it("物件形＋en 下改名儲存：POST body 的 name／desc 保形＝{ zh-Hant: 原值, en: 新值 }（zh-Hant 不遺失）", async () => {
      setLocale("en", { persist: false });
      await openManage([i18nItem()]);
      document.querySelector(".cg-manage-name").value = "Moonlit Bed";
      document.querySelector(".cg-manage-desc").value = "A key kept close";
      document.querySelector(".cg-manage-save").click();
      await Promise.resolve();
      expect(postedBody()).toEqual({
        op: "edit",
        id: "cg-1",
        name: { "zh-Hant": "月夜床帳", en: "Moonlit Bed" },
        desc: { "zh-Hant": "害羞鑰匙", en: "A key kept close" },
      });
    });

    it("物件形＋zh-Hant 下改名儲存：只換 zh-Hant 值、en 原封保留", async () => {
      await openManage([i18nItem()]);
      document.querySelector(".cg-manage-name").value = "月色床帳";
      document.querySelector(".cg-manage-save").click();
      await Promise.resolve();
      expect(postedBody()).toEqual({
        op: "edit",
        id: "cg-1",
        name: { "zh-Hant": "月色床帳", en: "Moonlit Canopy" },
        desc: { "zh-Hant": "害羞鑰匙", en: "A shy key" },
      });
    });

    it("字串形（含 en 下）儲存：name／desc 照舊送字串，不被包成物件", async () => {
      setLocale("en", { persist: false });
      await openManage([mkItem("cg-1", "月夜床帳", { opening: true, desc: "害羞鑰匙" })]);
      expect(document.querySelector(".cg-manage-name").value).toBe("月夜床帳"); // 字串＝語系無關、原樣
      document.querySelector(".cg-manage-name").value = "新名字";
      document.querySelector(".cg-manage-desc").value = "新描述";
      document.querySelector(".cg-manage-save").click();
      await Promise.resolve();
      expect(postedBody()).toEqual({ op: "edit", id: "cg-1", name: "新名字", desc: "新描述" });
    });

    // ── 儲存寫入的語系鍵＝預填那格的語系（卡片建構當下），且缺鍵時不把 fallback
    // 顯示的字抄進新鍵 ────────────────────────────────────────────────────────
    const zhOnlyItem = () => mkItem("cg-1", { "zh-Hant": "月夜床帳" }, {
      opening: true,
      desc: { "zh-Hant": "害羞鑰匙" },
    });

    it("物件形只有 zh-Hant 鍵＋en 下不改字就存：name／desc 與原物件深相等（不新增 en 鍵——fallback 顯示的 zh 文字不被抄進 en）", async () => {
      setLocale("en", { persist: false });
      await openManage([zhOnlyItem()]);
      expect(document.querySelector(".cg-manage-name").value).toBe("月夜床帳"); // en 缺鍵＝pickLabel 退回 zh-Hant 顯示
      expect(document.querySelector(".cg-manage-desc").value).toBe("害羞鑰匙");
      document.querySelector(".cg-manage-save").click();
      await Promise.resolve();
      expect(postedBody()).toEqual({
        op: "edit", id: "cg-1",
        name: { "zh-Hant": "月夜床帳" },
        desc: { "zh-Hant": "害羞鑰匙" },
      });
    });

    it("物件形只有 zh-Hant 鍵＋en 下改了 name 才存：name 加 en 鍵；desc 沒改＝仍是原物件", async () => {
      setLocale("en", { persist: false });
      await openManage([zhOnlyItem()]);
      document.querySelector(".cg-manage-name").value = "Moonlit Bed";
      document.querySelector(".cg-manage-save").click();
      await Promise.resolve();
      expect(postedBody()).toEqual({
        op: "edit", id: "cg-1",
        name: { "zh-Hant": "月夜床帳", en: "Moonlit Bed" },
        desc: { "zh-Hant": "害羞鑰匙" },
      });
    });

    it("管理態開著時把語系從 en 切回 zh-Hant 再存：鍵仍寫進 en（預填的是 en 的字；管理態切語系不重繪、輸入框不動）", async () => {
      setLocale("en", { persist: false });
      await openManage([i18nItem()]);
      const nameInput = document.querySelector(".cg-manage-name");
      expect(nameInput.value).toBe("Moonlit Canopy");
      setLocale("zh-Hant", { persist: false }); // 管理態不重繪（不丟使用者打到一半的字）
      expect(document.querySelector(".cg-manage-name")).toBe(nameInput); // 同一顆節點
      expect(nameInput.value).toBe("Moonlit Canopy");
      nameInput.value = "Moonlit Bed";
      document.querySelector(".cg-manage-save").click();
      await Promise.resolve();
      expect(postedBody()).toEqual({
        op: "edit", id: "cg-1",
        name: { "zh-Hant": "月夜床帳", en: "Moonlit Bed" }, // 寫進 en，不是儲存瞬間的 zh-Hant
        desc: { "zh-Hant": "害羞鑰匙", en: "A shy key" },
      });
    });
  });

  // ── 管理態分組 TAB（雙軌制）─────────────────────────────────────────────────
  describe("分組 TAB（桌機｜手機）", () => {
    // 雙組整包 fixture：/manage 回全部、前端 filter——切 TAB 不重新 fetch。
    const twoGroupRoutes = () => fetchStub({
      "GET /api/v4/cg/manage": { items: [
        mkItem("cg-1", "月夜床帳", { opening: true }),
        mkItem("cg-2", "窗邊"),
        mkItem("cg-m1", "枕畔", { target: "mobile", opening: true }),
      ] },
      "POST /api/v4/cg/manage": { ok: true },
    });

    async function openManage() {
      const presenter = makePresenter();
      global.fetch = twoGroupRoutes();
      const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
        send: () => {}, endpointBase: "/api/v4/cg",
      });
      panel.open();
      await panel.enterManage();
      return panel;
    }

    it("進管理態＝兩顆 TAB、預設「桌機」；清單只列 desktop 組", async () => {
      await openManage();
      const tabs = document.querySelectorAll(".cg-manage-tab");
      expect(tabs.length).toBe(2);
      expect(tabs[0].textContent).toBe("桌機");
      expect(tabs[1].textContent).toBe("手機");
      expect(tabs[0].classList.contains("is-active")).toBe(true);
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");
      expect(tabs[1].getAttribute("aria-selected")).toBe("false");
      const names = Array.from(document.querySelectorAll(".cg-manage-name")).map((i) => i.value);
      expect(names).toEqual(["月夜床帳", "窗邊"]); // mobile 組的枕畔不在
      expect(document.querySelector(".cg-manage-upload-target").textContent).toBe("上傳到：桌機組");
    });

    it("locale=en 時上傳歸屬列走英文字典（i18n；曾誤把兩段譯文字面串接、英文版漏空格，改參數化）", async () => {
      setLocale("en", { persist: false });
      await openManage();
      expect(document.querySelector(".cg-manage-upload-target").textContent).toBe("Upload to: Desktop set");
    });

    it("切「手機」TAB＝清單改列 mobile 組、上傳歸屬跟著換；純前端 filter 不重新 fetch", async () => {
      await openManage();
      const fetchCallsBefore = global.fetch.mock.calls.length;
      document.querySelectorAll(".cg-manage-tab")[1].click();
      const names = Array.from(document.querySelectorAll(".cg-manage-name")).map((i) => i.value);
      expect(names).toEqual(["枕畔"]);
      expect(document.querySelectorAll(".cg-manage-tab")[1].classList.contains("is-active")).toBe(true);
      expect(document.querySelector(".cg-manage-upload-target").textContent).toBe("上傳到：手機組");
      expect(global.fetch.mock.calls.length).toBe(fetchCallsBefore); // 沒有多打任何 fetch
      // 手機組卡片的開場景 aria-label 帶手機組語意
      expect(document.querySelector(".cg-flag-opening").getAttribute("aria-label"))
        .toBe("設「枕畔」為開場景（手機組）");
    });

    it("手機 TAB 下上傳＝FormData 帶 target=mobile（上傳歸屬當前 TAB）", async () => {
      const presenter = makePresenter();
      let uploadCall = null;
      global.fetch = vi.fn(async (url, opts = {}) => {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET" && url.endsWith("/manage")) {
          return { ok: true, status: 200, json: async () => ({ items: [mkItem("cg-m1", "枕畔", { target: "mobile", opening: true })] }) };
        }
        if (method === "POST" && url.endsWith("/upload")) {
          uploadCall = opts;
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: false, status: 404 };
      });
      const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
        send: () => {}, endpointBase: "/api/v4/cg",
      });
      panel.open();
      await panel.enterManage();
      document.querySelectorAll(".cg-manage-tab")[1].click(); // 切手機組
      const fileInput = document.querySelector(".cg-manage-upload-file");
      const file = new File([new Uint8Array(4)], "m.png", { type: "image/png" });
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      document.querySelector(".cg-manage-upload-btn").click();
      await flush();
      expect(uploadCall.body.get("target")).toBe("mobile");
    });

    it("重新 enterManage＝TAB 重設回「桌機」（不跨次殘留）", async () => {
      const panel = await openManage();
      document.querySelectorAll(".cg-manage-tab")[1].click(); // 切手機
      expect(document.querySelectorAll(".cg-manage-tab")[1].classList.contains("is-active")).toBe(true);
      await panel.exitManage();
      await panel.enterManage();
      const tabs = document.querySelectorAll(".cg-manage-tab");
      expect(tabs[0].classList.contains("is-active")).toBe(true);
      expect(tabs[1].classList.contains("is-active")).toBe(false);
    });
  });

  // ── 「<」返回鍵 ──────────────────────────────────────────────
  describe("管理態「<」返回鍵", () => {
    async function openManage() {
      const presenter = makePresenter();
      global.fetch = fetchStub({
        "GET /api/v4/cg/manage": { items: [mkItem("cg-1", "月夜床帳", { opening: true, desc: "管理態限定" })] },
      });
      const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
        send: () => {}, endpointBase: "/api/v4/cg",
      });
      panel.open();
      return { panel, presenter };
    }

    it("視圖態：返回鈕 hidden、扳手可見", async () => {
      await openManage();
      const back = document.querySelector(".cg-back-btn");
      expect(back).not.toBe(null);
      expect(back.hidden).toBe(true);
      expect(document.querySelector(".cg-manage-btn").hidden).toBe(false);
      expect(back.getAttribute("aria-label")).toBe("返回相冊");
    });

    it("hasManage=false（開源殼）＝返回鈕完全不存在——掛在 head 內、head 不建立即天然不存在（byte-identical 保證照舊）", () => {
      const bare = buildCgPanel(document.getElementById("cg-root"), makePresenter(), { send: () => true });
      bare.open();
      expect(document.querySelector(".cg-back-btn")).toBe(null);
      expect(document.querySelector(".cg-sheet-head")).toBe(null);
    });

    it("管理態：返回鈕現身、扳手隱藏（單一返回語意，不留兩顆做同件事的鈕）", async () => {
      const { panel } = await openManage();
      await panel.enterManage();
      expect(document.querySelector(".cg-back-btn").hidden).toBe(false);
      expect(document.querySelector(".cg-manage-btn").hidden).toBe(true);
    });

    it("點「<」＝exitManage 回相冊視圖態（不是關面板——點暗幕關面板照舊）；扳手復現", async () => {
      const { panel, presenter } = await openManage();
      await panel.enterManage();
      document.querySelector(".cg-back-btn").click();
      await flush();
      expect(presenter.init).toHaveBeenCalled();               // exitManage 重新 fetch 相冊
      expect(document.querySelector(".cg-manage-desc")).toBe(null); // desc 節點清除（回視圖態）
      expect(document.querySelectorAll(".cg-card").length).toBe(1);
      expect(panel.el.hidden).toBe(false);                     // 面板還開著＝返回不是關閉
      expect(document.querySelector(".cg-back-btn").hidden).toBe(true);
      expect(document.querySelector(".cg-manage-btn").hidden).toBe(false);
    });
  });
});
