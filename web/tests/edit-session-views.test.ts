// #9/#10 编辑会话与交付入账的展示映射：纯函数护栏，翻译错一个状态、
// 漏一个拒绝码中文名，都会在这里先红。
import { describe, expect, it } from "vitest";
import {
  DELIVERY_DISCLAIMER, DELIVERY_FINGERPRINT_VIEWS, DELIVERY_REJECTION_CODES,
  candidateTestResultView, candidateVerdictView, deliveryRejectionText,
  editSessionExitReasonText, editSessionStateView, editSessionTransitionText,
} from "../src/presentation";

describe("编辑会话状态映射", () => {
  it("七个后端状态各有中文标签", () => {
    expect(editSessionStateView("open").label).toBe("已开启");
    expect(editSessionStateView("patch_candidate").label).toBe("已有候选补丁");
    expect(editSessionStateView("verified").label).toBe("已验证");
    expect(editSessionStateView("awaiting_delivery").label).toBe("待交付");
    expect(editSessionStateView("delivered").label).toBe("已交付");
    expect(editSessionStateView("abandoned").label).toBe("已作废");
    expect(editSessionStateView("stale").label).toBe("已失效");
  });
  it("未知状态明说，不塌缩成已开启", () => {
    expect(editSessionStateView("mystery").label).toContain("未知状态");
    expect(editSessionStateView(null).label).toBe("未提供状态");
  });
  it("流转与收割原因有中文说明", () => {
    expect(editSessionTransitionText("open", "patch_candidate")).toBe("已开启 → 已有候选补丁");
    expect(editSessionExitReasonText("orphan_owner_process_gone")).toBe("开启会话的进程已中断");
    expect(editSessionExitReasonText("source_snapshot_changed")).toBe("源代码快照在会话开启后发生了变化");
    expect(editSessionExitReasonText("repair_delivered")).toBe("修复已交付");
    expect(editSessionExitReasonText("weird")).toBe("原因：weird");
    expect(editSessionExitReasonText("")).toBe("");
  });
});

describe("候选补丁与交付展示映射", () => {
  it("verdict/test_result 技术值翻成中文", () => {
    expect(candidateVerdictView("pending")).toBe("待验证");
    expect(candidateVerdictView("accepted")).toBe("已接受");
    expect(candidateVerdictView("rejected:DELIVERY_PATCH_MISMATCH")).toContain("已拒绝");
    expect(candidateVerdictView("rejected:DELIVERY_PATCH_MISMATCH")).toContain("补丁与批准记录不一致");
    expect(candidateVerdictView("rejected:WHATEVER")).toBe("已拒绝");
    expect(candidateVerdictView("")).toBe("未提供");
    expect(candidateTestResultView("not_run")).toBe("未运行");
    expect(candidateTestResultView("3 passed")).toBe("3 passed");
    expect(candidateTestResultView("")).toBe("未提供");
  });
  it("六个拒绝码全有中文名", () => {
    expect(DELIVERY_REJECTION_CODES).toHaveLength(6);
    for (const code of DELIVERY_REJECTION_CODES) {
      expect(deliveryRejectionText(code)).not.toBe("");
    }
    expect(deliveryRejectionText("NOT_A_CODE")).toBe("");
  });
  it("五指纹顺序与后端 FINGERPRINT_FIELDS 一致，disclaimer 是原句", () => {
    expect(DELIVERY_FINGERPRINT_VIEWS.map(item => item.key)).toEqual([
      "snapshot_sha256", "patch_sha256", "test_sha256",
      "evidence_manifest_sha256", "target_ref",
    ]);
    expect(DELIVERY_DISCLAIMER).toBe("内容哈希清单，非安全签署");
  });
});
