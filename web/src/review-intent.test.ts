import {describe, expect, it} from "vitest";
import {
  CUSTOM_DRAFT_KEY, acceptSuggestion, customIntent, draftKey, linesOf,
  presetIntent, recommendedText, suggestionFor, switchPresetDraft,
  type PresetContract,
} from "./review-intent";

const gradePreset: PresetContract = {
  preset_id: "grade-report-gpa", display_name: "无据：成绩单的绩点换算没有证据",
  goal: "检查新增绩点换算和加权计算是否有测试依据，重点关注不及格课程、空记录和零学分。",
  recommended_criteria: [
    "新增绩点换算（含不及格课程）有具名测试依据",
    "加权计算在空记录与零学分下有测试依据",
  ],
};
const coursePreset: PresetContract = {
  preset_id: "course-grab-retry", display_name: "承重：抢课脚本的重试被测试直接约束",
  goal: "验证抢课请求的新增重试与退避逻辑是否受到声明测试约束。",
  recommended_criteria: ["移除重试与退避代码后存在具名失败测试"],
};

describe("U02 案例配套目标", () => {
  it("演示案例的目标对象从同一预设派生指令、标题与验收要求", () => {
    const intent = presetIntent(gradePreset, "");
    expect(intent).toMatchObject({source: "preset", presetId: "grade-report-gpa",
      instruction: gradePreset.goal, userEdited: false});
    expect(intent.criteria).toEqual(gradePreset.recommended_criteria);
    expect(intent.title).toContain("绩点");
  });
  it("旧预设没有推荐字段时如实回退，不捏造验收要求", () => {
    const legacy = {...gradePreset, recommended_criteria: undefined};
    expect(presetIntent(legacy, "").criteria).toEqual([]);
    expect(recommendedText(legacy)).toBe("");
  });
  it("用户改动过的要求标记 userEdited，空草稿回落推荐", () => {
    expect(presetIntent(gradePreset, "自定义第一条\n\n自定义第二条").criteria)
      .toEqual(["自定义第一条", "自定义第二条"]);
    expect(presetIntent(gradePreset, "自定义").userEdited).toBe(true);
    expect(presetIntent(gradePreset, "").userEdited).toBe(false);
  });
});

describe("U02 切换案例不串用要求", () => {
  it("成绩单改过的要求切到抢课后不出现，切回后仍在", () => {
    const first = switchPresetDraft({drafts: {}, fromKey: "grade-report-gpa",
      toKey: "course-grab-retry", currentDraft: "绩点要求（用户手改）"});
    expect(first.drafts["grade-report-gpa"]).toBe("绩点要求（用户手改）");
    // 新案例没有草稿：保持空输入，推荐要求走建议区，不冒充用户输入。
    expect(first.nextDraft).toBe("");
    const back = switchPresetDraft({drafts: first.drafts, fromKey: "course-grab-retry",
      toKey: "grade-report-gpa", currentDraft: first.nextDraft});
    expect(back.nextDraft).toBe("绩点要求（用户手改）");
  });
  it("自定义入口的草稿独立存放，不与案例混用", () => {
    expect(draftKey({source: "custom"})).toBe(CUSTOM_DRAFT_KEY);
    expect(draftKey({source: "preset", presetId: "p1"})).toBe("p1");
  });
});

describe("U02 空输入建议（Tab 接受）", () => {
  it("仅在输入为空且建议可见时提供", () => {
    const recommended = recommendedText(gradePreset);
    expect(suggestionFor("", recommended, false)).toBe(recommended);
    expect(suggestionFor("已有内容", recommended, false)).toBeNull();
    expect(suggestionFor("", recommended, true)).toBeNull();
    expect(suggestionFor("", "", false)).toBeNull();
  });
  it("接受建议＝填入推荐文本；多余空白行被过滤成验收项", () => {
    expect(acceptSuggestion("a\nb")).toBe("a\nb");
    expect(linesOf(" a \n\n b ")).toEqual(["a", "b"]);
  });
});

describe("N06 自定义入口目标对象", () => {
  it("自定义指令与验收要求同源，空目标不捏造标题", () => {
    const intent = customIntent("  检查分摊脚本的接入  ", "第一条\n第二条");
    expect(intent.instruction).toBe("检查分摊脚本的接入");
    expect(intent.criteria).toEqual(["第一条", "第二条"]);
    expect(customIntent("", "").title).toBe("自定义审查");
  });
});
