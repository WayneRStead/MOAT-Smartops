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
      definitions: Array.isArray(definitions?.vehicleEntryTypes)
        ? definitions.vehicleEntryTypes.length
        : 0,
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

  /**
   * Refresh offline lists from ONE backend source:
   * GET /api/mobile/lists
   */
  const refreshLists = async () => {
    setLoading(true);
    try {
      const savedOrg = await AsyncStorage.getItem(ORG_KEY);
      if (!savedOrg) {
        Alert.alert("Missing Org", "No orgId found on this device yet.");
        return;
      }

      await apiGet("/api/mobile/whoami");

      const results = {};

      async function fetchMaybeArray(name, path, cacheKey) {
        try {
          const data = await apiGet(path);
          const items = Array.isArray(data)
            ? data
            : Array.isArray(data?.items)
              ? data.items
              : Array.isArray(data?.data)
                ? data.data
                : [];
          results[name] = items;
          await safeCacheSet(cacheKey, items);
          return items;
        } catch (e) {
          if (e?.status === 404) {
            results[name] = "__NOT_FOUND__";
            return [];
          }
          throw e;
        }
      }

      let mobileLists = null;
      try {
        mobileLists = await apiGet("/api/mobile/lists");
        results.mobileLists = "OK";
      } catch (e) {
        if (e?.status === 404) {
          results.mobileLists = "__NOT_FOUND__";
        } else {
          throw e;
        }
      }

      const definitions =
        mobileLists?.definitions && typeof mobileLists.definitions === "object"
          ? mobileLists.definitions
          : {};

      await safeCacheSetObject(CACHE_KEYS.definitions, definitions);

      const projects = Array.isArray(mobileLists?.projects)
        ? mobileLists.projects
        : await fetchMaybeArray(
            "projects",
            "/api/projects",
            CACHE_KEYS.projects,
          );

      const tasks = Array.isArray(mobileLists?.tasks)
        ? mobileLists.tasks
        : await fetchMaybeArray("tasks", "/api/tasks", CACHE_KEYS.tasks);

      const milestones = Array.isArray(mobileLists?.milestones)
        ? mobileLists.milestones
        : [];

      const milestonesByTask = {};
      for (const m of milestones) {
        const taskId = String(m?.taskId?._id || m?.taskId || "").trim();
        if (!taskId) continue;
        if (!Array.isArray(milestonesByTask[taskId])) {
          milestonesByTask[taskId] = [];
        }
        milestonesByTask[taskId].push(m);
      }

      const assets = Array.isArray(mobileLists?.assets)
        ? mobileLists.assets
        : await fetchMaybeArray("assets", "/api/assets", CACHE_KEYS.assets);

      const vehicles = Array.isArray(mobileLists?.vehicles)
        ? mobileLists.vehicles
        : await fetchMaybeArray(
            "vehicles",
            "/api/vehicles",
            CACHE_KEYS.vehicles,
          );

      const inspections = Array.isArray(mobileLists?.inspections)
        ? mobileLists.inspections
        : await fetchMaybeArray(
            "inspections",
            "/api/inspection/forms",
            CACHE_KEYS.inspections,
          );

      const documents = Array.isArray(mobileLists?.documents)
        ? mobileLists.documents
        : await fetchMaybeArray(
            "documents",
            "/api/documents",
            CACHE_KEYS.documents,
          );

      const groups = Array.isArray(mobileLists?.groups)
        ? mobileLists.groups
        : await fetchMaybeArray("groups", "/api/groups", CACHE_KEYS.groups);

      const users = Array.isArray(mobileLists?.users)
        ? mobileLists.users
        : await fetchMaybeArray("users", "/api/users", CACHE_KEYS.users);

      const vendors = Array.isArray(mobileLists?.vendors)
        ? mobileLists.vendors
        : await fetchMaybeArray("vendors", "/api/vendors", CACHE_KEYS.vendors);

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
      ]);

      await loadCounts();

      Alert.alert(
        "Success",
        `Lists refreshed.\nProjects: ${projects.length}\nTasks: ${tasks.length}\nVehicles: ${vehicles.length}\nVendors: ${vendors.length}`,
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
        <Row label="Inspections (forms)" value={counts.inspections} />
        <Row label="Documents" value={counts.documents} />
        <Row label="Groups" value={counts.groups} />
        <Row label="Users (optional)" value={counts.users} />
        <Row label="Vendors" value={counts.vendors} />

        <Text style={styles.hint}>
          This screen now refreshes all offline dropdown data from
          /api/mobile/lists. If Vendors or Definitions stay at 0, the backend is
          not returning them yet.
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
