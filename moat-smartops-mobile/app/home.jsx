import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { getStoredUserId } from "../apiClient";
import { getDocumentReadMap, listOfflineEvents } from "../database";
import { CACHE_DOCUMENTS, CACHE_TASKS } from "../refreshLists";

const THEME_COLOR = "#22a6b3";

function safeParseArray(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractId(value) {
  if (!value) return "";

  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }

  if (typeof value === "object") {
    if (value.$oid) return String(value.$oid).trim();
    if (value._id) return extractId(value._id);
    if (value.id) return extractId(value.id);
    if (value.userId) return extractId(value.userId);
  }

  return "";
}

function extractDate(value) {
  if (!value) return null;

  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof value === "object") {
    if (value.$date) {
      const d = new Date(value.$date);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }

  return null;
}

function isCompletedStatus(status) {
  const s = String(status || "")
    .trim()
    .toLowerCase();

  return s === "finished" || s === "completed" || s === "complete";
}

function isInProgressStatus(status) {
  const s = String(status || "")
    .trim()
    .toLowerCase();

  return (
    s === "started" ||
    s === "in progress" ||
    s === "in-progress" ||
    s === "progress"
  );
}

function isPendingStatus(status) {
  const s = String(status || "")
    .trim()
    .toLowerCase();

  return s === "pending";
}

function isPausedStatus(status) {
  const s = String(status || "")
    .trim()
    .toLowerCase();

  return (
    s === "paused" || s === "paused with problem" || s === "paused-with-problem"
  );
}

function getDueDate(task) {
  return (
    extractDate(task?.dueDate) ||
    extractDate(task?.dueAt) ||
    extractDate(task?.plannedEndAt) ||
    extractDate(task?.plannedEndDate) ||
    extractDate(task?.deadline) ||
    extractDate(task?.targetDate) ||
    null
  );
}

function getTaskStatus(task) {
  return (
    task?.status ||
    task?.taskStatus ||
    task?.workflowStatus ||
    task?.state ||
    ""
  );
}

function normalizeId(value) {
  return extractId(value);
}

function taskAssignedToUser(task, userId) {
  if (!userId) return false;

  const singleCandidates = [
    task?.assignee,
    task?.assigneeId,
    task?.assignedToUser,
    task?.assignedToId,
    task?.userId,
    task?.ownerId,
  ];

  for (const candidate of singleCandidates) {
    if (extractId(candidate) === userId) return true;
  }

  const arrayCandidates = [
    task?.assignedTo,
    task?.assignedUserIds,
    task?.assignees,
    task?.assignedUsers,
  ];

  for (const arr of arrayCandidates) {
    if (!Array.isArray(arr)) continue;
    if (arr.some((item) => extractId(item) === userId)) return true;
  }

  return false;
}

