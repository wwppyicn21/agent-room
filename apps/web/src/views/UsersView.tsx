import { useCallback, useEffect, useState } from "react";
import { ApiClient, type MeResponse, type RbacRole, type User } from "../api";
import { Avatar, Button, Card, Empty, Field, Select, TextInput } from "../ui";
import { formatTime, statusLabel } from "../format";

export function UsersView({
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
  const [users, setUsers] = useState<User[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RbacRole>("member");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.listUsers();
      setUsers(result.users);
    } catch (err) {
      onError(err);
    }
  }, [api, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!displayName.trim()) return;
    setBusy(true);
    try {
      await api.createUser({
        displayName: displayName.trim(),
        email: email.trim() || undefined,
        role,
      });
      setDisplayName("");
      setEmail("");
      await load();
      notify("用户已创建");
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (user: User, next: RbacRole) => {
    try {
      await api.setUserRole(user.id, next);
      await load();
    } catch (err) {
      onError(err);
    }
  };

  const toggle = async (user: User) => {
    try {
      if (user.status === "disabled") await api.enableUser(user.id);
      else await api.disableUser(user.id);
      await load();
    } catch (err) {
      onError(err);
    }
  };

  const canAdmin = me.role === "owner" || me.role === "admin";
  const roleOptions: RbacRole[] =
    me.role === "owner" ? ["owner", "admin", "member", "readonly"] : ["member", "readonly"];

  if (!canAdmin) {
    return (
      <Card title="用户管理">
        <Empty>需要系统管理员权限。</Empty>
      </Card>
    );
  }

  return (
    <div className="grid-2">
      <Card title="用户">
        <div className="list">
          {users.map((user) => (
            <div key={user.id} className="list-row">
              <div className="row tight">
                <Avatar name={user.displayName} />
                <div>
                  <div>{user.displayName}</div>
                  <div className="muted small">
                    {user.email ?? "无邮箱"} · {statusLabel(user.status)} ·{" "}
                    {formatTime(user.createdAt)}
                  </div>
                </div>
              </div>
              <div className="row tight">
                <Select
                  value={user.role}
                  onChange={(event) => void changeRole(user, event.target.value as RbacRole)}
                >
                  {["owner", "admin", "member", "readonly"].map((item) => (
                    <option
                      key={item}
                      value={item}
                      disabled={!roleOptions.includes(item as RbacRole)}
                    >
                      {item}
                    </option>
                  ))}
                </Select>
                <Button
                  variant={user.status === "disabled" ? "default" : "danger"}
                  onClick={() => void toggle(user)}
                >
                  {user.status === "disabled" ? "启用" : "禁用"}
                </Button>
              </div>
            </div>
          ))}
          {users.length === 0 && <Empty>暂无用户</Empty>}
        </div>
      </Card>
      <Card title="创建用户">
        <Field label="显示名称">
          <TextInput value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        <Field label="邮箱（dev 登录）">
          <TextInput value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="角色">
          <Select value={role} onChange={(event) => setRole(event.target.value as RbacRole)}>
            {roleOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="primary" disabled={busy} onClick={() => void create()}>
          创建
        </Button>
      </Card>
    </div>
  );
}
