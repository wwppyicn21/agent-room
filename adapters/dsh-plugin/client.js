/* global window */
/**
 * DSH Client half for @room/dsh-plugin.
 *
 * Contributes one tab under Settings -> Plugins where the operator can edit
 * the plugin's own config entry (`include:agent-room`) without touching the
 * profile patch. The tab reads and writes through the client `configForms`
 * service, so validation, revision checks and persistence stay owned by the
 * settings provider.
 */
window.__ModuleLoader__.load({
  id: "@room/dsh-plugin",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const NS = "agentRoom";
    const ENTRY_ID = "include:agent-room";

    const en = {
      tab: "Agent Room",
      title: "Agent Room bridge",
      description:
        "Bridge explicitly mapped Agent Room groups into independent DSH sessions. A group may map to one session; a session may serve one group.",
      connection: "Connection",
      baseUrl: "Room server URL",
      baseUrlHint:
        "For example http://127.0.0.1:8787. The plugin keeps its own Ed25519 key under the profile data directory.",
      forwarding: "Group to Session forwarding",
      forwardingHint:
        "Add one row per Room group. Messages in that group are forwarded into the bound DSH session; replies return to the same Room thread.",
      groupId: "Group ID",
      sessionId: "DSH session ID",
      label: "Label (optional)",
      add: "Add mapping",
      remove: "Remove",
      save: "Save",
      saving: "Saving...",
      saved: "Saved. Changes apply within a second; the plugin reconnects if the Room URL changed.",
      saveFailed: "The settings provider rejected the change.",
      loading: "Loading plugin settings...",
      unavailable: "This plugin configuration is not available in the current profile.",
      notWritable: "The current settings document is read-only.",
      empty: "No group is mapped yet. Messages are not forwarded until you add a row and save.",
      invalidGroup: "Every mapping needs a non-empty Group ID.",
      invalidSession: "Every mapping needs a non-empty DSH session ID.",
      duplicateGroup: "The same Group ID appears more than once.",
      duplicateSession: "One DSH session cannot serve more than one group.",
      invalidBaseUrl: "The Room server URL must not be empty.",
    };
    const zh = {
      tab: "Agent Room",
      title: "Agent Room 桥接",
      description:
        "把显式映射的 Agent Room 群组桥接到独立的 DSH 会话。一个群组只能映射一个会话，一个会话也只能服务一个群组。",
      connection: "连接",
      baseUrl: "Room 服务地址",
      baseUrlHint:
        "例如 http://127.0.0.1:8787。插件会在当前 profile 数据目录中维护自己的 Ed25519 密钥。",
      forwarding: "群组到会话的转发",
      forwardingHint:
        "每行对应一个 Room 群组。该群的消息会转发进绑定的 DSH 会话，回复会回到同一个 Room 话题。",
      groupId: "群组 ID",
      sessionId: "DSH 会话 ID",
      label: "备注（可选）",
      add: "添加映射",
      remove: "删除",
      save: "保存",
      saving: "保存中…",
      saved: "已保存，约 1 秒内生效；Room 地址变化时插件会自动重连。",
      saveFailed: "设置服务拒绝了本次修改。",
      loading: "正在加载插件设置…",
      unavailable: "当前 profile 中无法使用此插件配置。",
      notWritable: "当前设置文档为只读。",
      empty: "尚未映射任何群组。添加并保存后才会转发消息。",
      invalidGroup: "每个映射都需要非空的群组 ID。",
      invalidSession: "每个映射都需要非空的 DSH 会话 ID。",
      duplicateGroup: "同一个群组 ID 出现了多次。",
      duplicateSession: "同一个 DSH 会话不能服务多个群组。",
      invalidBaseUrl: "Room 服务地址不能为空。",
    };

    function arrayValue(value) {
      return Array.isArray(value) ? value : [];
    }

    /** Locate the settings namespace serving this bundle's entry id. */
    function namespaceOf(forms) {
      let namespaces = [];
      try {
        const view = forms.describe().getSnapshot().view;
        namespaces = arrayValue(view && view.namespaces);
      } catch {
        namespaces = [];
      }
      const names = namespaces
        .map((item) => item && item.ns)
        .filter((ns) => typeof ns === "string");
      return (
        names.find((ns) => ns === "agent-room") ||
        names.find((ns) => ns.endsWith("agent-room")) ||
        names.find((ns) => ns === ENTRY_ID) ||
        ENTRY_ID
      );
    }

    function rowKey(row, index) {
      return `${index}:${row.groupId}`;
    }

    function blankRow() {
      return { groupId: "", sessionId: "", label: "" };
    }

    function SettingsPage(props) {
      const snapshot = props.useConfig((state) => state);
      const form = props.form;
      const t = props.t;
      const [draft, setDraft] = React.useState(null);
      const [error, setError] = React.useState("");
      const [notice, setNotice] = React.useState("");
      const [busy, setBusy] = React.useState(false);

      const status = snapshot && snapshot.status;
      const revision = snapshot && snapshot.revision;

      React.useEffect(() => {
        if (status !== "ready") return;
        const value = snapshot.value || {};
        setDraft({
          roomBaseUrl: value.roomBaseUrl || "",
          groups: arrayValue(value.groups).map((group) => ({
            groupId: group.groupId || "",
            sessionId: group.sessionId || "",
            label: group.label || "",
          })),
        });
      }, [status, revision]);

      if (status === "loading" || status === "idle") {
        return h("div", { style: { padding: "24px 4px", opacity: 0.7 } }, t("loading"));
      }
      if (status === "unavailable") {
        return h(
          "div",
          { style: { padding: "24px 4px", opacity: 0.7 } },
          t("unavailable"),
          h(
            "pre",
            { style: { fontSize: 11, whiteSpace: "pre-wrap" } },
            String(props.namespaces || ""),
          ),
        );
      }
      if (!draft) return null;

      const writable = Boolean(snapshot.writable) && !busy;
      const updateRow = (index, field, value) => {
        setDraft((current) => ({
          ...current,
          groups: current.groups.map((row, rowIndex) =>
            rowIndex === index ? { ...row, [field]: value } : row,
          ),
        }));
      };
      const save = async () => {
        setError("");
        setNotice("");
        const baseUrl = draft.roomBaseUrl.trim();
        if (!baseUrl) {
          setError(t("invalidBaseUrl"));
          return;
        }
        const groups = draft.groups
          .map((row) => ({
            groupId: row.groupId.trim(),
            sessionId: row.sessionId.trim(),
            label: row.label.trim(),
          }))
          .filter((row) => row.groupId || row.sessionId || row.label);
        const groupSeen = new Set();
        const sessionSeen = new Set();
        for (const row of groups) {
          if (!row.groupId) {
            setError(t("invalidGroup"));
            return;
          }
          if (!row.sessionId) {
            setError(t("invalidSession"));
            return;
          }
          if (groupSeen.has(row.groupId)) {
            setError(t("duplicateGroup"));
            return;
          }
          if (sessionSeen.has(row.sessionId)) {
            setError(t("duplicateSession"));
            return;
          }
          groupSeen.add(row.groupId);
          sessionSeen.add(row.sessionId);
        }
        setBusy(true);
        try {
          const accepted = await form.mutate([
            { op: "set", path: ["roomBaseUrl"], value: baseUrl },
            { op: "set", path: ["groups"], value: groups },
          ]);
          if (accepted) setNotice(t("saved"));
          else setError(t("saveFailed"));
        } catch (cause) {
          setError(cause && cause.message ? String(cause.message) : t("saveFailed"));
        } finally {
          setBusy(false);
        }
      };

      const labelStyle = { fontSize: 12, opacity: 0.72, marginBottom: 4, display: "block" };
      const inputStyle = {
        width: "100%",
        boxSizing: "border-box",
        padding: "7px 9px",
        borderRadius: 6,
        border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
      };
      const cardStyle = {
        border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
        borderRadius: 10,
        padding: "14px 16px",
        marginBottom: 14,
      };

      const rows = draft.groups.map((row, index) =>
        h(
          "div",
          {
            key: rowKey(row, index),
            style: {
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1.4fr) minmax(0, 0.8fr) auto",
              gap: 8,
              alignItems: "end",
              marginBottom: 8,
            },
          },
          h(
            "label",
            null,
            h("span", { style: labelStyle }, t("groupId")),
            h("input", {
              style: inputStyle,
              value: row.groupId,
              placeholder: "grp_...",
              disabled: !writable,
              onChange: (event) => updateRow(index, "groupId", event.target.value),
            }),
          ),
          h(
            "label",
            null,
            h("span", { style: labelStyle }, t("sessionId")),
            h("input", {
              style: inputStyle,
              value: row.sessionId,
              placeholder: "session-...",
              disabled: !writable,
              onChange: (event) => updateRow(index, "sessionId", event.target.value),
            }),
          ),
          h(
            "label",
            null,
            h("span", { style: labelStyle }, t("label")),
            h("input", {
              style: inputStyle,
              value: row.label,
              disabled: !writable,
              onChange: (event) => updateRow(index, "label", event.target.value),
            }),
          ),
          h(
            "button",
            {
              type: "button",
              disabled: !writable,
              onClick: () =>
                setDraft((current) => ({
                  ...current,
                  groups: current.groups.filter((_item, rowIndex) => rowIndex !== index),
                })),
              style: {
                padding: "7px 10px",
                borderRadius: 6,
                border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
                background: "transparent",
                color: "inherit",
                cursor: writable ? "pointer" : "not-allowed",
                opacity: writable ? 1 : 0.5,
              },
            },
            t("remove"),
          ),
        ),
      );

      return h(
        "div",
        { style: { maxWidth: 980, padding: "4px 2px 24px" } },
        h("h2", { style: { margin: "0 0 6px", fontSize: 18 } }, t("title")),
        h("p", { style: { margin: "0 0 18px", opacity: 0.72, lineHeight: 1.5 } }, t("description")),
        h(
          "section",
          { style: cardStyle },
          h("h3", { style: { margin: "0 0 10px", fontSize: 14 } }, t("connection")),
          h(
            "label",
            null,
            h("span", { style: labelStyle }, t("baseUrl")),
            h("input", {
              style: inputStyle,
              value: draft.roomBaseUrl,
              disabled: !writable,
              onChange: (event) =>
                setDraft((current) => ({ ...current, roomBaseUrl: event.target.value })),
            }),
          ),
          h("p", { style: { margin: "6px 0 0", fontSize: 12, opacity: 0.62 } }, t("baseUrlHint")),
        ),
        h(
          "section",
          { style: cardStyle },
          h("h3", { style: { margin: "0 0 4px", fontSize: 14 } }, t("forwarding")),
          h(
            "p",
            { style: { margin: "0 0 12px", fontSize: 12, opacity: 0.62, lineHeight: 1.5 } },
            t("forwardingHint"),
          ),
          rows,
          rows.length === 0
            ? h("p", { style: { margin: "0 0 10px", fontSize: 12, opacity: 0.62 } }, t("empty"))
            : null,
          h(
            "button",
            {
              type: "button",
              disabled: !writable,
              onClick: () =>
                setDraft((current) => ({ ...current, groups: [...current.groups, blankRow()] })),
              style: {
                padding: "7px 12px",
                borderRadius: 6,
                border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
                background: "transparent",
                color: "inherit",
                cursor: writable ? "pointer" : "not-allowed",
                opacity: writable ? 1 : 0.5,
              },
            },
            t("add"),
          ),
        ),
        error
          ? h("p", { style: { color: "#e5484d", margin: "0 0 10px", fontSize: 13 } }, error)
          : null,
        notice
          ? h("p", { style: { color: "#30a46c", margin: "0 0 10px", fontSize: 13 } }, notice)
          : null,
        !snapshot.writable
          ? h("p", { style: { margin: "0 0 10px", fontSize: 12, opacity: 0.7 } }, t("notWritable"))
          : null,
        h(
          "button",
          {
            type: "button",
            disabled: !writable,
            onClick: () => void save(),
            style: {
              padding: "8px 18px",
              borderRadius: 6,
              border: "1px solid color-mix(in srgb, currentColor 26%, transparent)",
              background: "color-mix(in srgb, currentColor 8%, transparent)",
              color: "inherit",
              cursor: writable ? "pointer" : "not-allowed",
              opacity: writable ? 1 : 0.55,
              fontSize: 13,
            },
          },
          busy ? t("saving") : t("save"),
        ),
      );
    }

    return {
      inject: ["slots", "locale", "configForms"],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), "agent-room settings locale");
        ctx.effect(() => {
          let cancelled = false;
          let disposeTab;
          const register = (form, namespaces) => {
            disposeTab = ctx.slots.inject("settings.plugins.tab", () =>
              ctx.slots.register(
                {
                  name: "settings.plugins.tab",
                  id: "agent-room",
                  order: 30,
                  label: () => t("tab"),
                  locale: NS,
                  inject: () => ({ form, hooks: { config: form }, namespaces }),
                },
                SettingsPage,
              ),
            );
          };
          // The settings shell answers describe first; registering before that
          // would bind a namespace the client cannot confirm yet.
          void ctx.configForms
            .describe()
            .ensure()
            .catch(() => undefined)
            .then(() => {
              if (cancelled) return;
              const view = ctx.configForms.describe().getSnapshot().view;
              const namespaces = JSON.stringify(
                (view?.namespaces ?? []).map((item) => item && item.ns),
              );
              try {
                register(ctx.configForms.get(namespaceOf(ctx.configForms)), namespaces);
              } catch (cause) {
                ctx.logger?.warn?.("agent-room settings tab unavailable: %s", String(cause));
              }
            });
          return () => {
            cancelled = true;
            disposeTab?.();
          };
        }, "agent-room settings tab");
      },
    };
  },
});
