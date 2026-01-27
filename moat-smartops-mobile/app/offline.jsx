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
 * Offline cache keys (simple + reliable).
 * You can later move these into SQLite if you prefer.
 */
const CACHE_KEYS = {
  projects: "@moat:cache:projects",
  tasks: "@moat:cache:tasks",
  assets: "@moat:cache:assets",
  vehicles: "@moat:cache:vehicles",
  inspections: "@moat:cache:inspections",
  documents: "@moat:cache:documents",
  groups: "@moat:cache:groups",
};

async function safeCacheSet(key, value) {
  await AsyncStorage.setItem(key, JSON.stringify(value ?? []));
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

export default function OfflineScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const [counts, setCounts] = useState({
    projects: 0,
    tasks: 0,
    assets: 0,
    vehicles: 0,
    inspections: 0,
    documents: 0,
    groups: 0,
  });

  async function loadCounts() {
    const [projects, tasks, assets, vehicles, inspections, documents, groups] =
      await Promise.all([
        safeCacheGet(CACHE_KEYS.projects),
        safeCacheGet(CACHE_KEYS.tasks),
        safeCacheGet(CACHE_KEYS.assets),
        safeCacheGet(CACHE_KEYS.vehicles),
        safeCacheGet(CACHE_KEYS.inspections),
        safeCacheGet(CACHE_KEYS.documents),
        safeCacheGet(CACHE_KEYS.groups),
      ]);

    setCounts({
      projects: projects.length,
      tasks: tasks.length,
      assets: assets.length,
      vehicles: vehicles.length,
      inspections: inspections.length,
      documents: documents.length,
      groups: groups.length,
    });
  }

  useEffect(() => {
    (async () => {
      await loadCounts();
    })();
  }, []);

  /**
   * Refresh lists by calling REAL module endpoints.
   * If a module route isn't present on backend yet, we skip it gracefully.
   */
  const refreshLists = async () => {
    setLoading(true);
    try {
      const savedOrg = await AsyncStorage.getItem(ORG_KEY);
      if (!savedOrg) {
        Alert.alert("Missing Org", "No orgId found on this device yet.");
        return;
      }

      // Sanity check: confirm backend sees you + org
      await apiGet("/api/mobile/whoami");

      const results = {};

      async function fetchMaybe(name, path, cacheKey) {
        try {
          const data = await apiGet(path);

          // Many endpoints return { ok:true, items:[...] } OR just [...]
          const items = Array.isArray(data)
            ? data
            : Array.isArray(data?.items)
              ? data.items
              : Array.isArray(data?.data)
                ? data.data
                : [];

          results[name] = items;
          await safeCacheSet(cacheKey, items);
        } catch (e) {
          if (e?.status === 404) {
            results[name] = "__NOT_FOUND__";
            return;
          }
          throw e;
        }
      }

      await Promise.all([
        fetchMaybe("projects", "/api/projects", CACHE_KEYS.projects),
        fetchMaybe("tasks", "/api/tasks", CACHE_KEYS.tasks),
        fetchMaybe("assets", "/api/assets", CACHE_KEYS.assets),
        fetchMaybe("vehicles", "/api/vehicles", CACHE_KEYS.vehicles),
        // ✅ corrected plural (most common pattern)
        fetchMaybe("inspections", "/api/inspection", CACHE_KEYS.inspections),
        fetchMaybe("documents", "/api/documents", CACHE_KEYS.documents),
        fetchMaybe("groups", "/api/groups", CACHE_KEYS.groups),
      ]);

      await loadCounts();

      const notFound = Object.entries(results)
        .filter(([, v]) => v === "__NOT_FOUND__")
        .map(([k]) => k);

      if (notFound.length) {
        Alert.alert(
          "Lists refreshed (partial)",
          `These modules are not available on the backend yet:\n${notFound.join(", ")}`,
        );
      } else {
        Alert.alert("Success", "Lists refreshed and stored for offline use.");
      }
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
      {/* Top bar with Offline logo + home */}
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

      {/* Action buttons */}
      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={[styles.primaryButton, loading && styles.btnDisabled]}
          onPress={refreshLists}
          activeOpacity={0.85}
          disabled={loading}
        >
          <Text style={styles.primaryButtonText}>
            {loading ? "Working..." : "Refresh lists"}
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

      {/* Cached list counts */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Cached lists on device</Text>

        <Row label="Projects" value={counts.projects} />
        <Row label="Tasks" value={counts.tasks} />
        <Row label="Assets" value={counts.assets} />
        <Row label="Vehicles" value={counts.vehicles} />
        <Row label="Inspections" value={counts.inspections} />
        <Row label="Documents" value={counts.documents} />
        <Row label="Groups" value={counts.groups} />

        <Text style={styles.hint}>
          If any count stays at 0 after refresh, the backend endpoint may not
          exist yet or your user has no data in that module.
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
