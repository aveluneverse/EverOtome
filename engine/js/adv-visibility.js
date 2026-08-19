/**
 * adv-visibility.js — ADV 對話框顯示狀態機。
 *
 * 功能：進 intimate（CG 演出）模式＝左邊 ADV 對話框自動收起（只留 Chat Log＋輸入
 * 列，CG 不被遮）；intimate 結束＝自動回來；中途仍可用眼睛子鈕手動控制。
 *
 * 狀態模型（三層，唯一計算點 effective()）：
 *   - base：平時的持久偏好（localStorage v4.advVisible，getBase/setBase 由呼叫端注入）
 *   - intimate：intimate 門開關（cg_state frame 的 intimate 欄位＝server 第一手語義；
 *     F5 intimate 中＝WS 重連即推＝還原自動成立）
 *   - override：intimate 中手動切的臨時值（session 級、**絕不落 localStorage**——
 *     intimate 中的臨時查看不該汙染平時偏好；intimate 結束即歸 null）
 *
 * 顯示規則：intimate 中 → override ?? false（預設收）；平時 → base。
 * toggle()（眼睛子鈕）：intimate 中翻 override；平時翻 base（照舊寫 localStorage）。
 */

export function createAdvVisibility({ getBase, setBase, onRender }) {
  let intimate = false;
  let override = null; // null＝intimate 中未手動動過＝吃預設（收起）

  function effective() {
    if (intimate) return override === null ? false : override;
    return getBase();
  }

  function render() {
    onRender(effective());
  }

  return {
    /** cg_state frame 到達時呼叫（開/關 intimate 門、換景都會推；換景時 intimate
     *  不變＝override 保留，intimate 中手動打開的對話框不會因換景被收回去）。 */
    setIntimate(on) {
      const next = !!on;
      if (next === intimate) { render(); return; } // 同態重推（換景/F5 重連）＝冪等
      intimate = next;
      if (!intimate) override = null; // intimate 結束＝臨時 override 歸零、回平時基線
      render();
    },
    /** 眼睛子鈕：intimate 中＝翻臨時 override；平時＝翻持久基線。 */
    toggle() {
      if (intimate) {
        override = !effective();
      } else {
        setBase(!getBase());
      }
      render();
    },
    effective,
    isIntimate() { return intimate; },
  };
}
