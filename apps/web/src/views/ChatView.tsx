import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient, type Group, type Member, type MeResponse, type Message } from "../api";
import { RealtimeClient } from "../realtime";
import { mergeMessages, removeById } from "../state";
import { Button, Empty, TextArea } from "../ui";
import { formatTime } from "../format";

function payloadObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

interface ChatViewProps {
  api: ApiClient;
  me: MeResponse["user"];
  group: Group;
  notify: (message: string) => void;
  onError: (error: unknown) => void;
}

export function ChatView({ api, me, group, notify, onError }: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [presence, setPresence] = useState<Set<string>>(new Set());
  const [input, setInput] = useState("");
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [sending, setSending] = useState(false);
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [eventCursor, setEventCursor] = useState<number | null>(null);
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const groupIdRef = useRef(group.id);
  groupIdRef.current = group.id;

  const load = useCallback(async () => {
    const groupId = group.id;
    try {
      const [history, memberList] = await Promise.all([
        api.listMessages(groupId, { limit: 50 }),
        api.listMembers(groupId),
      ]);
      if (groupIdRef.current !== groupId) return;
      setMessages(history.items);
      setEventCursor(history.eventCursor);
      setOlderCursor(history.nextCursor);
      setMembers(memberList.members);
      stickRef.current = true;
    } catch (err) {
      if (groupIdRef.current === groupId) onError(err);
    }
  }, [api, group.id]);

  useEffect(() => {
    setMessages([]);
    setMembers([]);
    setPresence(new Set());
    setReplyTo(null);
    setEventCursor(null);
    setOlderCursor(null);
    stickRef.current = true;
    let active = true;
    void (async () => {
      if (!active) return;
      await load();
    })();
    return () => {
      active = false;
    };
  }, [load]);

  useEffect(() => {
    if (eventCursor === null) return;
    let client: RealtimeClient | null = null;
    const timer = setTimeout(() => {
      client = new RealtimeClient(
        api,
        group.id,
        {
          onEvent: (event) => {
            if (event.type === "message.created") {
              try {
                const parsed = payloadObject(event.payload) as {
                  messageId?: string;
                  content?: string;
                  senderType?: Message["senderType"];
                  senderId?: string;
                  rootMessageId?: string | null;
                  replyToMessageId?: string | null;
                  hop?: number;
                  seq?: number;
                  threadId?: string | null;
                };
                if (!parsed.messageId || parsed.threadId) return;
                const message: Message = {
                  id: parsed.messageId,
                  groupId: group.id,
                  threadId: null,
                  senderType: parsed.senderType ?? "user",
                  senderId: parsed.senderId ?? "",
                  content: parsed.content ?? "",
                  rootMessageId: parsed.rootMessageId ?? null,
                  replyToMessageId: parsed.replyToMessageId ?? null,
                  hop: parsed.hop ?? 0,
                  seq: parsed.seq ?? event.seq,
                  createdAt: event.createdAt,
                };
                setMessages((current) => mergeMessages(current, [message]));
              } catch {
                return;
              }
            } else if (event.type === "message.deleted") {
              try {
                const parsed = payloadObject(event.payload) as { messageId?: string };
                if (parsed.messageId)
                  setMessages((current) => removeById(current, parsed.messageId!));
              } catch {
                return;
              }
            }
          },
          onPresence: (next) => {
            if (groupIdRef.current !== group.id) return;
            setPresence(
              new Set(next.agents.filter((agent) => agent.online).map((agent) => agent.agentId)),
            );
            const presenceGroupId = group.id;
            void api
              .listMembers(presenceGroupId)
              .then((result) => {
                if (groupIdRef.current === presenceGroupId) setMembers(result.members);
              })
              .catch(() => undefined);
          },
          onState: (next, error) => {
            setState(next);
            setConnectionError(error ?? null);
          },
        },
        eventCursor,
      );
      if (import.meta.env.DEV) {
        (window as unknown as { __roomRealtime?: RealtimeClient }).__roomRealtime = client;
      }
      client.connect();
    }, 0);
    return () => {
      clearTimeout(timer);
      if (import.meta.env.DEV) {
        delete (window as unknown as { __roomRealtime?: RealtimeClient }).__roomRealtime;
      }
      client?.close();
    };
  }, [api, group.id, eventCursor]);

  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const result = await api.postMessage(group.id, {
        content,
        replyToMessageId: replyTo?.id,
        clientMessageId: `web-${randomId()}`,
      });
      setMessages((current) => mergeMessages(current, [result.message]));
      setInput("");
      setReplyTo(null);
    } catch (err) {
      onError(err);
    } finally {
      setSending(false);
    }
  };

  const remove = async (message: Message) => {
    if (!window.confirm("删除这条消息？")) return;
    try {
      await api.deleteMessage(message.id);
      setMessages((current) => removeById(current, message.id));
      notify("消息已删除");
    } catch (err) {
      onError(err);
    }
  };

  const nameOf = (message: Message): string => {
    if (message.senderType === "system") return "系统";
    const member = members.find(
      (item) => item.memberType === message.senderType && item.memberId === message.senderId,
    );
    return member?.displayName ?? message.senderId.slice(0, 8);
  };

  const onlineAgents = members.filter(
    (member) => member.memberType === "agent" && (presence.has(member.memberId) || member.online),
  );

  return (
    <div className="chat">
      <div className="chat-head">
        <div className="row tight">
          <span className={`dot ${state === "open" ? "online" : "off"}`} />
          <span className="muted small">{state === "open" ? "实时已连接" : "连接中/已断开"}</span>
        </div>
        <div className="row tight">
          {onlineAgents.map((member) => (
            <span key={member.memberId} className="badge badge-accent">
              ● {member.displayName}
            </span>
          ))}
          {onlineAgents.length === 0 && <span className="muted small">暂无在线 Agent</span>}
        </div>
        {connectionError && <span className="badge badge-danger">{connectionError}</span>}
      </div>
      <div className="chat-main">
        <div
          className="messages"
          ref={listRef}
          onScroll={() => {
            const el = listRef.current;
            if (!el) return;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {olderCursor !== null && (
            <button
              className="link small load-earlier"
              onClick={() => {
                const cursor = olderCursor;
                if (cursor === null) return;
                const el = listRef.current;
                const previousHeight = el?.scrollHeight ?? 0;
                const previousTop = el?.scrollTop ?? 0;
                const olderGroupId = group.id;
                void api
                  .listMessages(olderGroupId, { limit: 50, before: cursor })
                  .then((page) => {
                    if (groupIdRef.current !== olderGroupId) return;
                    setMessages((current) => mergeMessages(page.items, current));
                    setOlderCursor(page.nextCursor);
                    requestAnimationFrame(() => {
                      if (!el || groupIdRef.current !== olderGroupId) return;
                      el.scrollTop = previousTop + (el.scrollHeight - previousHeight);
                      stickRef.current = false;
                    });
                  })
                  .catch(onErrorRef.current);
              }}
            >
              加载更早消息
            </button>
          )}
          {messages.length === 0 && <Empty>还没有消息，说点什么吧。</Empty>}
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.senderType}`}>
              <header>
                <strong>{nameOf(message)}</strong>
                <span className="muted small">{formatTime(message.createdAt)}</span>
                {message.senderType !== "system" && (
                  <>
                    <button className="link small" onClick={() => setReplyTo(message)}>
                      回复
                    </button>
                    {(message.senderId === me.id || me.role === "owner" || me.role === "admin") && (
                      <button className="link small" onClick={() => void remove(message)}>
                        删除
                      </button>
                    )}
                  </>
                )}
              </header>
              {message.replyToMessageId && (
                <div className="reply-quote">
                  {(() => {
                    const original = messages.find((item) => item.id === message.replyToMessageId);
                    return original ? <>回复 {nameOf(original)}</> : <>回复「较早的消息」</>;
                  })()}
                </div>
              )}
              <div className="bubble">{message.content}</div>
              {message.hop > 0 && <div className="muted tiny">hop {message.hop}</div>}
            </article>
          ))}
          <div ref={bottomRef} />
        </div>
        <form className="composer" onSubmit={(event) => void send(event)}>
          {replyTo && (
            <div className="reply-bar">
              回复 {nameOf(replyTo)}：{replyTo.content.slice(0, 60)}
              <button type="button" className="link" onClick={() => setReplyTo(null)}>
                取消
              </button>
            </div>
          )}
          <div className="row">
            <TextArea
              value={input}
              placeholder={`以 ${me.displayName} 的身份发言…`}
              rows={2}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send(event);
                }
              }}
            />
            <Button variant="primary" type="submit" disabled={sending || !input.trim()}>
              {sending ? "发送中…" : "发送"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function randomId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
