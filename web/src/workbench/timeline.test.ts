// 行动时间线的护栏测试：四泳道映射是纯函数，输入什么记录就出什么条目；
// 形状不对的账本行必须被跳过而不是炸掉整条泳道，缺数据的泳道如实为空。
import { describe, expect, it } from "vitest";
import { buildTimeline, TIMELINE_LANES } from "./timeline";
import type { EvidenceLine } from "./model";
import type { ReverificationRecord } from "./reverification";

const claimRow = {
  schema_version: 1, run_id: "r1", record_id: "c1", record_type: "Claim",
  payload: {
    kind: "RequiredByTest",
    anchor: {kind: "unit", snapshot_id: "S2", path: "calc.py",
      line_start: 3, line_end: 4},
    provenance: ["f1", "f2", "f3"],
    scope: {},
  },
};

const experimentRow = {
  schema_version: 1, run_id: "r1", record_id: "x1", record_type: "Experiment",
  payload: {
    kind: "DeleteUnit",
    anchor: {kind: "unit", snapshot_id: "S2", path: "calc.py",
      line_start: 3, line_end: 4},
    intervention: {kind: "DeleteUnit", path: "calc.py", lines: [3, 4],
      file_removed: false, describe: "删除 2 行（置空，保持行号）"},
    status: "COMPLETE", restored_clean: true, cost_s: 0.8,
    pre_fact_ids: ["f1"], post_fact_ids: ["f2", "f3"],
  },
};

const line = (over: Partial<EvidenceLine>): EvidenceLine => ({
  file: "calc.py", line: 3, label: "承重", reason: null,
  unit_id: "u1", admissibility: "A", evidence_ids: ["e1"], ...over,
});

const record = (over: Partial<ReverificationRecord>): ReverificationRecord => ({
  reverification_id: "rv1", review_id: "r", comment_id: "c",
  claim_id: "u1", reason: "flaky_result_suspected", status: "settled",
  outcome: "claim.confirmed", claim_revision: 2, answered: true,
  ...over,
});

describe("buildTimeline 四泳道映射", () => {
  it("账本主张进提议泳道，点名观测支撑并可跳转", () => {
    const t = buildTimeline({ledger: [claimRow]});
    expect(t.proposals).toHaveLength(1);
    expect(t.proposals[0].title).toContain("测试要求");
    expect(t.proposals[0].title).toContain("calc.py:3");
    expect(t.proposals[0].detail).toContain("3 条观测");
    expect(t.proposals[0].ref).toEqual({path: "calc.py", line: 3});
  });

  it("实验进观测泳道，完成且还原干净给成功色调", () => {
    const t = buildTimeline({ledger: [experimentRow]});
    expect(t.observations).toHaveLength(1);
    expect(t.observations[0].title).toContain("calc.py:3");
    expect(t.observations[0].detail).toContain("完成");
    expect(t.observations[0].detail).toContain("还原干净");
    expect(t.observations[0].tone).toBe("success");
  });

  it("逐行结论与复验结局都进裁决泳道，可采性一并展示", () => {
    const t = buildTimeline({lines: [line({})],
      reverifications: [record({})]});
    expect(t.verdicts).toHaveLength(2);
    expect(t.verdicts[0].title).toContain("承重");
    expect(t.verdicts[0].detail).toContain("可采性 A 级 · 行为证据");
    expect(t.verdicts[1].title).toContain("复验结论确认");
    expect(t.verdicts[1].tone).toBe("success");
  });

  it("质疑请求进人工泳道，带原因中文与处理状态", () => {
    const t = buildTimeline({reverifications: [record({})]});
    expect(t.human).toHaveLength(1);
    expect(t.human[0].title).toContain("结果可能不稳定");
    expect(t.human[0].detail).toContain("已结算");
  });

  it("形状不对的行跳过；没有输入时四泳道全空", () => {
    const t = buildTimeline({ledger: [
      {record_type: "Claim"},
      {record_type: "Experiment", payload: "not-an-object"},
      "junk",
    ] as unknown as Array<Record<string, unknown>>});
    expect(t.proposals).toHaveLength(0);
    expect(t.observations).toHaveLength(0);
    const empty = buildTimeline({});
    expect(empty.proposals).toHaveLength(0);
    expect(empty.observations).toHaveLength(0);
    expect(empty.verdicts).toHaveLength(0);
    expect(empty.human).toHaveLength(0);
  });

  it("泳道数组就是 UI 渲染顺序：提议、观测、裁决、人工", () => {
    expect(TIMELINE_LANES.map(l => l.key))
      .toEqual(["proposals", "observations", "verdicts", "human"]);
  });
});
