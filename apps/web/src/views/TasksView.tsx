import { useCallback, useEffect, useState } from "react";
import { ApiClient, type Agent, type Approval, type Group, type Task } from "../api";
import { Badge, Button, Card, Empty, Field, Select, TextArea, TextInput } from "../ui";
import { formatTime, shortId, statusLabel } from "../format";

export function TasksView({
  api,
  group,
  onError,
  notify,
}: {
  api: ApiClient;
  group: Group;
  onError: (error: unknown) => void;
  notify: (message: string) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [status, setStatus] = useState("");
  const [sourceMessageId, setSourceMessageId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignedAgentId, setAssignedAgentId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [result, agentList] = await Promise.all([
        api.listTasks(group.id, { status: status || undefined, limit: 50 }),
        api.listAgents(),
      ]);
      setTasks(result.items);
      setAgents(agentList.agents);
      setSelected((current) =>
        current && result.items.some((item) => item.id === current.id) ? current : null,
      );
    } catch (err) {
      onError(err);
    }
  }, [api, group.id, status, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadApprovals = async (task: Task) => {
    try {
      const result = await api.listApprovals(task.id);
      setApprovals(result.approvals);
    } catch (err) {
      onError(err);
    }
  };

  const select = (task: Task) => {
    setSelected(task);
    void loadApprovals(task);
  };

  const create = async () => {
    if (!sourceMessageId.trim() || !title.trim()) return;
    setBusy(true);
    try {
      const result = await api.createTask(group.id, {
        sourceMessageId: sourceMessageId.trim(),
        title: title.trim(),
        description: description.trim() || undefined,
        assignedAgentId: assignedAgentId || undefined,
      });
      setSourceMessageId("");
      setTitle("");
      setDescription("");
      await load();
      setSelected(result.task);
      void loadApprovals(result.task);
      notify("任务已创建");
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: "pause" | "resume" | "cancel" | "assign", agentId?: string) => {
    if (!selected) return;
    try {
      if (action === "assign") {
        if (!agentId) return;
        await api.assignTask(selected.id, agentId);
      } else if (action === "cancel") {
        const reason = window.prompt("取消原因（可选）") ?? undefined;
        await api.cancelTask(selected.id, reason);
      } else {
        await api[action === "pause" ? "pauseTask" : "resumeTask"](selected.id);
      }
      await load();
      const refreshed = await api.getTask(selected.id);
      setSelected(refreshed.task);
      await loadApprovals(refreshed.task);
    } catch (err) {
      onError(err);
    }
  };

  const decide = async (approval: Approval, approve: boolean) => {
    try {
      if (approve) {
        await api.approve(approval.id);
      } else {
        const reason = window.prompt("拒绝原因（必填）");
        if (!reason?.trim()) return;
        await api.reject(approval.id, reason.trim());
      }
      await load();
      if (selected) {
        const refreshed = await api.getTask(selected.id);
        setSelected(refreshed.task);
        await loadApprovals(refreshed.task);
      }
      notify(approve ? "已批准" : "已拒绝");
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="split">
      <div className="split-side">
        <Card title="任务">
          <Select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">全部</option>
            {[
              "queued",
              "assigned",
              "running",
              "waiting_approval",
              "paused",
              "succeeded",
              "failed",
              "cancelled",
            ].map((item) => (
              <option key={item} value={item}>
                {statusLabel(item)}
              </option>
            ))}
          </Select>
          <div className="list">
            {tasks.map((task) => (
              <button
                key={task.id}
                className={`list-item ${selected?.id === task.id ? "active" : ""}`}
                onClick={() => select(task)}
              >
                <div>{task.title}</div>
                <div className="muted small">
                  {statusLabel(task.status)} · {shortId(task.id)}
                </div>
              </button>
            ))}
            {tasks.length === 0 && <Empty>暂无任务</Empty>}
          </div>
          <details>
            <summary className="small muted">从群消息创建任务</summary>
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
            <Field label="描述">
              <TextArea
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field label="指派 Agent">
              <Select
                value={assignedAgentId}
                onChange={(event) => setAssignedAgentId(event.target.value)}
              >
                <option value="">稍后分配</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Button variant="primary" disabled={busy} onClick={() => void create()}>
              创建
            </Button>
          </details>
        </Card>
      </div>
      <div className="split-main">
        {!selected && <Empty>选择一个任务查看详情。</Empty>}
        {selected && (
          <>
            <Card
              title={selected.title}
              actions={
                <Badge tone={selected.status === "failed" ? "danger" : "accent"}>
                  {statusLabel(selected.status)}
                </Badge>
              }
            >
              <div className="grid-2">
                <div>
                  <div className="muted small">Task ID</div>
                  <div className="mono small">{selected.id}</div>
                </div>
                <div>
                  <div className="muted small">指派 Agent</div>
                  <div>
                    {agents.find((agent) => agent.id === selected.assignedAgentId)?.displayName ??
                      "未分配"}
                  </div>
                </div>
                <div>
                  <div className="muted small">创建时间</div>
                  <div>{formatTime(selected.createdAt)}</div>
                </div>
                <div>
                  <div className="muted small">完成时间</div>
                  <div>{formatTime(selected.completedAt)}</div>
                </div>
              </div>
              {selected.description && <p>{selected.description}</p>}
              {selected.summary && <div className="quote-block">{selected.summary}</div>}
              {selected.error && <div className="error-banner">{selected.error}</div>}
              <div className="row tight">
                {selected.status === "queued" && (
                  <Select value="" onChange={(event) => void act("assign", event.target.value)}>
                    <option value="">分配 Agent…</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.displayName}
                      </option>
                    ))}
                  </Select>
                )}
                {selected.status === "running" && (
                  <Button onClick={() => void act("pause")}>暂停</Button>
                )}
                {selected.status === "paused" && (
                  <Button onClick={() => void act("resume")}>恢复</Button>
                )}
                {!["succeeded", "failed", "cancelled"].includes(selected.status) && (
                  <Button variant="danger" onClick={() => void act("cancel")}>
                    取消
                  </Button>
                )}
              </div>
            </Card>
            <Card title="审批">
              {approvals.length === 0 && <Empty>暂无审批请求</Empty>}
              {approvals.map((approval) => (
                <div key={approval.id} className="list-row">
                  <div>
                    <strong>{approval.title}</strong>
                    <div className="muted small">
                      {statusLabel(approval.status)} · {formatTime(approval.createdAt)}
                    </div>
                    {approval.details && <p className="small">{approval.details}</p>}
                    {approval.reason && <p className="small muted">原因：{approval.reason}</p>}
                  </div>
                  {approval.status === "pending" && (
                    <div className="row tight">
                      <Button variant="primary" onClick={() => void decide(approval, true)}>
                        批准
                      </Button>
                      <Button variant="danger" onClick={() => void decide(approval, false)}>
                        拒绝
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