function ActionTile({ label, icon, onPress, pulse = false }) {
  const anim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!pulse) {
      anim.stopAnimation();
      anim.setValue(1);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 0.55,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    );

    loop.start();
    return () => loop.stop();
  }, [pulse, anim]);

  return (
    <Animated.View style={{ width: "48%", opacity: anim }}>
      <TouchableOpacity
        style={[
          styles.actionTile,
          pulse && { borderWidth: 2, borderColor: THEME_COLOR },
        ]}
        onPress={onPress}
        activeOpacity={0.85}
      >
        <View style={styles.actionIconWrap}>
          <Image
            source={icon}
            style={styles.actionIconImage}
            resizeMode="contain"
          />
        </View>
        <Text style={styles.actionLabel}>{label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function ModuleTile({ label, icon, onPress, pulse = false }) {
  const anim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!pulse) {
      anim.stopAnimation();
      anim.setValue(1);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 0.55,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    );

    loop.start();
    return () => loop.stop();
  }, [pulse, anim]);

  return (
    <Animated.View style={{ width: "48%", opacity: anim }}>
      <TouchableOpacity
        style={[
          styles.tile,
          pulse && { borderWidth: 2, borderColor: THEME_COLOR },
        ]}
        onPress={onPress}
        activeOpacity={0.8}
      >
        <View style={styles.tileIconPlaceholder}>
          <Image
            source={icon}
            style={styles.tileIconImage}
            resizeMode="contain"
          />
        </View>
        <Text style={styles.tileLabel}>{label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

export default function HomeScreen() {
  const router = useRouter();

  const [historyNeedsAttention, setHistoryNeedsAttention] = useState(false);
  const [documentsNeedsAttention, setDocumentsNeedsAttention] = useState(false);

  const [myTasks, setMyTasks] = useState({
    total: 0,
    overdue: 0,
    inProgress: 0,
    paused: 0,
    pending: 0,
    completed: 0,
  });

  useEffect(() => {
    loadHomeSummary();
  }, []);

  const loadHomeSummary = async () => {
    try {
      const [storedTasksRaw, storedDocumentsRaw, userId] = await Promise.all([
        AsyncStorage.getItem(CACHE_TASKS),
        AsyncStorage.getItem(CACHE_DOCUMENTS),
        getStoredUserId(),
      ]);

      const tasks = safeParseArray(storedTasksRaw);
      const documents = safeParseArray(storedDocumentsRaw);

      const myTaskRows = tasks.filter((task) =>
        taskAssignedToUser(task, userId),
      );

      const now = new Date();

      let overdue = 0;
      let inProgress = 0;
      let paused = 0;
      let pending = 0;
      let completed = 0;

      for (const task of myTaskRows) {
        const status = getTaskStatus(task);
        const dueDate = getDueDate(task);
        const done = isCompletedStatus(status);

        if (done) {
          completed += 1;
        } else if (isPausedStatus(status)) {
          paused += 1;
        } else if (isPendingStatus(status)) {
          pending += 1;
        } else if (isInProgressStatus(status)) {
          inProgress += 1;
        }

        if (!done && dueDate && dueDate < now) {
          overdue += 1;
        }
      }

      setMyTasks({
        total: myTaskRows.length,
        overdue,
        inProgress,
        paused,
        pending,
        completed,
      });

      const offlineEvents = await listOfflineEvents(500);
      const unsynced = (offlineEvents || []).some(
        (row) => String(row?.syncStatus || "").toLowerCase() !== "synced",
      );
      setHistoryNeedsAttention(unsynced);

      const mobileDocs = documents.filter((d) => {
        const channel = String(d?.channel || "")
          .trim()
          .toLowerCase();
        const folder = String(d?.folder || "")
          .trim()
          .toLowerCase();

        return (
          channel === "mobile-library" &&
          ["policies", "safety", "general"].includes(folder)
        );
      });

      const readMap = await getDocumentReadMap(userId || null);

      const unreadExists = mobileDocs.some((doc) => {
        const docId = normalizeId(doc?.id || doc?._id);
        const record = readMap?.[docId];
        return !record?.firstReadAt;
      });

      const newerVersionExists = mobileDocs.some((doc) => {
        const docId = normalizeId(doc?.id || doc?._id);
        const record = readMap?.[docId];
        const lastSeen = record?.docUpdatedAt || null;
        const currentUpdatedAt = doc?.updatedAt || null;

        if (!currentUpdatedAt || !lastSeen) return false;

        const a = new Date(lastSeen);
        const b = new Date(currentUpdatedAt);

        if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
          return false;
        }

        return b > a;
      });

      setDocumentsNeedsAttention(unreadExists || newerVersionExists);
    } catch (e) {
      console.log("Failed to load home summary", e);
    }
  };

  const totalTasks = myTasks.total || 0;

  const modules = [
    {
      key: "production",
      label: "Productivity",
      icon: require("../assets/production.png"),
      route: "/production",
    },
    {
      key: "clocking",
      label: "Clocking",
      icon: require("../assets/clockings.png"),
      route: "/clocking",
    },
    {
      key: "logbook",
      label: "Vehicle Logbook",
      icon: require("../assets/vehicle-logbook.png"),
      route: "/logbook",
    },
    {
      key: "assets",
      label: "Assets",
      icon: require("../assets/assets.png"),
      route: "/assets",
    },
    {
      key: "inspections",
      label: "Inspections",
      icon: require("../assets/inspections.png"),
      route: "/inspections",
    },
    {
      key: "documents",
      label: "Documents",
      icon: require("../assets/documents.png"),
      route: "/documents",
      pulse: documentsNeedsAttention,
    },
  ];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <View style={styles.logoContainer}>
          <Pressable onPress={() => router.replace("/home")}>
            <Image
              source={require("../assets/moat-logo.png")}
              style={styles.logoImage}
              resizeMode="contain"
            />
          </Pressable>
        </View>
        <Text style={styles.appTitle}>Smart Operations Suite</Text>
      </View>

      <View style={styles.quickRow}>
        <ActionTile
          label="Offline Lists"
          icon={require("../assets/offline.png")}
          onPress={() => router.push("/offline")}
        />
        <ActionTile
          label="History"
          icon={require("../assets/history.png")}
          onPress={() => router.push("/history")}
          pulse={historyNeedsAttention}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>My Tasks Overview</Text>

        <View style={styles.overviewRow}>
          <View style={styles.donutPlaceholder}>
            <Text style={styles.donutCenterText}>{totalTasks}</Text>
            <Text style={styles.donutLabel}>Total</Text>
          </View>

          <View style={styles.statusList}>
            <Text style={styles.statusItem}>
              Overdue:{" "}
              <Text style={styles.statusOverdue}>{myTasks.overdue}</Text>
            </Text>
            <Text style={styles.statusItem}>
              In progress:{" "}
              <Text style={styles.statusInProgress}>{myTasks.inProgress}</Text>
            </Text>
            <Text style={styles.statusItem}>
              Paused: <Text style={styles.statusPaused}>{myTasks.paused}</Text>
            </Text>
            <Text style={styles.statusItem}>
              Pending:{" "}
              <Text style={styles.statusPending}>{myTasks.pending}</Text>
            </Text>
            <Text style={styles.statusItem}>
              Completed:{" "}
              <Text style={styles.statusCompleted}>{myTasks.completed}</Text>
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.modulesContainer}>
        <Text style={styles.modulesTitle}>Modules</Text>

        <View style={styles.modulesGrid}>
          {modules.map((m) => (
            <ModuleTile
              key={m.key}
              label={m.label}
              icon={m.icon}
              onPress={() => router.push(m.route)}
              pulse={!!m.pulse}
            />
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 40,
    paddingHorizontal: 16,
    paddingBottom: 32,
    backgroundColor: "#f5f5f5",
  },
  header: {
    alignItems: "center",
    marginBottom: 10,
  },
  logoContainer: {
    alignItems: "center",
  },
  logoImage: {
    width: 200,
    height: 100,
  },
  appTitle: {
    marginTop: -20,
    fontSize: 24,
    fontWeight: "500",
  },
  quickRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
    marginBottom: 14,
  },
  actionTile: {
    width: "100%",
    backgroundColor: "#ffffff",
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 10,
    alignItems: "center",
    elevation: 2,
  },
  actionIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  actionIconImage: {
    width: 44,
    height: 44,
  },
  actionLabel: {
    fontSize: 13,
    textAlign: "center",
    fontWeight: "600",
    color: "#000000",
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
    marginBottom: 12,
  },
  overviewRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  donutPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 6,
    borderColor: THEME_COLOR,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 16,
  },
  donutCenterText: {
    fontSize: 18,
    fontWeight: "700",
  },
  donutLabel: {
    fontSize: 10,
    color: "#666",
  },
  statusList: {
    flex: 1,
  },
  statusItem: {
    fontSize: 12,
    marginBottom: 4,
  },
  statusOverdue: {
    color: "#e74c3c",
    fontWeight: "600",
  },
  statusInProgress: {
    color: "#f39c12",
    fontWeight: "600",
  },
  statusPaused: {
    color: "#8e44ad",
    fontWeight: "600",
  },
  statusPending: {
    color: "#2980b9",
    fontWeight: "600",
  },
  statusCompleted: {
    color: "#27ae60",
    fontWeight: "600",
  },
  modulesContainer: {
    marginTop: 8,
  },
  modulesTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
  },
  modulesGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  tile: {
    width: "100%",
    backgroundColor: "#ffffff",
    borderRadius: 10,
    paddingVertical: 16,
    paddingHorizontal: 8,
    marginBottom: 12,
    alignItems: "center",
    elevation: 2,
  },
  tileIconPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  tileIconImage: {
    width: 48,
    height: 48,
  },
  tileLabel: {
    fontSize: 13,
    textAlign: "center",
  },
});
