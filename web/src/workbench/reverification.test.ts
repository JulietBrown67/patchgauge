import {describe, expect, it} from "vitest";
import {
  answeredLabel, CHALLENGE_REASONS, DEFAULT_CHALLENGE_REASON, evidenceDeltaRows,
  observationsCount, openItemLabel, outcomeReasonView, strategyLabel, testProposalView,
  outcomeClass, outcomeLabel, outcomeSummary, reasonLabel,
  reverificationForComment,
  statusLabel,
  validateChallengeInput, type ReverificationRecord,
} from "./reverification";

function record(
    overrides: Partial<ReverificationRecord> = {}): ReverificationRecord {
  return {
    reverification_id: "rvf-000001", review_id: "r1",
    comment_id: "cmt-000001", claim_id: "claim-1",
    reason: "flaky_result_suspected", explanation: "",
    status: "planned", outcome: null,
    plan: {replay_experiments: [{experiment_id: "claim-1"}],
      comparison: "vector_diff_against_original_experiment"},
    ...overrides,
  };
}

describe("challenge reasons", () => {
  it("keeps the closed seven options from the plan", () => {
    expect(CHALLENGE_REASONS).toHaveLength(7);
    expect(CHALLENGE_REASONS.map(item => item.value)).toEqual([
      "test_did_not_execute_code", "collection_crash_suspected",
      "flaky_result_suspected", "source_changed", "test_scope_incomplete",
      "new_test_available", "other_needs_explanation"]);
    expect(DEFAULT_CHALLENGE_REASON).toBe("test_did_not_execute_code");
  });

  it("only the other option requires a human explanation", () => {
    const needing = CHALLENGE_REASONS
      .filter(item => item.needsExplanation).map(item => item.value);
    expect(needing).toEqual(["other_needs_explanation"]);
  });
});

describe("labels", () => {
  it("maps statuses and outcomes to Chinese labels", () => {
    expect(statusLabel("planned")).toBe("等待确认");
    expect(statusLabel("settled")).toBe("已结算");
    expect(outcomeLabel("claim.confirmed")).toBe("结论确认");
    expect(outcomeLabel("claim.revised")).toBe("结论修订");
    expect(outcomeLabel("claim.withheld")).toBe("结论扣留");
    expect(outcomeLabel(null)).toBe("");
    expect(reasonLabel("source_changed")).toBe("代码已经变化");
  });

  it("maps outcomes to tone classes and falls back for unknowns", () => {
    expect(outcomeClass("claim.confirmed")).toBe("ok");
    expect(outcomeClass("claim.revised")).toBe("warn");
    expect(outcomeClass("claim.withheld")).toBe("hold");
    expect(outcomeClass(null)).toBe("");
    expect(statusLabel("nonsense")).toBe("nonsense");
    expect(reasonLabel("nonsense")).toBe("nonsense");
  });
});

describe("reverificationForComment", () => {
  it("returns the latest record for a comment", () => {
    const older = record({reverification_id: "rvf-000001"});
    const newer = record({reverification_id: "rvf-000002",
      status: "settled", outcome: "claim.confirmed"});
    expect(reverificationForComment([older, newer], "cmt-000001"))
      .toBe(newer);
  });

  it("returns null for comments without reverifications", () => {
    expect(reverificationForComment([], "cmt-000001")).toBeNull();
    expect(reverificationForComment(
      [record({comment_id: "cmt-000009"})], "cmt-000001")).toBeNull();
  });
});

describe("validateChallengeInput", () => {
  it("accepts a closed reason without an explanation", () => {
    expect(validateChallengeInput("flaky_result_suspected", "")).toBe("");
    expect(validateChallengeInput("source_changed", "  说明  ")).toBe("");
  });

  it("requires an explanation only for the other option", () => {
    expect(validateChallengeInput("other_needs_explanation", ""))
      .toBe("选择「其他」时必须补充人工说明");
    expect(validateChallengeInput("other_needs_explanation", "复跑两次结果不同"))
      .toBe("");
  });

  it("rejects open-ended reasons and overlong explanations", () => {
    expect(validateChallengeInput("because_i_think_so", ""))
      .toBe("请从闭合选项中选择质疑原因");
    expect(validateChallengeInput("flaky_result_suspected", "长".repeat(2001)))
      .toBe("说明最多 2000 字");
  });
});

