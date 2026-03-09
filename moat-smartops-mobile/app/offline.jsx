// moat-smartops-mobile/app/offline.jsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { apiGet, ORG_KEY } from "../apiClient";
import { syncOutbox } from "../syncOutbox";

const THEME_COLOR = "#22a6b3";

/**
 * Offline cache keys
 */
const CACHE_KEYS = {
  definitions: "@moat:cache:definitions",
  projects: "@moat:cache:projects",
  tasks: "@moat:cache:tasks",
  milestonesByTask: "@moat:cache:milestonesByTask",
  assets: "@moat:cache:assets",
  vehicles: "@moat:cache:vehicles",
  inspections: "@moat:cache:inspections",
  documents: "@moat:cache:documents",
  groups: "@moat:cache:groups",
  users: "@moat:cache:users",
  vendors: "@moat:cache:vehicleVendors",
};

async function safeCacheSet(key, value) {
  await AsyncStorage.setItem(key, JSON.stringify(value ?? []));
}

async function safeCacheSetObject(key, value) {
  await AsyncStorage.setItem(key, JSON.stringify(value ?? {}));
}

async function safeCacheGet(key) {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function safeCacheGetObject(key) {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function countDefinitions(definitions) {
  if (!definitions || typeof definitions !== "object") return 0;

  if (Array.isArray(definitions.vehicleEntryTypes)) {
    return definitions.vehicleEntryTypes.length;
  }
  if (Array.isArray(definitions.logTypes)) {
    return definitions.logTypes.length;
  }
  if (Array.isArray(definitions.purchaseTypes)) {
    return definitions.purchaseTypes.length;
  }

  return Object.keys(definitions).length;
}

function buildMilestonesByTask(milestones) {
  const out = {};
  for (const m of Array.isArray(milestones) ? milestones : []) {
    const taskId = String(
      m?.taskId?._id || m?.taskId || m?.parentTaskId || "",
    ).trim();
    if (!taskId) continue;
    if (!Array.isArray(out[taskId])) out[taskId] = [];
    out[taskId].push(m);
  }
  return out;
}

function normalizeVendors(vendors) {
  return (Array.isArray(vendors) ? vendors : [])
    .map((v) => {
      if (!v) return null;
      if (typeof v === "string") {
        return { id: v, label: v };
      }
      const id = String(v._id || v.id || v.name || "").trim();
      const label = String(v.name || v.label || id).trim();
      if (!label) return null;
      return {
        ...v,
        id: id || label,
        label,
      };
    })
    .filter(Boolean);
}

export default function OfflineScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const [counts, setCounts] = useState({
    definitions: 0,
    projects: 0,
    tasks: 0,
    milestonesTasks: 0,
    assets: 0,
    vehicles: 0,
    inspections: 0,
    documents: 0,
    groups: 0,
    users: 0,
    vendors: 0,
  });

  async function loadCounts() {
    const [
      definitions,
      projects,
      tasks,
      milestonesByTask,
      assets,
      vehicles,
      inspections,
      documents,
      groups,
      users,
      vendors,
    ] = await Promise.all([
      safeCacheGetObject(CACHE_KEYS.definitions),
      safeCacheGet(CACHE_KEYS.projects),
      safeCacheGet(CACHE_KEYS.tasks),
      safeCacheGetObject(CACHE_KEYS.milestonesByTask),
      safeCacheGet(CACHE_KEYS.assets),
      safeCacheGet(CACHE_KEYS.vehicles),
      safeCacheGet(CACHE_KEYS.inspections),
      safeCacheGet(CACHE_KEYS.documents),
      safeCacheGet(CACHE_KEYS.groups),
      safeCacheGet(CACHE_KEYS.users),
      safeCacheGet(CACHE_KEYS.vendors),
    ]);

    setCounts({
      definitions: countDefinitions(definitions),
      projects: projects.length,
      tasks: tasks.length,
      milestonesTasks: Object.keys(milestonesByTask || {}).length,
      assets: assets.length,
      vehicles: vehicles.length,
      inspections: inspections.length,
      documents: documents.length,
      groups: groups.length,
      users: users.length,
      vendors: vendors.length,
    });
  }

  useEffect(() => {
    (async () => {
      await loadCounts();
    })();
  }, []);

  const refreshLists = async () => {
    setLoading(true);
    try {
      const savedOrg = await AsyncStorage.getItem(ORG_KEY);
      if (!savedOrg) {
        Alert.alert("Missing Org", "No orgId found on this device yet.");
        return;
      }

      // sanity check
      await apiGet("/api/mobile/whoami");

      let mobileLists = null;
      try {
        mobileLists = await apiGet("/api/mobile/lists");
      } catch (e) {
        if (e?.status !== 404) throw e;
      }

      async function fetchMaybeArray(path) {
        try {
          const data = await apiGet(path);
          if (Array.isArray(data)) return data;
          if (Array.isArray(data?.items)) return data.items;
          if (Array.isArray(data?.data)) return data.data;
          return [];
        } catch (e) {
          if (e?.status === 404) return [];
          throw e;
        }
      }

      async function fetchMaybeObject(path) {
        try {
          const data = await apiGet(path);
          if (data?.definitions && typeof data.definitions === "object") {
            return data.definitions;
          }
          return data && typeof data === "object" && !Array.isArray(data)
            ? data
            : {};
        } catch (e) {
          if (e?.status === 404) return {};
          throw e;
        }
      }

      // PRIMARY: use /api/mobile/lists
      // FALLBACK: use old endpoints only if missing
      const projects = Array.isArray(mobileLists?.projects)
        ? mobileLists.projects
        : await fetchMaybeArray("/api/projects");

      const tasks = Array.isArray(mobileLists?.tasks)
        ? mobileLists.tasks
        : await fetchMaybeArray("/api/tasks");

      const milestones = Array.isArray(mobileLists?.milestones)
        ? mobileLists.milestones
        : Array.isArray(mobileLists?.taskMilestones)
          ? mobileLists.taskMilestones
          : [];

      const assets = Array.isArray(mobileLists?.assets)
        ? mobileLists.assets
        : await fetchMaybeArray("/api/assets");

      const vehicles = Array.isArray(mobileLists?.vehicles)
        ? mobileLists.vehicles
        : await fetchMaybeArray("/api/vehicles");

      const inspections = Array.isArray(mobileLists?.inspections)
        ? mobileLists.inspections
        : await fetchMaybeArray("/api/inspection/forms");

      const documents = Array.isArray(mobileLists?.documents)
        ? mobileLists.documents
        : await fetchMaybeArray("/api/documents");

      const groups = Array.isArray(mobileLists?.groups)
        ? mobileLists.groups
        : await fetchMaybeArray("/api/groups");

      const users = Array.isArray(mobileLists?.users)
        ? mobileLists.users
        : await fetchMaybeArray("/api/users");

      const vendorsRaw = Array.isArray(mobileLists?.vendors)
        ? mobileLists.vendors
        : await fetchMaybeArray("/api/vendors");

      const vendors = normalizeVendors(vendorsRaw);

      const definitions =
        mobileLists?.definitions && typeof mobileLists.definitions === "object"
          ? mobileLists.definitions
          : await fetchMaybeObject("/api/mobile/definitions");

      const milestonesByTask = buildMilestonesByTask(milestones);

      await Promise.all([
        safeCacheSet(CACHE_KEYS.projects, projects),
        safeCacheSet(CACHE_KEYS.tasks, tasks),
        safeCacheSetObject(CACHE_KEYS.milestonesByTask, milestonesByTask),
        safeCacheSet(CACHE_KEYS.assets, assets),
        safeCacheSet(CACHE_KEYS.vehicles, vehicles),
        safeCacheSet(CACHE_KEYS.inspections, inspections),
        safeCacheSet(CACHE_KEYS.documents, documents),
        safeCacheSet(CACHE_KEYS.groups, groups),
        safeCacheSet(CACHE_KEYS.users, users),
        safeCacheSet(CACHE_KEYS.vendors, vendors),
        safeCacheSetObject(CACHE_KEYS.definitions, definitions),
      ]);

      await loadCounts();

      Alert.alert(
        "Success",
        `Lists refreshed.\nProjects: ${projects.length}\nTasks: ${tasks.length}\nMilestones: ${milestones.length}\nVehicles: ${vehicles.length}\nVendors: ${vendors.length}`,
      );
    } catch (e) {
      Alert.alert("Could not refresh", e?.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const runSync = async () => {
    setLoading(true);
    try {
      const savedOrg = await AsyncStorage.getItem(ORG_KEY);
      if (!savedOrg) {
        Alert.alert("Missing Org", "No orgId found on this device yet.");
        return;
      }

      const res = await syncOutbox({ limit: 25 });
      Alert.alert(
        "Sync complete",
        `Synced: ${res.synced}\nFailed: ${res.failed}`,
      );
    } catch (e) {
      Alert.alert("Sync failed", e?.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.topBar}>
        <Image
          source={require("../assets/offline-screen.png")}
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

      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={[styles.primaryButton, loading && styles.btnDisabled]}
          onPress={refreshLists}
          activeOpacity={0.85}
          disabled={loading}
        >
          <Text style={styles.primaryButtonText}>
            {loading ? "Working..." : "Refresh lists + definitions"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.primaryButton,
            styles.secondaryButton,
            loading && styles.btnDisabled,
          ]}
          onPress={runSync}
          activeOpacity={0.85}
          disabled={loading}
        >
          <Text style={styles.primaryButtonText}>
            {loading ? "Working..." : "Sync outbox"}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Cached on device</Text>

        <Row
          label="Definitions (vehicle entry types)"
          value={counts.definitions}
        />
        <Row label="Projects" value={counts.projects} />
        <Row label="Tasks" value={counts.tasks} />
        <Row
          label="Milestones cached for tasks"
          value={counts.milestonesTasks}
        />
        <Row label="Assets" value={counts.assets} />
        <Row label="Vehicles" value={counts.vehicles} />
        <Row label="Vendors" value={counts.vendors} />
        <Row label="Inspections (forms)" value={counts.inspections} />
        <Row label="Documents" value={counts.documents} />
        <Row label="Groups" value={counts.groups} />
        <Row label="Users (optional)" value={counts.users} />

        <Text style={styles.hint}>
          This screen refreshes offline dropdown data primarily from
          /api/mobile/lists. If Tasks stays at 0, the backend is not returning
          tasks for your org.
        </Text>
      </View>
    </ScrollView>
  );
}

function Row({ label, value }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{String(value)}</Text>
    </View>
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
  actionsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
    marginBottom: 12,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: THEME_COLOR,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    elevation: 2,
    marginRight: 8,
  },
  secondaryButton: {
    marginRight: 0,
    marginLeft: 8,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  btnDisabled: {
    opacity: 0.6,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 16,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 10,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  rowLabel: {
    fontSize: 13,
    color: "#222",
    fontWeight: "600",
  },
  rowValue: {
    fontSize: 13,
    color: "#222",
    fontWeight: "700",
  },
  hint: {
    marginTop: 12,
    fontSize: 11,
    color: "#777",
  },
});
