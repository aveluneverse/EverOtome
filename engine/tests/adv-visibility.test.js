import { describe, it, expect } from "vitest";
import { createAdvVisibility } from "../js/adv-visibility.js";

// intimate（CG 演出）自動收 ADV：intimate 開＝預設收、關＝回平時偏好；中途手動
// ＝session override 不落 localStorage；換景（同態重推）不沒收使用者的手動選擇。

function harness(baseInit = true) {
  let base = baseInit;
  const rendered = [];
  const vis = createAdvVisibility({
    getBase: () => base,
    setBase: (v) => { base = v; },
    onRender: (v) => rendered.push(v),
  });
  return { vis, rendered, getBase: () => base };
}

describe("createAdvVisibility：intimate 自動收 ADV 狀態機", () => {
  it("平時＝吃持久基線；toggle 翻基線（寫回 setBase）", () => {
    const h = harness(true);
    h.vis.setIntimate(false);
    expect(h.vis.effective()).toBe(true);
    h.vis.toggle();
    expect(h.vis.effective()).toBe(false);
    expect(h.getBase()).toBe(false); // 平時 toggle＝持久偏好真的被改
  });

  it("intimate 開門＝預設收起（即使平時偏好是顯示）", () => {
    const h = harness(true);
    h.vis.setIntimate(true);
    expect(h.vis.effective()).toBe(false);
    expect(h.getBase()).toBe(true); // 基線絲毫不動
  });

  it("intimate 中手動打開＝override 生效、localStorage 基線不被汙染", () => {
    const h = harness(true);
    h.vis.setIntimate(true);
    h.vis.toggle(); // 使用者臨時打開
    expect(h.vis.effective()).toBe(true);
    expect(h.getBase()).toBe(true); // 沒寫基線
    h.vis.toggle(); // 再收回去
    expect(h.vis.effective()).toBe(false);
    expect(h.getBase()).toBe(true);
  });

  it("換景（同態 intimate 重推）＝使用者手動打開的不被收回去", () => {
    const h = harness(true);
    h.vis.setIntimate(true);
    h.vis.toggle(); // 打開
    h.vis.setIntimate(true); // 換景、server 重推 cg_state
    expect(h.vis.effective()).toBe(true); // override 保留
  });

  it("intimate 結束＝回平時基線＋override 歸零（下次 intimate 又是預設收）", () => {
    const h = harness(true);
    h.vis.setIntimate(true);
    h.vis.toggle(); // intimate 中打開
    h.vis.setIntimate(false); // 關門
    expect(h.vis.effective()).toBe(true); // 回基線（顯示）
    h.vis.setIntimate(true); // 再開 intimate
    expect(h.vis.effective()).toBe(false); // override 已歸零＝預設收
  });

  it("平時偏好本來就是收＝intimate 結束回收起狀態（尊重使用者的平時選擇）", () => {
    const h = harness(false);
    h.vis.setIntimate(true);
    expect(h.vis.effective()).toBe(false);
    h.vis.setIntimate(false);
    expect(h.vis.effective()).toBe(false); // 基線＝收
  });

  it("每次 setIntimate／toggle 都重渲染（onRender 收到最新值）", () => {
    const h = harness(true);
    h.vis.setIntimate(false);
    h.vis.setIntimate(true);
    h.vis.toggle();
    expect(h.rendered).toEqual([true, false, true]);
  });
});
