import { useEffect, useState } from "react";
import { ApiClient, type Group, type Workspace } from "../api";
import { Button, Card, Empty, Field, Select, TextArea, TextInput } from "../ui";
import { formatTime } from "../format";

export function SettingsView({
  api,
  group,
  onUpdated,
  onError,
  notify,
}: {
  api: ApiClient;
  group: Group;
  onUpdated: () => void;
  onError: (error: unknown) => void;
  notify: (message: string) => void;
}) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? "");
  const [participationMode, setParticipationMode] = useState<Group["participationMode"]>(
    group.participationMode,
  );
  const [allowAgentMessages, setAllowAgentMessages] = useState(group.allowAgentMessages);
  const [maxHops, setMaxHops] = useState(group.maxHops);
  const [maxRepliesPerRoot, setMaxRepliesPerRoot] = useState(group.maxRepliesPerRoot);
  const [maxAgentMessagesPerMinute, setMaxAgentMessagesPerMinute] = useState(
    group.maxAgentMessagesPerMinute,
  );
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(group.name);
    setDescription(group.description ?? "");
    setParticipationMode(group.participationMode);
    setAllowAgentMessages(group.allowAgentMessages);
    setMaxHops(group.maxHops);
    setMaxRepliesPerRoot(group.maxRepliesPerRoot);
    setMaxAgentMessagesPerMinute(group.maxAgentMessagesPerMinute);
  }, [group]);

  useEffect(() => {
    void api
      .listWorkspaces(group.id)
      .then((result) => setWorkspaces(result.workspaces))
      .catch((err) => onError(err));
  }, [api, group.id, onError]);

  const save = async () => {
    setBusy(true);
    try {
      await api.updateGroup(group.id, {
        name: name.trim() || group.name,
        description: description.trim() || null,
        settings: {
          participationMode,
          allowAgentMessages,
          maxHops,
          maxRepliesPerRoot,
          maxAgentMessagesPerMinute,
        },
      });
      onUpdated();
      notify("设置已保存");
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const createWorkspace = async () => {
    if (!workspaceName.trim()) return;
    try {
      const result = await api.createWorkspace(group.id, workspaceName.trim());
      setWorkspaces((current) => [...current, result.workspace]);
      setWorkspaceName("");
      notify("Workspace 已创建");
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="grid-2">
      <Card title="群组设置">
        <Field label="名称">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="描述">
          <TextArea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field label="参与模式">
          <Select
            value={participationMode}
            onChange={(event) =>
              setParticipationMode(event.target.value as Group["participationMode"])
            }
          >
            <option value="all">all — 所有在线 Agent</option>
            <option value="mention">mention — 仅 @ 提及</option>
            <option value="disabled">disabled — 禁用</option>
          </Select>
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={allowAgentMessages}
            onChange={(event) => setAllowAgentMessages(event.target.checked)}
          />
          <span>允许 Agent 之间互相发言</span>
        </label>
        <div className="grid-2">
          <Field label="最大 hop">
            <TextInput
              type="number"
              min={1}
              value={maxHops}
              onChange={(event) => setMaxHops(Number(event.target.value))}
            />
          </Field>
          <Field label="每个 root 最大回复">
            <TextInput
              type="number"
              min={1}
              value={maxRepliesPerRoot}
              onChange={(event) => setMaxRepliesPerRoot(Number(event.target.value))}
            />
          </Field>
          <Field label="Agent 每分钟上限">
            <TextInput
              type="number"
              min={1}
              value={maxAgentMessagesPerMinute}
              onChange={(event) => setMaxAgentMessagesPerMinute(Number(event.target.value))}
            />
          </Field>
        </div>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          保存
        </Button>
      </Card>
      <Card title="Workspace">
        <p className="muted small">Workspace 仅记录任务执行环境的元数据映射；文件系统隔离属 M7。</p>
        <div className="list">
          {workspaces.map((workspace) => (
            <div key={workspace.id} className="list-row">
              <div>
                <div>{workspace.name}</div>
                <div className="muted small">
                  {workspace.id} · {formatTime(workspace.createdAt)}
                </div>
              </div>
            </div>
          ))}
          {workspaces.length === 0 && <Empty>暂无 Workspace</Empty>}
        </div>
        <div className="row">
          <TextInput
            placeholder="Workspace 名称"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
          />
          <Button onClick={() => void createWorkspace()}>创建</Button>
        </div>
      </Card>
    </div>
  );
}
