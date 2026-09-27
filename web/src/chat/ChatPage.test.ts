// 对话入口纯函数投影的单元测试（渲染与交互按仓库惯例留给 e2e）。
import { describe, expect, it } from "vitest";
import {
  exitTone, lastSeq, mergeEvents, progressLabel, rangesText,
} from "./cards";
import type { ChatEvent } from "./cards";

function event(seq: number, kind = "assistant.text"): ChatEvent {
  return { seq, at: `t${seq}`, kind, text: `m${seq}` };
}

describe("mergeEvents", () => {
  it("按 seq 去重且有序（轮询与发送两条来源会重叠）", () => {
    const merged = mergeEvents(
      [event(1), event(2), event(3)],
      [event(2), event(3), event(4)],
    );
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(lastSeq(merged)).toBe(4);
  });

  it("后到的同 seq 事件覆盖旧事件（状态更新语义）", () => {
    const merged = mergeEvents([event(1)], [{ ...event(1), kind: "card.progress" }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe("card.progress");
  });

  it("空列表安全", () => {
    expect(lastSeq([])).toBe(0);
    expect(mergeEvents([], [])).toEqual([]);
  });
});

describe("rangesText", () => {
  it("单行、区间与多段", () => {
    expect(rangesText([[6, 6]])).toBe("6");
    expect(rangesText([[3, 9]])).toBe("3-9");
    expect(rangesText([[3, 9], [12, 12]])).toBe("3-9、12");
  });

  it("非数组输入返回空串而不是崩溃", () => {
    expect(rangesText(undefined)).toBe("");
    expect(rangesText("nope")).toBe("");
  });
});

describe("exitTone / progressLabel", () => {
  it("退出码语气与后端口径一一对应", () => {
    expect(exitTone(0)).toBe("ok");
    expect(exitTone(2)).toBe("items");
    expect(exitTone(5)).toBe("insufficient");
    expect(exitTone(4)).toBe("info");
    expect(exitTone(3)).toBe("warn");
  });

  it("未知状态原样显示，已知状态给中文", () => {
    expect(progressLabel("EXECUTING")).toBe("反事实实验中");
    expect(progressLabel("COMPLETE")).toBe("完成");
    expect(progressLabel("WEIRD")).toBe("WEIRD");
  });
});
