import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
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
import { refreshCachedMe } from "../apiClient";
import { saveAssetCreate, saveAssetLog } from "../database";
import { syncOutbox } from "../syncOutbox";

const THEME_COLOR = "#22a6b3";

const LAST_SCAN_KEY = "@moat:lastScan";
const ASSETS_KEY = "@moat:assets";
const CACHE_ASSETS_KEY = "@moat:cache:assets";
const CACHE_PROJECTS_KEY = "@moat:cache:projects";
const CACHE_ME_KEY = "@moat:cache:me";
const TOKEN_KEY = "@moat:cache:token";
const USER_ID_KEYS = ["@moat:userId", "@moat:userid", "moat:userid"];

const CAN_CREATE_ROLES = new Set([
  "project_manager",
  "project-manager",
  "manager",
  "admin",
  "administrator",
  "superadmin",
  "super_admin",
  "owner",
]);

const ASSET_STATUS_OPTIONS = [
  { id: "active", label: "Active" },
  { id: "maintenance", label: "Maintenance" },
  { id: "retired", label: "Retired" },
  { id: "lost", label: "Lost" },
  { id: "stolen", label: "Stolen" },
];

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

function normalizeAssetStatus(value, fallback = "active") {
  const v = String(value || "")
    .trim()
    .toLowerCase();

  if (v === "maintanance") return "maintenance";
  if (
    v === "active" ||
    v === "maintenance" ||
    v === "retired" ||
    v === "lost" ||
    v === "stolen"
  ) {
    return v;
  }

  return fallback;
}

function assetStatusLabel(value) {
  const v = normalizeAssetStatus(value, "");
  const found = ASSET_STATUS_OPTIONS.find((s) => s.id === v);
  return found ? found.label : "";
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
      input?.value ||
      input?.data?.assetCode ||
      input?.data?.code ||
      input?.data?.tag ||
      input?.asset?.code ||
      input?.asset?.assetCode ||
      fallbackCode,
  );
}

function pickProjectId(input) {
  return String(
    input?.assetProjectId ||
      input?.projectId?._id ||
      input?.projectId?.id ||
      input?.project?._id ||
      input?.project?.id ||
      input?.projectId ||
      input?.project ||
      "",
  ).trim();
}

function pickProjectLabel(input) {
  return String(
    input?.assetProject ||
      input?.projectName ||
      input?.projectLabel ||
      input?.project?.name ||
      input?.projectId?.name ||
      pickProjectId(input) ||
      "",
  ).trim();
}

