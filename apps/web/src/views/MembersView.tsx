import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient, type Group, type Member, type MemberCandidate, type MeResponse } from "../api";
import { Avatar, Button, Card, Empty, Field, Select } from "../ui";
import { formatTime, statusLabel } from "../format";

export function MembersView({
  api,
  group,
  me,
  onError,
}: {
  api: ApiClient;
  group: Group;
  me: MeResponse["user"];
  onError: (error: unknown) => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [candidates, setCandidates] = useState<MemberCandidate[]>([]);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [kind, setKind] = useState<"user" | "agent">("user");
  const [memberId, setMemberId] = useState("");
  const [busy, setBusy] = useState(false);
  const isSystemAdmin = me.role === "owner" || me.role === "admin";
  const [loadedGroupId, setLoadedGroupId] = useState<string | null>(null);
  const groupIdRef = useRef(group.id);
  groupIdRef.current = group.id;

  const loadMembers = useCallback(async () => {
    const groupId = group.id;
    try {
      const memberList = await api.listMembers(groupId);
      if (groupIdRef.current !== groupId) return;
      setMembers(memberList.members);
      setLoadedGroupId(groupId);
    } catch (err) {
      if (groupIdRef.current === groupId) onError(err);
    }
  }, [api, group.id, onError]);

  const myMembership = members.find(
    (member) => member.memberType === "user" && member.memberId === me.id,
  );
  const canManage =
    loadedGroupId === group.id &&
    (isSystemAdmin || myMembership?.memberRole === "owner" || myMembership?.memberRole === "admin");

  const loadCandidates = useCallback(async () => {
    if (!canManage) {
      setCandidates([]);
      return;
    }
    try {
      const result = await api.listMemberCandidates(group.id, kind);
      setCandidates(result.candidates);
      setCandidateError(null);
    } catch (err) {
      setCandidates([]);
      setCandidateError(err instanceof Error ? err.message : String(err));
    }
  }, [api, canManage, group.id, kind]);

  const refresh = useCallback(async () => {
    await loadMembers();
    await loadCandidates();
  }, [loadMembers, loadCandidates]);

  useEffect(() => {
    setMembers([]);
    setCandidates([]);
    setCandidateError(null);
    setMemberId("");
    setLoadedGroupId(null);
    void loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    setMemberId("");
    void loadCandidates();
  }, [loadCandidates]);

  const add = async () => {
    if (!memberId) return;
    setBusy(true);
    try {
      await api.addMember(group.id, { memberType: kind, memberId, memberRole: "member" });
      setMemberId("");
      await refresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: Member, role: string) => {
    try {
      await api.updateMemberRole(group.id, member.memberType, member.memberId, role);
      await refresh();
    } catch (err) {
      onError(err);
    }
  };

  const remove = async (member: Member) => {
    if (!window.confirm(`移除成员 ${member.displayName}？`)) return;
    try {
      await api.removeMember(group.id, member.memberType, member.memberId);
      await refresh();
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="grid-2">
      <Card title="成员">
        <div className="list">
          {members.map((member) => (
            <div key={`${member.memberType}:${member.memberId}`} className="list-row">
              <div className="row tight">
                <Avatar name={member.displayName} />
                <div>
                  <div>
                    {member.displayName}
                    <span className="muted small">
                      {" "}
                      · {member.memberType === "agent" ? "Agent" : "用户"}
                    </span>
                  </div>
                  <div className="muted small">
                    {statusLabel(member.status)}
                    {member.online ? " · 在线" : ""}
                    {member.joinedAt ? ` · ${formatTime(member.joinedAt)}` : ""}
                  </div>
                </div>
              </div>
              {canManage ? (
                <div className="row tight">
                  <Select
                    value={member.memberRole}
                    onChange={(event) => void changeRole(member, event.target.value)}
                  >
                    {member.memberType === "agent" ? (
                      <option value="member">成员</option>
                    ) : (
                      <>
                        <option value="owner">Owner</option>
                        <option value="admin">Admin</option>
                        <option value="member">成员</option>
                      </>
                    )}
                  </Select>
                  <Button variant="danger" onClick={() => void remove(member)}>
                    移除
                  </Button>
                </div>
              ) : (
                <span className="badge">{member.memberRole}</span>
              )}
            </div>
          ))}
          {members.length === 0 && <Empty>暂无成员</Empty>}
        </div>
      </Card>
      {canManage && (
        <Card title="添加成员">
          <Field label="类型">
            <Select
              value={kind}
              onChange={(event) => setKind(event.target.value as "user" | "agent")}
            >
              <option value="user">用户</option>
              <option value="agent">Agent</option>
            </Select>
          </Field>
          <Field label="成员">
            <Select value={memberId} onChange={(event) => setMemberId(event.target.value)}>
              <option value="">选择…</option>
              {candidates.map((item) => (
                <option key={item.memberId} value={item.memberId}>
                  {item.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" disabled={busy || !memberId} onClick={() => void add()}>
            添加
          </Button>
          {candidateError && <p className="muted small">候选列表不可用：{candidateError}</p>}
        </Card>
      )}
    </div>
  );
}
