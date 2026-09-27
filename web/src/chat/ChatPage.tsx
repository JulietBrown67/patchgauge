// 对话式入口页面（B 计划第一期）。
// ChatRoute 是 main.tsx 之外的挂载包装：hash 为 #/chat 时整页替换为对话，
// 否则原样渲染主应用并附加右下角入口按钮——main.tsx 只需两行接线。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SESSION_TOKEN_KEY, resolveStartupToken } from "../presentation";
import {
  HistoryCard, NoticeCard, PlanCard, ProgressCard, ReposCard, ResultCard,
  TrendCard, WatchCard, WatchNoticeCard, lastSeq, mergeEvents, renderRich,
} from "./cards";
import type { ChatEvent } from "./cards";
import "./chat.css";

const CHAT_CONV_KEY = "patchgauge.chat.conv";
const CHAT_HASH = "#/chat";

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function makeApi(token: string) {
  return async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (init?.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(path, { ...init, headers, cache: "no-store" });
    if (!response.ok) {
      let code = `HTTP_${response.status}`;
      let message = `${response.status}`;
      try {
        const raw = (await response.json()) as { code?: string; detail?: unknown; message?: string };
        code = raw.code || code;
        message = raw.message || (typeof raw.detail === "string" ? raw.detail : message);
      } catch { /* 保留 HTTP 状态码口径 */ }
      throw new HttpError(response.status, code, message);
    }
    return (await response.json()) as T;
  };
}

function useHashRoute(): boolean {
  const [open, setOpen] = useState(() => window.location.hash === CHAT_HASH);
  useEffect(() => {
    const onChange = () => setOpen(window.location.hash === CHAT_HASH);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return open;
}

export function ChatRoute({ children }: { children: ReactNode }) {
  const open = useHashRoute();
  if (open) return <ChatPage />;
  return (
    <>
      {children}
      <a className="chatp-route-fab" href={CHAT_HASH}>💬 对话入口</a>
    </>
  );
}

function ChatPage() {
  const [token] = useState(() =>
    resolveStartupToken(window.location.hash, sessionStorage.getItem(SESSION_TOKEN_KEY)));
  const api = useMemo(() => makeApi(token), [token]);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [convId, setConvId] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const convRef = useRef("");
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const stored = sessionStorage.getItem(CHAT_CONV_KEY) || "";
    const bootstrap = async () => {
      try {
        let conv = stored;
        if (!conv) {
          const created = await api<{ conversation_id: string }>(
            "/api/v2/chat/conversations", { method: "POST", body: "{}" });
          conv = created.conversation_id;
          sessionStorage.setItem(CHAT_CONV_KEY, conv);
        }
        if (cancelled) return;
        convRef.current = conv;
        setConvId(conv);
        const first = await api<{ events: ChatEvent[] }>(
          `/api/v2/chat/conversations/${conv}/events`);
        if (!cancelled) setEvents(first.events);
      } catch (exc) {
        if (!cancelled) setError(`连接失败：${(exc as Error).message}。请从启动器打开本页以带上令牌。`);
      }
    };
    void bootstrap();
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!convId) return;
    const timer = window.setInterval(async () => {
      try {
        const fresh = await api<{ events: ChatEvent[] }>(
          `/api/v2/chat/conversations/${convId}/events?after=${lastSeq(events)}`);
        if (fresh.events.length) setEvents((prev) => mergeEvents(prev, fresh.events));
      } catch { /* 轮询失败静默，下一轮重试；发送路径会暴露错误 */ }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [api, convId, events]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [events]);

  const absorb = useCallback((incoming: ChatEvent[]) => {
    setEvents((prev) => mergeEvents(prev, incoming));
  }, []);

  const send = useCallback(async (text: string) => {
    const body = text.trim();
    if (!body || !convRef.current) return;
    setBusy(true);
    setError("");
    try {
      const out = await api<{ events: ChatEvent[] }>(
        `/api/v2/chat/conversations/${convRef.current}/messages`,
        { method: "POST", body: JSON.stringify({ text: body }) });
      absorb(out.events);
      setDraft("");
    } catch (exc) {
      setError((exc as Error).message);
    } finally {
      setBusy(false);
    }
  }, [absorb, api]);

  const onAction = useCallback(async (actionId: string, decision: string) => {
    if (!convRef.current) return;
    setBusy(true);
    setError("");
    try {
      const out = await api<{ events: ChatEvent[] }>(
        `/api/v2/chat/conversations/${convRef.current}/actions`,
        { method: "POST", body: JSON.stringify({ action_id: actionId, decision }) });
      absorb(out.events);
    } catch (exc) {
      setError((exc as Error).message);
    } finally {
      setBusy(false);
    }
  }, [absorb, api]);

  const onCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setError("");
    } catch {
      setError("复制失败：浏览器拒绝了剪贴板权限，请手动选中复制。");
    }
  }, []);

  return (
    <div className="chatp-page">
      <header className="chatp-head">
        <h1>PatchGauge · 对话</h1>
        <span className="chatp-sub">结论来自实验回执，不来自聊天</span>
        <a href="#/">返回主界面</a>
      </header>
      <div className="chatp-list" ref={listRef} role="log" aria-label="对话记录">
        {events.length === 0 && !error && <div className="chatp-empty">正在连接……</div>}
        {events.map((event) => {
          switch (event.kind) {
            case "user.text":
              return <div key={event.seq} className="chatp-msg--user">{String(event.text)}</div>;
            case "assistant.text":
              return (
                <div key={event.seq} className="chatp-msg--ai">
                  {renderRich(String(event.text || ""))}
                </div>
              );
            case "card.plan":
              return <PlanCard key={event.seq} event={event} onAction={onAction} busy={busy} />;
            case "card.progress":
              return <ProgressCard key={event.seq} event={event} />;
            case "card.result":
              return <ResultCard key={event.seq} event={event} onCopy={onCopy} />;
            case "card.repos":
              return <ReposCard key={event.seq} event={event} onPick={(name) => void send(`检查 ${name}`)} />;
            case "card.history":
              return <HistoryCard key={event.seq} event={event} />;
            case "card.trend":
              return <TrendCard key={event.seq} event={event} />;
            case "card.watch":
              return <WatchCard key={event.seq} event={event} />;
            case "card.watch_notice":
              return (
                <WatchNoticeCard key={event.seq} event={event} busy={busy}
                  onCheck={(repo) => void send(`检查 ${repo}`)} />
              );
            case "card.notice":
              return <NoticeCard key={event.seq} event={event} />;
            default:
              return null;
          }
        })}
      </div>
      {error && <div className="chatp-error" role="alert">{error}</div>}
      <div className="chatp-input-row">
        <textarea
          value={draft}
          placeholder="试试：检查 ｜ 补测指令 ｜ 盯着 retry_demo ｜ 历史"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send(draft);
            }
          }}
        />
        <button type="button" className="chatp-btn chatp-btn--primary"
          disabled={busy || !draft.trim()} onClick={() => void send(draft)}>
          发送
        </button>
      </div>
    </div>
  );
}
