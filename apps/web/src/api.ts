export type RbacRole = "owner" | "admin" | "member" | "readonly";
export type TaskStatus =
  | "queued"
  | "assigned"
  | "running"
  | "waiting_approval"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface AuthInfo {
  authMode: "dev" | "access";
}

export interface User {
  id: string;
  displayName: string;
  email: string | null;
  role: RbacRole;
  status: "active" | "disabled";
  createdAt?: number;
  updatedAt?: number;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  participationMode: "all" | "mention" | "disabled";
  allowAgentMessages: boolean;
  maxHops: number;
  maxRepliesPerRoot: number;
  maxAgentMessagesPerMinute: number;
  createdAt: number;
  updatedAt: number;
}

export interface Member {
  groupId: string;
  memberType: "user" | "agent";
  memberId: string;
  memberRole: "owner" | "admin" | "member";
  joinedAt: number;
  displayName: string;
  status: string;
  online?: boolean;
}

export interface Message {
  id: string;
  groupId: string;
  threadId: string | null;
  senderType: "user" | "agent" | "system";
  senderId: string;
  content: string;
  rootMessageId: string | null;
  replyToMessageId: string | null;
  hop: number;
  seq: number;
  createdAt: number;
}

export interface Thread {
  id: string;
  groupId: string;
  sourceMessageId: string;
  title: string;
  status: "open" | "closed" | "failed";
  createdByUserId: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface Task {
  id: string;
  groupId: string;
  threadId: string | null;
  sourceMessageId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: string;
  assignedAgentId: string | null;
  createdByUserId: string;
  idempotencyKey: string | null;
  workspaceId: string | null;
  result: string | null;
  summary: string | null;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadDetail {
  thread: Thread;
  sourceMessage: Message | null;
  messageCount: number;
  lastMessageAt: number | null;
  task: Task | null;
}

export interface Approval {
  id: string;
  taskId: string;
  runId: string | null;
  threadId: string | null;
  requestedByAgentId: string;
  title: string;
  details: string | null;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  decidedByUserId: string | null;
  decidedAt: number | null;
  reason: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EventRow {
  seq: number;
  id: string;
  type: string;
  groupId: string | null;
  threadId: string | null;
  taskId: string | null;
  actorType: "user" | "agent" | "system";
  actorId: string;
  payload: unknown;
  createdAt: number;
}

export interface Delivery {
  id: string;
  agentId: string;
  eventId: string;
  status: "pending" | "delivered" | "acked" | "failed";
  attempts: number;
  createdAt: number;
  deliveredAt: number | null;
  ackedAt: number | null;
  failedAt: number | null;
}

export interface DeliveryItem {
  delivery: Delivery;
  agentDisplayName: string;
  eventType: string;
}

export interface DeliveryStats {
  statuses: Record<string, number>;
  oldestPendingAt: number | null;
}

export interface Workspace {
  id: string;
  groupId: string;
  name: string;
  createdByUserId: string;
  createdAt: number;
}

export interface GroupAgent {
  id: string;
  displayName: string;
  status: Agent["status"];
}

export interface Agent {
  id: string;
  displayName: string;
  runtime: string;
  model: string | null;
  capabilities: string;
  status: string;
  hostId: string | null;
  createdAt: number;
  updatedAt: number;
  online?: boolean;
}

export interface AgentKey {
  id: string;
  agentId: string;
  fingerprint: string;
  publicKey: string;
  status: "active" | "revoked";
  createdAt: number;
  revokedAt: number | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: T extends { seq: number } ? number | null : string | null;
}

export interface MeResponse {
  user: { id: string; displayName: string; email: string | null; role: RbacRole };
  server: { serverId: string };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  devEmail?: string | null;
  fetchImpl?: FetchLike;
}

export class ApiClient {
  private devEmail: string | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.devEmail = options.devEmail ?? null;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  setDevEmail(email: string | null): void {
    this.devEmail = email;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (this.devEmail) headers.set("x-dev-user-email", this.devEmail);
    const response = await this.fetchImpl(this.baseUrl + path, { ...init, headers });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? "http_error",
        error?.message ?? `request failed with status ${response.status}`,
      );
    }
    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "DELETE",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  authInfo(): Promise<AuthInfo> {
    return this.get<AuthInfo>("/api/v1/auth-info");
  }

  me(): Promise<MeResponse> {
    return this.get<MeResponse>("/api/v1/me");
  }

  listGroups(): Promise<{ groups: Group[] }> {
    return this.get("/api/v1/groups");
  }

  createGroup(body: { name: string; description?: string }): Promise<{ group: Group }> {
    return this.post("/api/v1/groups", body);
  }

  getGroup(groupId: string): Promise<{ group: Group }> {
    return this.get(`/api/v1/groups/${groupId}`);
  }

  updateGroup(
    groupId: string,
    body: {
      name?: string;
      description?: string | null;
      settings?: {
        participationMode: Group["participationMode"];
        allowAgentMessages: boolean;
        maxHops: number;
        maxRepliesPerRoot: number;
        maxAgentMessagesPerMinute: number;
      };
    },
  ): Promise<{ group: Group }> {
    return this.patch(`/api/v1/groups/${groupId}`, body);
  }

  listMembers(groupId: string): Promise<{ members: Member[] }> {
    return this.get(`/api/v1/groups/${groupId}/members`);
  }

  addMember(
    groupId: string,
    body: { memberType: "user" | "agent"; memberId: string; memberRole?: string },
  ): Promise<{ member: Member }> {
    return this.post(`/api/v1/groups/${groupId}/members`, body);
  }

  updateMemberRole(
    groupId: string,
    memberType: "user" | "agent",
    memberId: string,
    memberRole: string,
  ): Promise<{ member: Member }> {
    return this.patch(`/api/v1/groups/${groupId}/members/${memberType}/${memberId}`, {
      memberRole,
    });
  }

  removeMember(
    groupId: string,
    memberType: "user" | "agent",
    memberId: string,
  ): Promise<{ removed: boolean }> {
    return this.delete(`/api/v1/groups/${groupId}/members/${memberType}/${memberId}`);
  }

  listGroupAgents(groupId: string): Promise<{ agents: GroupAgent[] }> {
    return this.get(`/api/v1/groups/${groupId}/agents`);
  }

  listMessages(
    groupId: string,
    options: { limit?: number; cursor?: number } = {},
  ): Promise<{ items: Message[]; nextCursor: number | null; eventCursor: number }> {
    return this.get(`/api/v1/groups/${groupId}/messages${queryString(options)}`);
  }

  postMessage(
    groupId: string,
    body: {
      content: string;
      threadId?: string;
      replyToMessageId?: string;
      clientMessageId?: string;
    },
  ): Promise<{ message: Message }> {
    return this.post(`/api/v1/groups/${groupId}/messages`, body);
  }

  deleteMessage(messageId: string, reason?: string): Promise<{ message: Message }> {
    return this.delete(`/api/v1/messages/${messageId}`, reason ? { reason } : undefined);
  }

  listThreads(
    groupId: string,
    options: { status?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ items: Thread[]; nextCursor: string | null }> {
    return this.get(`/api/v1/groups/${groupId}/threads${queryString(options)}`);
  }

  createThread(
    groupId: string,
    body: { sourceMessageId: string; title: string },
  ): Promise<{ thread: Thread }> {
    return this.post(`/api/v1/groups/${groupId}/threads`, body);
  }

  getThread(threadId: string): Promise<ThreadDetail> {
    return this.get(`/api/v1/threads/${threadId}`);
  }

  listThreadMessages(
    threadId: string,
    options: { limit?: number; cursor?: number } = {},
  ): Promise<{ items: Message[]; nextCursor: number | null }> {
    return this.get(`/api/v1/threads/${threadId}/messages${queryString(options)}`);
  }

  postThreadMessage(
    threadId: string,
    body: { content: string; replyToMessageId?: string },
  ): Promise<{ message: Message }> {
    return this.post(`/api/v1/threads/${threadId}/messages`, body);
  }

  listThreadEvents(
    threadId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: EventRow[]; nextCursor: string | null }> {
    return this.get(`/api/v1/threads/${threadId}/events${queryString(options)}`);
  }

  closeThread(threadId: string): Promise<{ thread: Thread }> {
    return this.post(`/api/v1/threads/${threadId}/close`);
  }

  listTasks(
    groupId: string,
    options: { status?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ items: Task[]; nextCursor: string | null }> {
    return this.get(`/api/v1/groups/${groupId}/tasks${queryString(options)}`);
  }

  createTask(
    groupId: string,
    body: {
      sourceMessageId: string;
      title: string;
      description?: string;
      assignedAgentId?: string;
      workspaceId?: string;
      idempotencyKey?: string;
    },
  ): Promise<{ task: Task; threadId: string }> {
    return this.post(`/api/v1/groups/${groupId}/tasks`, body);
  }

  getTask(taskId: string): Promise<{ task: Task }> {
    return this.get(`/api/v1/tasks/${taskId}`);
  }

  assignTask(taskId: string, agentId: string): Promise<{ task: Task }> {
    return this.post(`/api/v1/tasks/${taskId}/assign`, { agentId });
  }

  pauseTask(taskId: string): Promise<Task> {
    return this.post(`/api/v1/tasks/${taskId}/pause`);
  }

  resumeTask(taskId: string): Promise<Task> {
    return this.post(`/api/v1/tasks/${taskId}/resume`);
  }

  cancelTask(taskId: string, reason?: string): Promise<{ task: Task }> {
    return this.post(`/api/v1/tasks/${taskId}/cancel`, { reason });
  }

  listApprovals(taskId: string): Promise<{ approvals: Approval[] }> {
    return this.get(`/api/v1/tasks/${taskId}/approvals`);
  }

  approve(approvalId: string): Promise<{ approval: Approval; task: Task }> {
    return this.post(`/api/v1/approvals/${approvalId}/approve`);
  }

  reject(approvalId: string, reason: string): Promise<{ approval: Approval; task: Task }> {
    return this.post(`/api/v1/approvals/${approvalId}/reject`, { reason });
  }

  listEvents(
    groupId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: EventRow[]; nextCursor: string | null }> {
    return this.get(`/api/v1/groups/${groupId}/events${queryString(options)}`);
  }

  listDeliveries(
    groupId: string,
    options: { status?: string; agentId?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ items: DeliveryItem[]; nextCursor: string | null }> {
    return this.get(`/api/v1/groups/${groupId}/deliveries${queryString(options)}`);
  }

  deliveryStats(groupId: string): Promise<DeliveryStats> {
    return this.get(`/api/v1/groups/${groupId}/deliveries/stats`);
  }

  listWorkspaces(groupId: string): Promise<{ workspaces: Workspace[] }> {
    return this.get(`/api/v1/groups/${groupId}/workspaces`);
  }

  createWorkspace(groupId: string, name: string): Promise<{ workspace: Workspace }> {
    return this.post(`/api/v1/groups/${groupId}/workspaces`, { name });
  }

  listAgents(): Promise<{ agents: Agent[] }> {
    return this.get("/api/v1/agents");
  }

  registerAgent(body: {
    displayName: string;
    runtime: string;
    model?: string;
    capabilities?: string[];
    publicKey: string;
  }): Promise<{ agent: Agent; key: AgentKey }> {
    return this.post("/api/v1/agents", body);
  }

  disableAgent(agentId: string, reason?: string): Promise<{ agent: Agent }> {
    return this.post(`/api/v1/agents/${agentId}/disable`, { reason });
  }

  enableAgent(agentId: string): Promise<{ agent: Agent }> {
    return this.post(`/api/v1/agents/${agentId}/enable`);
  }

  listAgentKeys(agentId: string): Promise<{ keys: AgentKey[] }> {
    return this.get(`/api/v1/agents/${agentId}/keys`);
  }

  addAgentKey(agentId: string, publicKey: string): Promise<{ key: AgentKey }> {
    return this.post(`/api/v1/agents/${agentId}/keys`, { publicKey });
  }

  revokeAgentKey(agentId: string, keyId: string): Promise<{ key: AgentKey }> {
    return this.post(`/api/v1/agents/${agentId}/keys/${keyId}/revoke`);
  }

  listUsers(): Promise<{ users: User[] }> {
    return this.get("/api/v1/users");
  }

  createUser(body: {
    displayName: string;
    email?: string;
    role?: RbacRole;
  }): Promise<{ user: User }> {
    return this.post("/api/v1/users", body);
  }

  setUserRole(userId: string, role: RbacRole): Promise<{ user: User }> {
    return this.patch(`/api/v1/users/${userId}`, { role });
  }

  disableUser(userId: string): Promise<{ user: User }> {
    return this.post(`/api/v1/users/${userId}/disable`);
  }

  enableUser(userId: string): Promise<{ user: User }> {
    return this.post(`/api/v1/users/${userId}/enable`);
  }

  async realtimeTicket(): Promise<{ ticket: string; expiresAt: number }> {
    return this.post("/api/v1/realtime/ticket");
  }
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export function parseEventPayload(event: EventRow): Record<string, unknown> {
  try {
    const parsed =
      typeof event.payload === "string" ? (JSON.parse(event.payload) as unknown) : event.payload;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function messageFromEvent(event: EventRow, groupId: string): Message | null {
  if (event.type !== "message.created") return null;
  const payload = parseEventPayload(event);
  const content = payload.content;
  const messageId = payload.messageId;
  if (typeof content !== "string" || typeof messageId !== "string") return null;
  return {
    id: messageId,
    groupId,
    threadId: typeof payload.threadId === "string" ? payload.threadId : event.threadId,
    senderType:
      payload.senderType === "agent" || payload.senderType === "system"
        ? payload.senderType
        : "user",
    senderId: typeof payload.senderId === "string" ? payload.senderId : event.actorId,
    content,
    rootMessageId: typeof payload.rootMessageId === "string" ? payload.rootMessageId : null,
    replyToMessageId:
      typeof payload.replyToMessageId === "string" ? payload.replyToMessageId : null,
    hop: typeof payload.hop === "number" ? payload.hop : 0,
    seq: typeof payload.seq === "number" ? payload.seq : event.seq,
    createdAt: event.createdAt,
  };
}
