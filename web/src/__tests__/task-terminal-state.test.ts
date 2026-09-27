import {describe, expect, it} from "vitest";
import {deriveTaskTerminalState, type TaskTerminalInput} from "../taskTerminalState";

const base: TaskTerminalInput = {
  authorization: {status: "active", derived_status: "active"},
  receipt: {status: "supported"},
  source_snapshot_matches: true,
};

describe("task terminal state projection", () => {
  it("shows stopping until the backend confirms worker termination", () => {
    const view = deriveTaskTerminalState({...base, job: {
      status: "stopping", termination_state: "unconfirmed", stop_reason: "user_cancel",
    }});
    expect(view.key).toBe("stopping");
    expect(view.label).toContain("正在停止");
    expect(view.primaryAction).toBe("wait");
  });

  it("separates an observed behavior regression from an environment failure", () => {
    const regression = deriveTaskTerminalState({...base, receipt: {
      status: "gap_remains", reason: "观察到目标行为回归",
    }});
    expect(regression.key).toBe("regression_observed");
    expect(regression.detail).toContain("回归");

    const environment = deriveTaskTerminalState({...base, receipt: {status: "inconclusive"},
      job: {status: "failed", error: {code: "RUNNER_UNAVAILABLE", detail: "runner offline"}}});
    expect(environment.key).toBe("environment_failed");
    expect(environment.primaryAction).toBe("configure");
    expect(environment.detail).toContain("不可判定");
  });

  it("does not let historical supported evidence override the latest authorization", () => {
    const view = deriveTaskTerminalState({
      ...base,
      authorization: {status: "stopped", derived_status: "stopped", stop_reason: "user_stop",
        stopped_at: 1_700_000_000},
      receipt: {status: "supported"},
    });
    expect(view.key).toBe("stopped");
    expect(view.label).toContain("已停止");
    expect(view.stopReason).toBe("你停止了委托");
  });

  it("marks a supported result stale when the source snapshot moved", () => {
    const view = deriveTaskTerminalState({...base, source_snapshot_matches: false});
    expect(view.key).toBe("evidence_stale");
    expect(view.primaryAction).toBe("reverify");
  });
});
