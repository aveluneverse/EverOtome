import { describe, it, expect, beforeEach } from "vitest";
import { FurnitureManager } from "../js/furniture.js";

// 家具擺放系統：config 驅動／localStorage 記放置／多選 toggle／config 無此節＝
// 整族不長。

const ITEM = {
  id: "side-table",
  label: "邊桌",
  file: "assets/furniture/side-table.webp",
  left: "2.5%",
  height: "62dvh",
  bottom: "-21dvh",
  defaultOn: true,
};

function makeAnchor() {
  // 鏡照 index.html：#stage-bg 是 body 直屬、家具層插它「之後」
  const bg = document.createElement("div");
  bg.id = "stage-bg";
  document.body.appendChild(bg);
  return bg;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.className = ""; // has-furniture 跨測試殘留會讓「零污染」斷言誤紅
  localStorage.clear();
});

describe("FurnitureManager — 房間家具擺放", () => {
  it("config 有件＋defaultOn → 層插在錨點之後、item 帶 config 擺位", () => {
    const bg = makeAnchor();
    new FurnitureManager(bg, [ITEM]);
    const layer = document.querySelector(".furniture-layer");
    expect(layer).not.toBeNull();
    expect(bg.nextElementSibling).toBe(layer); // 背景之上、其餘之下的 DOM 序
    const img = layer.querySelector(".furniture-item");
    expect(img).not.toBeNull();
    expect(img.src).toContain("furniture/side-table.webp");
    expect(img.style.left).toBe("2.5%");
    expect(img.style.height).toBe("62dvh");
    expect(img.style.bottom).toBe("-21dvh");
  });

  it("config 無節／空陣列／錨點缺席 → 整族不長（DOM 與沒有這支模組時一模一樣）", () => {
    const bg = makeAnchor();
    new FurnitureManager(bg, undefined);
    new FurnitureManager(bg, []);
    new FurnitureManager(null, [ITEM]);
    expect(document.querySelector(".furniture-layer")).toBeNull();
  });

  it("defaultOn:false 且無記錄 → 不渲染；toggle 放置＝出現＋localStorage 記住", () => {
    const bg = makeAnchor();
    const mgr = new FurnitureManager(bg, [{ ...ITEM, defaultOn: false }]);
    expect(document.querySelector(".furniture-item")).toBeNull();
    expect(mgr.isOn("side-table")).toBe(false);
    expect(mgr.toggle("side-table")).toBe(true); // 放置
    expect(document.querySelector(".furniture-item")).not.toBeNull();
    expect(JSON.parse(localStorage.getItem("v4.furniture"))["side-table"]).toBe(true);
  });

  it("toggle 收起＝移除節點＋記錄 false（使用者的選擇蓋過 defaultOn）", () => {
    const bg = makeAnchor();
    const mgr = new FurnitureManager(bg, [ITEM]); // defaultOn:true＝初始有
    expect(document.querySelector(".furniture-item")).not.toBeNull();
    expect(mgr.toggle("side-table")).toBe(false); // 收起
    expect(document.querySelector(".furniture-item")).toBeNull();
    // 重建（模擬 F5）：記錄 false 蓋過 defaultOn:true
    document.body.innerHTML = "";
    const bg2 = makeAnchor();
    const mgr2 = new FurnitureManager(bg2, [ITEM]);
    expect(mgr2.isOn("side-table")).toBe(false);
    expect(document.querySelector(".furniture-item")).toBeNull();
  });

  it("未知 id toggle＝no-op false；壞 config 項（缺 id／file）過濾不炸", () => {
    const bg = makeAnchor();
    const mgr = new FurnitureManager(bg, [
      ITEM,
      { id: "", file: "x.webp" },
      { id: "no-file" },
      null,
    ]);
    expect(mgr.items.length).toBe(1);
    expect(mgr.toggle("ghost")).toBe(false);
  });

  it("壞 localStorage JSON → 靜默回預設（defaultOn），不炸", () => {
    localStorage.setItem("v4.furniture", "{not-json");
    const bg = makeAnchor();
    const mgr = new FurnitureManager(bg, [ITEM]);
    expect(mgr.isOn("side-table")).toBe(true); // 回 defaultOn
    expect(document.querySelector(".furniture-item")).not.toBeNull();
  });

  it("讓位訊號：有家具＝body.has-furniture、全收＝移除、再放＝回來", () => {
    const bg = makeAnchor();
    const mgr = new FurnitureManager(bg, [ITEM]); // defaultOn:true
    expect(document.body.classList.contains("has-furniture")).toBe(true);
    mgr.toggle("side-table"); // 收起＝畫面沒家具＝立繪回 C 位
    expect(document.body.classList.contains("has-furniture")).toBe(false);
    mgr.toggle("side-table"); // 再放＝再讓位
    expect(document.body.classList.contains("has-furniture")).toBe(true);
  });

  it("讓位訊號：config 無件／錨點缺席 → 永不掛 class（body 零污染）", () => {
    const bg = makeAnchor();
    new FurnitureManager(bg, []);
    new FurnitureManager(null, [ITEM]);
    expect(document.body.classList.contains("has-furniture")).toBe(false);
  });
});

