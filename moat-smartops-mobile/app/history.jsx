// moat-smartops-mobile/History.jsx
import { useRouter } from "expo-router";
import * as SQLite from "expo-sqlite";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const THEME_COLOR = "#22a6b3";

async function getDb() {
  // Same DB name as your database.js
  return await SQLite.openDatabaseAsync("moatSmartOps.db");
}

function fmtWhen(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  } catch {
    return String(iso);
  }
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function summarizePayload(eventType, payloadJson) {
  const p = safeParse(payloadJson) || {};
  // Keep it short + useful
  if (eventType === "activity-log") {
    return (
      (p.note ? `Note: ${p.note}` : "") ||
      (p.taskId ? `Task: ${p.taskId}` : "") ||
      (p.projectId ? `Project: ${p.projectId}` : "") ||
      "Activity log"
    );
  }
  if (eventType === "project-update") {
    return (
      (p.managerNote ? `Note: ${p.managerNote}` : "") ||
      (p.status ? `Status: ${p.status}` : "") ||
      (p.projectId ? `Project: ${p.projectId}` : "") ||
      "Project update"
    );
  }
  if (eventType === "task-update") {
    return (
      (p.note ? `Note: ${p.note}` : "") ||
      (p.status ? `Status: ${p.status}` : "") ||
      (p.taskId ? `Task: ${p.taskId}` : "") ||
      "Task update"
    );
  }
  if (eventType === "user-document") {
    return (
      (p.title ? `Title: ${p.title}` : "") ||
      (p.tag ? `Tag: ${p.tag}` : "") ||
      (p.projectId ? `Project: ${p.projectId}` : "") ||
      "User document"
    );
  }
  return p?.note ? `Note: ${p.note}` : "Saved event";
}

function normalizeServerStage(row) {
  // Support either serverStage or server_stage (in case schema differs)
  const v = row?.serverStage ?? row?.server_stage ?? null;
  if (!v) return "";
  return String(v).toLowerCase();
}

function getBadgeStyle(syncStatus, serverStage) {
  // syncStatus: pending | synced | failed
  // serverStage: received | applied (optional)
  let backgroundColor = "#ccc";
  if (syncStatus === "pending") backgroundColor = "#f39c12";
  else if (syncStatus === "failed") backgroundColor = "#e74c3c";
  else if (syncStatus === "synced") {
    // Applied should look "stronger" but we won't change colors unless you want.
    // We'll keep same green to avoid confusing users.
    backgroundColor = "#27ae60";
  }
  return {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor,
  };
}

function getBadgeText(syncStatus, serverStage) {
  if (syncStatus === "pending") return "Pending";
  if (syncStatus === "failed") return "Failed";

  // syncStatus === "synced"
  // If backend later confirms it applied, show Applied.
  if (serverStage === "applied") return "Applied";
  return "Sent to server";
}

