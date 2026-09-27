import {describe, expect, it} from "vitest";
import {
  EMPTY_FILTER, filterConclusions, filterCountLabel, fileOptions, gradeForRow,
  isFiltering, passportMarkdown, stepIndex, type ConclusionRow,
} from "./conclusion-tools";

const rows: ConclusionRow[] = [
  {file: "pkg/a.py", line: 3, label: "承重"},
  {file: "pkg/a.py", line: 7, label: "无据"},
  {file: "pkg/b.py", line: 2, label: "游离"},
  {file: "pkg/b.py", line: 9, label: "未标注"},
];

// 证书只覆盖 pkg/a.py:3（A 级）与 pkg/b.py:9（C 级），其余行没有证书。
const certificates = [
  {可采性: "A", 位置: {file: "pkg/a.py", start: 3, end: 3}},
  {可采性: "C", 位置: {file: "pkg/b.py", start: 9, end: 9}},
];

describe("conclusion filtering", () => {
  it("returns the same rows when nothing is filtered", () => {
    expect(isFiltering(EMPTY_FILTER)).toBe(false);
    expect(filterConclusions(rows, EMPTY_FILTER, certificates)).toEqual(rows);
  });

  it("filters by verdict label and by file", () => {
    expect(filterConclusions(rows, {...EMPTY_FILTER, label: "承重"}, certificates))
      .toEqual([{file: "pkg/a.py", line: 3, label: "承重"}]);
    expect(filterConclusions(rows, {...EMPTY_FILTER, file: "pkg/b.py"}, certificates)
      .map(row => row.line)).toEqual([2, 9]);
  });

  it("filters by admissibility grade and admits lines that were never graded", () => {
    expect(gradeForRow(certificates, rows[0])).toBe("A");
    expect(gradeForRow(certificates, rows[1])).toBe("");
    expect(gradeForRow(null, rows[0])).toBe("");
    expect(filterConclusions(rows, {...EMPTY_FILTER, grade: "A"}, certificates)
      .map(row => row.file + ":" + row.line)).toEqual(["pkg/a.py:3"]);
    // 未定级的行不会被算进任何等级：拿不到就是拿不到，不猜。
    expect(filterConclusions(rows, {...EMPTY_FILTER, grade: "B"}, certificates))
      .toEqual([]);
    // 证书只写了文件、没有行区间时匹配不到具体行——与 main.tsx 的 findCertificate 同规则，
    // 不为了「筛得更多」在这里放宽它。
    expect(gradeForRow([{可采性: "B", 位置: {file: "pkg/a.py"}}], rows[1])).toBe("");
  });

  it("never hides how many rows were filtered away", () => {
    const shown = filterConclusions(rows, {...EMPTY_FILTER, label: "游离"}, certificates);
    expect(filterCountLabel(rows.length, shown.length))
      .toBe("显示 1 / 共 4 行（筛选只影响显示，不改任何结论）");
    expect(filterCountLabel(4, 4)).toBe("4 行");
  });

  it("lists files in a stable order", () => {
    expect(fileOptions(rows)).toEqual(["pkg/a.py", "pkg/b.py"]);
  });
});

describe("passport markdown export", () => {
  const view = {
    statusLabel: "已完成", addedLines: 22, loadLines: 4, namedFailures: 1,
    unevidencedLines: 3, driftLines: 2, restoreLabel: "已验证",
    planFingerprint: "plan-demo-sha", bundleAvailable: true, live: false,
    modelLabel: "deepseek-v4-pro", modelCalls: 3, recommendationLabel: "已生成 1 条",
  };

  it("carries exactly the fields the passport card shows", () => {
    const text = passportMarkdown(view);
    expect(text.split("\n")[0]).toBe("# PatchGauge · 证据护照");
    for (const line of ["- 状态：已完成", "- 新增代码行数：22 行", "- 承重行数：4 行",
      "- 具名失败测试数：1 个", "- 无据行数：3 行", "- 游离行数：2 行",
      "- 恢复状态：已验证", "- 计划指纹：plan-demo-sha",
      "- 完整 ReviewBundle：已装载，可下载留存"]) {
      expect(text).toContain(line);
    }
  });

  it("says who did not call a model instead of leaving a blank row", () => {
    expect(passportMarkdown(view))
      .toContain("- 模型参与：本次未调用模型 · 确定性调度");
    expect(passportMarkdown(view)).not.toContain("模型调用");
    const live = passportMarkdown({...view, live: true});
    expect(live).toContain("- 模型参与：是 · deepseek-v4-pro");
    expect(live).toContain("- 模型调用：3 次");
    expect(live).toContain("- 建议阶段：已生成 1 条");
  });
});

describe("keyboard stepping", () => {
  it("starts at the first row going forward and the last going back", () => {
    expect(stepIndex(-1, 1, 4)).toBe(0);
    expect(stepIndex(-1, -1, 4)).toBe(3);
  });

  it("stops at the ends instead of wrapping", () => {
    expect(stepIndex(3, 1, 4)).toBe(3);
    expect(stepIndex(0, -1, 4)).toBe(0);
    expect(stepIndex(1, 1, 4)).toBe(2);
    expect(stepIndex(-1, 1, 0)).toBe(-1);
  });
});
