import { describe, it, expect, beforeEach, vi } from "vitest";
import { confirmDialog, confirmPhotoDialog } from "../js/confirm.js";
import { setLocale } from "../js/i18n.js";

// 自刻確認彈窗（window.confirm 系統窗吃不到主題、iOS 露網域抬頭）。
// 元件契約：確定=true／取消・暗幕・Esc=false／Enter=確定／單例守門／focus 管理／
// 關窗零殘留。設定頁與 MENU 忘記暫存的「呼叫端流程」測在 settings.test.js 與
// sandbox.test.js，這裡只釘元件本身。

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("confirmDialog — 自刻確認彈窗", () => {
  it("開窗：veil＋card＋訊息＋確定/取消兩鈕，role=alertdialog，focus 落在確定", () => {
    const p = confirmDialog("這段沙盒對話將永遠消失，確定？");
    const veil = document.querySelector(".confirm-veil");
    expect(veil).not.toBeNull();
    const card = veil.querySelector(".confirm-card");
    expect(card.getAttribute("role")).toBe("alertdialog");
    expect(card.getAttribute("aria-modal")).toBe("true");
    expect(card.querySelector(".confirm-msg").textContent).toBe("這段沙盒對話將永遠消失，確定？");
    expect(card.querySelector(".confirm-ok").textContent).toBe("確定");
    expect(card.querySelector(".confirm-cancel").textContent).toBe("取消");
    expect(document.activeElement).toBe(card.querySelector(".confirm-ok"));
    card.querySelector(".confirm-cancel").click(); // 收尾（不留懸掛 promise）
    return p;
  });

  it("locale=en 時兩顆鈕走英文字典（i18n）", () => {
    setLocale("en", { persist: false });
    const p = confirmDialog("msg");
    const card = document.querySelector(".confirm-card");
    expect(card.querySelector(".confirm-ok").textContent).toBe("OK");
    expect(card.querySelector(".confirm-cancel").textContent).toBe("Cancel");
    card.querySelector(".confirm-cancel").click(); // 收尾（不留懸掛 promise）
    return p;
  });

  it("點確定 → resolve true，關窗零殘留", async () => {
    const p = confirmDialog("msg");
    document.querySelector(".confirm-ok").click();
    await expect(p).resolves.toBe(true);
    expect(document.querySelector(".confirm-veil")).toBeNull();
  });

  it("點取消 → resolve false", async () => {
    const p = confirmDialog("msg");
    document.querySelector(".confirm-cancel").click();
    await expect(p).resolves.toBe(false);
    expect(document.querySelector(".confirm-veil")).toBeNull();
  });

  it("點暗幕（veil 本體）→ resolve false（點暗幕即關慣例＝取消語意）；點卡片內部不關", async () => {
    const p = confirmDialog("msg");
    const veil = document.querySelector(".confirm-veil");
    veil.querySelector(".confirm-card").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".confirm-veil")).not.toBeNull(); // 卡片內點擊不關
    veil.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect(p).resolves.toBe(false);
  });

  it("Esc → false；Enter → true（原生 confirm 同款鍵盤語意）", async () => {
    const p1 = confirmDialog("msg");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p1).resolves.toBe(false);
    const p2 = confirmDialog("msg");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await expect(p2).resolves.toBe(true);
  });

  it("單例守門：開著時再呼叫＝直接 resolve false、不疊第二層", async () => {
    const p1 = confirmDialog("first");
    const p2 = confirmDialog("second");
    await expect(p2).resolves.toBe(false);
    expect(document.querySelectorAll(".confirm-veil").length).toBe(1);
    expect(document.querySelector(".confirm-msg").textContent).toBe("first"); // 第一層不被動搖
    document.querySelector(".confirm-ok").click();
    await expect(p1).resolves.toBe(true);
  });

  it("focus 還原：關窗後 focus 回到呼叫前的元素（鍵盤使用者不迷路）", async () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.focus();
    const p = confirmDialog("msg");
    expect(document.activeElement).not.toBe(btn); // 開窗時 focus 在確定鈕
    document.querySelector(".confirm-cancel").click();
    await p;
    expect(document.activeElement).toBe(btn);
  });

  it("Tab 在兩鈕間循環（迷你 focus trap）", () => {
    const p = confirmDialog("msg");
    const ok = document.querySelector(".confirm-ok");
    const cancel = document.querySelector(".confirm-cancel");
    expect(document.activeElement).toBe(ok);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(cancel);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(ok);
    cancel.click();
    return p;
  });

  // ── imageUrl 縮圖預覽（Ctrl+V → 先看見要傳什麼再確定）─────────────────────
  it("imageUrl 有給：訊息上方插 .confirm-img、src／alt 正確、DOM 序＝圖在字前", async () => {
    const p = confirmDialog("把這張圖傳給他？", { imageUrl: "blob:test-preview-url" });
    const card = document.querySelector(".confirm-card");
    const img = card.querySelector(".confirm-img");
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("blob:test-preview-url");
    expect(img.getAttribute("alt")).toBe("要傳送的圖片預覽");
    // 圖在字前（先看圖、再讀問句）
    expect(img.nextElementSibling.className).toBe("confirm-msg");
    document.querySelector(".confirm-ok").click();
    await expect(p).resolves.toBe(true);
    expect(document.querySelector(".confirm-img")).toBeNull(); // 關窗零殘留同契約
  });

  it("imageUrl 沒給（既有兩呼叫點）：無 .confirm-img、行為與擴充前逐一相同", async () => {
    const p = confirmDialog("這段沙盒對話將永遠消失，確定？");
    expect(document.querySelector(".confirm-img")).toBeNull();
    expect(document.querySelector(".confirm-card").firstElementChild.className).toBe("confirm-msg");
    document.querySelector(".confirm-cancel").click();
    await expect(p).resolves.toBe(false);
  });
});

