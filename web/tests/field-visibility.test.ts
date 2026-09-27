import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

// 字段可见性护栏（收窄版，任务单「需要新增的测试护栏」第 1 条）：
// 锁两批：第四波 P1 #8/#11/#14/#15 点名的那批字段，加上第六波 M1/M2 落地的
// 编辑会话入账与五指纹交付（那批由另一个会话实现，这里把它的可见性也钉住——
// 屏幕上看不见的字段等于没做）。分两层断言——
// 1) FIELD_VISIBILITY：字段的字面键名必须出现在「解析/类型/展示函数」层；
// 2) VIEW_WIRING：把字段翻译成屏幕文案的视图函数必须被页面文件真实调用。
// 两层都过，字段才算真正接到了屏幕。后端每个字段的跨语言硬门禁不做，
// 等这批稳定后再谈扩面。
const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url));

const read = (name: string): string =>
  readFileSync(WEB_ROOT + name, "utf-8");

const FIELD_VISIBILITY: Record<string, string[]> = {
  // #8 复验记录：差异化证据与原始观测。reverification.ts 负责解析，
  // CodeWorkbench.tsx 通过视图函数间接读取（见 VIEW_WIRING）。
  "evidence_delta": ["src/workbench/reverification.ts"],
  "strategy": ["src/workbench/reverification.ts", "src/workbench/CodeWorkbench.tsx"],
  "outcome_reason": ["src/workbench/reverification.ts", "src/workbench/CodeWorkbench.tsx"],
  "replay_observations": ["src/workbench/reverification.ts", "src/workbench/CodeWorkbench.tsx"],
  "original_observations": ["src/workbench/reverification.ts", "src/workbench/CodeWorkbench.tsx"],
  "test_proposal": ["src/workbench/reverification.ts"],
  "patch_sha256": ["src/workbench/reverification.ts"],
  // #11 证书 per-test 定级与运行事实。
  "逐条定级": ["src/presentation.ts", "src/main.tsx"],
  "回滚干净": ["src/main.tsx"],
  "耗时秒": ["src/main.tsx"],
  // #14 发布状态：被 normalizer 丢掉的三个字段 + 门禁中文名。
  "ui_probe_status": ["src/main.tsx"],
  "narrow_package_checks": ["src/main.tsx"],
  "pending_gate_details": ["src/main.tsx"],
  "resume_condition": ["src/main.tsx"],
  "releaseGateLabel": ["src/main.tsx"],
  // #15 本波点名子集：源码树截断提示 + 沙箱未强制限制。
  "tree.truncated": ["src/workbench/CodeWorkbench.tsx"],
  "wb-tree-truncated": ["src/workbench/CodeWorkbench.tsx", "src/styles.css"],
  "unenforced_limits": ["src/presentation.ts"],
  "evaluation_context": ["src/main.tsx"],
  // 第六波 M1/M2：编辑会话入账与五指纹交付。只收**有辨识度**的键名——
  // intent / verdict / stale / abandoned 这类词在本仓到处都是，
  // 用子串断言等于没断言，所以不收它们。
  "edit_sessions": ["src/presentation.ts", "src/main.tsx"],
  "session_id": ["src/presentation.ts", "src/main.tsx"],
  "snapshot_sha256": ["src/presentation.ts", "src/main.tsx"],
  "candidates": ["src/presentation.ts", "src/main.tsx"],
  "transitions": ["src/presentation.ts", "src/main.tsx"],
  "test_result": ["src/presentation.ts", "src/main.tsx"],
  "delivery_approval": ["src/presentation.ts", "src/main.tsx"],
  "delivery_export": ["src/presentation.ts", "src/main.tsx"],
  "fingerprints": ["src/presentation.ts", "src/main.tsx"],
  "manifest_sha256": ["src/presentation.ts", "src/main.tsx"],
  "test_sha256": ["src/presentation.ts"],
  "evidence_manifest_sha256": ["src/presentation.ts", "src/main.tsx"],
  "target_ref": ["src/presentation.ts"],
  // 交付物措辞红线：这句话必须真的被页面渲染出来，不能只躺在常量里。
  "DELIVERY_DISCLAIMER": ["src/presentation.ts", "src/main.tsx"],
  "DELIVERY_FINGERPRINT_VIEWS": ["src/presentation.ts", "src/main.tsx"],
  "DELIVERY_REJECTION_CODES": ["src/presentation.ts", "src/main.tsx"],
  // D1.2 升级率度量：自主决定次数必须从解析层读到页面渲染。
  "autonomous_decisions": ["src/presentation.ts", "src/main.tsx"],
};

// 视图函数 → 必须调用它的页面文件。函数有单测只能证明「翻译正确」，
// 不调用就等于白翻——这里锁的是调用点。
const VIEW_WIRING: Record<string, string[]> = {
  "evidenceDeltaRows": ["src/workbench/CodeWorkbench.tsx"],
  "testProposalView": ["src/workbench/CodeWorkbench.tsx"],
  "strategyLabel": ["src/workbench/CodeWorkbench.tsx"],
  "outcomeReasonView": ["src/workbench/CodeWorkbench.tsx"],
  "certificateGradeRows": ["src/main.tsx"],
  "uiProbeStatusView": ["src/main.tsx"],
  "narrowPackageChecksView": ["src/main.tsx"],
  "unenforcedLimitsView": ["src/main.tsx"],
  // 第六波：把编辑会话状态、候选裁决与交付拒绝码翻成人话的视图函数。
  "editSessionStateView": ["src/main.tsx"],
  "editSessionTransitionText": ["src/main.tsx"],
  "editSessionExitReasonText": ["src/main.tsx"],
  "candidateVerdictView": ["src/main.tsx"],
  "candidateTestResultView": ["src/main.tsx"],
  "deliveryRejectionText": ["src/main.tsx"],
  // D1.2：把 narration.autonomy 翻成「自主 N 次 · 升级 M 次」的视图函数。
  "autonomyView": ["src/main.tsx"],
};

describe("字段可见性护栏（第四波 + 第六波 + D1 点名字段）", () => {
  it.each(Object.entries(FIELD_VISIBILITY))("%s 的字面键名在解析层有读取点",
      (field, files) => {
    for (const file of files) {
      expect(read(file).includes(field),
        `${field} 应出现在 ${file}`).toBe(true);
    }
  });

  it.each(Object.entries(VIEW_WIRING))("%s 被页面文件真实调用",
      (fn, files) => {
    for (const file of files) {
      expect(read(file).includes(fn + "("),
        `${fn} 应在 ${file} 中被调用`).toBe(true);
    }
  });

  it("护栏清单本身不许悄悄缩水", () => {
    // 三批字段（第四波 19 项 + 第六波 16 项 + D1.2 升级率 1 项）与
    // 视图函数（8 + 6 + D1.2 autonomyView），防止有人删表项让护栏空转。
    expect(Object.keys(FIELD_VISIBILITY).length).toBeGreaterThanOrEqual(36);
    expect(Object.keys(VIEW_WIRING).length).toBeGreaterThanOrEqual(15);
  });
});
