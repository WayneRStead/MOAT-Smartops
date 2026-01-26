// moat-smartops-mobile/app/org-select.jsx
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

const THEME_COLOR = "#22a6b3";

export default function OrgSelectScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [orgs, setOrgs] = useState([]);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const data = await apiGet("/api/mobile/bootstrap");
        const list = Array.isArray(data?.orgs) ? data.orgs : [];
        if (!mounted) return;

        setOrgs(list);

        // If only one org, auto-select
        if (list.length === 1 && list[0]?._id) {
          await AsyncStorage.setItem(ORG_KEY, String(list[0]._id));
          router.replace("/home");
          return;
        }

        if (list.length === 0) {
          Alert.alert(
            "No organisation",
            "Your account is not linked to an organisation yet. Please contact your admin.",
          );
        }
      } catch (e) {
        console.log("[org-select] bootstrap error", e);
        Alert.alert("Error", e?.message || "Could not load organisations.");
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [router]);

  const pickOrg = async (orgId) => {
    try {
      await AsyncStorage.setItem(ORG_KEY, String(orgId));
      router.replace("/home");
    } catch (e) {
      Alert.alert("Error", "Could not save organisation on this device.");
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Image
          source={require("../assets/moat-logo.png")}
          style={styles.logo}
          resizeMode="contain"
        />
        <Text style={styles.title}>Select Organisation</Text>
        <Text style={styles.subtitle}>
          {loading ? "Loading..." : "Choose where you are working today"}
        </Text>
      </View>

      <View style={styles.list}>
        {orgs.map((o) => (
          <TouchableOpacity
            key={String(o._id)}
            style={styles.orgTile}
            onPress={() => pickOrg(o._id)}
            activeOpacity={0.85}
          >
            <View style={styles.orgDot} />
            <View style={{ flex: 1 }}>
              <Text style={styles.orgName}>{o.name || "Organisation"}</Text>
              <Text style={styles.orgId} numberOfLines={1}>
                {String(o._id)}
              </Text>
            </View>
          </TouchableOpacity>
        ))}

        {!loading && orgs.length === 0 && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>No organisations available.</Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 24,
    backgroundColor: "#f5f5f5",
    flexGrow: 1,
  },
  header: {
    alignItems: "center",
    marginBottom: 14,
  },
  logo: {
    width: 220,
    height: 100,
    marginBottom: -20,
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    marginTop: 6,
  },
  subtitle: {
    fontSize: 12,
    color: "#666",
    marginTop: 6,
  },
  list: {
    marginTop: 10,
  },
  orgTile: {
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    elevation: 2,
    flexDirection: "row",
    alignItems: "center",
  },
  orgDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: THEME_COLOR,
    marginRight: 10,
  },
  orgName: {
    fontSize: 15,
    fontWeight: "600",
  },
  orgId: {
    fontSize: 11,
    color: "#777",
    marginTop: 3,
  },
  emptyCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 16,
    elevation: 2,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 12,
    color: "#666",
  },
});