// ── confirmPhotoDialog（跟即時通訊軟體一樣圖＋文一起送；files 累積制：窗開著
// 繼續 Ctrl+V 追加，jsdom 無 DataTransfer/createObjectURL，測試用自製 event
// 物件＋URL stub）──────────────────────────────────────────────────────────
function fakeImg(name) {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

/** jsdom 沒有 DataTransfer 建構子——自製 paste event（handler 只讀 e.clipboardData.items）。 */
function fakePasteEvent(files) {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  ev.clipboardData = {
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
  };
  return ev;
}

describe("confirmPhotoDialog — 貼圖預覽＋說明輸入窗（files 累積制）", () => {
  beforeEach(() => {
    let n = 0;
    // jsdom 無 URL.createObjectURL——窗內部建預覽用，stub 成可辨識的假 URL
    URL.createObjectURL = vi.fn(() => "blob:mock-" + ++n);
    URL.revokeObjectURL = vi.fn();
  });

  it("開窗：縮圖列＋輸入框（預填 initialText＋placeholder）＋兩鈕，focus 落輸入框", async () => {
    const p = confirmPhotoDialog({
      files: [fakeImg("a.png")],
      initialText: "先打好的字",
      placeholder: "想跟圖一起說的話（可留白）⋯⋯",
    });
    const card = document.querySelector(".confirm-card");
    expect(card.querySelectorAll(".confirm-imgs .confirm-img").length).toBe(1);
    const field = card.querySelector(".confirm-input");
    expect(field.value).toBe("先打好的字");
    expect(field.placeholder).toBe("想跟圖一起說的話（可留白）⋯⋯");
    expect(document.activeElement).toBe(field);
    card.querySelector(".confirm-cancel").click();
    await p;
  });

  it("確定 → {ok:true, text:窗內當下內容, files:清單}（窗內改的以窗內為準）", async () => {
    const f1 = fakeImg("a.png");
    const p = confirmPhotoDialog({ files: [f1], initialText: "原稿" });
    const field = document.querySelector(".confirm-input");
    field.value = "改過的說明";
    document.querySelector(".confirm-ok").click();
    const res = await p;
    expect(res.ok).toBe(true);
    expect(res.text).toBe("改過的說明");
    expect(res.files).toEqual([f1]); // File 物件原樣交回（上傳用真身，不是 URL）
    expect(document.querySelector(".confirm-veil")).toBeNull();
  });

  it("多張初始清單：縮圖列張數／順序／alt 帶序號正確；關窗零殘留＋全 revoke", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("a.png"), fakeImg("b.png"), fakeImg("c.png")] });
    const imgs = document.querySelectorAll(".confirm-imgs .confirm-img");
    expect(imgs.length).toBe(3);
    expect(imgs[0].getAttribute("src")).toBe("blob:mock-1"); // createObjectURL 呼叫序＝files 序
    expect(imgs[2].getAttribute("src")).toBe("blob:mock-3");
    expect(imgs[1].getAttribute("alt")).toBe("要傳送的圖片預覽（第 2 張，共 3 張）");
    document.querySelector(".confirm-ok").click();
    await p;
    expect(document.querySelector(".confirm-imgs")).toBeNull(); // 關窗零殘留同契約
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3); // 預覽 URL 窗自管、全數回收
  });

  it("單張 alt 不帶序號（與累積前的單張窗逐字同）", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("only.png")] });
    const img = document.querySelector(".confirm-imgs .confirm-img");
    expect(img.getAttribute("alt")).toBe("要傳送的圖片預覽");
    document.querySelector(".confirm-cancel").click();
    await p;
  });

  // ── 累積模式（連按 Ctrl+V 逐張貼＝常見真實工作流）──────────────────────────
  it("窗開著再 paste 圖片 → 縮圖列 +1、alt 全量重算、事件被吃掉（不進說明框）", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("a.png")], maxCount: 3 });
    expect(document.querySelectorAll(".confirm-imgs .confirm-img").length).toBe(1);
    const ev = fakePasteEvent([fakeImg("b.png")]);
    document.dispatchEvent(ev);
    const imgs = document.querySelectorAll(".confirm-imgs .confirm-img");
    expect(imgs.length).toBe(2);
    expect(ev.defaultPrevented).toBe(true); // 圖片貼上被窗吃掉（檔名文字不進說明框）
    expect(imgs[0].getAttribute("alt")).toBe("要傳送的圖片預覽（第 1 張，共 2 張）");
    document.querySelector(".confirm-ok").click();
    const res = await p;
    expect(res.files.length).toBe(2); // 後貼進來的一起交回
    expect(res.files[1].name).toBe("b.png");
  });

  it("累積到 maxCount 再貼 → 拒收、提示行亮「一次最多 N 張」、清單不變", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("a.png"), fakeImg("b.png"), fakeImg("c.png")], maxCount: 3 });
    expect(document.querySelector(".confirm-hint").textContent).toBe(""); // 未超額＝提示空
    document.dispatchEvent(fakePasteEvent([fakeImg("d.png")]));
    expect(document.querySelectorAll(".confirm-imgs .confirm-img").length).toBe(3);
    expect(document.querySelector(".confirm-hint").textContent).toContain("一次最多 3 張");
    document.querySelector(".confirm-ok").click();
    const res = await p;
    expect(res.files.map((f) => f.name)).toEqual(["a.png", "b.png", "c.png"]); // 第 4 張真的沒收
  });

  it("初始清單就超過 maxCount → 收前 N 張＋提示亮（所見即所送、不默默丟）", async () => {
    const p = confirmPhotoDialog({
      files: [fakeImg("1.png"), fakeImg("2.png"), fakeImg("3.png"), fakeImg("4.png")],
      maxCount: 3,
    });
    expect(document.querySelectorAll(".confirm-imgs .confirm-img").length).toBe(3);
    expect(document.querySelector(".confirm-hint").textContent).toContain("一次最多 3 張");
    document.querySelector(".confirm-cancel").click();
    await p;
  });

  it("窗開著貼純文字 → 不攔（說明框照常吃字）、縮圖列不變", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("a.png")] });
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    ev.clipboardData = { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] };
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false); // 放行＝瀏覽器原生貼字行為不受影響
    expect(document.querySelectorAll(".confirm-imgs .confirm-img").length).toBe(1);
    document.querySelector(".confirm-cancel").click();
    await p;
  });

  it("關窗後 document paste listener 已拆（零殘留：再貼不再有人接）", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("a.png")] });
    document.querySelector(".confirm-cancel").click();
    await p;
    const ev = fakePasteEvent([fakeImg("b.png")]);
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false); // 沒人 preventDefault＝listener 已拆乾淨
  });

  it("取消／暗幕 → {ok:false, text:'', files:[]}", async () => {
    const p1 = confirmPhotoDialog({ files: [fakeImg("a.png")], initialText: "字" });
    document.querySelector(".confirm-cancel").click();
    await expect(p1).resolves.toEqual({ ok: false, text: "", files: [] });
    const p2 = confirmPhotoDialog({ files: [fakeImg("b.png")] });
    document.querySelector(".confirm-veil").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect(p2).resolves.toEqual({ ok: false, text: "", files: [] });
  });

  it("Enter＝確定送出；Esc＝取消（鍵盤語意同 confirmDialog）", async () => {
    const p1 = confirmPhotoDialog({ files: [fakeImg("a.png")], initialText: "用鍵盤送" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(r1.text).toBe("用鍵盤送");
    const p2 = confirmPhotoDialog({ files: [fakeImg("b.png")] });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p2).resolves.toEqual({ ok: false, text: "", files: [] });
  });

  it("IME 組字中的 Enter（isComposing）不送出——中文選字不誤發", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("a.png")] });
    const ev = new KeyboardEvent("keydown", { key: "Enter" });
    Object.defineProperty(ev, "isComposing", { get: () => true });
    document.dispatchEvent(ev);
    expect(document.querySelector(".confirm-veil")).not.toBeNull(); // 窗還在＝沒送
    document.querySelector(".confirm-cancel").click();
    await expect(p).resolves.toEqual({ ok: false, text: "", files: [] });
  });

  it("說明框是 textarea＋Shift+Enter 不送出（換行放行）", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("a.png")], initialText: "第一行" });
    const field = document.querySelector(".confirm-input");
    expect(field.tagName).toBe("TEXTAREA");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    expect(document.querySelector(".confirm-veil")).not.toBeNull(); // 窗還在＝沒送
    field.value = "第一行\n第二行"; // 換行後的多行內容原樣進 text
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    const res = await p;
    expect(res.ok).toBe(true);
    expect(res.text).toBe("第一行\n第二行");
  });

  it("Tab 循環：輸入框→確定→取消→✕（殿後）→輸入框", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("a.png")] });
    const field = document.querySelector(".confirm-input");
    const ok = document.querySelector(".confirm-ok");
    const cancel = document.querySelector(".confirm-cancel");
    const x = document.querySelector(".confirm-thumb-x");
    expect(document.activeElement).toBe(field);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(ok);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(cancel);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(x); // ✕ 也在鍵盤可達範圍（動態 ring 殿後）
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(field);
    cancel.click();
    await p;
  });

  // ── ✕ 移除單張（縮圖右上小圓 ✕）──────────────────────────────────────────
  it("每顆縮圖右上有 ✕（button＋aria-label 帶序號＋SVG 圖示）", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("a.png"), fakeImg("b.png")] });
    const xs = document.querySelectorAll(".confirm-thumb .confirm-thumb-x");
    expect(xs.length).toBe(2);
    expect(xs[0].getAttribute("aria-label")).toBe("移除第 1 張");
    expect(xs[1].getAttribute("aria-label")).toBe("移除第 2 張");
    expect(xs[0].querySelector("svg")).not.toBeNull(); // SVG 線條圖示（不用 emoji）
    document.querySelector(".confirm-cancel").click();
    await p;
  });

  it("點第 2 張 ✕ → 移除該張：縮圖剩 2、alt／aria 全量重算、該預覽 URL 已 revoke、確定交回的清單少那張", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("a.png"), fakeImg("b.png"), fakeImg("c.png")] });
    document.querySelectorAll(".confirm-thumb-x")[1].click();
    const imgs = document.querySelectorAll(".confirm-imgs .confirm-img");
    expect(imgs.length).toBe(2);
    expect(imgs[0].getAttribute("alt")).toBe("要傳送的圖片預覽（第 1 張，共 2 張）");
    expect(imgs[1].getAttribute("src")).toBe("blob:mock-3"); // c.png 的預覽遞補成第 2 顆
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-2"); // b.png 的預覽當場回收
    document.querySelector(".confirm-ok").click();
    const res = await p;
    expect(res.files.map((f) => f.name)).toEqual(["a.png", "c.png"]);
  });

  it("滿額提示亮著時 ✕ 掉一張 → 提示解除、可以再貼進來", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("a.png"), fakeImg("b.png"), fakeImg("c.png")], maxCount: 3 });
    document.dispatchEvent(fakePasteEvent([fakeImg("d.png")])); // 滿額拒收＝提示亮
    expect(document.querySelector(".confirm-hint").textContent).toContain("一次最多 3 張");
    document.querySelectorAll(".confirm-thumb-x")[0].click();
    expect(document.querySelector(".confirm-hint").textContent).toBe(""); // 低於上限＝提示解除
    document.dispatchEvent(fakePasteEvent([fakeImg("e.png")])); // 空位補得進來
    expect(document.querySelectorAll(".confirm-imgs .confirm-img").length).toBe(3);
    document.querySelector(".confirm-ok").click();
    const res = await p;
    expect(res.files.map((f) => f.name)).toEqual(["b.png", "c.png", "e.png"]);
  });

  it("✕ 到最後一張也移掉 → 窗自動關（面板清空即收），resolve {ok:false, files:[]}", async () => {
    const p = confirmPhotoDialog({ files: [fakeImg("a.png")] });
    document.querySelector(".confirm-thumb-x").click();
    await expect(p).resolves.toEqual({ ok: false, text: "", files: [] });
    expect(document.querySelector(".confirm-veil")).toBeNull();
  });

  it("單例守門：confirmDialog 開著時呼叫 confirmPhotoDialog＝直接 {ok:false}（互斥）", async () => {
    const p1 = confirmDialog("first");
    const p2 = confirmPhotoDialog({ files: [fakeImg("a.png")], initialText: "x" });
    await expect(p2).resolves.toEqual({ ok: false, text: "", files: [] });
    expect(document.querySelectorAll(".confirm-veil").length).toBe(1);
    document.querySelector(".confirm-ok").click();
    await expect(p1).resolves.toBe(true);
  });
});
