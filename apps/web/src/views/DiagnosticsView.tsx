import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiClient,
  type DeliveryItem,
  type DeliveryStats,
  type EventRow,
  type Group,
  type MeResponse,
} from "../api";
import { Button, Card, Empty, Select } from "../ui";
import { formatTime, shortId, statusLabel } from "../format";

export function DiagnosticsView({
  api,
  group,
  me,
  onError: _onError,
}: {
  api: ApiClient;
  group: Group;
  me: MeResponse["user"];
  onError: (error: unknown) => void;
}) {
  const [stats, setStats] = useState<DeliveryStats | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryItem[]>([]);
  const [deliveryStatus, setDeliveryStatus] = useState("");
  const [deliveryCursor, setDeliveryCursor] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const groupIdRef = useRef(group.id);
  groupIdRef.current = group.id;

  useEffect(() => {
    setStats(null);
    setDeliveries([]);
    setDeliveryCursor(null);
    setEvents([]);
    setEventCursor(null);
    setCanManage(null);
  }, [group.id]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await api.listMembers(group.id);
        if (!active) return;
        const membership = result.members.find(
          (member) => member.memberType === "user" && member.memberId === me.id,
        );
        const systemAdmin = me.role === "owner" || me.role === "admin";
        setCanManage(
          systemAdmin || membership?.memberRole === "owner" || membership?.memberRole === "admin",
        );
      } catch {
        if (active) setCanManage(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [api, group.id, me.id, me.role]);

  const loadStats = useCallback(async () => {
    if (canManage !== true) return;
    const groupId = group.id;
    try {
      const result = await api.deliveryStats(groupId);
      if (groupIdRef.current === groupId) setStats(result);
    } catch {
      if (groupIdRef.current === groupId) setStats(null);
    }
  }, [api, canManage, group.id]);

  const loadDeliveries = useCallback(
    async (cursor?: string) => {
      if (canManage !== true) return;
      const groupId = group.id;
      try {
        const result = await api.listDeliveries(groupId, {
          status: deliveryStatus || undefined,
          limit: 50,
          cursor,
        });
        if (groupIdRef.current !== groupId) return;
        setDeliveries((current) => (cursor ? [...current, ...result.items] : result.items));
        setDeliveryCursor(result.nextCursor);
      } catch {
        if (groupIdRef.current === groupId) setDeliveries([]);
      }
    },
    [api, canManage, group.id, deliveryStatus],
  );

  const loadEvents = useCallback(
    async (cursor?: string) => {
      const groupId = group.id;
      try {
        const result = await api.listEvents(groupId, { limit: 50, cursor });
        if (groupIdRef.current !== groupId) return;
        setEvents((current) => (cursor ? [...current, ...result.items] : result.items));
        setEventCursor(result.nextCursor);
      } catch {
        if (groupIdRef.current === groupId) setEvents([]);
      }
    },
    [api, group.id],
  );

  useEffect(() => {
    void loadStats();
    void loadDeliveries();
  }, [loadStats, loadDeliveries]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  return (
    <div className="stack">
      {canManage === false && (
        <p className="muted small">诊断信息仅群组 Owner/Admin 或系统管理员可见。</p>
      )}
      {canManage === true && (
        <div className="stat-row">
          {stats &&
            Object.entries(stats.statuses).map(([status, count]) => (
              <div key={status} className="stat">
                <div className="stat-value">{count}</div>
                <div className="muted small">{statusLabel(status)}</div>
              </div>
            ))}
          <div className="stat">
            <div className="stat-value">
              {stats?.oldestPendingAt ? formatTime(stats.oldestPendingAt) : "—"}
            </div>
            <div className="muted small">最老 pending</div>
          </div>
        </div>
      )}
      {canManage === true && (
        <Card
          title="Delivery"
          actions={
            <div className="row tight">
              <Select
                value={deliveryStatus}
                onChange={(event) => {
                  setDeliveryStatus(event.target.value);
                  setDeliveries([]);
                  setDeliveryCursor(null);
                }}
              >
                <option value="">全部</option>
                <option value="pending">pending</option>
                <option value="delivered">delivered</option>
                <option value="acked">acked</option>
                <option value="failed">failed</option>
              </Select>
              <Button onClick={() => void loadDeliveries()}>刷新</Button>
            </div>
          }
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Delivery</th>
                  <th>Agent</th>
                  <th>Event</th>
                  <th>状态</th>
                  <th>尝试</th>
                  <th>创建</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((item) => (
                  <tr key={item.delivery.id}>
                    <td className="mono small">{shortId(item.delivery.id)}</td>
                    <td className="small">
                      {item.agentDisplayName || shortId(item.delivery.agentId)}
                    </td>
                    <td className="mono small">
                      {item.eventType || shortId(item.delivery.eventId)}
                    </td>
                    <td>
                      <span
                        className={`badge badge-${item.delivery.status === "failed" ? "danger" : "accent"}`}
                      >
                        {statusLabel(item.delivery.status)}
                      </span>
                    </td>
                    <td>{item.delivery.attempts}</td>
                    <td className="small">{formatTime(item.delivery.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {deliveries.length === 0 && <Empty>暂无 Delivery</Empty>}
          </div>
          {deliveryCursor && (
            <Button onClick={() => void loadDeliveries(deliveryCursor)}>加载更多</Button>
          )}
        </Card>
      )}
      <Card title="事件历史" actions={<Button onClick={() => void loadEvents()}>刷新</Button>}>
        <div className="list compact">
          {events.map((event) => (
            <div key={event.id} className="list-row">
              <div>
                <span className="mono small">{event.seq}</span>{" "}
                <strong className="small">{event.type}</strong>
                <div className="muted small">
                  {formatTime(event.createdAt)} · {event.actorType}:{shortId(event.actorId)}
                </div>
              </div>
            </div>
          ))}
          {events.length === 0 && <Empty>暂无事件</Empty>}
        </div>
        {eventCursor && <Button onClick={() => void loadEvents(eventCursor)}>加载更多</Button>}
      </Card>
    </div>
  );
}