// ── 外部指令出口：setOn 給 room_state frame handler 用（後端推來的家具開關值
// 冪等套用）；snapshot 供上報／回讀用的全件快照。
const ITEM2 = {
  id: "reading-lamp",
  label: "閱讀燈",
  file: "assets/furniture/reading-lamp.webp",
  left: "80%",
  height: "30dvh",
  bottom: "-5dvh",
  defaultOn: false,
};

describe("setOn／snapshot（外部指令出口）", () => {
  it("setOn 定向冪等：現值≠目標→切換回 true；已是目標→回 false 不動", () => {
    const bg = makeAnchor();
    const mgr = new FurnitureManager(bg, [ITEM]); // defaultOn:true
    expect(mgr.setOn("side-table", false)).toBe(true); // 改了：true→false
    expect(mgr.setOn("side-table", false)).toBe(false); // 已是 false＝不動
    expect(mgr.isOn("side-table")).toBe(false);
    expect(mgr.snapshot()).toEqual({ "side-table": false });
  });

  it("setOn 目標值＝現值（含未記錄、走 defaultOn）→ 回 false，且不留 localStorage 寫入痕跡", () => {
    const bg = makeAnchor();
    const mgr = new FurnitureManager(bg, [ITEM]); // defaultOn:true、尚無記錄
    expect(mgr.setOn("side-table", true)).toBe(false); // 目標＝現值(true)＝不動
    expect(localStorage.getItem("v4.furniture")).toBeNull();
  });

  it("setOn 未知 id → no-op 回 false，不動任何狀態", () => {
    const bg = makeAnchor();
    const mgr = new FurnitureManager(bg, [ITEM]);
    expect(mgr.setOn("ghost-chair", true)).toBe(false);
    expect(localStorage.getItem("v4.furniture")).toBeNull();
  });

  it("setOn 放置未記錄的 defaultOn:false 項 → 回 true、DOM 真的長出節點", () => {
    const bg = makeAnchor();
    const mgr = new FurnitureManager(bg, [ITEM2]);
    expect(document.querySelector(".furniture-item")).toBeNull();
    expect(mgr.setOn("reading-lamp", true)).toBe(true);
    expect(document.querySelector(".furniture-item")).not.toBeNull();
    expect(mgr.isOn("reading-lamp")).toBe(true);
  });

  it("snapshot()：全件皆列，含從未記錄過、走 defaultOn 邏輯的項", () => {
    const bg = makeAnchor();
    const mgr = new FurnitureManager(bg, [ITEM, ITEM2]); // side-table true／reading-lamp false
    expect(mgr.snapshot()).toEqual({ "side-table": true, "reading-lamp": false });
    mgr.toggle("reading-lamp");
    expect(mgr.snapshot()).toEqual({ "side-table": true, "reading-lamp": true });
  });

  it("snapshot()：config 無件 → 空物件", () => {
    const bg = makeAnchor();
    const mgr = new FurnitureManager(bg, []);
    expect(mgr.snapshot()).toEqual({});
  });

  // 收起時只 img.remove()、沒清 onerror——舊圖若在「收起→再放置」之後才報錯，
  // 沒有守衛就會把層裡那顆新 img 從 _nodes 刪掉（節點沒人追蹤＋讓位 class 失
  // 準＋下次 toggle 長出重複）。jsdom 不會真的去載圖，直接呼叫舊節點殘留的
  // onerror 就能把那一刻重現。
  it("舊節點遲到的 onerror 不動到新節點（收起→再放置的競態）", () => {
    const bg = makeAnchor();
    const mgr = new FurnitureManager(bg, [ITEM]); // defaultOn:true＝初始有
    const stale = document.querySelector(".furniture-item");
    expect(typeof stale.onerror).toBe("function");

    mgr.toggle("side-table"); // 收起：舊節點離開畫面，onerror 還掛在它身上
    mgr.toggle("side-table"); // 再放置：層裡換成一顆新 img
    const fresh = document.querySelector(".furniture-item");
    expect(fresh).not.toBe(stale);

    stale.onerror(); // 舊圖此刻才報錯

    expect(document.querySelectorAll(".furniture-item").length).toBe(1);
    expect(document.querySelector(".furniture-item")).toBe(fresh); // 新節點沒被誤刪
    expect(document.body.classList.contains("has-furniture")).toBe(true);
    expect(mgr.isOn("side-table")).toBe(true);
  });
});
