import {describe, expect, it} from "vitest";
import {actionCapability, canTaskAction, candidateChipInput, closurePulseOf, mappingRequest,
  taskErrorText, taskOutcomeLabel, type EvidenceTask,
  taskRequirements, taskLink, adaptRoundRow,
  groupFindings, isNonBehaviorFinding, recommendedFindingIds, MAX_FINDING_REFS,
  type TaskCriterion} from "./TaskClosure";

describe("处置回执语义边界", () => {
  it("执行完成或陌生状态不会被解释为补证成功", () => {
    expect(taskOutcomeLabel("reviewed")).toBe("未识别结论：reviewed");
    expect(taskOutcomeLabel()).toBe("尚无复验结论");
    expect(taskOutcomeLabel("accepted_risk")).toContain("缺口保留");
    expect(taskOutcomeLabel("supported")).toBe("目标具备测试依据");
  });
  it("操作仅由服务端允许动作决定，prepared不隐含授权", () => {
    const criterion = {status: "prepared", allowed_actions: []} as unknown as TaskCriterion;
    expect(canTaskAction(criterion, "confirm_adoption")).toBe(false);
    expect(canTaskAction({...criterion, allowed_actions: ["confirm_adoption"]}, "confirm_adoption")).toBe(true);
  });
  it("要求只保存用户输入，不自动关联或签发缺口结论", () => {
    expect(taskRequirements("  正常输入有测试依据\n\n异常输入有测试依据  ")).toEqual([
      {text: "正常输入有测试依据", finding_ids: []}, {text: "异常输入有测试依据", finding_ids: []},
    ]);
  });
  it("任务链接不携带会话凭据", () => {
    expect(taskLink("task-1&token=secret")).toBe("#task=task-1%26token%3Dsecret");
  });
});

describe("U10 补测能力与错误映射", () => {
  const blocked = {enabled: false, code: "REPAIR_NOT_AUTHORIZED",
    reason: "本次审查创建时未授权生成补测候选（冻结授权不含补测权限）。",
    recovery: "configure_new_review" as const};
  it("服务端未提供能力投影时保持旧口径，提供时按投影读取", () => {
    const legacy = {status: "selected", allowed_actions: ["propose_test"]} as unknown as TaskCriterion;
    expect(actionCapability(legacy, "propose_test")).toBeUndefined();
    const projected = {...legacy,
      action_capabilities: {propose_test: blocked}} as unknown as TaskCriterion;
    expect(actionCapability(projected, "propose_test")).toMatchObject({enabled: false});
  });
  it("授权被拒的稳定错误码映射为中文原因与恢复指引", () => {
    class Coded extends Error {
      constructor(public code: string) {super("test proposal was not approved");}
    }
    const text = taskErrorText(new Coded("REPAIR_NOT_AUTHORIZED"));
    expect(text).toContain("未授权生成补测候选");
    expect(text).toContain("REPAIR_NOT_AUTHORIZED");
    expect(taskErrorText(new Coded("SOURCE_SNAPSHOT_CHANGED"))).toContain("源码在审查后已变化");
    // 未知码回退原始消息，不猜测原因。
    expect(taskErrorText(new Coded("SOMETHING_NEW"))).toBe("test proposal was not approved");
    expect(taskErrorText(new Error("网络中断"))).toBe("网络中断");
    expect(taskErrorText("not-an-error")).toContain("请求未完成");
  });
});

describe("U11 第六步导航状态来自真实任务回执", () => {
  const criterion = (outcome?: string) => ({criterion_id: "c1", text: "t",
    finding_ids: [], status: "pending", allowed_actions: [],
    outcome: outcome ? {status: outcome} : undefined} as unknown as TaskCriterion);
  it("没有任务或没有验收项时不显示完成", () => {
    expect(closurePulseOf(undefined)).toBe("none");
    expect(closurePulseOf({task_id: "t", criteria: []} as unknown as EvidenceTask)).toBe("none");
  });
  it("任务失败、实验未完成都只能是处置进行中，不得显示完成", () => {
    expect(closurePulseOf({task_id: "t", criteria: [criterion()]} as unknown as EvidenceTask)).toBe("pending");
    expect(closurePulseOf({task_id: "t",
      criteria: [criterion("inconclusive")]} as unknown as EvidenceTask)).toBe("pending");
    expect(closurePulseOf({task_id: "t",
      criteria: [criterion("pending")]} as unknown as EvidenceTask)).toBe("pending");
  });
  it("全部 supported 或人工接受风险才算已有结论；观察到缺口单独标记", () => {
    expect(closurePulseOf({task_id: "t",
      criteria: [criterion("supported"), criterion("accepted_risk")]} as unknown as EvidenceTask)).toBe("done");
    expect(closurePulseOf({task_id: "t",
      criteria: [criterion("gap_remains")]} as unknown as EvidenceTask)).toBe("gap");
  });
});

