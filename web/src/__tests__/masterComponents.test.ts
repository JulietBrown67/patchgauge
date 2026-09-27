/* T06 组件先行测试：仓库没有 jsdom/@testing-library（vitest 跑在 node 环境），
   按既有约定只测组件模块导出的纯函数；渲染与交互留给 web/e2e。 */

import {describe, expect, it} from "vitest";
import {
  outcomeLabel, roundConclusion, roundPendingRechecks, roundsView, supersedeReasonLabel,
  type TaskRound,
} from "../master/RoundHistoryView";
import {
  budgetView, canCancel, canResume, isTerminal, jobPhaseRows, jobStatusLabel,
  jobStopReasonLabel, recoveryHint, type JobView,
} from "../master/JobProgressView";
import {
  CONFIRMATION_BOUNDARY_NOTE, confirmPayload, mappingCandidatesView, mappingReasonLabel,
  type MappingRequest,
} from "../master/MappingConfirmation";
import {
  adoptionLabel, candidateChips, reverificationLabel, visaLabel,
  type CandidateChipInput,
} from "../master/CandidateStatusChips";

function round(overrides: Partial<TaskRound>): TaskRound {
  return {
    round_id: "round-a", round_no: 1, status: "active",
    requirement_version: "req-aaaa1111",
    criteria: [{criterion_id: "c1", outcome: "supported"}],
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("RoundHistoryView：轮次分组与取代原因", () => {
  const rounds: TaskRound[] = [
    round({round_id: "round-1", round_no: 1, status: "superseded",
      superseded_by: "round-2", supersede_reason: "resumed_legacy", closed_at: 123}),
    round({round_id: "round-2", round_no: 2, status: "superseded",
      superseded_by: "round-3", supersede_reason: "requirement_changed", closed_at: 456}),
    round({round_id: "round-3", round_no: 3, status: "active"}),
  ];

  it("区分当前轮次与历史轮次，历史按轮次号倒序", () => {
    const view = roundsView(rounds, "round-3");
    expect(view.invalidReason).toBeNull();
    expect(view.active?.round_id).toBe("round-3");
    expect(view.history.map(item => item.round_no)).toEqual([2, 1]);
  });

  it("数据不符合契约时如实报错，不猜测当前轮次", () => {
    expect(roundsView([...rounds, round({round_id: "round-4", round_no: 4})]).invalidReason)
      .toBe("存在多个 active 轮次，数据不符合轮次契约");
    expect(roundsView(rounds.slice(0, 2)).invalidReason).toBe("没有 active 轮次");
    expect(roundsView(rounds, "round-9").invalidReason)
      .toBe("active_round_id(round-9) 与轮次列表不一致");
    const empty = roundsView([]);
    expect(empty.active).toBeNull();
    expect(empty.invalidReason).toBeNull();
  });

  it("四种取代原因有稳定文案，未知原因不冒充已知", () => {
    expect(supersedeReasonLabel("adoption_applied")).toBe("采用成功，进入新轮次");
    expect(supersedeReasonLabel("requirement_changed")).toContain("要求修改");
    expect(supersedeReasonLabel("reverify_new_snapshot")).toContain("重新核验");
    expect(supersedeReasonLabel("resumed_legacy")).toContain("轮次1");
    expect(supersedeReasonLabel("mystery")).toBe("未识别原因：mystery");
    expect(supersedeReasonLabel(undefined)).toBe("未记录取代原因");
  });
});

describe("RoundHistoryView：待复验条件与聚合口径", () => {
  it("采用成功后的新轮次把验收项保守标记为待复核，任务级结论不可判定", () => {
    const newRound = round({round_id: "round-2", round_no: 2, criteria: [
      {criterion_id: "c1", outcome: "pending_recheck"},
      {criterion_id: "c2", outcome: "supported"},
    ]});
    expect(roundPendingRechecks(newRound).map(item => item.criterion_id)).toEqual(["c1"]);
    const conclusion = roundConclusion(newRound);
    expect(conclusion.level).toBe("inconclusive");
    expect(conclusion.label).toContain("暂时无法判定");
  });

  it("未检查项不能因其他项通过而完成；全部有结论才算完成", () => {
    const pending = round({criteria: [
      {criterion_id: "c1", outcome: "supported"}, {criterion_id: "c2", outcome: "pending"}]});
    expect(roundConclusion(pending).level).toBe("inconclusive");
    const decided = round({criteria: [
      {criterion_id: "c1", outcome: "supported"}, {criterion_id: "c2", outcome: "gap_remains"}]});
    expect(roundConclusion(decided).level).toBe("complete");
    expect(roundConclusion(round({criteria: []})).level).toBe("empty");
    expect(outcomeLabel("gap_remains")).toBe("仍有证据缺口");
    expect(outcomeLabel("weird")).toBe("未识别结论：weird");
  });
});

describe("JobProgressView：状态、预算与恢复", () => {
  const job: JobView = {
    job_id: "job-abc123", kind: "domain_experiment", status: "running",
    created_at: 1, started_at: 100,
    phases: [
      {name: "prepare", started_at: 100, ended_at: 150, status: "done"},
      {name: "execute", started_at: 150, ended_at: 0, status: "running"},
    ],
    budget: {budget_id: "budget-1", reserved: 60, settled: 12, currency: "seconds"},
  };

  it("作业状态与停止原因有稳定文案，未知值如实暴露", () => {
    expect(jobStatusLabel("needs_recovery")).toBe("需要恢复处理");
    expect(jobStatusLabel("teleported")).toBe("未识别状态：teleported");
    expect(jobStopReasonLabel("budget_exhausted")).toBe("预算耗尽");
    expect(jobStopReasonLabel("")).toBeNull();
    expect(jobStopReasonLabel(undefined)).toBeNull();
    expect(jobStopReasonLabel("alien")).toBe("未识别停止原因：alien");
  });

  it("共享预算分列预留/结算/剩余，结算超出预留时显式提示", () => {
    const view = budgetView(job.budget)!;
    expect(view.remaining).toBe(48);
    expect(view.label).toContain("剩余 48 秒");
    expect(view.overSettled).toBe(false);
    const over = budgetView({budget_id: "b", reserved: 10, settled: 12, currency: "units"})!;
    expect(over.overSettled).toBe(true);
    expect(over.label).toContain("结算超出预留 2 个单位");
    expect(budgetView(undefined)).toBeNull();
  });

  it("阶段行给出状态与时长，运行中阶段不计时长", () => {
    const rows = jobPhaseRows(job.phases);
    expect(rows[0]).toEqual({name: "prepare", statusLabel: "完成", durationMs: 50, running: false});
    expect(rows[1]).toEqual({name: "execute", statusLabel: "进行中", durationMs: 0, running: true});
    expect(jobPhaseRows(undefined)).toEqual([]);
  });

  it("取消只对排队/运行开放；恢复只对 needs_recovery 开放", () => {
    expect(canCancel(job)).toBe(true);
    expect(canCancel({...job, status: "queued"})).toBe(true);
    expect(canCancel({...job, status: "completed"})).toBe(false);
    expect(canResume({...job, status: "needs_recovery"})).toBe(true);
    expect(canResume({...job, status: "interrupted"})).toBe(false);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("needs_recovery")).toBe(true);
    expect(canCancel({...job, status: "stopping"})).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });

  it("恢复提示要求先核对文件状态；中断与恢复是两种状态", () => {
    expect(recoveryHint({...job, status: "needs_recovery"})).toContain("核对实际文件状态");
    expect(recoveryHint({...job, status: "needs_recovery"})).toContain("不会盲目重放写入");
    expect(recoveryHint({...job, status: "interrupted"})).toContain("中断");
    expect(recoveryHint({...job, status: "stopping"})).toContain("等待归属");
    expect(recoveryHint({...job, status: "completed"})).toBeNull();
  });
});

describe("MappingConfirmation：歧义确认只确认目标身份", () => {
  const request: MappingRequest = {
    mapping_id: "map-1", needs_confirmation: true, reason: "duplicate_code",
    original: {path: "src/app.py", start_line: 10, end_line: 24},
    candidates: [
      {target_id: "t1", path: "src/app.py", start_line: 12, end_line: 26, basis: "patch_location"},
      {target_id: "t2", path: "src/app_copy.py", start_line: 12, end_line: 26, basis: "context"},
    ],
  };

  it("候选列表逐条给出位置与定位依据", () => {
    const view = mappingCandidatesView(request);
    expect(view.empty).toBe(false);
    expect(view.rows[0]).toEqual(
      {target_id: "t1", label: "src/app.py:12-26", basis: "patch_location"});
    expect(view.rows[1].label).toBe("src/app_copy.py:12-26");
  });

  it("没有候选时不允许确认，原因文案不冒充已知类别", () => {
    const empty = mappingCandidatesView({...request, candidates: []});
    expect(empty.empty).toBe(true);
    expect(empty.rows).toEqual([]);
    expect(mappingReasonLabel("duplicate_code")).toContain("重复代码");
    expect(mappingReasonLabel("odd_case")).toBe("需人工确认：odd_case");
  });

  it("确认动作的载荷符合 confirm_target_mapping 契约", () => {
    expect(confirmPayload(request, true, "  已人工核对  "))
      .toEqual({mapping_id: "map-1", confirmed: true, operator_note: "已人工核对"});
    expect(confirmPayload(request, false, "").confirmed).toBe(false);
  });

  it("对话框固定展示边界：确认不等于复验结论", () => {
    expect(CONFIRMATION_BOUNDARY_NOTE).toContain("仍必须真实复验");
    expect(CONFIRMATION_BOUNDARY_NOTE).toContain("不会直接生成成功结论");
  });
});

describe("CandidateStatusChips：五个维度分开表示", () => {
  it("已采用、复验中、复验失败、有效签证、人工接受风险各有独立徽标", () => {
    const adopted = candidateChips({candidate_id: "c1", adoption: {status: "applied"}});
    expect(adopted).toEqual([
      {key: "adopted", label: "已采用", tone: "info", dimension: "adoption"}]);

    const reverifyRunning = candidateChips({candidate_id: "c1", adoption: {status: "applied"},
      reverification: {status: "running"}});
    expect(reverifyRunning.map(chip => chip.key)).toEqual(["adopted", "reverify_running"]);
    expect(reverifyRunning[1].label).toBe("复验中");

    const reverifyFailed = candidateChips({candidate_id: "c1", reverification: {status: "failed"}});
    expect(reverifyFailed[0]).toEqual(
      {key: "reverify_failed", label: "复验失败", tone: "bad", dimension: "reverification"});

    const visa = candidateChips({candidate_id: "c1", visa: {status: "eligible"}});
    expect(visa[0]).toEqual(
      {key: "visa_eligible", label: "有效签证", tone: "ok", dimension: "visa"});

    const risk = candidateChips({candidate_id: "c1",
      riskAcceptance: {accepted: true, reason: "用户确认"}});
    expect(risk[0]).toEqual(
      {key: "risk_accepted", label: "人工接受风险", tone: "warn", dimension: "risk_acceptance"});
  });

  it("资格不足是独立标记：与签证扣留同时出现，不互相合并", () => {
    const chips = candidateChips({candidate_id: "c1",
      visa: {status: "withheld_small_case"}, adoption: {status: "applied"},
      riskAcceptance: {accepted: true}, qualificationInsufficient: true});
    expect(chips.map(chip => chip.key)).toEqual(
      ["adopted", "visa_withheld", "risk_accepted", "qualification_insufficient"]);
    const qualification = chips.find(chip => chip.key === "qualification_insufficient")!;
    expect(qualification.dimension).toBe("qualification");
    expect(qualification.label).toContain("资格不足");
    expect(qualification.label).toContain("人工接受");
    expect(new Set(chips.map(chip => chip.key)).size).toBe(chips.length);
  });

  it("一个维度不冒充另一个维度：签证不产生采用徽标，执行失败不产生复验结论", () => {
    const onlyVisa = candidateChips({candidate_id: "c1", visa: {status: "eligible"}});
    expect(onlyVisa.some(chip => chip.dimension === "adoption")).toBe(false);
    const execFailed = candidateChips({candidate_id: "c1",
      verification: {status: "failed"}});
    expect(execFailed.map(chip => chip.key)).toEqual(["verification_failed"]);
    expect(execFailed.some(chip => chip.dimension === "reverification")).toBe(false);
    expect(candidateChips({candidate_id: "c1"})).toEqual([]);
  });

  it("未知枚举值通过查询函数如实回显，不静默归类", () => {
    expect(visaLabel("maybe")).toBe("未识别签证状态：maybe");
    expect(adoptionLabel("half")).toBe("未识别采用状态：half");
    expect(reverificationLabel("soon")).toBe("未识别复验状态：soon");
  });
});
