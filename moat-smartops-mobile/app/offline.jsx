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
import { loadCachedLists, refreshListsFromServer } from "../refreshLists";

const THEME_COLOR = "#22a6b3";

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
    try {
      const cached = await loadCachedLists();

      setCounts({
        definitions: countDefinitions(cached.definitions),
        projects: Array.isArray(cached.projects) ? cached.projects.length : 0,
        tasks: Array.isArray(cached.tasks) ? cached.tasks.length : 0,
        milestonesTasks: cached.milestonesByTask
          ? Object.keys(cached.milestonesByTask).length
          : 0,
        assets: Array.isArray(cached.assets) ? cached.assets.length : 0,
        vehicles: Array.isArray(cached.vehicles) ? cached.vehicles.length : 0,
        inspections: Array.isArray(cached.inspections)
          ? cached.inspections.length
          : 0,
        documents: Array.isArray(cached.documents)
          ? cached.documents.length
          : 0,
        groups: Array.isArray(cached.groups) ? cached.groups.length : 0,
        users: Array.isArray(cached.users) ? cached.users.length : 0,
        vendors: Array.isArray(cached.vendors) ? cached.vendors.length : 0,
      });
    } catch (e) {
      console.log("[offline] loadCounts failed", e);
    }
  }

  useEffect(() => {
    loadCounts();
  }, []);

  const refreshLists = async () => {
    setLoading(true);
    try {
      const res = await refreshListsFromServer();
      await loadCounts();

      Alert.alert(
        "Success",
        `Lists refreshed.
Projects: ${res.projectsCount}
Tasks: ${res.tasksCount}
Milestones: ${res.milestonesCount}
Vehicles: ${res.vehiclesCount}
Vendors: ${res.vendorsCount}
Documents: ${res.documentsCount}
Offline document files saved: ${res.mobileLibrarySavedOfflineCount}
Offline document files failed: ${res.mobileLibraryFailedOfflineCount}`,
      );
    } catch (e) {
      Alert.alert("Could not refresh", e?.message || "Unknown error");
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
          style={[styles.primaryButtonSingle, loading && styles.btnDisabled]}
          onPress={refreshLists}
          activeOpacity={0.85}
          disabled={loading}
        >
          <Text style={styles.primaryButtonText}>
            {loading ? "Working..." : "Refresh lists"}
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
          This screen now uses refreshLists.js as the single source of truth for
          cached offline lists.
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
    marginTop: 8,
    marginBottom: 12,
  },
  primaryButtonSingle: {
    backgroundColor: THEME_COLOR,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    elevation: 2,
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
