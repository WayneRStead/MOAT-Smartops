// app/offline.jsx
// app/offline.jsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
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
import { ORG_KEY } from "../apiClient";
import { syncOutbox } from "../syncOutbox";

// Storage keys for cached lists (align to whatever your production.jsx uses)
const CACHE_KEYS = {
  projects: "@moat:cache:projects",
  tasks: "@moat:cache:tasks",
  milestones: "@moat:cache:milestones",
  users: "@moat:cache:users",

  // placeholders for upcoming list caching
  assets: "@moat:cache:assets",
  vehicles: "@moat:cache:vehicles",
  inspections: "@moat:cache:inspections",
  documents: "@moat:cache:documents",
};

function safeParseArray(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
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
    milestones: 0,
    users: 0,
    assets: 0,
    vehicles: 0,
    inspections: 0,
    documents: 0,
  });

  const tiles = useMemo(
    () => [
      { key: "projects", label: "Projects" },
      { key: "tasks", label: "My Tasks" },
      { key: "milestones", label: "Milestones" },
      { key: "users", label: "Users" },
      { key: "assets", label: "Assets" },
      { key: "vehicles", label: "Vehicles" },
      { key: "inspections", label: "Inspections" },
      { key: "documents", label: "Documents" },
    ],
    [],
  );

  async function refreshCounts() {
    const next = {};
    for (const k of Object.keys(CACHE_KEYS)) {
      const raw = await AsyncStorage.getItem(CACHE_KEYS[k]);
      next[k] = safeParseArray(raw).length;
    }
    setCounts((prev) => ({ ...prev, ...next }));
  }

  useEffect(() => {
    refreshCounts();
  }, []);

  async function handleRefreshLists() {
    setLoading(true);
    try {
      // This is the backend endpoint we added: GET /api/mobile/lists
      // Using apiPost here would be wrong (GET). So we do fetch directly.
      const orgId = await AsyncStorage.getItem(ORG_KEY);

      // Use the same auth headers the apiClient uses
      // (apiClient has getAuthHeaders, but we’ll keep it simple & safe here)
      const token = await AsyncStorage.getItem("@moat:token");

      if (!token) {
        Alert.alert("Not signed in", "Please sign in again.");
        return;
      }
      if (!orgId) {
        Alert.alert("Missing Org", "No orgId found on the device.");
        return;
      }

      const baseUrl =
        process.env.EXPO_PUBLIC_API_BASE_URL || "https://YOUR-RENDER-URL";

      const res = await fetch(`${baseUrl}/api/mobile/lists`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "x-org-id": orgId,
          "Content-Type": "application/json",
        },
      });

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }

      if (!res.ok) {
        throw new Error(json?.error || json?.message || `HTTP ${res.status}`);
      }

      const projects = Array.isArray(json?.projects) ? json.projects : [];
      const tasks = Array.isArray(json?.tasks) ? json.tasks : [];
      const milestones = Array.isArray(json?.milestones) ? json.milestones : [];
      const users = Array.isArray(json?.users) ? json.users : [];

      // Save the known lists
      await AsyncStorage.setItem(CACHE_KEYS.projects, JSON.stringify(projects));
      await AsyncStorage.setItem(CACHE_KEYS.tasks, JSON.stringify(tasks));
      await AsyncStorage.setItem(
        CACHE_KEYS.milestones,
        JSON.stringify(milestones),
      );
      await AsyncStorage.setItem(CACHE_KEYS.users, JSON.stringify(users));

      // For now, these 4 are placeholders until backend adds them to /lists
      // (we keep counts consistent by ensuring keys exist)
      for (const k of ["assets", "vehicles", "inspections", "documents"]) {
        const existing = await AsyncStorage.getItem(CACHE_KEYS[k]);
        if (!existing)
          await AsyncStorage.setItem(CACHE_KEYS[k], JSON.stringify([]));
      }

      await refreshCounts();
      Alert.alert("Updated", "Lists refreshed and stored for offline use.");
    } catch (e) {
      Alert.alert("Could not refresh", e?.message || "Network request failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSyncOutbox() {
    setLoading(true);
    try {
      const result = await syncOutbox({ limit: 25 });
      await refreshCounts();
      Alert.alert(
        "Sync complete",
        `Synced: ${result.synced}\nFailed: ${result.failed}`,
      );
    } catch (e) {
      Alert.alert("Sync failed", e?.message || "Network request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.topBar}>
        <Image
          source={require("../assets/offline-screen.png")}
          style={styles.logo}
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

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Offline & Sync</Text>
        <Text style={styles.cardSubtitle}>
          These lists power dropdowns when you have no signal. Sync pushes your
          saved actions to the server.
        </Text>

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.primaryBtn, loading && styles.btnDisabled]}
            onPress={handleRefreshLists}
            disabled={loading}
          >
            <Text style={styles.primaryBtnText}>
              {loading ? "Working…" : "Refresh Lists"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.secondaryBtn, loading && styles.btnDisabled]}
            onPress={handleSyncOutbox}
            disabled={loading}
          >
            <Text style={styles.secondaryBtnText}>
              {loading ? "Working…" : "Sync Outbox"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Cached Lists</Text>
        <Text style={styles.cardSubtitle}>
          What’s currently stored on this device
        </Text>

        <View style={styles.grid}>
          {tiles.map((t) => (
            <View key={t.key} style={styles.listTile}>
              <Text style={styles.listTileLabel}>{t.label}</Text>
              <Text style={styles.listTileCount}>{counts[t.key] ?? 0}</Text>
              <Text style={styles.listTileHint}>items</Text>
            </View>
          ))}
        </View>

        <TouchableOpacity style={styles.smallLink} onPress={refreshCounts}>
          <Text style={styles.smallLinkText}>Recheck counts</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const THEME_COLOR = "#22a6b3";

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
    marginBottom: 12,
  },
  logo: {
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
  actionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  primaryBtn: {
    width: "48%",
    backgroundColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  primaryBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 13,
  },
  secondaryBtn: {
    width: "48%",
    borderWidth: 1,
    borderColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  secondaryBtnText: {
    color: THEME_COLOR,
    fontWeight: "700",
    fontSize: 13,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  listTile: {
    width: "48%",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e9e9e9",
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 12,
    marginBottom: 12,
    elevation: 1,
  },
  listTileLabel: {
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 8,
  },
  listTileCount: {
    fontSize: 22,
    fontWeight: "800",
    color: THEME_COLOR,
    lineHeight: 26,
  },
  listTileHint: {
    fontSize: 11,
    color: "#666",
    marginTop: 2,
  },
  smallLink: {
    marginTop: 4,
    alignSelf: "center",
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  smallLinkText: {
    fontSize: 12,
    color: "#555",
    textDecorationLine: "underline",
  },
});
