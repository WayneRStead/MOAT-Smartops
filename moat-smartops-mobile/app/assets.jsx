import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { saveAssetCreate, saveAssetLog } from "../database";
import { syncOutbox } from "../syncOutbox";

const THEME_COLOR = "#22a6b3";

const LAST_SCAN_KEY = "@moat:lastScan";
const ASSETS_KEY = "@moat:assets";
const CACHE_ASSETS_KEY = "@moat:cache:assets";
const TOKEN_KEY = "@moat:cache:token";
const USER_ID_KEYS = ["@moat:userId", "@moat:userid", "moat:userid"];

const CAN_CREATE_ROLES = new Set([
  "project_manager",
  "project-manager",
  "manager",
  "admin",
  "superadmin",
  "owner",
]);

function formatNow() {
  const d = new Date();
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
}

async function getCurrentCoords() {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return null;

    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    const lat = Number(pos?.coords?.latitude);
    const lng = Number(pos?.coords?.longitude);
    const acc = Number(pos?.coords?.accuracy);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      lat,
      lng,
      acc: Number.isFinite(acc) ? acc : null,
      capturedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.log("[ASSETS] Location error", e);
    return null;
  }
}

async function loadAssetsMap() {
  try {
    const raw = await AsyncStorage.getItem(ASSETS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

async function saveAssetsMap(mapObj) {
  await AsyncStorage.setItem(ASSETS_KEY, JSON.stringify(mapObj || {}));
}

async function loadCache(key, fallback) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function normCode(v) {
  return String(v || "")
    .trim()
    .toUpperCase();
}

function pickAssetCode(input, fallbackCode = "") {
  return normCode(
    input?.assetCode ||
      input?.code ||
      input?.tag ||
      input?.assetTag ||
      input?.barcode ||
      input?._id ||
      fallbackCode,
  );
}

function normalizeAssetOption(input, fallbackCode = "") {
  if (!input || typeof input !== "object") return null;

  const assetCode = pickAssetCode(input, fallbackCode);
  if (!assetCode) return null;

  const assetName = String(
    input.assetName || input.name || input.title || "",
  ).trim();

  const assetCategory = String(
    input.assetCategory || input.category || input.type || "",
  ).trim();

  const assetProject = String(
    input.assetProject ||
      input.projectName ||
      input.projectLabel ||
      input.projectId ||
      "",
  ).trim();

  const assetLocation = String(
    input.assetLocation || input.location || input.area || "",
  ).trim();

  return {
    id: assetCode,
    assetCode,
    assetName,
    assetCategory,
    assetProject,
    assetLocation,
    label: assetName ? `${assetCode} — ${assetName}` : assetCode,
    raw: input,
  };
}

function buildAssetListFromSources(localMap, cachedAssets) {
  const merged = new Map();

  for (const item of Array.isArray(cachedAssets) ? cachedAssets : []) {
    const normalized = normalizeAssetOption(item);
    if (!normalized) continue;
    merged.set(normalized.assetCode, normalized);
  }

  for (const [codeKey, meta] of Object.entries(localMap || {})) {
    const normalized = normalizeAssetOption(meta || {}, codeKey);
    if (!normalized) continue;

    const existing = merged.get(normalized.assetCode);
    merged.set(normalized.assetCode, {
      ...(existing || {}),
      ...normalized,
      raw: { ...(existing?.raw || {}), ...(meta || {}) },
    });
  }

  return Array.from(merged.values()).sort((a, b) =>
    String(a.label).localeCompare(String(b.label)),
  );
}

async function refreshAssetsList() {
  const [localMap, cachedAssets] = await Promise.all([
    loadAssetsMap(),
    loadCache(CACHE_ASSETS_KEY, []),
  ]);

  return buildAssetListFromSources(localMap, cachedAssets);
}

function decodeJwtPayload(token) {
  try {
    const part = token?.split?.(".")?.[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);

    if (typeof atob === "function") return JSON.parse(atob(pad));
    if (typeof Buffer !== "undefined") {
      return JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
    }
    return null;
  } catch {
    return null;
  }
}

async function getCurrentUserMeta() {
  let token = "";
  try {
    token = (await AsyncStorage.getItem(TOKEN_KEY)) || "";
  } catch {}

  const payload = token ? decodeJwtPayload(token) : null;

  let userId = "";
  for (const k of USER_ID_KEYS) {
    const v = await AsyncStorage.getItem(k);
    if (v) {
      userId = String(v);
      break;
    }
  }

  if (!userId && payload?.sub) userId = String(payload.sub);

  const roles = []
    .concat(payload?.roles || [])
    .concat(payload?.role ? [payload.role] : [])
    .map((r) =>
      String(r || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);

  return {
    userId,
    roles,
    token,
  };
}

function parseAssetScan(scanValue) {
  const raw = String(scanValue || "").trim();
  if (!raw) return null;

  try {
    const obj = JSON.parse(raw);
    const code =
      obj.assetCode ||
      obj.code ||
      obj.tag ||
      obj.assetTag ||
      obj.id ||
      obj.assetId ||
      null;

    return {
      assetCode: code ? String(code).trim() : null,
      raw,
      meta: obj,
    };
  } catch {
    // not JSON
  }

  return { assetCode: raw, raw, meta: null };
}

async function tryImmediateSyncForAssets() {
  try {
    const res = await syncOutbox({ limit: 10 });
    console.log("[ASSETS] immediate sync result", res);
    return res;
  } catch (e) {
    console.log("[ASSETS] immediate sync failed", e);
    return null;
  }
}

function SelectModal({
  visible,
  title,
  items,
  selectedId,
  onSelect,
  onClose,
  emptyText = "No items available.",
  getId,
  getLabel,
}) {
  const _getId =
    getId ||
    ((it) => {
      if (typeof it === "string") return it;
      return String(it?.id || it?._id || "");
    });

  const _getLabel =
    getLabel ||
    ((it) => {
      if (typeof it === "string") return it;
      return String(it?.label || it?.name || it?.title || _getId(it));
    });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.selectModalCard}>
          <Text style={styles.selectModalTitle}>{title}</Text>

          {!items?.length ? (
            <Text style={styles.modalHint}>{emptyText}</Text>
          ) : (
            <FlatList
              data={items}
              keyExtractor={(item, idx) => {
                const id = _getId(item);
                return id ? String(id) : String(idx);
              }}
              style={{ maxHeight: 380 }}
              renderItem={({ item }) => {
                const id = String(_getId(item) || "");
                const label = _getLabel(item);
                const active = selectedId && id === String(selectedId);

                return (
                  <TouchableOpacity
                    style={[styles.selectRow, active && styles.selectRowActive]}
                    onPress={() => onSelect(item)}
                  >
                    <Text
                      style={[
                        styles.selectRowText,
                        active && styles.selectRowTextActive,
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              }}
            />
          )}

          <TouchableOpacity style={styles.modalCloseButton} onPress={onClose}>
            <Text style={styles.modalCloseText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

export default function AssetsScreen() {
  const router = useRouter();

  const [userRole, setUserRole] = useState("");
  const [userId, setUserId] = useState("");
  const [assetsList, setAssetsList] = useState([]);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);

  const canCreateAsset = CAN_CREATE_ROLES.has(
    String(userRole || "").toLowerCase(),
  );

  const [assetCode, setAssetCode] = useState("");
  const [assetName, setAssetName] = useState("");
  const [assetCategory, setAssetCategory] = useState("");
  const [assetProject, setAssetProject] = useState("");
  const [assetLocation, setAssetLocation] = useState("");

  const [createVisible, setCreateVisible] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [newProject, setNewProject] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [pendingScanRaw, setPendingScanRaw] = useState(null);

  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logDateTime, setLogDateTime] = useState(formatNow());
  const [logNote, setLogNote] = useState("");
  const [logPhoto, setLogPhoto] = useState(null);

  const effectiveCode = String(assetCode || "").trim();

  const selectedAssetOption =
    assetsList.find((a) => normCode(a.assetCode) === normCode(assetCode)) ||
    null;

  useFocusEffect(
    useCallback(() => {
      let alive = true;

      (async () => {
        const [userMeta, assetItems] = await Promise.all([
          getCurrentUserMeta(),
          refreshAssetsList(),
        ]);

        if (!alive) return;

        const preferredRole =
          userMeta.roles.find((r) => CAN_CREATE_ROLES.has(r)) ||
          userMeta.roles[0] ||
          "worker";

        setUserRole(preferredRole);
        setUserId(String(userMeta.userId || ""));
        setAssetsList(assetItems);
      })();

      return () => {
        alive = false;
      };
    }, []),
  );

  const openCreateModal = useCallback(
    (prefill = {}) => {
      setNewCode(prefill.assetCode || effectiveCode || "");
      setNewName(prefill.assetName || "");
      setNewCategory(prefill.assetCategory || "");
      setNewProject(prefill.assetProject || "");
      setNewLocation(prefill.assetLocation || "");
      setPendingScanRaw(prefill.raw || null);
      setCreateVisible(true);
    },
    [effectiveCode],
  );

  const closeCreateModal = () => {
    setCreateVisible(false);
    setPendingScanRaw(null);
  };

  const applySelectedAsset = useCallback((item) => {
    if (!item) return;

    setAssetCode(item.assetCode || "");
    setAssetName(item.assetName || "");
    setAssetCategory(item.assetCategory || "");
    setAssetProject(item.assetProject || "");
    setAssetLocation(item.assetLocation || "");
  }, []);

  const applyAssetFromStore = useCallback(async (code) => {
    const key = normCode(code);
    if (!key) return null;

    const [localMap, cachedAssets] = await Promise.all([
      loadAssetsMap(),
      loadCache(CACHE_ASSETS_KEY, []),
    ]);

    const merged = buildAssetListFromSources(localMap, cachedAssets);
    const found = merged.find((a) => normCode(a.assetCode) === key);

    return found || null;
  }, []);

  const ensureAssetKnownOrPrompt = useCallback(
    async (parsed) => {
      const parsedCode = String(parsed?.assetCode || "").trim();
      if (!parsedCode) {
        Alert.alert("Scan failed", "Could not detect an asset code/tag.");
        return;
      }

      setAssetCode(parsedCode);

      const existing = await applyAssetFromStore(parsedCode);
      if (existing) {
        setAssetCode(existing.assetCode || parsedCode);
        setAssetName(existing.assetName || "");
        setAssetCategory(existing.assetCategory || "");
        setAssetProject(existing.assetProject || "");
        setAssetLocation(existing.assetLocation || "");
        return;
      }

      if (!canCreateAsset) {
        Alert.alert(
          "Asset not found",
          "This asset is not on your device yet. Only a Project Manager (or above) can add new assets.",
        );
        return;
      }

      openCreateModal({
        assetCode: parsedCode,
        raw: parsed.raw,
      });
    },
    [applyAssetFromStore, canCreateAsset, openCreateModal],
  );

  useFocusEffect(
    useCallback(() => {
      let mounted = true;

      (async () => {
        try {
          const raw = await AsyncStorage.getItem(LAST_SCAN_KEY);
          if (!raw) return;

          const scan = JSON.parse(raw);
          await AsyncStorage.removeItem(LAST_SCAN_KEY);

          if (!mounted) return;

          const value = scan?.value ? String(scan.value) : "";
          if (!value) return;

          const parsed = parseAssetScan(value);
          await ensureAssetKnownOrPrompt(parsed);
        } catch (e) {
          console.log("[ASSETS] Failed to apply scan result", e);
        }
      })();

      return () => {
        mounted = false;
      };
    }, [ensureAssetKnownOrPrompt]),
  );

  useEffect(() => {
    (async () => {
      const code = normCode(assetCode);
      if (!code) return;

      const existing = await applyAssetFromStore(code);
      if (!existing) return;

      setAssetCode(existing.assetCode || code);
      setAssetName(existing.assetName || "");
      setAssetCategory(existing.assetCategory || "");
      setAssetProject(existing.assetProject || "");
      setAssetLocation(existing.assetLocation || "");
    })();
  }, [assetCode, applyAssetFromStore]);

  const takePhoto = async (setter) => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Camera permission",
        "Camera access is required to take a photo.",
      );
      return;
    }

    const result = await ImagePicker.launchCameraAsync({ quality: 0.5 });
    if (result.canceled) return;

    const uri =
      result.assets && result.assets.length > 0 ? result.assets[0].uri : null;
    if (uri) setter(uri);
  };

  const handleScanAsset = () => {
    router.push({
      pathname: "/scan",
      params: {
        returnTo: "/assets",
        field: "asset",
        label: "Scan asset",
      },
    });
  };

  const canProceedWithAsset = useMemo(() => {
    return String(assetCode || "").trim().length > 0;
  }, [assetCode]);

  const handleSaveNewAsset = async () => {
    if (!canCreateAsset) {
      Alert.alert(
        "Not allowed",
        "Only a Project Manager (or above) can add assets.",
      );
      return;
    }

    const code = String(newCode || "").trim();
    if (!code) {
      Alert.alert("Missing code", "Please enter an asset code/tag.");
      return;
    }

    const name = String(newName || "").trim();
    if (!name) {
      Alert.alert("Missing name", "Please enter an asset name.");
      return;
    }

    const coords = await getCurrentCoords();

    const meta = {
      assetCode: code,
      assetName: name,
      assetCategory: String(newCategory || "").trim() || null,
      assetProject: String(newProject || "").trim() || null,
      assetLocation: String(newLocation || "").trim() || null,
      assignedGeo: coords || null,
      createdAt: new Date().toISOString(),
      source: pendingScanRaw ? "scan" : "manual",
      scanRaw: pendingScanRaw || null,
    };

    const map = await loadAssetsMap();
    map[code.toUpperCase()] = meta;
    await saveAssetsMap(map);

    const nextAssets = await refreshAssetsList();
    setAssetsList(nextAssets);

    setAssetCode(code);
    setAssetName(name);
    setAssetCategory(meta.assetCategory || "");
    setAssetProject(meta.assetProject || "");
    setAssetLocation(meta.assetLocation || "");

    try {
      await saveAssetCreate({
        ...meta,
        userId: userId || null,
        updatedAt: new Date().toISOString(),
      });

      await tryImmediateSyncForAssets();

      console.log("[ASSETS] asset-create queued for sync");
    } catch (e) {
      console.log("[ASSETS] Failed to queue asset-create", e);
    }

    Alert.alert(
      "Asset created",
      "Asset saved on this device and queued for sync.",
    );
    closeCreateModal();
  };

  const openLogModal = () => {
    if (!canProceedWithAsset) {
      Alert.alert(
        "No asset selected",
        "Please scan or enter an asset before adding a log.",
      );
      return;
    }

    (async () => {
      const existing = await applyAssetFromStore(assetCode);
      if (existing) {
        setAssetName(existing.assetName || assetName);
        setAssetCategory(existing.assetCategory || assetCategory);
        setAssetProject(existing.assetProject || assetProject);
        setAssetLocation(existing.assetLocation || assetLocation);
      }
    })();

    setLogDateTime(formatNow());
    setLogNote("");
    setLogPhoto(null);
    setLogModalVisible(true);
  };

  const handleSaveLog = async () => {
    const coords = await getCurrentCoords();
    const nowIso = new Date().toISOString();

    const payload = {
      kind: "log",
      userId: userId || null,
      assetCode: String(assetCode || "").trim(),
      assetName: String(assetName || "").trim(),
      assetCategory: String(assetCategory || "").trim(),
      assetProject: String(assetProject || "").trim() || null,
      assetLocation: String(assetLocation || "").trim() || null,
      dateTime: logDateTime,
      note: logNote,
      photoUri: logPhoto,
      location: coords,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    try {
      const id = await saveAssetLog(payload);
      await tryImmediateSyncForAssets();

      console.log("[ASSETS] asset log saved locally with id:", id);
      Alert.alert("Saved", "Asset log captured.");
      setLogModalVisible(false);
    } catch (e) {
      console.log("[ASSETS] Failed to save asset log", e);
      Alert.alert("Save failed", "Could not save asset log on this device.");
    }
  };

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.topBar}>
          <Image
            source={require("../assets/assets-screen.png")}
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

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Assets</Text>

          <View style={styles.scanRow}>
            <TouchableOpacity
              style={styles.scanButton}
              onPress={handleScanAsset}
            >
              <Image
                source={require("../assets/barcode.png")}
                style={styles.scanIcon}
              />
              <Text style={styles.scanText}>Scan asset</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.scanButton, { marginLeft: 8 }]}
              onPress={() => setAssetPickerOpen(true)}
            >
              <Text style={styles.scanText}>Select asset</Text>
            </TouchableOpacity>

            {canCreateAsset && (
              <TouchableOpacity
                style={[styles.scanButton, { marginLeft: 8 }]}
                onPress={() =>
                  openCreateModal({
                    assetCode: assetCode || "",
                    assetName,
                    assetCategory,
                    assetProject,
                    assetLocation,
                  })
                }
              >
                <Text style={styles.scanText}>+ Asset</Text>
              </TouchableOpacity>
            )}
          </View>

          <TextInput
            style={styles.input}
            placeholder="Asset code / tag"
            placeholderTextColor="#aaa"
            value={assetCode}
            onChangeText={setAssetCode}
            autoCapitalize="characters"
          />

          {selectedAssetOption ? (
            <Text style={styles.selectedHint}>
              Selected: {selectedAssetOption.label}
            </Text>
          ) : null}

          <TextInput
            style={styles.input}
            placeholder="Asset name"
            placeholderTextColor="#aaa"
            value={assetName}
            onChangeText={setAssetName}
          />

          <TextInput
            style={styles.input}
            placeholder="Category / type"
            placeholderTextColor="#aaa"
            value={assetCategory}
            onChangeText={setAssetCategory}
          />

          <TextInput
            style={styles.input}
            placeholder="Project (optional)"
            placeholderTextColor="#aaa"
            value={assetProject}
            onChangeText={setAssetProject}
          />

          <TextInput
            style={styles.input}
            placeholder="Location / area (optional)"
            placeholderTextColor="#aaa"
            value={assetLocation}
            onChangeText={setAssetLocation}
          />

          <TouchableOpacity style={styles.primaryButton} onPress={openLogModal}>
            <Image
              source={require("../assets/activity-log.png")}
              style={styles.logIcon}
            />
            <Text style={styles.primaryButtonText}>Add log</Text>
          </TouchableOpacity>

          {!canCreateAsset && (
            <Text style={styles.hintText}>
              Note: Only Project Managers (or above) can add new assets.
            </Text>
          )}
        </View>
      </ScrollView>

      <SelectModal
        visible={assetPickerOpen}
        title="Select asset"
        items={assetsList}
        selectedId={normCode(assetCode)}
        getId={(a) => a.assetCode}
        getLabel={(a) => a.label}
        onSelect={(a) => {
          applySelectedAsset(a);
          setAssetPickerOpen(false);
        }}
        onClose={() => setAssetPickerOpen(false)}
        emptyText="No assets cached yet. Refresh offline lists or scan/create an asset."
      />

      <Modal
        visible={createVisible}
        transparent
        animationType="slide"
        onRequestClose={closeCreateModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Create asset</Text>
            <Text style={styles.modalSubtitle}>Only PM+ can add assets.</Text>

            <TextInput
              style={styles.input}
              placeholder="Asset code/tag (required)"
              placeholderTextColor="#aaa"
              value={newCode}
              onChangeText={setNewCode}
              autoCapitalize="characters"
            />

            <TextInput
              style={styles.input}
              placeholder="Asset name (required)"
              placeholderTextColor="#aaa"
              value={newName}
              onChangeText={setNewName}
            />

            <TextInput
              style={styles.input}
              placeholder="Category/type"
              placeholderTextColor="#aaa"
              value={newCategory}
              onChangeText={setNewCategory}
            />

            <TextInput
              style={styles.input}
              placeholder="Project (optional)"
              placeholderTextColor="#aaa"
              value={newProject}
              onChangeText={setNewProject}
            />

            <TextInput
              style={styles.input}
              placeholder="Location/area (optional)"
              placeholderTextColor="#aaa"
              value={newLocation}
              onChangeText={setNewLocation}
            />

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.primaryButton, styles.modalButton]}
                onPress={handleSaveNewAsset}
              >
                <Text style={styles.primaryButtonText}>Save asset</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalButton]}
                onPress={closeCreateModal}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>

            {pendingScanRaw ? (
              <Text style={styles.modalHint}>Prefilled from scan.</Text>
            ) : null}
          </View>
        </View>
      </Modal>

      <Modal
        visible={logModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setLogModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Asset log</Text>
            <Text style={styles.modalSubtitle}>
              {assetName || assetCode || "Current asset"}
            </Text>

            <View style={styles.dateRow}>
              <TextInput
                style={[styles.input, styles.dateInput]}
                placeholder="Date / time"
                placeholderTextColor="#aaa"
                value={logDateTime}
                onChangeText={setLogDateTime}
              />
              <TouchableOpacity
                style={styles.useNowButton}
                onPress={() => setLogDateTime(formatNow())}
              >
                <Text style={styles.useNowText}>Use now</Text>
              </TouchableOpacity>
            </View>

            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Note"
              placeholderTextColor="#aaa"
              value={logNote}
              onChangeText={setLogNote}
              multiline
            />

            {!logPhoto ? (
              <TouchableOpacity
                style={styles.photoButton}
                onPress={() => takePhoto(setLogPhoto)}
              >
                <Image
                  source={require("../assets/camera.png")}
                  style={styles.photoIcon}
                />
                <Text style={styles.photoButtonText}>Take photo</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.photoPreview}>
                <Image
                  source={{ uri: logPhoto }}
                  style={styles.photoPreviewImage}
                />
                <TouchableOpacity
                  style={styles.retryPhotoButton}
                  onPress={() => takePhoto(setLogPhoto)}
                >
                  <Text style={styles.retryPhotoText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.primaryButton, styles.modalButton]}
                onPress={handleSaveLog}
              >
                <Text style={styles.primaryButtonText}>Save log</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalButton]}
                onPress={() => setLogModalVisible(false)}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.modalHint}>
              After saving, scan the next asset or go home from the header.
            </Text>
          </View>
        </View>
      </Modal>
    </>
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
  scanRow: {
    flexDirection: "row",
    justifyContent: "flex-start",
    flexWrap: "wrap",
    marginBottom: 8,
  },
  scanButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: THEME_COLOR,
    marginBottom: 8,
  },
  scanIcon: {
    width: 48,
    height: 48,
    marginRight: 6,
  },
  scanText: {
    color: THEME_COLOR,
    fontWeight: "500",
    fontSize: 13,
  },
  selectedHint: {
    marginTop: -4,
    marginBottom: 10,
    fontSize: 12,
    color: "#666",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
    backgroundColor: "#fafafa",
    fontSize: 14,
  },
  textArea: {
    height: 80,
    textAlignVertical: "top",
  },
  primaryButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 4,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    marginLeft: 6,
  },
  logIcon: {
    width: 32,
    height: 32,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: THEME_COLOR,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonText: {
    color: THEME_COLOR,
    fontSize: 14,
    fontWeight: "600",
  },
  hintText: {
    marginTop: 10,
    fontSize: 11,
    color: "#777",
    textAlign: "center",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 6,
    textAlign: "center",
  },
  modalSubtitle: {
    fontSize: 12,
    color: "#666",
    marginBottom: 12,
    textAlign: "center",
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  dateInput: {
    flex: 1,
    marginBottom: 0,
  },
  useNowButton: {
    marginLeft: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: "#eee",
  },
  useNowText: {
    fontSize: 11,
    color: "#333",
  },
  photoButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: THEME_COLOR,
    marginBottom: 10,
  },
  photoIcon: {
    width: 32,
    height: 32,
    marginRight: 8,
  },
  photoButtonText: {
    color: THEME_COLOR,
    fontWeight: "600",
  },
  photoPreview: {
    alignItems: "center",
    marginBottom: 10,
  },
  photoPreviewImage: {
    width: 140,
    height: 140,
    borderRadius: 8,
    marginBottom: 6,
  },
  retryPhotoButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: "#f39c12",
  },
  retryPhotoText: {
    color: "#fff",
    fontWeight: "600",
  },
  modalButtonsRow: {
    flexDirection: "row",
    marginTop: 12,
  },
  modalButton: {
    flex: 1,
    marginHorizontal: 4,
  },
  modalHint: {
    marginTop: 10,
    fontSize: 11,
    color: "#777",
    textAlign: "center",
  },
  selectModalCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 16,
  },
  selectModalTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 10,
    textAlign: "center",
  },
  selectRow: {
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  selectRowActive: {
    backgroundColor: "#e8f8fa",
  },
  selectRowText: {
    fontSize: 14,
    color: "#111",
  },
  selectRowTextActive: {
    color: THEME_COLOR,
    fontWeight: "700",
  },
  modalCloseButton: {
    marginTop: 8,
    alignSelf: "center",
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  modalCloseText: {
    color: "#555",
    fontSize: 12,
  },
});