export default function HistoryScreen() {
  const router = useRouter();

  const [filter, setFilter] = useState("all"); // all | pending | synced | failed
  const [counts, setCounts] = useState({
    all: 0,
    pending: 0,
    synced: 0,
    failed: 0,
  });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const filterOptions = useMemo(
    () => [
      { key: "all", label: "All" },
      { key: "pending", label: "Pending" },
      // Keep filter key "synced" for your existing system and cleanup timer logic.
      // The label is improved.
      { key: "synced", label: "Sent" },
      { key: "failed", label: "Failed" },
    ],
    [],
  );

  const loadData = async () => {
    setLoading(true);
    try {
      const db = await getDb();

      // Counts
      const countRows = await db.getAllAsync(
        `SELECT syncStatus, COUNT(*) AS c
         FROM offline_events
         GROUP BY syncStatus`,
      );

      const nextCounts = { all: 0, pending: 0, synced: 0, failed: 0 };
      for (const r of countRows) {
        const s = (r.syncStatus || "").toLowerCase();
        if (s === "pending") nextCounts.pending = r.c || 0;
        if (s === "synced") nextCounts.synced = r.c || 0;
        if (s === "failed") nextCounts.failed = r.c || 0;
      }
      nextCounts.all =
        nextCounts.pending + nextCounts.synced + nextCounts.failed;

      setCounts(nextCounts);

      // Events list
      const where = filter === "all" ? "" : `WHERE syncStatus = '${filter}'`;

      // NOTE:
      // We attempt to read serverStage/server_stage if it exists.
      // If it doesn't exist in your table yet, SQLite will throw.
      // So we do a safe fallback query.
      let list = [];
      try {
        list = await db.getAllAsync(
          `SELECT id, eventType, orgId, userId, entityRef, payloadJson, fileUrisJson,
                  syncStatus, errorText, createdAt, updatedAt,
                  serverStage, server_stage
           FROM offline_events
           ${where}
           ORDER BY createdAt DESC
           LIMIT 200`,
        );
      } catch {
        // Fallback if serverStage columns don't exist yet
        list = await db.getAllAsync(
          `SELECT id, eventType, orgId, userId, entityRef, payloadJson, fileUrisJson,
                  syncStatus, errorText, createdAt, updatedAt
           FROM offline_events
           ${where}
           ORDER BY createdAt DESC
           LIMIT 200`,
        );
      }

      setRows(list || []);
    } catch (e) {
      console.log("[History] load error", e);
      Alert.alert("Error", "Could not load History from SQLite.");
    } finally {
      setLoading(false);
    }
  };

  const handleClearSynced = async () => {
    try {
      const db = await getDb();

      if ((counts.synced || 0) === 0) {
        Alert.alert("Nothing to clear", "No sent items to delete.");
        return;
      }

      Alert.alert(
        "Clear sent history?",
        `This will delete ${counts.synced} sent item(s) from this device history.\nPending/failed items will be kept.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Clear",
            style: "destructive",
            onPress: async () => {
              try {
                await db.runAsync(
                  `DELETE FROM offline_events WHERE syncStatus='synced'`,
                );
                Alert.alert("Cleared", "Sent history has been removed.");
                await loadData();
              } catch (err) {
                console.log("[History] clear error", err);
                Alert.alert("Error", "Could not clear sent items.");
              }
            },
          },
        ],
      );
    } catch (e) {
      console.log("[History] clear error", e);
      Alert.alert("Error", "Could not clear sent items.");
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Top bar with History logo + home */}
      <View style={styles.topBar}>
        <Image
          source={require("../assets/history-screen.png")}
          style={styles.topBarLogo}
          resizeMode="contain"
        />
        <TouchableOpacity
          style={styles.homeButton}
          onPress={() => router.replace("/home")}
        >
          <Image
            source={require("../assets/home.png")}
            style={styles.homeIcon}
          />
        </TouchableOpacity>
      </View>

      {/* Controls */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>History</Text>
        <Text style={styles.cardSubtitle}>
          Pending = still on device.
          {"\n"}
          Sent to server = successfully uploaded.
          {"\n"}
          Applied = server confirmed it updated a real record (will appear once
          backend applier is added).
        </Text>

        {/* Filter chips */}
        <View style={styles.chipRow}>
          {filterOptions.map((o) => {
            const selected = filter === o.key;
            const count =
              o.key === "all"
                ? counts.all
                : o.key === "pending"
                  ? counts.pending
                  : o.key === "synced"
                    ? counts.synced
                    : counts.failed;

            return (
              <TouchableOpacity
                key={o.key}
                style={[styles.chip, selected && styles.chipSelected]}
                onPress={() => setFilter(o.key)}
              >
                <Text
                  style={[styles.chipText, selected && styles.chipTextSelected]}
                >
                  {o.label} ({count || 0})
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.secondaryButton, styles.rowButton]}
            onPress={loadData}
            disabled={loading}
          >
            <Text style={styles.secondaryButtonText}>
              {loading ? "Refreshing…" : "Refresh"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.primaryButton, styles.rowButton]}
            onPress={handleClearSynced}
          >
            <Text style={styles.primaryButtonText}>Clear sent</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* List */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Recent items</Text>

        {rows.length === 0 ? (
          <Text style={styles.emptyText}>
            No history items for this filter.
          </Text>
        ) : (
          rows.map((r) => {
            const status = (r.syncStatus || "pending").toLowerCase();
            const serverStage = normalizeServerStage(r); // "" | "received" | "applied"
            const summary = summarizePayload(r.eventType, r.payloadJson);
            const when = fmtWhen(r.createdAt);

            return (
              <View key={String(r.id)} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>
                    {r.eventType || "event"}{" "}
                    <Text style={styles.rowMeta}>#{r.id}</Text>
                  </Text>

                  <Text style={styles.rowSub}>
                    {when} {r.entityRef ? `| Ref: ${r.entityRef}` : ""}
                  </Text>

                  <Text style={styles.rowBody} numberOfLines={2}>
                    {summary}
                  </Text>

                  {status === "synced" && serverStage === "applied" ? (
                    <Text style={styles.rowAppliedHint} numberOfLines={1}>
                      Applied on server
                    </Text>
                  ) : null}

                  {status === "failed" && r.errorText ? (
                    <Text style={styles.rowError} numberOfLines={2}>
                      Error: {String(r.errorText)}
                    </Text>
                  ) : null}
                </View>

                <View style={getBadgeStyle(status, serverStage)}>
                  <Text style={styles.badgeText}>
                    {getBadgeText(status, serverStage)}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </View>

      <Text style={styles.hintText}>
        Your existing auto-delete (30 days after “sent”) can stay exactly the
        same. When we add “Applied”, it won’t break cleanup.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 60,
    paddingHorizontal: 16,
    paddingBottom: 32,
    backgroundColor: "#f5f5f5",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  topBarLogo: {
    flex: 1,
    height: 48,
  },
  homeButton: {
    padding: 4,
    marginLeft: 8,
  },
  homeIcon: {
    width: 32,
    height: 32,
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 4,
  },
  cardSubtitle: {
    fontSize: 12,
    color: "#666",
    marginBottom: 12,
    lineHeight: 16,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 10,
  },
  chip: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 18,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginRight: 8,
    marginBottom: 8,
    backgroundColor: "#fafafa",
  },
  chipSelected: {
    borderColor: THEME_COLOR,
    backgroundColor: "#e6f9fb",
  },
  chipText: {
    fontSize: 12,
    color: "#555",
    fontWeight: "500",
  },
  chipTextSelected: {
    color: THEME_COLOR,
    fontWeight: "600",
  },
  buttonRow: {
    flexDirection: "row",
    marginTop: 6,
  },
  rowButton: {
    flex: 1,
    marginHorizontal: 4,
  },
  primaryButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: THEME_COLOR,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  secondaryButtonText: {
    color: THEME_COLOR,
    fontSize: 14,
    fontWeight: "600",
  },
  emptyText: {
    fontSize: 12,
    color: "#999",
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  rowTitle: {
    fontSize: 14,
    fontWeight: "600",
  },
  rowMeta: {
    fontSize: 12,
    fontWeight: "500",
    color: "#777",
  },
  rowSub: {
    fontSize: 11,
    color: "#777",
    marginTop: 2,
  },
  rowBody: {
    fontSize: 12,
    color: "#333",
    marginTop: 6,
  },
  rowAppliedHint: {
    fontSize: 11,
    color: "#27ae60",
    marginTop: 6,
    fontWeight: "700",
  },
  rowError: {
    fontSize: 11,
    color: "#e74c3c",
    marginTop: 6,
  },
  badgeText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
  },
  hintText: {
    fontSize: 11,
    color: "#777",
    textAlign: "center",
    marginTop: 4,
    lineHeight: 16,
  },
});
