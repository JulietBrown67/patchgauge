// 对话卡片（B 计划第一期）：纯展示组件 + 可单测的投影函数。
// 结论性内容（三态/退出码/恢复）一律来自后端回执渲染，前端不做任何推断。
import type { ReactNode } from "react";

export interface ChatEvent {
  seq: number;
  at: string;
  kind: string;
  [key: string]: unknown;
}

export const PROGRESS_LABELS: Record<string, string> = {
  CREATED: "已创建",
  DRAFTING: "起草中",
  INTAKE_VALIDATED: "输入已校验",
  PLAN_DRAFTED: "计划已起草",
  AWAITING_APPROVAL: "待批准",
  PLAN_FROZEN: "计划已确认",
  BASELINE_RUNNING: "基线实验中",
  EXECUTING: "反事实实验中",
  REPLANNING: "重规划",
  AWAITING_HUMAN: "等待人工",
  VERIFYING_RESTORE: "校验恢复中",
  PROPOSING_REPAIR: "提议修复",
  VERIFYING_REPAIR: "验证修复",
  DELIVERING_BRANCH: "交付分支",
  SYNTHESIZING: "汇总证据",
  CANCELLING: "取消中",
  RECOVERING: "恢复中",
  CLEANUP_REQUIRED: "待清理",
  QUARANTINED: "已隔离",
  COMPLETE: "完成",
  COMPLETED: "完成",
  PARTIAL: "部分完成",
  FAILED: "失败",
  ABORTED: "已中止",
  CANCELLED: "已取消",
};

export function progressLabel(status: string): string {
  return PROGRESS_LABELS[status] || status;
}

/** 退出码 → 徽章语气（与后端 EXIT_MEANINGS 一一对应，仅决定样式）。 */
export function exitTone(exitCode: number): string {
  if (exitCode === 0) return "ok";
  if (exitCode === 2) return "items";
  if (exitCode === 5) return "insufficient";
  if (exitCode === 4) return "info";
  return "warn";
}

export function rangesText(ranges: Array<[number, number]> | unknown): string {
  if (!Array.isArray(ranges)) return "";
  return ranges
    .map((pair) => (Array.isArray(pair) && pair[0] === pair[1]
      ? `${pair[0]}`
      : `${pair?.[0] ?? "?"}-${pair?.[1] ?? "?"}`))
    .join("、");
}

/** 按 seq 去重合并（轮询与发送两条来源会重叠）。 */
export function mergeEvents(existing: ChatEvent[], incoming: ChatEvent[]): ChatEvent[] {
  const bySeq = new Map<number, ChatEvent>();
  for (const event of [...existing, ...incoming]) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function lastSeq(events: ChatEvent[]): number {
  return events.length ? events[events.length - 1].seq : 0;
}

/** 轻量富文本：**粗体**、`代码`、```代码块```；不渲染任何 HTML。 */
export function renderRich(text: string): ReactNode[] {
  const blocks = text.split("```");
  return blocks.map((block, index) => {
    if (index % 2 === 1) {
      const body = block.replace(/^[a-z]*\n/, "");
      return <pre key={index} className="chatp-code">{body.trimEnd()}</pre>;
    }
    const parts = block.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return (
      <span key={index}>
        {parts.map((part, i) => {
          if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
            return <strong key={i}>{part.slice(2, -2)}</strong>;
          }
          if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
            return <code key={i}>{part.slice(1, -1)}</code>;
          }
          return part;
        })}
      </span>
    );
  });
}

function Item({ event, children }: { event: ChatEvent; children: ReactNode }) {
  return <div className="chatp-card" data-seq={event.seq}>{children}</div>;
}

export function PlanCard({ event, onAction, busy }:
  { event: ChatEvent; onAction: (actionId: string, decision: string) => void;
    busy: boolean }) {
  const changes = (event.changes || {}) as Record<string, number>;
  const status = String(event.status || "pending");
  return (
    <Item event={event}>
      <div className="chatp-card-title">检查计划（确认前不会执行任何实验）</div>
      <dl className="chatp-kv">
        <dt>仓库</dt><dd>{String(event.repo)}</dd>
        <dt>测试范围</dt><dd>{(event.tests as string[])?.join("、") || "—"}</dd>
        <dt>预算</dt><dd>{String(event.budget)} 秒</dd>
        <dt>基点</dt><dd>HEAD {String(event.head || "").slice(0, 12)}｜快照 {String(event.snapshot_sha256 || "").slice(0, 12)}</dd>
        <dt>改动</dt>
        <dd>已跟踪 {changes.tracked ?? 0}｜未跟踪 {changes.untracked ?? 0}
          {changes.binary ? `｜二进制 ${changes.binary}（不计入分析）` : ""}
          {changes.renamed ? `｜重命名 ${changes.renamed}` : ""}</dd>
      </dl>
      {status === "pending" ? (
        <div className="chatp-row">
          <button type="button" className="chatp-btn chatp-btn--primary"
            disabled={busy}
            onClick={() => onAction(String(event.action_id), "approve")}>
            确认并开始实验
          </button>
          <button type="button" className="chatp-btn chatp-btn--ghost"
            disabled={busy}
            onClick={() => onAction(String(event.action_id), "decline")}>
            取消
          </button>
        </div>
      ) : (
        <span className="chatp-chip chatp-chip--info">{status === "approved" ? "已确认" : "已取消"}</span>
      )}
    </Item>
  );
}

