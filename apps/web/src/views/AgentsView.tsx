import { useCallback, useEffect, useState } from "react";
import { ApiClient, type Agent, type AgentKey, type MeResponse } from "../api";
import { Avatar, Button, Card, Empty, Field, TextArea, TextInput } from "../ui";
import { formatTime, shortId, statusLabel } from "../format";

export function AgentsView({
  api,
  me,
  onError,
  notify,
}: {
  api: ApiClient;
  me: MeResponse["user"];
  onError: (error: unknown) => void;
  notify: (message: string) => void;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [runtime, setRuntime] = useState("dsh");
  const [model, setModel] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.listAgents();
      setAgents(result.agents);
      setSelected((current) =>
        current && result.agents.some((agent) => agent.id === current.id) ? current : null,
      );
    } catch (err) {
      onError(err);
    }
  }, [api, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadKeys = async (agent: Agent) => {
    setSelected(agent);
    try {
      const result = await api.listAgentKeys(agent.id);
      setKeys(result.keys);
    } catch (err) {
      onError(err);
    }
  };

  const register = async () => {
    if (!displayName.trim() || !publicKey.trim()) return;
    setBusy(true);
    try {
      await api.registerAgent({
        displayName: displayName.trim(),
        runtime: runtime.trim() || "dsh",
        model: model.trim() || undefined,
        publicKey: publicKey.trim(),
      });
      setDisplayName("");
      setModel("");
      setPublicKey("");
      await load();
      notify("Agent 已注册");
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (agent: Agent) => {
    try {
      if (agent.status === "disabled") {
        await api.enableAgent(agent.id);
      } else {
        const reason = window.prompt("禁用原因（可选）") ?? undefined;
        await api.disableAgent(agent.id, reason);
      }
      await load();
    } catch (err) {
      onError(err);
    }
  };

  const addKey = async () => {
    if (!selected || !newKey.trim()) return;
    try {
      await api.addAgentKey(selected.id, newKey.trim());
      setNewKey("");
      await loadKeys(selected);
      notify("密钥已添加");
    } catch (err) {
      onError(err);
    }
  };

  const revoke = async (key: AgentKey) => {
    if (!selected || !window.confirm("吊销该密钥并断开连接？")) return;
    try {
      await api.revokeAgentKey(selected.id, key.id);
      await loadKeys(selected);
    } catch (err) {
      onError(err);
    }
  };

  const canAdmin = me.role === "owner" || me.role === "admin";

  return (
    <div className="split">
      <div className="split-side">
        <Card title="Agent">
          <div className="list">
            {agents.map((agent) => (
              <button
                key={agent.id}
                className={`list-item ${selected?.id === agent.id ? "active" : ""}`}
                onClick={() => void loadKeys(agent)}
              >
                <div className="row tight">
                  <Avatar name={agent.displayName} />
                  <div>
                    <div>{agent.displayName}</div>
                    <div className="muted small">
                      {statusLabel(agent.status)}
                      {agent.online ? " · 在线" : ""}
                      {agent.model ? ` · ${agent.model}` : ""}
                    </div>
                  </div>
                </div>
              </button>
            ))}
            {agents.length === 0 && <Empty>暂无 Agent</Empty>}
          </div>
        </Card>
        {canAdmin && (
          <Card title="注册 Agent">
            <Field label="名称">
              <TextInput
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>
            <Field label="Runtime">
              <TextInput value={runtime} onChange={(event) => setRuntime(event.target.value)} />
            </Field>
            <Field label="Model（可选）">
              <TextInput value={model} onChange={(event) => setModel(event.target.value)} />
            </Field>
            <Field label="Ed25519 公钥（PEM）">
              <TextArea
                rows={4}
                value={publicKey}
                onChange={(event) => setPublicKey(event.target.value)}
              />
            </Field>
            <Button variant="primary" disabled={busy} onClick={() => void register()}>
              注册
            </Button>
          </Card>
        )}
      </div>
      <div className="split-main">
        {!selected && <Empty>选择一个 Agent 查看密钥。</Empty>}
        {selected && (
          <Card
            title={`${selected.displayName} 的密钥`}
            actions={
              canAdmin ? (
                <Button variant="danger" onClick={() => void toggle(selected)}>
                  {selected.status === "disabled" ? "启用" : "禁用"}
                </Button>
              ) : undefined
            }
          >
            <div className="grid-2">
              <div>
                <div className="muted small">Agent ID</div>
                <div className="mono small">{selected.id}</div>
              </div>
              <div>
                <div className="muted small">Runtime / Model</div>
                <div>
                  {selected.runtime}
                  {selected.model ? ` · ${selected.model}` : ""}
                </div>
              </div>
              <div>
                <div className="muted small">Host</div>
                <div>{selected.hostId ?? "—"}</div>
              </div>
              <div>
                <div className="muted small">创建时间</div>
                <div>{formatTime(selected.createdAt)}</div>
              </div>
            </div>
            <div className="list">
              {keys.map((key) => (
                <div key={key.id} className="list-row">
                  <div>
                    <div className="mono small">{shortId(key.fingerprint)}</div>
                    <div className="muted small">
                      {statusLabel(key.status)} · 创建 {formatTime(key.createdAt)}
                    </div>
                  </div>
                  {key.status === "active" && canAdmin && (
                    <Button variant="danger" onClick={() => void revoke(key)}>
                      吊销
                    </Button>
                  )}
                </div>
              ))}
              {keys.length === 0 && <Empty>暂无密钥</Empty>}
            </div>
            {canAdmin && (
              <details>
                <summary className="small muted">添加密钥</summary>
                <TextArea
                  rows={4}
                  value={newKey}
                  placeholder="Ed25519 公钥 PEM"
                  onChange={(event) => setNewKey(event.target.value)}
                />
                <Button onClick={() => void addKey()}>添加</Button>
              </details>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
