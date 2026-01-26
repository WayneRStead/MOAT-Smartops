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
      (p.note ? `Note: ${p.note}` : "") ||
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
      (p.docCategory ? `Tag: ${p.docCategory}` : "") ||
      (p.projectId ? `Project: ${p.projectId}` : "") ||
      "User document"
    );
  }
  return p?.note ? `Note: ${p.note}` : "Saved event";
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
      { key: "synced", label: "Synced" },
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

      const list = await db.getAllAsync(
        `SELECT id, eventType, orgId, userId, entityRef, payloadJson, fileUrisJson,
                syncStatus, errorText, createdAt, updatedAt
         FROM offline_events
         ${where}
         ORDER BY createdAt DESC
         LIMIT 200`,
      );

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
        Alert.alert("Nothing to clear", "No synced items to delete.");
        return;
      }

      Alert.alert(
        "Clear synced history?",
        `This will delete ${counts.synced} synced item(s) from this device history.\nPending/failed items will be kept.`,
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
                Alert.alert("Cleared", "Synced history has been removed.");
                await loadData();
              } catch (err) {
                console.log("[History] clear error", err);
                Alert.alert("Error", "Could not clear synced items.");
              }
            },
          },
        ],
      );
    } catch (e) {
      console.log("[History] clear error", e);
      Alert.alert("Error", "Could not clear synced items.");
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const getBadgeStyle = (status) => {
    let backgroundColor = "#ccc";
    if (status === "pending") backgroundColor = "#f39c12";
    else if (status === "synced") backgroundColor = "#27ae60";
    else if (status === "failed") backgroundColor = "#e74c3c";
    return {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 12,
      backgroundColor,
    };
  };

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
          This shows what has been captured on the device. Synced items can be
          cleared to save space.
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
            <Text style={styles.primaryButtonText}>Clear synced</Text>
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

                  {status === "failed" && r.errorText ? (
                    <Text style={styles.rowError} numberOfLines={2}>
                      Error: {String(r.errorText)}
                    </Text>
                  ) : null}
                </View>

                <View style={getBadgeStyle(status)}>
                  <Text style={styles.badgeText}>
                    {status === "pending"
                      ? "Pending"
                      : status === "synced"
                        ? "Synced"
                        : "Failed"}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </View>

      <Text style={styles.hintText}>
        Note: auto-delete (30–90 days after sync) can be added once backend sync
        is wired.
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
  },
});
