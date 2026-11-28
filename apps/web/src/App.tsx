import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient, ApiError, type AuthInfo, type Group, type MeResponse } from "./api";
import { AgentsView } from "./views/AgentsView";
import { ChatView } from "./views/ChatView";
import { DiagnosticsView } from "./views/DiagnosticsView";
import { MembersView } from "./views/MembersView";
import { SettingsView } from "./views/SettingsView";
import { TasksView } from "./views/TasksView";
import { ThreadsView } from "./views/ThreadsView";
import { UsersView } from "./views/UsersView";
import { Button, Field, TextInput } from "./ui";
import { initials } from "./format";

type View =
  "chat" | "threads" | "tasks" | "members" | "agents" | "users" | "settings" | "diagnostics";

const TABS: { id: View; label: string }[] = [
  { id: "chat", label: "群聊" },
  { id: "threads", label: "Thread" },
  { id: "tasks", label: "任务" },
  { id: "members", label: "成员" },
  { id: "agents", label: "Agent" },
  { id: "users", label: "用户" },
  { id: "settings", label: "设置" },
  { id: "diagnostics", label: "诊断" },
];

const STORAGE_EMAIL = "agentroom.devEmail";
const STORAGE_GROUP = "agentroom.groupId";

export function App() {
  const api = useMemo(() => new ApiClient({ devEmail: localStorage.getItem(STORAGE_EMAIL) }), []);
  const [authMode, setAuthMode] = useState<AuthInfo["authMode"]>("dev");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<string | null>(localStorage.getItem(STORAGE_GROUP));
  const [view, setView] = useState<View>("chat");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [email, setEmail] = useState(localStorage.getItem(STORAGE_EMAIL) ?? "");
  const [groupName, setGroupName] = useState("");

  const group = groups.find((item) => item.id === groupId) ?? null;

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  }, []);
  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const describeError = useCallback((err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.status === 401) return "未登录或登录已过期，请重新登录。";
      return `${err.code}: ${err.message}`;
    }
    return err instanceof Error ? err.message : String(err);
  }, []);

  const onError = useCallback((err: unknown) => setError(describeError(err)), [describeError]);

  const loadGroups = useCallback(async () => {
    const result = await api.listGroups();
    setGroups(result.groups);
    setGroupId((current) => {
      const next =
        current && result.groups.some((item) => item.id === current)
          ? current
          : (result.groups[0]?.id ?? null);
      if (next) localStorage.setItem(STORAGE_GROUP, next);
      return next;
    });
  }, [api]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const info = await api.authInfo();
        if (active) setAuthMode(info.authMode);
        const current = await api.me();
        if (!active) return;
        setMe(current);
        await loadGroups();
      } catch {
        if (active) setMe(null);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [api, loadGroups]);

  const login = async () => {
    setError("");
    try {
      api.setDevEmail(email.trim() || null);
      localStorage.setItem(STORAGE_EMAIL, email.trim());
      const current = await api.me();
      setMe(current);
      await loadGroups();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const logout = () => {
    api.setDevEmail(null);
    localStorage.removeItem(STORAGE_EMAIL);
    setMe(null);
    setGroups([]);
    setGroupId(null);
  };

  const createGroup = async () => {
    if (!groupName.trim()) return;
    setError("");
    try {
      const created = await api.createGroup({ name: groupName.trim() });
      setGroupName("");
      await loadGroups();
      setGroupId(created.group.id);
      localStorage.setItem(STORAGE_GROUP, created.group.id);
      notify("群组已创建");
    } catch (err) {
      setError(describeError(err));
    }
  };

  if (loading) {
    return (
      <div className="content">
        <p className="muted">加载中…</p>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="login">
        <div>
          <h1>Agent Room</h1>
          <p className="muted">多 Agent 协作空间</p>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {authMode === "dev" ? (
          <div className="card">
            <p className="muted small">开发模式：输入已注册用户的邮箱或 ID。</p>
            <Field label="dev 用户邮箱">
              <TextInput
                value={email}
                placeholder="owner@example.com"
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void login();
                }}
              />
            </Field>
            <div className="row" style={{ marginTop: 12 }}>
              <Button variant="primary" onClick={() => void login()}>
                进入
              </Button>
            </div>
          </div>
        ) : (
          <div className="card">
            <p>已启用 Cloudflare Access。请通过 Access 登录后刷新页面。</p>
            <Button onClick={() => window.location.reload()}>刷新</Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          Agent Room
          <small>server {me.server.serverId.slice(0, 12)}</small>
        </div>
        <div className="me">
          <span className="avatar">{initials(me.user.displayName)}</span>
          <div className="meta">
            <div className="name">{me.user.displayName}</div>
            <div className="role">
              {me.user.role}
              {me.user.email ? ` · ${me.user.email}` : ""}
            </div>
          </div>
          <button className="link small" onClick={logout}>
            退出
          </button>
        </div>
        <div className="tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`tab ${view === tab.id ? "active" : ""}`}
              onClick={() => setView(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <h3 className="small muted">群组</h3>
        <div className="group-list">
          {groups.map((item) => (
            <button
              key={item.id}
              className={`group-item ${item.id === groupId ? "active" : ""}`}
              onClick={() => {
                setGroupId(item.id);
                localStorage.setItem(STORAGE_GROUP, item.id);
              }}
            >
              {item.name}
              <span className="sub">
                {item.participationMode} · {item.status}
              </span>
            </button>
          ))}
          {groups.length === 0 && <p className="muted small">还没有群组</p>}
        </div>
        <div className="spacer" />
        <div className="row tight">
          <TextInput
            placeholder="新群组名称"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createGroup();
            }}
          />
          <Button onClick={() => void createGroup()}>创建</Button>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <div>
            <h1>{group?.name ?? "选择群组"}</h1>
            <div className="desc">{group?.description ?? "从左侧选择或创建一个群组"}</div>
          </div>
          <div className="right">
            <span className={`badge ${group ? "badge-accent" : ""}`}>
              {group ? (group.status === "active" ? "活跃" : "已归档") : "无群组"}
            </span>
          </div>
        </div>
        <div className="content">
          {error && (
            <div className="error-banner">
              <span>{error}</span>
              <button className="link" onClick={() => setError("")}>
                关闭
              </button>
            </div>
          )}
          {!group && <p className="empty">选择一个群组开始。</p>}
          {group && view === "chat" && (
            <ChatView api={api} me={me.user} group={group} notify={notify} onError={onError} />
          )}
          {group && view === "threads" && <ThreadsView api={api} group={group} onError={onError} />}
          {group && view === "tasks" && (
            <TasksView api={api} group={group} onError={onError} notify={notify} />
          )}
          {group && view === "members" && (
            <MembersView api={api} group={group} me={me.user} onError={onError} />
          )}
          {group && view === "agents" && (
            <AgentsView api={api} me={me.user} onError={onError} notify={notify} />
          )}
          {group && view === "users" && (
            <UsersView api={api} me={me.user} onError={onError} notify={notify} />
          )}
          {group && view === "settings" && (
            <SettingsView
              api={api}
              group={group}
              onUpdated={() => void loadGroups()}
              onError={onError}
              notify={notify}
            />
          )}
          {group && view === "diagnostics" && (
            <DiagnosticsView api={api} group={group} me={me.user} onError={onError} />
          )}
        </div>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
