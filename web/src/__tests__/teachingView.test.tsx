// T12 教学视图组件测试：形状来自 modou/teaching_view.py 的 narrate() 输出。
// 直接函数调用返回 React 元素树；用递归收集渲染文本后断言。
import {describe, expect, it} from "vitest";
import {TeachingView, teachingOutcomeLabel,
        type TeachingNarration} from "../master/TeachingView";

const covered: TeachingNarration = {
  narrative_id: "teach-1",
  took_away: {file: "cart.py", lines: [40, 45], excerpt: "def total(): ..."},
  tests_changed: [{id: "tests/test_cart.py::test_total", before: "passed", after: "failed"}],
  related_tests: ["tests/test_cart.py::test_total"],
  outcome: "conclusive",
  why_conclusive: "拿走目标代码后相关测试失败、恢复后重新通过。",
  conclusion_boundary: "教学叙述只解释本次干预实验。",
};

const notCovered: TeachingNarration = {
  ...covered,
  outcome: "not_covering",
  tests_changed: [],
  why_conclusive: "拿走后测试仍然全部通过，不能声称有测试证据。",
};

const collectionBroken: TeachingNarration = {
  ...covered,
  outcome: "inconclusive_collection_failure",
  why_conclusive: "测试在收集阶段就失败了，本实验不产生证据。",
};

type ReactNodeLike = {props?: {children?: unknown}} | string | number | null | undefined;

function renderText(node: ReactNodeLike): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderText).join("");
  const props = (node as {props?: {children?: unknown}}).props;
  return renderText((props?.children ?? null) as ReactNodeLike);
}

describe("TeachingView", () => {
  it("正例展示拿走的代码、变化的测试与可下结论的依据", () => {
    const text = renderText(TeachingView({narration: covered}));
    expect(text).toContain("cart.py");
    expect(text).toContain("passed → failed");
    expect(text).toContain("教学视图");
    expect(text).toContain(covered.why_conclusive);
  });

  it("未覆盖例与收集失败例都带明确的不可结论标识", () => {
    for (const narration of [notCovered, collectionBroken]) {
      const text = renderText(TeachingView({narration}));
      expect(text).toContain("本例不能作为测试证据结论");
      expect(text).toContain(teachingOutcomeLabel(narration.outcome));
    }
    expect(teachingOutcomeLabel("not_covering")).toContain("不能下结论");
    expect(teachingOutcomeLabel("inconclusive_collection_failure")).toContain("实验无效");
  });

  it("边界文案始终展示：不做评分、不代表对作业的评价", () => {
    const text = renderText(TeachingView({narration: covered}));
    expect(text).toContain(covered.conclusion_boundary);
  });
});
