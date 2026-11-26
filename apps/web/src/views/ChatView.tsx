import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient, type Group, type Member, type MeResponse, type Message } from "../api";
import { RealtimeClient } from "../realtime";
import { mergeMessages, removeById } from "../state";
import { Button, Empty, TextArea } from "../ui";
import { formatTime } from "../format";

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
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const [history, memberList] = await Promise.all([
        api.listMessages(group.id, { limit: 50 }),
        api.listMembers(group.id),
      ]);
      setMessages(history.items);
      setMembers(memberList.members);
    } catch (err) {
      onError(err);
    }
  }, [api, group.id, onError]);

  useEffect(() => {
    setMessages([]);
    setReplyTo(null);
    void load();
  }, [load]);

  useEffect(() => {
    let client: RealtimeClient | null = null;
    const timer = setTimeout(() => {
      client = new RealtimeClient(
        api,
        group.id,
        {
          onEvent: (event) => {
            if (event.type === "message.created") {
              const payload = event.payload;
              try {
                const parsed = JSON.parse(payload) as {
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
                const parsed = JSON.parse(event.payload) as { messageId?: string };
                if (parsed.messageId)
                  setMessages((current) => removeById(current, parsed.messageId!));
              } catch {
                return;
              }
            }
          },
          onPresence: (next) => {
            setPresence(
              new Set(next.agents.filter((agent) => agent.online).map((agent) => agent.agentId)),
            );
            void api
              .listMembers(group.id)
              .then((result) => setMembers(result.members))
              .catch(() => undefined);
          },
          onState: (next, error) => {
            setState(next);
            if (error) onError(new Error(error));
          },
        },
        messages.at(-1)?.seq ?? 0,
      );
      client.connect();
    }, 0);
    return () => {
      clearTimeout(timer);
      client?.close();
    };
  }, [api, group.id, onError]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
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
        clientMessageId: `web-${crypto.randomUUID()}`,
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
          <span className={`dot ${state === "open" ? "ok" : "off"}`} />
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
      </div>
      <div className="messages">
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
                回复{" "}
                {nameOf(messages.find((item) => item.id === message.replyToMessageId) ?? message)}
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
  );
}
