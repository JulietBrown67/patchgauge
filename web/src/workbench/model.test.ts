// 工作台纯逻辑层的护栏测试：结论→视觉语义的映射、文件树装配、
// 初始定位优先级与具名测试提取。颜色只承载一半语义，另一半必须在
// 图标形状与文字名称里——这两件事都要被钉死在测试里。
import { describe, expect, it } from "vitest";
import {
  VERDICT_SPECS, buildTree, defaultExpandedPaths, initialFocus,
  testsForEvidence, verdictForLine,
  type EvidenceLine, type SourceTreeEntry,
} from "./model";

const entry = (patch: Partial<SourceTreeEntry> & {path: string}): SourceTreeEntry => ({
  name: patch.path.split("/").pop() || patch.path, kind: "file", language: "python",
  changed: false, evidence_count: 0, comment_count: 0, ...patch,
});

describe("workbench verdict mapping", () => {
  it("maps render_model labels to workbench verdict semantics", () => {
    const line = (patch: Partial<EvidenceLine>): EvidenceLine =>
      ({file: "pkg/core.py", line: 1, ...patch});
    expect(verdictForLine(line({label: "承重"}))).toBe("load");
    expect(verdictForLine(line({label: "无据"}))).toBe("unevidenced");
    expect(verdictForLine(line({label: "游离"}))).toBe("drift");
    expect(verdictForLine(line({label: "未标注"}))).toBe("unlabeled");
    expect(verdictForLine(line({reason: "inert_withheld"}))).toBe("unlabeled");
    // 未标注按原因分泳道：没探过 → ai；失败无法归因 → failure；证据不可信 → hollow。
    expect(verdictForLine(line({reason: "not_measured"}))).toBe("ai");
    expect(verdictForLine(line({reason: "unsupported_file"}))).toBe("ai");
    expect(verdictForLine(line({reason: "budget_exhausted"}))).toBe("ai");
    expect(verdictForLine(line({reason: "no_valid_transform"}))).toBe("ai");
    expect(verdictForLine(line({reason: "not_isolated"}))).toBe("failure");
    expect(verdictForLine(line({reason: "collateral_breakage"}))).toBe("failure");
    expect(verdictForLine(line({reason: "flaky_or_dirty_restore"}))).toBe("hollow");
    expect(verdictForLine(line({reason: "probe_timeout"}))).toBe("hollow");
    expect(verdictForLine(line({reason: "environment_shift"}))).toBe("hollow");
    expect(verdictForLine(line({reason: "non_executable"}))).toBe("unlabeled");
    // 不认识的历史标签只能落回未标注，不能凭空升级成承重。
    expect(verdictForLine(line({label: "惰性"}))).toBe("unlabeled");
    expect(verdictForLine(line({}))).toBe("unlabeled");
  });

  it("gives every verdict a distinct glyph and a non-empty text name", () => {
    const specs = Object.values(VERDICT_SPECS);
    expect(new Set(specs.map(spec => spec.glyph)).size).toBe(specs.length);
    for (const spec of specs) {
      expect(spec.name.trim().length).toBeGreaterThan(0);
      expect(spec.description.trim().length).toBeGreaterThan(0);
      expect(spec.className).toMatch(/^evg-/);
    }
    // 承重必须排在最前：首次进入工作台先看最有价值的证据。
    expect(VERDICT_SPECS.load.priority).toBe(0);
  });
});

describe("workbench source tree", () => {
  const entries = [
    entry({path: "docs/readme.md", language: "markdown"}),
    entry({path: "pkg/core.py", changed: true, evidence_count: 2}),
    entry({path: "pkg/util.py"}),
    entry({path: "tests/test_core.py", changed: true}),
    entry({path: "notes.txt", comment_count: 1}),
  ];

  it("nests flat entries and ranks changed > evidence > comment > other", () => {
    const nodes = buildTree(entries);
    expect(nodes.map(node => node.name)).toEqual(["pkg", "tests", "notes.txt", "docs"]);
    const pkg = nodes[0];
    expect(pkg.kind).toBe("directory");
    expect(pkg.changed).toBe(true);
    expect(pkg.evidenceCount).toBe(2);
    expect(pkg.children.map(child => child.name)).toEqual(["core.py", "util.py"]);
  });

  it("only expands directories that lead to marked files", () => {
    const nodes = buildTree(entries);
    const expanded = defaultExpandedPaths(nodes);
    expect(expanded.has("pkg")).toBe(true);
    expect(expanded.has("tests")).toBe(true);
    expect(expanded.has("docs")).toBe(false);
  });
});

describe("workbench initial focus", () => {
  const nodes = buildTree([
    entry({path: "pkg/core.py", changed: true, evidence_count: 1}),
    entry({path: "pkg/other.py"}),
  ]);

  it("prefers load over unevidenced, then file rank, then line number", () => {
    const target = initialFocus(nodes, [
      {file: "pkg/other.py", line: 3, label: "承重"},
      {file: "pkg/core.py", line: 9, label: "承重"},
      {file: "pkg/core.py", line: 4, label: "无据"},
    ]);
    expect(target).toEqual({path: "pkg/core.py", line: 9, nonce: 0});
  });

  it("falls back to any labeled line when nothing is load-bearing", () => {
    const target = initialFocus(nodes, [
      {file: "pkg/core.py", line: 12, label: "无据"},
    ]);
    expect(target?.path).toBe("pkg/core.py");
    expect(target?.line).toBe(12);
  });

  it("returns null when there is nothing to show", () => {
    expect(initialFocus(nodes, [])).toBeNull();
  });
});

describe("workbench named tests", () => {
  it("extracts test ids recorded in the evidence ledger", () => {
    const ledger = [
      {record_id: "claim-1", payload: {data: {regressions: [
        {test_id: "tests/test_core.py::test_required", before: "PASS", after: "FAIL"},
      ]}}},
      {record_id: "claim-2", payload: {data: {regressions: [
        {test_id: "tests/test_core.py::test_other"},
        {test_id: ""},
      ]}}},
    ];
    expect(testsForEvidence(ledger, ["claim-1"]))
      .toEqual(["tests/test_core.py::test_required"]);
    expect(testsForEvidence(ledger, ["claim-1", "claim-2"])).toHaveLength(2);
    expect(testsForEvidence(ledger, ["claim-404"])).toEqual([]);
    expect(testsForEvidence(undefined, undefined)).toEqual([]);
  });
});
