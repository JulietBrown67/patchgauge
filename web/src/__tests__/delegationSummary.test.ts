import {describe, expect, it} from "vitest";
import {aggregateEvidence, needsReverify, nextAction, summarizeTask,
  type EvidenceTask} from "../TaskClosure";
import {delegationEventLabel, delegationStatusLabel, delegationTone,
  expiryLabel, remainingQuotaLabel, type DelegationView} from "../master/DelegationCard";

function task(partial: Partial<EvidenceTask>): EvidenceTask {
  return {schema_version: "evidence-task-v1", task_id: "task-" + "a".repeat(24),
    origin_review_id: "r1", title: "测试任务",
    criteria: [{criterion_id: "criterion-1", text: "目标行为有依据", finding_ids: [],
      status: "pending", allowed_actions: ["select_disposition"]}],
    ...partial};
}

describe("P0-02 任务摘要", () => {
  it("证据聚合遵守'未完成项不让整体通过'", () => {
    expect(aggregateEvidence(task({})).status).toBe("pending");
    const supported = task({criteria: [{criterion_id: "c1", text: "t", finding_ids: [],
      status: "reviewed", allowed_actions: [], outcome: {status: "supported"}}]});
    expect(aggregateEvidence(supported)).toEqual(
      {status: "supported", label: "当前验收项都有测试依据", tone: "ok"});
    const mixed = task({criteria: [
      {criterion_id: "c1", text: "t", finding_ids: [], status: "reviewed", allowed_actions: [],
        outcome: {status: "supported"}},
      {criterion_id: "c2", text: "t", finding_ids: [], status: "reviewed", allowed_actions: [],
        outcome: {status: "pending"}}]});
    expect(aggregateEvidence(mixed).status).toBe("pending");
    const regression = task({criteria: [{criterion_id: "c1", text: "t", finding_ids: [],
      status: "reviewed", allowed_actions: [], outcome: {status: "gap_remains"}}]});
    expect(aggregateEvidence(regression).status).toBe("regression_observed");
    const incomplete = task({criteria: [{criterion_id: "c1", text: "t", finding_ids: [],
      status: "reviewed", allowed_actions: [], outcome: {status: "inconclusive"}}]});
    expect(aggregateEvidence(incomplete).label).toContain("暂时无法判定");
  });
  it("源码快照失配或待复核项标记需要复验", () => {
    const moved = task({criteria: [{criterion_id: "c1", text: "t", finding_ids: [],
      status: "reviewed", allowed_actions: [], source_snapshot_matches: false,
      outcome: {status: "supported"}}]});
    expect(needsReverify(moved)).toBe(true);
    expect(nextAction(moved)?.kind).toBe("reverify");
  });
  it("下一步随状态推进：处置→候选→采用→领取回执", () => {
    const pending = task({});
    expect(nextAction(pending)).toEqual(
      {label: "为验收项选择处置路径", kind: "scroll", criterion_id: "criterion-1"});
    const prepared = task({criteria: [{criterion_id: "c1", text: "t", finding_ids: [],
      status: "prepared", allowed_actions: ["confirm_adoption"]}]});
    expect(nextAction(prepared)?.label).toBe("确认采用并复验");
    const supported = task({criteria: [{criterion_id: "c1", text: "t", finding_ids: [],
      status: "reviewed", allowed_actions: [], outcome: {status: "supported"}}]});
    expect(nextAction(supported)?.kind).toBe("receipt");
    const summary = summarizeTask(supported);
    expect(summary.version).toContain("初始版本");
    expect(summary.goals).toHaveLength(1);
  });
});

describe("P0-02 持续委托卡", () => {
  const auth: DelegationView = {auth_id: "auth-" + "b".repeat(24), task_id: "task-" + "a".repeat(24),
    requirement_version: "req-0001", created_at: 0, expires_at: 0,
    max_reverify: 3, used_reverify: 1, status: "active", derived_status: "active",
    remaining_reverify: 2, seconds_remaining: 300};
  it("状态文案与语义色：有效=青绿，待注意=琥珀，停止=红", () => {
    expect(delegationTone("active")).toBe("ok");
    expect(delegationTone("expired")).toBe("warn");
    expect(delegationTone("needs_reconfirm")).toBe("warn");
    expect(delegationTone("stopped")).toBe("danger");
    expect(delegationStatusLabel(auth)).toBe("委托有效");
    expect(delegationStatusLabel({...auth, derived_status: "needs_reconfirm"}))
      .toContain("重新确认");
  });
  it("额度与到期只陈述服务端数字", () => {
    expect(remainingQuotaLabel(auth)).toBe("剩余复验额度 2 / 3 次");
    expect(remainingQuotaLabel({...auth, remaining_reverify: undefined})).toBe("剩余复验额度 2 / 3 次");
    expect(expiryLabel(auth)).toBe("约 5 分钟后到期");
    expect(expiryLabel({...auth, seconds_remaining: 0})).toBe("授权期限已过");
  });
  it("事件种类都有可读名称，不暴露原始 kind 给用户", () => {
    expect(delegationEventLabel("check_no_change")).toContain("无变化");
    expect(delegationEventLabel("reverify_dispatched")).toContain("投递复验");
    expect(delegationEventLabel("brand_new_kind")).toContain("brand_new_kind");
  });
});
