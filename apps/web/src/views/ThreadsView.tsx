import { useCallback, useEffect, useState } from "react";
import {
  ApiClient,
  type EventRow,
  type Group,
  type Message,
  type Task,
  type Thread,
  type ThreadDetail,
} from "../api";
import { Button, Card, Empty, Field, Select, TextArea, TextInput } from "../ui";
import { formatTime, shortId, statusLabel } from "../format";
import { mergeMessages } from "../state";

export function ThreadsView({
  api,
  group,
  onError,
}: {
  api: ApiClient;
  group: Group;
  onError: (error: unknown) => void;
}) {
  const [status, setStatus] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [input, setInput] = useState("");
  const [sourceMessageId, setSourceMessageId] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState<Task | null>(null);
  const [olderCursor, setOlderCursor] = useState<number | null>(null);

  const loadThreads = useCallback(async () => {
    try {
      const result = await api.listThreads(group.id, { status: status || undefined, limit: 50 });
      setThreads(result.items);
      setSelectedId((current) =>
        current && result.items.some((item) => item.id === current)
          ? current
          : (result.items[0]?.id ?? null),
      );
    } catch (err) {
      onError(err);
    }
  }, [api, group.id, status, onError]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setMessages([]);
      setEvents([]);
      setTask(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const [threadDetail, threadMessages, threadEvents] = await Promise.all([
          api.getThread(selectedId),
          api.listThreadMessages(selectedId, { limit: 50 }),
          api.listThreadEvents(selectedId, { limit: 50 }),
        ]);
        if (!active) return;
        setDetail(threadDetail);
        setMessages(threadMessages.items);
        setOlderCursor(threadMessages.nextCursor);
        setEvents(threadEvents.items);
        setTask(threadDetail.task);
      } catch (err) {
        if (active) onError(err);
      }
    })();
    return () => {
      active = false;
    };
  }, [api, selectedId, onError]);

  const create = async () => {
    if (!sourceMessageId.trim() || !title.trim()) return;
    setBusy(true);
    try {
      const result = await api.createThread(group.id, {
        sourceMessageId: sourceMessageId.trim(),
        title: title.trim(),
      });
      setSourceMessageId("");
      setTitle("");
      await loadThreads();
      setSelectedId(result.thread.id);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const reply = async () => {
    if (!selectedId || !input.trim()) return;
    try {
      const result = await api.postThreadMessage(selectedId, { content: input.trim() });
      setMessages((current) => [...current, result.message]);
      setInput("");
    } catch (err) {
      onError(err);
    }
  };

  const close = async () => {
    if (!selectedId) return;
    try {
      const result = await api.closeThread(selectedId);
      setDetail((current) => (current ? { ...current, thread: result.thread } : current));
      await loadThreads();
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="split">
      <div className="split-side">
        <Card title="Thread">
          <div className="row tight">
            <Select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">全部</option>
              <option value="open">进行中</option>
              <option value="closed">已关闭</option>
              <option value="failed">失败</option>
            </Select>
          </div>
          <div className="list">
            {threads.map((thread) => (
              <button
                key={thread.id}
                className={`list-item ${selectedId === thread.id ? "active" : ""}`}
                onClick={() => setSelectedId(thread.id)}
              >
                <div>{thread.title}</div>
                <div className="muted small">
                  {statusLabel(thread.status)} · {formatTime(thread.createdAt)}
                </div>
              </button>
            ))}
            {threads.length === 0 && <Empty>暂无 Thread</Empty>}
          </div>
          <details>
            <summary className="small muted">从群消息创建 Thread</summary>
            <Field label="来源消息 ID">
              <TextInput
                value={sourceMessageId}
                placeholder="msg_…"
                onChange={(event) => setSourceMessageId(event.target.value)}
              />
            </Field>
            <Field label="标题">
              <TextInput value={title} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Button variant="primary" disabled={busy} onClick={() => void create()}>
              创建
            </Button>
          </details>
        </Card>
      </div>
      <div className="split-main">
        {!detail && <Empty>选择一个 Thread 查看详情。</Empty>}
        {detail && (
          <>
            <Card
              title={detail.thread.title}
              actions={
                detail.thread.status === "open" ? (
                  <Button variant="danger" onClick={() => void close()}>
                    关闭 Thread
                  </Button>
                ) : (
                  <span className="badge">{statusLabel(detail.thread.status)}</span>
                )
              }
            >
              <div className="grid-2">
                <div>
                  <div className="muted small">Thread ID</div>
                  <div className="mono small">{detail.thread.id}</div>
                </div>
                <div>
                  <div className="muted small">来源消息</div>
                  <div className="mono small">{shortId(detail.thread.sourceMessageId)}</div>
                </div>
                <div>
                  <div className="muted small">消息数</div>
                  <div>{detail.messageCount}</div>
                </div>
                <div>
                  <div className="muted small">Task</div>
                  <div>
                    {detail.task
                      ? `${detail.task.title} · ${statusLabel(detail.task.status)}`
                      : "—"}
                  </div>
                </div>
              </div>
              {detail.sourceMessage && (
                <div className="quote-block">{detail.sourceMessage.content}</div>
              )}
            </Card>
            <Card title="Thread 消息">
              <div className="thread-messages">
                {olderCursor !== null && (
                  <button
                    className="link small load-earlier"
                    onClick={() => {
                      const cursor = olderCursor;
                      if (cursor === null || !selectedId) return;
                      void api
                        .listThreadMessages(selectedId, { limit: 50, before: cursor })
                        .then((page) => {
                          setMessages((current) => mergeMessages(page.items, current));
                          setOlderCursor(page.nextCursor);
                        })
                        .catch(onError);
                    }}
                  >
                    加载更早消息
                  </button>
                )}
                {messages.map((message) => (
                  <div key={message.id} className={`message ${message.senderType}`}>
                    <header>
                      <strong>
                        {message.senderType === "agent"
                          ? "Agent"
                          : message.senderType === "system"
                            ? "系统"
                            : "用户"}
                      </strong>
                      <span className="muted small">{formatTime(message.createdAt)}</span>
                    </header>
                    <div className="bubble">{message.content}</div>
                  </div>
                ))}
                {messages.length === 0 && <Empty>暂无消息</Empty>}
              </div>
              {detail.thread.status === "open" && (
                <div className="row">
                  <TextArea
                    rows={2}
                    value={input}
                    placeholder="在 Thread 中发言…"
                    onChange={(event) => setInput(event.target.value)}
                  />
                  <Button variant="primary" onClick={() => void reply()}>
                    发送
                  </Button>
                </div>
              )}
            </Card>
            <Card title="事件日志">
              <div className="list compact">
                {events.map((event) => (
                  <div key={event.id} className="list-row">
                    <span className="mono small">{event.type}</span>
                    <span className="muted small">{formatTime(event.createdAt)}</span>
                  </div>
                ))}
                {events.length === 0 && <Empty>暂无事件</Empty>}
              </div>
            </Card>
            {task && (
              <Card title="关联 Task">
                <div className="row spread">
                  <span>{task.title}</span>
                  <span className="badge">{statusLabel(task.status)}</span>
                </div>
                <div className="muted small">分配：{task.assignedAgentId ?? "未分配"}</div>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
