// app/home.jsx
import { useRouter } from "expo-router";
import { useMemo } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export default function HomeScreen() {
  const router = useRouter();

  // Later these can come from the backend
  const myTasks = useMemo(
    () => ({
      overdue: 3,
      inProgress: 7,
      completed: 12,
    }),
    [],
  );

  const totalTasks =
    myTasks.overdue + myTasks.inProgress + myTasks.completed || 1;

  // Module definitions with icons
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
    },
  ];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Branding / Header */}
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

      {/* QUICK ACTION TILES (NEW) */}
      <View style={styles.quickRow}>
        <ActionTile
          label="Offline & Sync"
          icon={require("../assets/offline.png")}
          onPress={() => router.push("/offline")}
        />
        <ActionTile
          label="History"
          icon={require("../assets/history.png")}
          onPress={() => router.push("/history")}
        />
      </View>

      {/* Task / milestone overview */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>My Tasks Overview</Text>
        <Text style={styles.cardSubtitle}>Today / This week</Text>

        <View style={styles.overviewRow}>
          {/* Simple placeholder "donut" */}
          <View style={styles.donutPlaceholder}>
            <Text style={styles.donutCenterText}>{totalTasks}</Text>
            <Text style={styles.donutLabel}>Total</Text>
          </View>

          {/* Status breakdown */}
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
              Completed:{" "}
              <Text style={styles.statusCompleted}>{myTasks.completed}</Text>
            </Text>
          </View>
        </View>

        {/* Simple trend placeholder */}
        <View style={styles.trendPlaceholder}>
          <Text style={styles.trendText}>Task trend (placeholder)</Text>
        </View>
      </View>

      {/* Modules grid */}
      <View style={styles.modulesContainer}>
        <Text style={styles.modulesTitle}>Modules</Text>

        <View style={styles.modulesGrid}>
          {modules.map((m) => (
            <ModuleTile
              key={m.key}
              label={m.label}
              icon={m.icon}
              onPress={() => router.push(m.route)}
            />
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

function ActionTile({ label, icon, onPress }) {
  return (
    <TouchableOpacity
      style={styles.actionTile}
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
  );
}

function ModuleTile({ label, icon, onPress }) {
  return (
    <TouchableOpacity style={styles.tile} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.tileIconPlaceholder}>
        <Image
          source={icon}
          style={styles.tileIconImage}
          resizeMode="contain"
        />
      </View>
      <Text style={styles.tileLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const THEME_COLOR = "#22a6b3";

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

  // NEW quick actions row
  quickRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
    marginBottom: 14,
  },
  actionTile: {
    width: "48%",
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
    marginBottom: 4,
  },
  cardSubtitle: {
    fontSize: 12,
    color: "#666",
    marginBottom: 12,
  },
  overviewRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
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
  statusCompleted: {
    color: "#27ae60",
    fontWeight: "600",
  },
  trendPlaceholder: {
    height: 40,
    borderRadius: 6,
    backgroundColor: "#f0f0f0",
    alignItems: "center",
    justifyContent: "center",
  },
  trendText: {
    fontSize: 11,
    color: "#777",
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
    width: "48%",
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