function normalizeAssetOption(input, fallbackCode = "") {
  if (!input || typeof input !== "object") return null;

  const assetCode = pickAssetCode(input, fallbackCode);
  if (!assetCode) return null;

  const assetName = String(
    input.assetName || input.name || input.title || "",
  ).trim();

  const assetCategory = String(
    input.assetCategory ||
      input.category ||
      input.type ||
      input.assetType ||
      "",
  ).trim();

  const projectId = pickProjectId(input);
  const assetProject = pickProjectLabel(input);

  const assetLocation = String(
    input?.assetLocation ||
      input?.locationName ||
      input?.area ||
      input?.location?.name ||
      input?.location?.label ||
      "",
  ).trim();

  const assetStatus = normalizeAssetStatus(
    input?.assetStatus || input?.status || input?.presentStatus || "active",
  );

  const lat =
    input?.location?.lat ??
    input?.lat ??
    (Array.isArray(input?.geometry?.coordinates)
      ? input.geometry.coordinates[1]
      : null);

  const lng =
    input?.location?.lng ??
    input?.lng ??
    (Array.isArray(input?.geometry?.coordinates)
      ? input.geometry.coordinates[0]
      : null);

  return {
    id: assetCode,
    assetCode,
    assetName,
    assetCategory,
    assetProjectId: projectId || null,
    assetProject: assetProject || null,
    assetLocation,
    assetStatus,
    lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
    lng: Number.isFinite(Number(lng)) ? Number(lng) : null,
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

  let cachedMe = null;
  try {
    const rawMe = await AsyncStorage.getItem(CACHE_ME_KEY);
    cachedMe = rawMe ? JSON.parse(rawMe) : null;
  } catch {
    cachedMe = null;
  }

  let userId = "";
  for (const k of USER_ID_KEYS) {
    const v = await AsyncStorage.getItem(k);
    if (v) {
      userId = String(v);
      break;
    }
  }

  if (!userId && cachedMe?._id) userId = String(cachedMe._id);
  if (!userId && cachedMe?.userId) userId = String(cachedMe.userId);
  if (!userId && payload?.sub) userId = String(payload.sub);

  const roles = []
    .concat(cachedMe?.roles || [])
    .concat(cachedMe?.role ? [cachedMe.role] : [])
    .concat(payload?.roles || [])
    .concat(payload?.role ? [payload.role] : [])
    .concat(payload?.user?.roles || [])
    .concat(payload?.user?.role ? [payload.user.role] : [])
    .concat(payload?.permissions || [])
    .map((r) =>
      String(r || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);

  console.log("[ASSETS] cachedMe:", cachedMe);
  console.log("[ASSETS] token payload:", payload);
  console.log("[ASSETS] decoded roles:", roles);

  return {
    userId,
    roles,
    token,
    cachedMe,
  };
}

function parseAssetScan(scanValue) {
  if (scanValue == null) return null;

  if (typeof scanValue === "object") {
    const obj = scanValue;

    const code =
      obj?.assetCode ||
      obj?.code ||
      obj?.tag ||
      obj?.assetTag ||
      obj?.barcode ||
      obj?.value ||
      obj?.data ||
      obj?.text ||
      obj?.raw ||
      obj?.asset?.code ||
      obj?.asset?.assetCode ||
      null;

    const rawString =
      typeof code === "string"
        ? code
        : typeof obj?.data === "string"
          ? obj.data
          : JSON.stringify(obj);

    return {
      assetCode: code ? String(code).trim() : null,
      raw: rawString,
      meta: obj,
    };
  }

  const raw = String(scanValue || "").trim();
  if (!raw) return null;

  try {
    const obj = JSON.parse(raw);
    const code =
      obj?.assetCode ||
      obj?.code ||
      obj?.tag ||
      obj?.assetTag ||
      obj?.barcode ||
      obj?.value ||
      obj?.data ||
      obj?.text ||
      obj?.raw ||
      obj?.asset?.code ||
      obj?.asset?.assetCode ||
      null;

    return {
      assetCode: code ? String(code).trim() : raw,
      raw,
      meta: obj,
    };
  } catch {
    return {
      assetCode: raw,
      raw,
      meta: null,
    };
  }
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

function pickProjectIdFromProject(input) {
  return String(input?._id || input?.id || "").trim();
}

function pickProjectName(input) {
  return String(input?.name || input?.title || pickProjectIdFromProject(input));
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

function SelectField({ label, valueText, onPress, disabled }) {
  return (
    <TouchableOpacity
      style={[styles.selectField, disabled && { opacity: 0.5 }]}
      onPress={onPress}
      disabled={!!disabled}
    >
      <Text style={styles.selectFieldLabel}>{label}</Text>
      <Text style={styles.selectFieldValue} numberOfLines={1}>
        {valueText || "Tap to select"}
      </Text>
    </TouchableOpacity>
  );
}

export default function AssetsScreen() {
  const router = useRouter();

  const [userRole, setUserRole] = useState("");
  const [userId, setUserId] = useState("");

  const [assetsList, setAssetsList] = useState([]);
  const [projects, setProjects] = useState([]);

  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [createProjectPickerOpen, setCreateProjectPickerOpen] = useState(false);
  const [logStatusPickerOpen, setLogStatusPickerOpen] = useState(false);

  const canCreateAsset = CAN_CREATE_ROLES.has(
    String(userRole || "").toLowerCase(),
  );

  const [assetCode, setAssetCode] = useState("");
  const [assetName, setAssetName] = useState("");
  const [assetCategory, setAssetCategory] = useState("");
  const [assetProjectId, setAssetProjectId] = useState("");
  const [assetLocation, setAssetLocation] = useState("");
  const [assetStatus, setAssetStatus] = useState("");

  const [createVisible, setCreateVisible] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [newProjectId, setNewProjectId] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [newStatus, setNewStatus] = useState("active");
  const [pendingScanRaw, setPendingScanRaw] = useState(null);
  const [isSavingAssetCreate, setIsSavingAssetCreate] = useState(false);

  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logDateTime, setLogDateTime] = useState(formatNow());
  const [logNote, setLogNote] = useState("");
  const [logPhoto, setLogPhoto] = useState(null);
  const [logStatus, setLogStatus] = useState("active");
  const [isSavingLog, setIsSavingLog] = useState(false);

  const effectiveCode = String(assetCode || "").trim();

  const selectedAssetOption =
    assetsList.find((a) => normCode(a.assetCode) === normCode(assetCode)) ||
    null;

  const selectedProject =
    projects.find(
      (p) => pickProjectIdFromProject(p) === String(assetProjectId),
    ) || null;

  const selectedCreateProject =
    projects.find(
      (p) => pickProjectIdFromProject(p) === String(newProjectId),
    ) || null;

  useFocusEffect(
    useCallback(() => {
      let alive = true;

      (async () => {
        try {
          await refreshCachedMe();
        } catch (e) {
          console.log("[ASSETS] refreshCachedMe failed", e);
        }

        const [userMeta, assetItems, cachedProjects] = await Promise.all([
          getCurrentUserMeta(),
          refreshAssetsList(),
          loadCache(CACHE_PROJECTS_KEY, []),
        ]);

        if (!alive) return;

        const preferredRole =
          userMeta.roles.find((r) => CAN_CREATE_ROLES.has(r)) ||
          userMeta.roles.find((r) => r.includes("admin")) ||
          userMeta.roles.find((r) => r.includes("manager")) ||
          userMeta.roles[0] ||
          "worker";

        console.log("[ASSETS] resolved userRole:", preferredRole);
        console.log("[ASSETS] resolved userId:", userMeta.userId);

        setUserRole(preferredRole);
        setUserId(String(userMeta.userId || ""));
        setAssetsList(assetItems);
        setProjects(Array.isArray(cachedProjects) ? cachedProjects : []);
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
      setNewProjectId(prefill.assetProjectId || "");
      setNewLocation(prefill.assetLocation || "");
      setNewStatus(normalizeAssetStatus(prefill.assetStatus || "active"));
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
    setAssetProjectId(item.assetProjectId || "");
    setAssetLocation(item.assetLocation || "");
    setAssetStatus(normalizeAssetStatus(item.assetStatus || "active"));
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

      const existing = await applyAssetFromStore(parsedCode);
      if (existing) {
        applySelectedAsset(existing);
        return;
      }

      setAssetCode(parsedCode);
      setAssetStatus("");

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
        assetStatus: "active",
      });
    },
    [applyAssetFromStore, applySelectedAsset, canCreateAsset, openCreateModal],
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

          const candidate =
            scan?.value ?? scan?.data ?? scan?.text ?? scan?.raw ?? scan;

          const parsed = parseAssetScan(candidate);

          console.log("[ASSETS] scan object:", scan);
          console.log("[ASSETS] parsed scan:", parsed);

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
    if (isSavingAssetCreate) return;

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

    setIsSavingAssetCreate(true);

    try {
      const coords = await getCurrentCoords();

      const selectedCreateProjectObj =
        projects.find(
          (p) => pickProjectIdFromProject(p) === String(newProjectId),
        ) || null;

      const meta = {
        assetCode: code,
        assetName: name,
        assetCategory: String(newCategory || "").trim() || null,
        assetProjectId: String(newProjectId || "").trim() || null,
        assetProject: selectedCreateProjectObj
          ? pickProjectName(selectedCreateProjectObj)
          : null,
        assetLocation: String(newLocation || "").trim() || null,
        assetStatus: normalizeAssetStatus(newStatus || "active"),
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
      setAssetProjectId(meta.assetProjectId || "");
      setAssetLocation(meta.assetLocation || "");
      setAssetStatus(meta.assetStatus || "active");

      await saveAssetCreate({
        ...meta,
        userId: userId || null,
        updatedAt: new Date().toISOString(),
      });

      await tryImmediateSyncForAssets();

      console.log("[ASSETS] asset-create queued for sync");

      Alert.alert(
        "Asset created",
        "Asset saved on this device and queued for sync.",
      );
      closeCreateModal();
    } catch (e) {
      console.log("[ASSETS] Failed to queue asset-create", e);
      Alert.alert("Save failed", "Could not save asset on this device.");
    } finally {
      setIsSavingAssetCreate(false);
    }
  };

  const openLogModal = () => {
    if (!canProceedWithAsset) {
      Alert.alert(
        "No asset selected",
        "Please scan or select an asset before adding a log.",
      );
      return;
    }

    (async () => {
      const existing = await applyAssetFromStore(assetCode);
      if (existing) {
        applySelectedAsset(existing);
        setLogStatus(normalizeAssetStatus(existing.assetStatus || "active"));
      } else {
        setLogStatus(normalizeAssetStatus(assetStatus || "active"));
      }
    })();

    setLogDateTime(formatNow());
    setLogNote("");
    setLogPhoto(null);
    setLogModalVisible(true);
  };

  const handleSaveLog = async () => {
    if (isSavingLog) return;
    setIsSavingLog(true);

    try {
      const coords = await getCurrentCoords();
      const nowIso = new Date().toISOString();
      const nextStatus = normalizeAssetStatus(
        logStatus || assetStatus || "active",
      );

      const selectedProjectObj =
        projects.find(
          (p) => pickProjectIdFromProject(p) === String(assetProjectId),
        ) || null;

      const payload = {
        kind: "log",
        userId: userId || null,
        assetCode: String(assetCode || "").trim(),
        assetName: String(assetName || "").trim(),
        assetCategory: String(assetCategory || "").trim(),
        assetProjectId: String(assetProjectId || "").trim() || null,
        assetProject: selectedProjectObj
          ? pickProjectName(selectedProjectObj)
          : null,
        assetLocation: String(assetLocation || "").trim() || null,
        assetStatus: normalizeAssetStatus(assetStatus || "active"),
        nextStatus,
        dateTime: logDateTime,
        note: logNote,
        photoUri: logPhoto,
        location: coords,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const currentMap = await loadAssetsMap();
      const codeKey = normCode(assetCode);

      currentMap[codeKey] = {
        ...(currentMap[codeKey] || {}),
        assetCode: codeKey,
        assetName:
          String(assetName || "").trim() ||
          currentMap[codeKey]?.assetName ||
          "",
        assetCategory:
          String(assetCategory || "").trim() ||
          currentMap[codeKey]?.assetCategory ||
          "",
        assetProjectId:
          String(assetProjectId || "").trim() ||
          currentMap[codeKey]?.assetProjectId ||
          null,
        assetProject: selectedProjectObj
          ? pickProjectName(selectedProjectObj)
          : currentMap[codeKey]?.assetProject || null,
        assetLocation:
          String(assetLocation || "").trim() ||
          currentMap[codeKey]?.assetLocation ||
          null,
        assetStatus: nextStatus,
        updatedAt: nowIso,
      };

      await saveAssetsMap(currentMap);

      const nextAssets = await refreshAssetsList();
      setAssetsList(nextAssets);
      setAssetStatus(nextStatus);

      const id = await saveAssetLog(payload);
      await tryImmediateSyncForAssets();

      console.log("[ASSETS] asset log saved locally with id:", id);
      Alert.alert("Saved", "Asset log captured.");
      setLogModalVisible(false);
    } catch (e) {
      console.log("[ASSETS] Failed to save asset log", e);
      Alert.alert("Save failed", "Could not save asset log on this device.");
    } finally {
      setIsSavingLog(false);
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

            {canCreateAsset && (
              <TouchableOpacity
                style={[styles.scanButton, { marginLeft: 8 }]}
                onPress={() =>
                  openCreateModal({
                    assetCode: assetCode || "",
                    assetName,
                    assetCategory,
                    assetProjectId,
                    assetLocation,
                    assetStatus: assetStatus || "active",
                  })
                }
              >
                <Text style={styles.scanText}>+ Asset</Text>
              </TouchableOpacity>
            )}
          </View>

          <SelectField
            label="Asset"
            valueText={
              selectedAssetOption
                ? selectedAssetOption.label
                : "Select asset or scan asset"
            }
            onPress={() => setAssetPickerOpen(true)}
          />

          <TextInput
            style={styles.input}
            placeholder="Asset code / tag"
            placeholderTextColor="#aaa"
            value={assetCode}
            onChangeText={setAssetCode}
            autoCapitalize="characters"
          />

          <TextInput
            style={styles.input}
            placeholder="Category / type"
            placeholderTextColor="#aaa"
            value={assetCategory}
            editable={false}
          />

          <TextInput
            style={styles.input}
            placeholder="Present status"
            placeholderTextColor="#aaa"
            value={assetStatus ? assetStatusLabel(assetStatus) : ""}
            editable={false}
          />

          <SelectField
            label="Project (optional)"
            valueText={selectedProject ? pickProjectName(selectedProject) : ""}
            onPress={() => setProjectPickerOpen(true)}
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
        selectedId={selectedAssetOption?.assetCode || ""}
        getId={(a) => a.assetCode}
        getLabel={(a) => a.label}
        onSelect={(a) => {
          applySelectedAsset(a);
          setAssetPickerOpen(false);
        }}
        onClose={() => setAssetPickerOpen(false)}
        emptyText="No assets cached yet. Scan an asset or refresh offline lists."
      />

      <SelectModal
        visible={projectPickerOpen}
        title="Select project (optional)"
        items={projects}
        selectedId={assetProjectId}
        getId={(p) => pickProjectIdFromProject(p)}
        getLabel={(p) => pickProjectName(p)}
        onSelect={(p) => {
          setAssetProjectId(pickProjectIdFromProject(p));
          setProjectPickerOpen(false);
        }}
        onClose={() => setProjectPickerOpen(false)}
        emptyText="No projects cached yet. Refresh offline lists."
      />

      <SelectModal
        visible={createProjectPickerOpen}
        title="Select project (optional)"
        items={projects}
        selectedId={newProjectId}
        getId={(p) => pickProjectIdFromProject(p)}
        getLabel={(p) => pickProjectName(p)}
        onSelect={(p) => {
          setNewProjectId(pickProjectIdFromProject(p));
          setCreateProjectPickerOpen(false);
        }}
        onClose={() => setCreateProjectPickerOpen(false)}
        emptyText="No projects cached yet. Refresh offline lists."
      />

      <SelectModal
        visible={logStatusPickerOpen}
        title="Update asset status"
        items={ASSET_STATUS_OPTIONS}
        selectedId={logStatus}
        getId={(s) => s.id}
        getLabel={(s) => s.label}
        onSelect={(s) => {
          setLogStatus(String(s?.id || "active"));
          setLogStatusPickerOpen(false);
        }}
        onClose={() => setLogStatusPickerOpen(false)}
        emptyText="No statuses available."
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
              editable={!isSavingAssetCreate}
            />

            <TextInput
              style={styles.input}
              placeholder="Asset name (required)"
              placeholderTextColor="#aaa"
              value={newName}
              onChangeText={setNewName}
              editable={!isSavingAssetCreate}
            />

            <TextInput
              style={styles.input}
              placeholder="Category/type"
              placeholderTextColor="#aaa"
              value={newCategory}
              onChangeText={setNewCategory}
              editable={!isSavingAssetCreate}
            />

            <TextInput
              style={styles.input}
              placeholder="Initial status"
              placeholderTextColor="#aaa"
              value={assetStatusLabel(newStatus)}
              editable={false}
            />

            <SelectField
              label="Project (optional)"
              valueText={
                selectedCreateProject
                  ? pickProjectName(selectedCreateProject)
                  : ""
              }
              onPress={() => setCreateProjectPickerOpen(true)}
              disabled={isSavingAssetCreate}
            />

            <TextInput
              style={styles.input}
              placeholder="Location/area (optional)"
              placeholderTextColor="#aaa"
              value={newLocation}
              onChangeText={setNewLocation}
              editable={!isSavingAssetCreate}
            />

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.modalButton,
                  isSavingAssetCreate && { opacity: 0.6 },
                ]}
                onPress={handleSaveNewAsset}
                disabled={isSavingAssetCreate}
              >
                <Text style={styles.primaryButtonText}>
                  {isSavingAssetCreate ? "Saving..." : "Save asset"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalButton]}
                onPress={closeCreateModal}
                disabled={isSavingAssetCreate}
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
        onRequestClose={() => (isSavingLog ? null : setLogModalVisible(false))}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Asset log</Text>
            <Text style={styles.modalSubtitle}>
              {assetName || assetCode || "Current asset"}
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Current status"
              placeholderTextColor="#aaa"
              value={assetStatus ? assetStatusLabel(assetStatus) : ""}
              editable={false}
            />

            <SelectField
              label="Update status"
              valueText={assetStatusLabel(logStatus)}
              onPress={() => setLogStatusPickerOpen(true)}
              disabled={isSavingLog}
            />

            <View style={styles.dateRow}>
              <TextInput
                style={[styles.input, styles.dateInput]}
                placeholder="Date / time"
                placeholderTextColor="#aaa"
                value={logDateTime}
                onChangeText={setLogDateTime}
                editable={!isSavingLog}
              />
              <TouchableOpacity
                style={[styles.useNowButton, isSavingLog && { opacity: 0.5 }]}
                onPress={() => setLogDateTime(formatNow())}
                disabled={isSavingLog}
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
              editable={!isSavingLog}
            />

            {!logPhoto ? (
              <TouchableOpacity
                style={[styles.photoButton, isSavingLog && { opacity: 0.5 }]}
                onPress={() => (!isSavingLog ? takePhoto(setLogPhoto) : null)}
                disabled={isSavingLog}
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
                  style={[
                    styles.retryPhotoButton,
                    isSavingLog && { opacity: 0.5 },
                  ]}
                  onPress={() => (!isSavingLog ? takePhoto(setLogPhoto) : null)}
                  disabled={isSavingLog}
                >
                  <Text style={styles.retryPhotoText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.modalButton,
                  isSavingLog && { opacity: 0.6 },
                ]}
                onPress={handleSaveLog}
                disabled={isSavingLog}
              >
                <Text style={styles.primaryButtonText}>
                  {isSavingLog ? "Saving..." : "Save log"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalButton]}
                onPress={() => setLogModalVisible(false)}
                disabled={isSavingLog}
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
  selectField: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
    backgroundColor: "#fafafa",
  },
  selectFieldLabel: {
    fontSize: 11,
    color: "#777",
    marginBottom: 4,
  },
  selectFieldValue: {
    fontSize: 14,
    color: "#111",
    fontWeight: "600",
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
});