describe("v2 strategy fields", () => {
  it("labels answered and unanswered challenges honestly", () => {
    expect(answeredLabel(record({answered: true}))).toBe("已回答");
    expect(answeredLabel(record({answered: false}))).toBe("未回答");
    // v1 记录没有该字段：如实标「未回答」，不假装回答过。
    expect(answeredLabel(record())).toBe("未回答");
  });

  it("renders open items with honest not-implemented wording", () => {
    expect(openItemLabel("not_implemented"))
      .toBe("历史记录：这条理由当时只复验了原实验；该原因现已有专属差异化实验");
    expect(openItemLabel("requires_human_judgment"))
      .toBe("这个问题无法用实验回答，已转人工判断");
     expect(openItemLabel("needs_new_experiment"))
       .toBe("needs_new_experiment");
     // 策略 4：签证扣留原样透出真实状态，不圆场。
     expect(openItemLabel("test_visa_withheld:WITHHELD_SMALL_CASE"))
       .toBe(
         "补测签证扣留（WITHHELD_SMALL_CASE）：用户提交的测试未被判定有效，不改判原结论");
   });
});

describe("outcome summaries follow the strategy, not one generic sentence", () => {
  it("names the three coverage_check endings differently", () => {
    expect(outcomeSummary(record({outcome: "claim.confirmed",
      strategy: "coverage_check"})))
      .toBe("失败的测试确实执行过被删的行：失败是这段代码的行为证据，原主张被确认。");
    expect(outcomeSummary(record({outcome: "claim.revised",
      strategy: "coverage_check"})))
      .toContain("没有任何失败的测试执行过被删的行");
    expect(outcomeSummary(record({outcome: "claim.withheld",
      strategy: "coverage_check"})))
      .toContain("覆盖率不可用");
  });

  it("separates collateral damage from behavioural evidence", () => {
    expect(outcomeSummary(record({outcome: "claim.confirmed",
      strategy: "collection_check"}))).toContain("行为性的");
    expect(outcomeSummary(record({outcome: "claim.revised",
      strategy: "collection_check"}))).toContain("连带损坏");
    expect(outcomeSummary(record({outcome: "claim.confirmed",
      strategy: "scope_widen"}))).toContain("原主张不变");
  });

  it("keeps the replay wording for replay strategies and v1 records", () => {
    expect(outcomeSummary(record({outcome: "claim.confirmed",
      strategy: "flaky_result_suspected"})))
      .toBe("复验观察到与原实验一致的状态向量，原主张被确认。");
    expect(outcomeSummary(record({outcome: "claim.revised"})))
      .toContain("复验结果与原观测不一致");
    expect(outcomeSummary(record({outcome: "claim.withheld"})))
      .toContain("结论被扣留");
    expect(outcomeSummary(record())).toBe("");
  });
});
+describe("v2 evidence visualisation", () => {
  it("labels every backend strategy and admits unknown ones verbatim", () => {
    expect(strategyLabel("coverage_check")).toBe("覆盖率核对");
    expect(strategyLabel("test_visa")).toBe("补测签证验证");
    expect(strategyLabel("scope_widen")).toBe("扩大收集范围重跑");
    expect(strategyLabel("human_routing")).toBe("转人工判断");
    expect(strategyLabel("collection_check")).toBe("只收集不执行");
    expect(strategyLabel("flaky_result_suspected")).toBe("多轮重跑对比");
    expect(strategyLabel("source_changed")).toBe("源码快照核对");
    expect(strategyLabel("replay_only")).toBe("原样重放（仅旧记录）");
    expect(strategyLabel("")).toBe("策略未记录（旧版复验）");
    expect(strategyLabel(undefined)).toBe("策略未记录（旧版复验）");
    expect(strategyLabel("future_strategy")).toBe("future_strategy");
  });

  it("renders coverage hit tests and admissibility without weakening them", () => {
    const rows = evidenceDeltaRows(record({
      status: "settled", outcome: "claim.confirmed",
      evidence_delta: {hit_tests: ["tests/test_core.py::test_required"],
        admissibility: "behavioural"},
    }));
    expect(rows).toEqual([
      {label: "执行过被删行的测试",
        value: "tests/test_core.py::test_required"},
      {label: "证据等级",
        value: "A 级 · 行为证据：失败测试确实执行过被删的行"},
    ]);
  });

  it("names the downgrade honestly when no test hit the lines", () => {
    const rows = evidenceDeltaRows(record({
      status: "settled", outcome: "claim.revised",
      evidence_delta: {admissibility: "indirect"},
    }));
    expect(rows).toEqual([{label: "证据等级",
      value: "B 级 · 间接证据：失败测试没有执行过被删的行"}]);
  });

  it("renders replay divergence, widen budget and visa protected claims", () => {
    expect(evidenceDeltaRows(record({
      evidence_delta: {divergent_experiments: ["claim-1"], replay_runs: 3},
    }))).toEqual([
      {label: "与原结果不一致的实验", value: "claim-1"},
      {label: "重放轮数", value: "3"},
    ]);
    expect(evidenceDeltaRows(record({
      evidence_delta: {widen_scope: {added_count: 40, capped: true}},
    }))).toEqual([{label: "扩大收集范围",
      value: "需新增 40 条测试，超出预算上限，已拒绝截断执行"}]);
    expect(evidenceDeltaRows(record({
      evidence_delta: {widen_scope: {added_count: 4}},
    }))).toEqual([{label: "扩大收集范围",
      value: "确定性扩跑，新增 4 条测试"}]);
    expect(evidenceDeltaRows(record({
      evidence_delta: {new_claim: "该行现受用户提交的测试保护",
        new_claim_id: "rvf-000001:protected",
        visa_status: "VERIFIED_EFFECTIVE",
        original_claim_grade_unchanged: true},
    }))).toEqual([
      {label: "新增受保护主张", value: "该行现受用户提交的测试保护"},
      {label: "补测签证",
        value: "签证通过：基线绿、干预后断言级失败、复跑一致"},
      {label: "原主张", value: "等级维持不变；新增主张不升级原结论"},
    ]);
  });

  it("surfaces unknown delta keys and ignores empty deltas", () => {
    expect(evidenceDeltaRows(record())).toEqual([]);
    expect(evidenceDeltaRows(record({evidence_delta: null}))).toEqual([]);
    const rows = evidenceDeltaRows(record({
      evidence_delta: {detail: {"baseline": "collected"}},
    }));
    expect(rows).toEqual([{label: "detail", value: '{"baseline":"collected"}'}]);
  });

  it("translates stable outcome reason codes and keeps free text verbatim", () => {
    expect(outcomeReasonView("requires_human_judgment"))
      .toEqual({label: "这个问题无法用实验回答，已转人工判断", technical: false});
    expect(outcomeReasonView("coverage_unavailable: no coverage data").label)
      .toBe("覆盖率数据不可用，无法核对：no coverage data");
    expect(outcomeReasonView("test_visa_withheld:WITHHELD_SMALL_CASE").label)
      .toContain("补测签证扣留（WITHHELD_SMALL_CASE）");
    expect(outcomeReasonView("some english sentence"))
      .toEqual({label: "some english sentence", technical: true});
    expect(outcomeReasonView("").label).toBe("");
    expect(outcomeReasonView(undefined).label).toBe("");
  });

  it("counts observations and exposes the challenge test proposal", () => {
    expect(observationsCount(undefined)).toBe(0);
    expect(observationsCount([{experiment_id: "claim-1"}])).toBe(1);
    expect(testProposalView(record())).toBeNull();
    expect(testProposalView(record({
      test_proposal: {patch: "--- a/x\n+++ b/x", patch_sha256: "a".repeat(64)},
    }))).toEqual({sha: "a".repeat(64), patch: "--- a/x\n+++ b/x"});
  });
});