export function ProgressCard({ event }: { event: ChatEvent }) {
  const status = String(event.status || "");
  return (
    <Item event={event}>
      <div className="chatp-row">
        <span className="chatp-chip chatp-chip--info">进度</span>
        <span>{progressLabel(status)}</span>
        <span className="chatp-sub" style={{ color: "var(--text-faint)", fontSize: 12 }}>
          审查 {String(event.review_id).slice(0, 8)}
        </span>
      </div>
    </Item>
  );
}

export function ResultCard({ event, onCopy }:
  { event: ChatEvent; onCopy: (text: string) => void }) {
  const exitCode = Number(event.exit_code);
  const byLabel = (event.by_label || {}) as Record<string, number>;
  const items = (event.items || []) as Array<{ label: string; file: string; ranges: [number, number][] }>;
  const retest = String(event.retest_md || "");
  const restore = (event.restore_state || {}) as Record<string, unknown>;
  return (
    <Item event={event}>
      <div className="chatp-row">
        <div className="chatp-card-title">检查结果（来自实验回执）</div>
        <span className={`chatp-chip chatp-chip--${exitTone(exitCode)}`}>退出码 {exitCode}</span>
        <span className="chatp-chip">{progressLabel(String(event.state))}</span>
      </div>
      <div className="chatp-row">
        <span className="chatp-chip">承重 {byLabel["承重"] ?? 0}</span>
        <span className="chatp-chip chatp-chip--items">无据 {byLabel["无据"] ?? 0}</span>
        <span className="chatp-chip chatp-chip--warn">游离 {byLabel["游离"] ?? 0}</span>
        <span className="chatp-chip chatp-chip--info">恢复 {restore.verified ? "干净" : "异常"}</span>
      </div>
      {items.length > 0 && (
        <div className="chatp-items">
          {items.map((item) => (
            <div key={`${item.label}:${item.file}`}>
              <strong>{item.label}</strong>　<code>{item.file}</code>：行 {rangesText(item.ranges)}
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12, color: "var(--text-faint)" }}>{String(event.exit_meaning || "")}</div>
      {retest && (
        <button type="button" className="chatp-btn" onClick={() => onCopy(retest)}>
          复制「给 AI 的补测指令」
        </button>
      )}
    </Item>
  );
}

export function ReposCard({ event, onPick }:
  { event: ChatEvent; onPick: (name: string) => void }) {
  const repos = (event.repos || []) as Array<{ repo_id: string; display_name: string; technical_name: string }>;
  return (
    <Item event={event}>
      <div className="chatp-card-title">{String(event.text || "选择仓库")}</div>
      <div className="chatp-row">
        {repos.map((repo) => (
          <button type="button" key={repo.repo_id} className="chatp-btn"
            onClick={() => onPick(repo.technical_name || repo.display_name)}>
            {repo.display_name}
          </button>
        ))}
      </div>
    </Item>
  );
}

export function HistoryCard({ event }: { event: ChatEvent }) {
  const entries = (event.entries || []) as Array<Record<string, unknown>>;
  return (
    <Item event={event}>
      <div className="chatp-card-title">本会话检查历史</div>
      <div className="chatp-items">
        {entries.map((entry) => (
          <div key={String(entry.review_id)}>
            {String(entry.at || "").slice(0, 19)}｜{progressLabel(String(entry.state))}｜
            承重 {String(entry["承重"])}／无据 {String(entry["无据"])}／游离 {String(entry["游离"])}
          </div>
        ))}
      </div>
    </Item>
  );
}

export function WatchCard({ event }: { event: ChatEvent }) {
  const on = Boolean(event.on);
  return (
    <Item event={event}>
      <div className="chatp-row">
        <span className={`chatp-chip ${on ? "chatp-chip--ok" : "chatp-chip--info"}`}>
          {on ? "盯守开启" : "盯守关闭"}
        </span>
        <span>{String(event.text || "")}</span>
      </div>
    </Item>
  );
}

export function WatchNoticeCard({ event, onCheck, busy }:
  { event: ChatEvent; onCheck: (repo: string) => void; busy: boolean }) {
  return (
    <Item event={event}>
      <div className="chatp-row">
        <span className="chatp-chip chatp-chip--items">新改动</span>
        <span>{String(event.text || "")}</span>
        <button type="button" className="chatp-btn chatp-btn--primary" disabled={busy}
          onClick={() => onCheck(String(event.repo || ""))}>
          一键检查
        </button>
      </div>
    </Item>
  );
}

export function NoticeCard({ event }: { event: ChatEvent }) {
  const level = String(event.level || "info");
  return (
    <Item event={event}>
      <div className="chatp-row">
        <span className={`chatp-chip ${level === "warn" ? "chatp-chip--warn" : "chatp-chip--info"}`}>
          {level === "warn" ? "注意" : "说明"}
        </span>
        <span>{String(event.text || "")}</span>
      </div>
    </Item>
  );
}

export function TrendCard({ event }: { event: ChatEvent }) {
  const entries = (event.entries || []) as Array<Record<string, unknown>>;
  return (
    <Item event={event}>
      <div className="chatp-card-title">趋势：{String(event.repo)}</div>
      <div className="chatp-items">
        {entries.map((entry) => {
          const labeled = Number(entry["已标注行数"] || 0);
          const rate = labeled
            ? `${Math.round((Number(entry["承重"] || 0) / labeled) * 100)}%` : "—";
          return (
            <div key={String(entry.review_id)}>
              {String(entry.at || "").slice(0, 19)}｜承重 {String(entry["承重"])}／
              无据 {String(entry["无据"])}／游离 {String(entry["游离"])}｜
              未标注 {String(entry["未标注"])}｜分母 {labeled}｜承重率 {rate}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
        承重率=承重÷(承重+无据+游离)，分母与未标注同时展示；缩范围或删测试不会在这里变成改善。
      </div>
    </Item>
  );
}
