import { describe, it, expect } from "vitest";
import { bindLocaleRelabel } from "../js/appearance-labels.js";
import { setLocale, pickLabel, onLocaleChange } from "../js/i18n.js";

// 外觀面板卡名換語系即時重譯（final review Important 1）：app.js 建外觀面板當下用
// pickLabel() 把 config 標籤物件（造型／主題／家具）算成字串直接寫 textContent，
// 沒有掛 data-i18n（config 標籤是物件不是鍵，applyDom() 天生套不到）——app.js 是
// 模組頂層自呼叫 main()（import 即整套開機），沒辦法在 jsdom 單測裡單獨匯入，
// 重譯邏輯抽成 appearance-labels.js 的純函式，這裡直接測那支。

function cardWithName() {
  const card = document.createElement("button");
  const name = document.createElement("span");
  name.className = "appearance-card-name";
  card.appendChild(name);
  return card;
}

describe("bindLocaleRelabel", () => {
  it("重跑 getLabel 寫回每張卡的卡名（不是建立當下拍照，每次呼叫都重查）", () => {
    const swan = cardWithName();
    const rose = cardWithName();
    const cards = new Map([["swan", swan], ["rose", rose]]);
    const labels = { swan: "水晶天鵝", rose: "薔薇暮誓" };
    const relabel = bindLocaleRelabel({ cards, getLabel: (id) => labels[id] });
    relabel();
    expect(swan.querySelector(".appearance-card-name").textContent).toBe("水晶天鵝");
    labels.swan = "改過的名字";
    relabel();
    expect(swan.querySelector(".appearance-card-name").textContent).toBe("改過的名字");
    expect(rose.querySelector(".appearance-card-name").textContent).toBe("薔薇暮誓");
  });

  it("卡表是空 Map／未定義都安全 no-op", () => {
    expect(() => bindLocaleRelabel({ cards: new Map(), getLabel: () => "x" })()).not.toThrow();
    expect(() => bindLocaleRelabel({ cards: undefined, getLabel: () => "x" })()).not.toThrow();
  });

  it("卡片缺 .appearance-card-name 後代＝跳過該卡、不炸其餘卡", () => {
    const bare = document.createElement("button"); // 沒有 name span
    const swan = cardWithName();
    const cards = new Map([["bare", bare], ["swan", swan]]);
    const relabel = bindLocaleRelabel({ cards, getLabel: (id) => (id === "swan" ? "水晶天鵝" : "x") });
    expect(() => relabel()).not.toThrow();
    expect(swan.querySelector(".appearance-card-name").textContent).toBe("水晶天鵝");
  });

  it("與 pickLabel／onLocaleChange／setLocale 串接：主題 label 物件換語系即時重譯（brief 指定情境）", () => {
    const card = cardWithName();
    const cards = new Map([["crystal-swan", card]]);
    const theme = { id: "crystal-swan", label: { "zh-Hant": "水晶天鵝", en: "Crystal Swan" } };
    const relabel = bindLocaleRelabel({
      cards,
      getLabel: (id) => (id === theme.id ? pickLabel(theme.label) : id),
    });
    relabel(); // 面板建好當下的初始寫入（同 app.js 建卡那一刻）
    expect(card.querySelector(".appearance-card-name").textContent).toBe("水晶天鵝");

    // 同 app.js 的接線：onLocaleChange(() => relabelThemes()) ——訂閱後
    // 換語系不必手動再呼叫一次 relabel()，setLocale 本身會觸發。
    const unsubscribe = onLocaleChange(relabel);
    try {
      setLocale("en", { persist: false });
      expect(card.querySelector(".appearance-card-name").textContent).toBe("Crystal Swan");

      setLocale("zh-Hant", { persist: false });
      expect(card.querySelector(".appearance-card-name").textContent).toBe("水晶天鵝");
    } finally {
      unsubscribe();
    }
  });
});