describe("N03 发现分组与推荐绑定", () => {
  const findings = [
    {file: "stats.py", line: 8, label: "未标注", text: ""},
    {file: "stats.py", line: 9, label: "承重", text: "def grade_label(score):"},
    {file: "stats.py", line: 17, label: "无据", text: "def to_gpa(courses):"},
    {file: "stats.py", line: 29, label: "无据", text: "def weighted_gpa(courses):"},
    {file: "stats.py", line: 12, label: "未标注", text: "# comment"},
  ];
  it("空行与注释归入非行为组，分组按文件聚合", () => {
    expect(isNonBehaviorFinding(findings[0])).toBe(true);
    expect(isNonBehaviorFinding(findings[4])).toBe(true);
    expect(isNonBehaviorFinding(findings[2])).toBe(false);
    const groups = groupFindings(findings);
    expect(groups).toHaveLength(1);
    expect(groups[0].behavior.map(f => f.line)).toEqual([9, 17, 29]);
    expect(groups[0].nonBehavior.map(f => f.line)).toEqual([8, 12]);
  });
  it("绩点类目标推荐 to_gpa/weighted_gpa 等相关无据行，且不超过服务端上限", () => {
    const ids = recommendedFindingIds(findings,
      "检查新增绩点换算和加权计算是否有测试依据（to_gpa / weighted_gpa）");
    expect(ids).toContain("stats.py:17");
    expect(ids).toContain("stats.py:29");
    expect(ids).not.toContain("stats.py:8");
    expect(ids.length).toBeLessThanOrEqual(MAX_FINDING_REFS);
    // 空行注释永远不进推荐。
    expect(recommendedFindingIds([{file: "a.py", line: 1, label: "未标注", text: ""}], "补测依据"))
      .toEqual([]);
  });
});

describe("N04 接线适配器", () => {
  it("服务端轮次行折成轮次视图契约；结论缺失时按待检查处理", () => {
    const row = {round_id: "round-1", round_no: 2, status: "superseded",
      supersede_reason: "adoption_applied", requirement_version: "req-0001",
      created_at: 1, closed_at: 2,
      criteria_outcomes: [{criterion_id: "c1", status: "reviewed", outcome_status: "supported"},
        {criterion_id: "c2", status: "pending", outcome_status: ""}]};
    const view = adaptRoundRow(row);
    expect(view.status).toBe("superseded");
    expect(view.criteria).toEqual([
      {criterion_id: "c1", outcome: "supported"},
      {criterion_id: "c2", outcome: "pending"}]);
  });
  it("候选徽标只映射服务端真实记录的维度", () => {
    const adopted = {status: "reviewed", candidate: {patch_sha256: "a".repeat(64),
      verification: {status: "VERIFIED_EFFECTIVE", visa: {status: "VERIFIED_EFFECTIVE"}}}} as unknown as TaskCriterion;
    const chips = candidateChipInput(adopted);
    expect(chips.adoption.status).toBe("applied");
    expect(chips.verification.status).toBe("passed");
    expect(chips.visa?.status).toBe("eligible");
    const fresh = {status: "pending", candidate: null} as unknown as TaskCriterion;
    expect(candidateChipInput(fresh).adoption.status).toBe("not_prepared");
    expect(candidateChipInput(fresh).visa).toBeUndefined();
  });
  it("映射确认只对 needs_confirmation 的项生成请求；确认不改变结论", () => {
    const criterion = {target_mapping: {mappings: [
      {mapping_id: "m1", status: "mapped"},
      {mapping_id: "m2", status: "needs_confirmation", reason: "duplicate_code",
        origin: {file: "pkg/a.py", line: 10},
        candidates: [{file: "pkg/a.py", line: 12, basis: "patch"}]}]}} as unknown as TaskCriterion;
    const request = mappingRequest(criterion);
    expect(request?.mapping_id).toBe("m2");
    expect(request?.candidates[0]).toMatchObject({path: "pkg/a.py", start_line: 12, basis: "patch"});
    expect(mappingRequest({target_mapping: {mappings: [{mapping_id: "m1", status: "mapped"}]}} as unknown as TaskCriterion)).toBeNull();
  });
});
