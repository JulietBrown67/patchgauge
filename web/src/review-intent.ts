// U02/N06：一次审查只允许一个目标对象。演示案例与自定义入口各自生成
// ReviewIntent；提示词、验收要求、任务标题都从它派生，创建请求与运行
// 前摘要消费同一份数据。用户的临时输入按案例保留，切换案例不静默覆盖。
export type ReviewIntent = {
  source: "preset" | "custom";
  presetId?: string;
  title: string;
  instruction: string;
  criteria: string[];
  userEdited: boolean;
};

export type PresetContract = {
  preset_id: string;
  display_name: string;
  goal: string;
  recommended_criteria?: string[];
};

export type IntentDrafts = Record<string, string>;

export const CUSTOM_DRAFT_KEY = "__custom__";

export function draftKey(intent: {source: "preset" | "custom"; presetId?: string}): string {
  return intent.source === "preset" && intent.presetId ? intent.presetId : CUSTOM_DRAFT_KEY;
}

export function recommendedText(preset: PresetContract): string {
  return (preset.recommended_criteria || []).join("\n");
}

/** 演示案例的目标对象：指令用案例提示词；验收要求用推荐或该案例的草稿。 */
export function presetIntent(preset: PresetContract, draft: string): ReviewIntent {
  const recommended = recommendedText(preset);
  const trimmed = draft.trim();
  return {
    source: "preset",
    presetId: preset.preset_id,
    title: preset.display_name || preset.goal,
    instruction: preset.goal,
    criteria: trimmed ? linesOf(trimmed) : (preset.recommended_criteria || []),
    userEdited: Boolean(trimmed) && trimmed !== recommended,
  };
}

/** 自定义入口的目标对象：指令是用户目标；验收要求独立成行。 */
export function customIntent(goal: string, draft: string): ReviewIntent {
  return {
    source: "custom",
    title: goal.trim() || "自定义审查",
    instruction: goal.trim(),
    criteria: linesOf(draft),
    userEdited: Boolean(draft.trim()),
  };
}

export function linesOf(text: string): string[] {
  return text.split("\n").map(value => value.trim()).filter(Boolean);
}

/**
 * 切换案例：先把当前草稿记在原案例名下，再取新案例的草稿。没有草稿
 * 时保持空输入——推荐要求通过建议区展示（Tab/按钮采纳），创建时由
 * presetIntent 兜底，不把推荐直接写进输入框冒充用户输入。这样成绩单
 * 改过的要求切到抢课不会被带走，切回来时也还在。
 */
export function switchPresetDraft(options: {
  drafts: IntentDrafts; fromKey: string; toKey: string; currentDraft: string;
}): {drafts: IntentDrafts; nextDraft: string} {
  const drafts = {...options.drafts, [options.fromKey]: options.currentDraft};
  const stored = drafts[options.toKey];
  return {drafts, nextDraft: stored !== undefined ? stored : ""};
}

/**
 * 空输入建议（Tab 接受）：只有当输入框为空且建议尚未被关闭时提供。
 * 建议只是推荐，不把内容写成“已证实”；接受后进入正常编辑态。
 */
export function suggestionFor(draft: string, recommended: string, dismissed: boolean): string | null {
  if (!draft.trim() && recommended.trim() && !dismissed) return recommended;
  return null;
}

/** 确认建议＝把推荐文本写入草稿；再次编辑时保持用户内容优先。 */
export function acceptSuggestion(recommended: string): string {
  return recommended;
}
