export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function formatTime(value: number | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(value: number | null | undefined): string {
  if (!value) return "—";
  const delta = Date.now() - value;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return formatTime(value);
}

export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "排队中",
    assigned: "已分配",
    running: "执行中",
    waiting_approval: "等待审批",
    paused: "已暂停",
    succeeded: "成功",
    failed: "失败",
    cancelled: "已取消",
    open: "进行中",
    closed: "已关闭",
    pending: "待处理",
    delivered: "已投递",
    acked: "已确认",
    approved: "已批准",
    rejected: "已拒绝",
    expired: "已过期",
    active: "启用",
    disabled: "禁用",
    offline: "离线",
    revoked: "已吊销",
  };
  return labels[status] ?? status;
}
