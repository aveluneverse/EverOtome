import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BlushController } from "../js/blush.js";

// 臉紅暈層控制器：manifest 宣告制、show 淡入＋hold 後自然緩退、
// 重入重置計時、無素材造型靜默 no-op。timer 用 fake timers 快轉。

beforeEach(() => {
  document.body.innerHTML = '<div id="stage"></div>';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function mk(opts) {
  const c = new BlushController(document.getElementById("stage"), opts);
  return c;
}

describe("BlushController — 掛層與素材宣告", () => {
  it("建構即掛 .sprite-blush 層（opacity 0、aria-hidden）；未 syncFrom 前 show()＝no-op 不炸", () => {
    const c = mk();
    const layer = document.querySelector("#stage .sprite-blush");
    expect(layer).not.toBeNull();
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(() => c.show("deep")).not.toThrow();
    expect(layer.style.opacity).not.toBe("1"); // 無素材＝不亮
  });

  it("syncFrom：manifest 有 blush 鍵＝掛 <img>（assetsPath+檔名）；無鍵＝收 img、show no-op", () => {
    const c = mk();
    c.syncFrom({ blush: "blush.webp" }, "assets/sample/");
    const img = document.querySelector(".sprite-blush img");
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("assets/sample/blush.webp");
    c.syncFrom({ size: [1024, 1536] }, "assets/masked/"); // 面罩造型：無 blush 鍵
    expect(document.querySelector(".sprite-blush img")).toBeNull();
    expect(() => c.show("mid")).not.toThrow();
    expect(document.querySelector(".sprite-blush").style.opacity).toBe("0");
  });

  it("static 單張造型：有 blush 鍵也視同未宣告（無堆疊幀容器可定位）＝收 img、show no-op", () => {
    const c = mk();
    c.syncFrom({ blush: "blush.webp" }, "a/");
    expect(document.querySelector(".sprite-blush img")).not.toBeNull();
    c.syncFrom({ static: true, image: "portrait.webp", blush: "blush.webp" }, "b/");
    expect(document.querySelector(".sprite-blush img")).toBeNull();
    expect(() => c.show("deep")).not.toThrow();
    expect(document.querySelector(".sprite-blush").style.opacity).toBe("0");
  });

  it("syncFrom 換造型＝換 src＋臉紅立即歸零（新造型從平靜開始）", () => {
    const c = mk();
    c.syncFrom({ blush: "blush.webp" }, "a/");
    c.show("deep");
    expect(document.querySelector(".sprite-blush").style.opacity).toBe("1");
    c.syncFrom({ blush: "blush.webp" }, "b/");
    expect(document.querySelector(".sprite-blush img").getAttribute("src")).toBe("b/blush.webp");
    expect(document.querySelector(".sprite-blush").style.opacity).toBe("0");
  });
});

describe("BlushController — show／消退（濃度由角色自己選：mid=0.75、deep=1）", () => {
  it("show('mid')＝0.75、show('deep')＝1、未知級別容錯當 mid", () => {
    const c = mk();
    c.syncFrom({ blush: "blush.webp" }, "a/");
    const layer = document.querySelector(".sprite-blush");
    c.show("mid");
    expect(layer.style.opacity).toBe("0.75");
    c.show("deep");
    expect(layer.style.opacity).toBe("1");
    c.show("whatever");
    expect(layer.style.opacity).toBe("0.75");
  });

  it("hold（預設 90s）到期＝自然緩退（opacity 0＋緩退時長）；到期前保持", () => {
    const c = mk({ holdMs: 90_000 });
    c.syncFrom({ blush: "blush.webp" }, "a/");
    const layer = document.querySelector(".sprite-blush");
    c.show("deep");
    vi.advanceTimersByTime(89_000);
    expect(layer.style.opacity).toBe("1"); // 還在紅
    vi.advanceTimersByTime(1_100);
    expect(layer.style.opacity).toBe("0"); // 一分半到＝自己退
    expect(layer.style.transitionDuration).toBe("2.8s"); // 緩退不瞬滅
  });

  it("show 重入＝重置計時（角色持續害羞＝紅不退）；升級 mid→deep 同理", () => {
    const c = mk({ holdMs: 90_000 });
    c.syncFrom({ blush: "blush.webp" }, "a/");
    const layer = document.querySelector(".sprite-blush");
    c.show("mid");
    vi.advanceTimersByTime(80_000);
    c.show("deep"); // 80 秒時又發一次＝計時重來
    vi.advanceTimersByTime(80_000);
    expect(layer.style.opacity).toBe("1"); // 距第二次 show 才 80s＝還紅著
    vi.advanceTimersByTime(10_100);
    expect(layer.style.opacity).toBe("0");
  });

  it("clear()＝主動緩退；clear(true)＝瞬收（換裝用零動畫）", () => {
    const c = mk();
    c.syncFrom({ blush: "blush.webp" }, "a/");
    const layer = document.querySelector(".sprite-blush");
    c.show("deep");
    c.clear();
    expect(layer.style.opacity).toBe("0");
    expect(layer.style.transitionDuration).toBe("2.8s");
    c.show("deep");
    c.clear(true);
    expect(layer.style.opacity).toBe("0");
    expect(layer.style.transitionDuration).toBe("0s");
  });
});
