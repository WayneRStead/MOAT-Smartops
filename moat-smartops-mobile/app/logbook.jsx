// app/logbook.jsx
// FULL DROP-IN REPLACEMENT (Trips + Purchases + Logs + Reminders)
//
// Adds:
// ✅ Reminder panel above logbook (next reminder for selected vehicle)
// ✅ Purchase: vendor dropdown + add new vendor, type dropdown from backend, project/task dropdowns
// ✅ Log: vendor dropdown, type dropdown from backend, reminder dropdown
// ✅ Slip photo label
// ✅ Saving guards to prevent duplicate submissions
//
// Assumptions:
// - Cached lists exist:
//   @moat:cache:projects
//   @moat:cache:tasks
// - OrgId is at @moat:cache:orgid
// - Token is at @moat:cache:token
// - API base URL is at @moat:api
// - database.js exports:
//   saveVehicleCreate, saveVehicleTrip, saveVehiclePurchase, saveVehicleLog

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

import {
  saveVehicleCreate,
  saveVehicleLog,
  saveVehiclePurchase,
  saveVehicleTrip,
} from "../database";

const THEME_COLOR = "#22a6b3";

const USAGE_TYPES = [
  { key: "business", label: "Business" },
  { key: "private", label: "Private" },
];

const LAST_SCAN_KEY = "@moat:lastScan";
const VEHICLES_KEY = "@moat:vehicles";

const CACHE_PROJECTS_KEY = "@moat:cache:projects";
const CACHE_TASKS_KEY = "@moat:cache:tasks";
const CACHE_VEHICLES_KEY = "@moat:cache:vehicles";
const ORG_KEY = "@moat:cache:orgid";
const TOKEN_KEY = "@moat:cache:token";
const USER_ID_KEYS = ["@moat:userId", "@moat:userid", "moat:userid"];

const API_BASE_URL_KEY = "@moat:api";

// Local vendor cache (simple UX list; later can be synced)
const VENDORS_KEY = "@moat:cache:vendors";

// Optional local reminder cache
// shape: { [REG]: [ { id, title, dueAt, ... } ] }
const VEHICLE_REMINDERS_KEY = "@moat:cache:vehicleReminders";

function nowIso() {
  return new Date().toISOString();
}

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

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function pickId(x) {
  return String(
    x?._id || x?.id || x?.projectId || x?.taskId || x?.userId || "",
  );
}

function pickName(x) {
  return (
    x?.name ||
    x?.title ||
    x?.projectName ||
    x?.taskName ||
    x?.label ||
    x?.code ||
    x?.ref ||
    x?.number ||
    pickId(x)
  );
}

function decodeJwtPayload(token) {
  try {
    const part = token?.split?.(".")?.[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);

    if (typeof atob === "function") return safeJsonParse(atob(pad));
    if (typeof Buffer !== "undefined")
      return safeJsonParse(Buffer.from(pad, "base64").toString("utf8"));
    return null;
  } catch {
    return null;
  }
}

async function getCurrentUserId() {
  for (const k of USER_ID_KEYS) {
    const v = await AsyncStorage.getItem(k);
    if (v) return String(v);
  }
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  const payload = token ? decodeJwtPayload(token) : null;
  const uid = payload?.sub || payload?.user_id || null;
  return uid ? String(uid) : "";
}

async function loadCache(key, fallback) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    const json = JSON.parse(raw);
    return json ?? fallback;
  } catch {
    return fallback;
  }
}

function asStringOrNull(v) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function normReg(v) {
  return String(v || "")
    .trim()
    .toUpperCase();
}

function openTripKeyForReg(reg) {
  return `@moat:openTrip:${normReg(reg)}`;
}

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

async function getApiBaseUrl() {
  const v = await AsyncStorage.getItem(API_BASE_URL_KEY);
  return String(v || "").trim();
}

async function getDeviceLocationSafe() {
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
    if (Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001) return null;

    return {
      lat,
      lng,
      acc: Number.isFinite(acc) ? acc : null,
      capturedAt: nowIso(),
    };
  } catch {
    return null;
  }
}

// -------- Vehicle local store helpers --------
async function loadVehiclesMap() {
  try {
    const raw = await AsyncStorage.getItem(VEHICLES_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

async function saveVehiclesMap(mapObj) {
  await AsyncStorage.setItem(VEHICLES_KEY, JSON.stringify(mapObj || {}));
}

function normalizeVehicleOption(input, fallbackReg = "") {
  if (!input || typeof input !== "object") return null;

  const reg = normReg(
    input.regNumber ||
      input.reg ||
      input.registration ||
      input.registrationNumber ||
      input.plate ||
      fallbackReg,
  );

  if (!reg) return null;

  const make = String(input.make || input.vehicleMake || "").trim();
  const model = String(input.model || input.vehicleModel || "").trim();
  const vehicleType = String(input.vehicleType || input.type || "").trim();
  const vin = String(input.vin || "").trim();
  const year =
    input.year != null && String(input.year).trim()
      ? String(input.year).trim()
      : "";

  const parts = [make, model || vehicleType].filter(Boolean);
  const subtitle = parts.join(" ");

  return {
    id: reg,
    regNumber: reg,
    make,
    model,
    vehicleType,
    vin,
    year,
    label: subtitle ? `${reg} — ${subtitle}` : reg,
    raw: input,
  };
}

function buildVehicleListFromSources(localMap, cachedVehicles) {
  const merged = new Map();

  // 1) start with cached/offline-list vehicles
  for (const item of Array.isArray(cachedVehicles) ? cachedVehicles : []) {
    const normalized = normalizeVehicleOption(item);
    if (!normalized) continue;
    merged.set(normalized.regNumber, normalized);
  }

  // 2) overlay local created/scanned vehicles (these are usually richer/newer)
  for (const [regKey, meta] of Object.entries(localMap || {})) {
    const normalized = normalizeVehicleOption(meta || {}, regKey);
    if (!normalized) continue;

    const existing = merged.get(normalized.regNumber);
    merged.set(normalized.regNumber, {
      ...(existing || {}),
      ...normalized,
      raw: { ...(existing?.raw || {}), ...(meta || {}) },
    });
  }

  return Array.from(merged.values()).sort((a, b) =>
    String(a.label).localeCompare(String(b.label)),
  );
}

async function refreshVehiclesList() {
  const [localMap, cachedVehicles] = await Promise.all([
    loadVehiclesMap(),
    loadCache(CACHE_VEHICLES_KEY, []),
  ]);

  return buildVehicleListFromSources(localMap, cachedVehicles);
}

/**
 * Disc parse: registration - 6 : VIN - 12 : type - 8 : make - 9 : model - 10
 */
function parseLicenceDisc(scanValue) {
  const raw = String(scanValue || "").trim();
  if (!raw) return null;

  try {
    const obj = JSON.parse(raw);

    const reg =
      obj.registration ||
      obj.reg ||
      obj.regNumber ||
      obj.registrationNumber ||
      obj.plate ||
      obj.vehicleReg ||
      null;

    const vin = obj.vin || obj.VIN || null;
    const make = obj.make || obj.vehicleMake || null;
    const model = obj.model || obj.vehicleModel || null;
    const year = obj.year || obj.vehicleYear || null;
    const vehicleType = obj.type || obj.vehicleType || null;

    return {
      regNumber: reg ? String(reg).trim() : null,
      vin: vin ? String(vin).trim() : null,
      make: make ? String(make).trim() : null,
      model: model ? String(model).trim() : null,
      year: year ? String(year).trim() : null,
      vehicleType: vehicleType ? String(vehicleType).trim() : null,
      raw,
    };
  } catch {
    // not JSON
  }

  if (raw.includes("%")) {
    const parts = raw.split("%");
    const get = (idx) => (parts[idx] ? String(parts[idx]).trim() : null);

    const regNumber = get(6);
    const vin = get(12);

    let typeRaw = get(8);
    let vehicleType = null;
    if (typeRaw) vehicleType = typeRaw.split("/")[0].split(" ")[0].trim();

    const make = get(9);
    const model = get(10);

    if (!regNumber) return null;

    return {
      regNumber,
      vin: vin || null,
      make: make || null,
      model: model || null,
      year: null,
      vehicleType: vehicleType || null,
      raw,
    };
  }

  return {
    regNumber: raw,
    vin: null,
    make: null,
    model: null,
    year: null,
    vehicleType: null,
    raw,
  };
}

/* -----------------------------
   Select Modal
------------------------------*/
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
  footer,
}) {
  const _getId =
    getId ||
    ((it) => {
      if (typeof it === "string") return it;
      return pickId(it);
    });

  const _getLabel =
    getLabel ||
    ((it) => {
      if (typeof it === "string") return it;
      return pickName(it);
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
            <Text style={styles.cardSubtitle}>{emptyText}</Text>
          ) : (
            <FlatList
              data={items}
              keyExtractor={(it, idx) => {
                const id = _getId(it);
                return id ? String(id) : String(idx);
              }}
              style={{ maxHeight: 380 }}
              renderItem={({ item }) => {
                const id = String(_getId(item) || "");
                const label = _getLabel(item);
                const active = selectedId && id && id === String(selectedId);
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

          {footer ? <View style={{ marginTop: 10 }}>{footer}</View> : null}

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

/* -----------------------------
   Vendors helpers
------------------------------*/
async function loadVendors() {
  const list = await loadCache(VENDORS_KEY, []);
  if (!Array.isArray(list)) return [];

  return list
    .map((x) => {
      if (!x) return null;

      if (typeof x === "string") {
        return { id: x, label: x };
      }

      const id = String(x._id || x.id || x.name || x.label || "");
      const label = String(x.name || x.label || x.id || x._id || "").trim();

      if (!label) return null;

      return {
        id: id || label,
        label,
        raw: x,
      };
    })
    .filter(Boolean)
    .sort(sortByLabel);
}

async function saveVendors(list) {
  await AsyncStorage.setItem(
    VENDORS_KEY,
    JSON.stringify(Array.isArray(list) ? list : []),
  );
}

function sortByLabel(a, b) {
  return String(a?.label || "").localeCompare(
    String(b?.label || ""),
    undefined,
    { sensitivity: "base" },
  );
}

/* -----------------------------
   Backend fetch: Types + Reminders
------------------------------*/
async function fetchVehicleEntryTypesSafe({ baseUrl, token }) {
  // 1) try cached definitions first
  try {
    const raw = await AsyncStorage.getItem("@moat:cache:definitions");
    const defs = raw ? JSON.parse(raw) : {};
    const arr = Array.isArray(defs?.vehicleEntryTypes)
      ? defs.vehicleEntryTypes
      : [];

    const cachedTypes = arr
      .map((x) => {
        if (!x) return null;
        if (typeof x === "string") return { id: x, label: x };
        const id = String(x.id || x._id || x.key || x.code || x.value || "");
        const label = String(x.label || x.name || x.title || id);
        if (!label) return null;
        return { id: id || label, label };
      })
      .filter(Boolean)
      .sort(sortByLabel);

    if (cachedTypes.length) return cachedTypes;
  } catch {}

  // 2) fallback to explicit endpoints if you add them later
  const candidates = [
    "/api/mobile/vehicle-entry-types",
    "/api/mobile/vehicles/entry-types",
    "/api/mobile/logbook/types",
    "/api/logbook/types",
  ];

  for (const path of candidates) {
    try {
      const url = joinUrl(baseUrl, path);
      const res = await fetch(url, {
        headers: {
          Authorization: token ? `Bearer ${token}` : "",
        },
      });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      const arr = data?.types || data?.items || data || [];
      if (!Array.isArray(arr) || arr.length === 0) continue;

      const types = arr
        .map((x) => {
          if (!x) return null;
          if (typeof x === "string") return { id: x, label: x };
          const id = String(x.id || x._id || x.key || x.code || x.value || "");
          const label = String(x.label || x.name || x.title || id);
          if (!label) return null;
          return { id: id || label, label };
        })
        .filter(Boolean)
        .sort(sortByLabel);

      if (types.length) return types;
    } catch {}
  }

  return [];
}

async function fetchVehicleRemindersSafe({ baseUrl, token, regNumber }) {
  // TODO: BACKEND ENDPOINT — adjust if needed.
  // expected response: { reminders: [...] } or [...]
  const reg = normReg(regNumber);
  if (!reg) return [];

  const candidates = [
    `/api/mobile/vehicles/${encodeURIComponent(reg)}/reminders`,
    `/api/mobile/vehicles/${encodeURIComponent(reg)}/reminders/next`,
    `/api/mobile/reminders/vehicle/${encodeURIComponent(reg)}`,
    `/api/reminders/vehicle/${encodeURIComponent(reg)}`,
  ];

  for (const path of candidates) {
    try {
      const url = joinUrl(baseUrl, path);
      const res = await fetch(url, {
        headers: { Authorization: token ? `Bearer ${token}` : "" },
      });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);

      let arr = data?.reminders || data?.items || data || [];
      if (!Array.isArray(arr)) arr = [];

      const normalized = arr
        .map((x) => {
          if (!x) return null;
          const id = String(x.id || x._id || x.reminderId || "");
          const title = String(
            x.title || x.name || x.label || x.type || "Reminder",
          );
          const dueAt = x.dueAt || x.dueDate || x.nextAt || x.when || null;
          return { id: id || title, title, dueAt };
        })
        .filter(Boolean);

      return normalized;
    } catch {
      // try next
    }
  }

  return [];
}

function sortRemindersByDue(reminders) {
  return (reminders || []).slice().sort((a, b) => {
    const da = a?.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
    const db = b?.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
    return da - db;
  });
}

function fmtDue(dueAt) {
  try {
    if (!dueAt) return "";
    const ms = Date.parse(dueAt);
    if (!Number.isFinite(ms)) return String(dueAt);
    const d = new Date(ms);
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
  } catch {
    return String(dueAt || "");
  }
}

export default function VehicleLogScreen() {
  const router = useRouter();

  // Cached lists
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);

  // Identity
  const [orgId, setOrgId] = useState("");
  const [userId, setUserId] = useState("");
  const [token, setToken] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");

  // Vehicle fields
  const [vehicle, setVehicle] = useState("");
  const [regNumber, setRegNumber] = useState("");

  // Local vehicle picker
  const [vehiclesList, setVehiclesList] = useState([]);
  const [vehiclePickerOpen, setVehiclePickerOpen] = useState(false);

  // Main project/task (optional)
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");

  // Selectors
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);

  // Open trip (per vehicle, persisted)
  const [openTrip, setOpenTrip] = useState(null);

  // Reminder panel
  const [vehicleReminders, setVehicleReminders] = useState([]);
  const nextReminder = useMemo(() => {
    const sorted = sortRemindersByDue(vehicleReminders);
    return sorted.length ? sorted[0] : null;
  }, [vehicleReminders]);

  // Types (shared for purchase + log)
  const [entryTypes, setEntryTypes] = useState([]); // [{id,label}]
  const [typesLoading, setTypesLoading] = useState(false);

  // Vendors
  const [vendors, setVendors] = useState([]); // [{id,label}]
  const [vendorPickerVisible, setVendorPickerVisible] = useState(false);
  const [vendorDraft, setVendorDraft] = useState("");

  // Modals
  const [tripModalVisible, setTripModalVisible] = useState(false);
  const [purchaseModalVisible, setPurchaseModalVisible] = useState(false);
  const [logModalVisible, setLogModalVisible] = useState(false);

  // Create vehicle modal
  const [createVehicleVisible, setCreateVehicleVisible] = useState(false);
  const [newRegNumber, setNewRegNumber] = useState("");
  const [newVin, setNewVin] = useState("");
  const [newVehicleType, setNewVehicleType] = useState("");
  const [newYear, setNewYear] = useState("");
  const [newMake, setNewMake] = useState("");
  const [newModel, setNewModel] = useState("");
  const [pendingDiscRaw, setPendingDiscRaw] = useState(null);
  const [isSavingVehicleCreate, setIsSavingVehicleCreate] = useState(false);

  // Trip state
  const [tripType, setTripType] = useState("start"); // 'start' | 'end'
  const [tripProjectId, setTripProjectId] = useState("");
  const [tripTaskId, setTripTaskId] = useState("");
  const [tripUsage, setTripUsage] = useState("");
  const [tripOdometer, setTripOdometer] = useState("");
  const [tripOdometerPhoto, setTripOdometerPhoto] = useState(null);
  const [usagePickerVisible, setUsagePickerVisible] = useState(false);
  const [tripProjectPickerOpen, setTripProjectPickerOpen] = useState(false);
  const [tripTaskPickerOpen, setTripTaskPickerOpen] = useState(false);
  const [isSavingTrip, setIsSavingTrip] = useState(false);

  // Purchase state
  const [purchaseVendor, setPurchaseVendor] = useState(""); // label
  const [purchaseTypeId, setPurchaseTypeId] = useState(""); // id from backend types
  const [purchaseDate, setPurchaseDate] = useState("");
  const [purchaseProjectId, setPurchaseProjectId] = useState("");
  const [purchaseTaskId, setPurchaseTaskId] = useState("");
  const [purchaseCost, setPurchaseCost] = useState("");
  const [purchaseNotes, setPurchaseNotes] = useState("");
  const [purchaseSlipPhoto, setPurchaseSlipPhoto] = useState(null);
  const [purchaseTypePickerOpen, setPurchaseTypePickerOpen] = useState(false);
  const [purchaseProjectPickerOpen, setPurchaseProjectPickerOpen] =
    useState(false);
  const [purchaseTaskPickerOpen, setPurchaseTaskPickerOpen] = useState(false);
  const [purchaseVendorPickerOpen, setPurchaseVendorPickerOpen] =
    useState(false);
  const [isSavingPurchase, setIsSavingPurchase] = useState(false);

  // Log state
  const [logTypeId, setLogTypeId] = useState("");
  const [logDate, setLogDate] = useState("");
  const [logOdometer, setLogOdometer] = useState("");
  const [logVendor, setLogVendor] = useState("");
  const [logTag, setLogTag] = useState("");
  const [logCost, setLogCost] = useState("");
  const [logNotes, setLogNotes] = useState("");
  const [logCompletesReminderId, setLogCompletesReminderId] = useState("");
  const [logPhoto, setLogPhoto] = useState(null);
  const [logTypePickerOpen, setLogTypePickerOpen] = useState(false);
  const [logVendorPickerOpen, setLogVendorPickerOpen] = useState(false);
  const [logReminderPickerOpen, setLogReminderPickerOpen] = useState(false);
  const [isSavingLog, setIsSavingLog] = useState(false);

  const effectiveReg = regNumber?.trim();

  const selectedVehicleOption =
    vehiclesList.find((v) => normReg(v.regNumber) === normReg(regNumber)) ||
    null;

  // Load cached projects/tasks + identity + vendors once
  useEffect(() => {
    (async () => {
      const [p, t] = await Promise.all([
        loadCache(CACHE_PROJECTS_KEY, []),
        loadCache(CACHE_TASKS_KEY, []),
      ]);
      setProjects(Array.isArray(p) ? p : []);
      setTasks(Array.isArray(t) ? t : []);

      const oid = (await AsyncStorage.getItem(ORG_KEY)) || "";
      setOrgId(String(oid || ""));

      const uid = await getCurrentUserId();
      setUserId(String(uid || ""));

      const tk = (await AsyncStorage.getItem(TOKEN_KEY)) || "";
      setToken(String(tk || ""));

      const base = await getApiBaseUrl();
      setApiBaseUrl(base);

      const vs = await loadVendors();
      setVendors(vs.sort(sortByLabel));

      const vehicleItems = await refreshVehiclesList();
      setVehiclesList(vehicleItems);
    })();
  }, []);

  // Fetch types from backend (if base URL exists)
  useEffect(() => {
    (async () => {
      if (!apiBaseUrl) return;
      setTypesLoading(true);
      try {
        const types = await fetchVehicleEntryTypesSafe({
          baseUrl: apiBaseUrl,
          token,
        });
        setEntryTypes(types);
      } finally {
        setTypesLoading(false);
      }
    })();
  }, [apiBaseUrl, token]);

  // Load open trip when reg changes (per vehicle persisted)
  useEffect(() => {
    (async () => {
      const reg = normReg(regNumber);
      if (!reg) {
        setOpenTrip(null);
        return;
      }
      const k = openTripKeyForReg(reg);
      const raw = await AsyncStorage.getItem(k);
      const obj = raw ? safeJsonParse(raw) : null;
      setOpenTrip(obj && typeof obj === "object" ? obj : null);
    })();
  }, [regNumber]);

  // Load reminders when reg changes (cache first, then backend)
  useEffect(() => {
    (async () => {
      const reg = normReg(regNumber);
      if (!reg) {
        setVehicleReminders([]);
        return;
      }

      // 1) local cache
      const raw = await AsyncStorage.getItem(VEHICLE_REMINDERS_KEY);
      const map = raw ? safeJsonParse(raw) : null;
      const fromCache = map && typeof map === "object" ? map[reg] : null;
      if (Array.isArray(fromCache)) setVehicleReminders(fromCache);

      // 2) backend fetch (if configured)
      if (apiBaseUrl) {
        const fetched = await fetchVehicleRemindersSafe({
          baseUrl: apiBaseUrl,
          token,
          regNumber: reg,
        });
        if (Array.isArray(fetched)) {
          setVehicleReminders(fetched);

          // update cache
          const nextMap = map && typeof map === "object" ? { ...map } : {};
          nextMap[reg] = fetched;
          await AsyncStorage.setItem(
            VEHICLE_REMINDERS_KEY,
            JSON.stringify(nextMap),
          );
        }
      }
    })();
  }, [regNumber, apiBaseUrl, token]);

  const selectedProject = projects.find((p) => pickId(p) === projectId) || null;
  const selectedTask = tasks.find((t) => pickId(t) === taskId) || null;

  const tasksForProject = useMemo(() => {
    if (!projectId) return tasks;
    const pid = String(projectId);
    return tasks.filter((t) => {
      const v =
        t?.projectId?._id ||
        t?.projectId?.id ||
        t?.project?._id ||
        t?.project?.id ||
        t?.projectId ||
        t?.project ||
        "";
      return String(v || "") === pid;
    });
  }, [tasks, projectId]);

  const tripSelectedProject =
    projects.find((p) => pickId(p) === tripProjectId) || null;
  const tripSelectedTask = tasks.find((t) => pickId(t) === tripTaskId) || null;

  const tasksForTripProject = useMemo(() => {
    if (!tripProjectId) return tasks;
    const pid = String(tripProjectId);
    return tasks.filter((t) => {
      const v =
        t?.projectId?._id ||
        t?.projectId?.id ||
        t?.project?._id ||
        t?.project?.id ||
        t?.projectId ||
        t?.project ||
        "";
      return String(v || "") === pid;
    });
  }, [tasks, tripProjectId]);

  const purchaseSelectedProject =
    projects.find((p) => pickId(p) === purchaseProjectId) || null;
  const purchaseSelectedTask =
    tasks.find((t) => pickId(t) === purchaseTaskId) || null;

  const tasksForPurchaseProject = useMemo(() => {
    if (!purchaseProjectId) return tasks;
    const pid = String(purchaseProjectId);
    return tasks.filter((t) => {
      const v =
        t?.projectId?._id ||
        t?.projectId?.id ||
        t?.project?._id ||
        t?.project?.id ||
        t?.projectId ||
        t?.project ||
        "";
      return String(v || "") === pid;
    });
  }, [tasks, purchaseProjectId]);

  const logTypeObj =
    entryTypes.find((t) => String(t.id) === String(logTypeId)) || null;
  const purchaseTypeObj =
    entryTypes.find((t) => String(t.id) === String(purchaseTypeId)) || null;

  const reminderOptions = useMemo(() => {
    const sorted = sortRemindersByDue(vehicleReminders || []);
    return sorted.map((r) => ({
      id: r.id,
      label: r.dueAt ? `${r.title} (due ${fmtDue(r.dueAt)})` : r.title,
      title: r.title,
      dueAt: r.dueAt || null,
    }));
  }, [vehicleReminders]);

  const selectedReminderObj =
    reminderOptions.find(
      (r) => String(r.id) === String(logCompletesReminderId),
    ) || null;

  const openCreateVehicleModal = useCallback(
    (prefill = {}) => {
      setNewRegNumber(prefill.regNumber || effectiveReg || "");
      setNewVin(prefill.vin || "");
      setNewVehicleType(prefill.vehicleType || "");
      setNewYear(prefill.year || "");
      setNewMake(prefill.make || "");
      setNewModel(prefill.model || "");
      setPendingDiscRaw(prefill.raw || null);
      setCreateVehicleVisible(true);
    },
    [effectiveReg],
  );

  const closeCreateVehicleModal = () => {
    setCreateVehicleVisible(false);
    setPendingDiscRaw(null);
  };

  const getVehicleMetaForReg = useCallback(async (reg) => {
    const key = normReg(reg);
    if (!key) return null;
    const map = await loadVehiclesMap();
    return map[key] || null;
  }, []);

  const applySelectedVehicle = useCallback((item) => {
    if (!item) return;
    setRegNumber(normReg(item.regNumber || item.id || ""));
    setVehicle(String(item.make || item.raw?.make || "").trim());
  }, []);

  const ensureVehicleKnownOrPrompt = useCallback(
    async (parsed) => {
      const parsedReg = String(parsed?.regNumber || "").trim();
      if (!parsedReg) {
        Alert.alert("Scan failed", "Could not detect a registration number.");
        return;
      }

      const regKey = normReg(parsedReg);
      setRegNumber(regKey);

      const localMap = await loadVehiclesMap();
      const cachedVehicles = await loadCache(CACHE_VEHICLES_KEY, []);
      const mergedVehicles = buildVehicleListFromSources(
        localMap,
        cachedVehicles,
      );
      setVehiclesList(mergedVehicles);

      const existingMerged = mergedVehicles.find(
        (v) => normReg(v.regNumber) === regKey,
      );

      if (existingMerged) {
        setVehicle(
          existingMerged.make ||
            parsed?.make ||
            existingMerged.raw?.make ||
            vehicle ||
            "",
        );

        // Optional: enrich local map with disc details if vehicle already exists in cache
        const existingLocal = localMap[regKey] || {};
        localMap[regKey] = {
          ...existingLocal,
          regNumber: regKey,
          vin: parsed?.vin || existingLocal?.vin || null,
          vehicleType:
            parsed?.vehicleType || existingLocal?.vehicleType || null,
          year: parsed?.year || existingLocal?.year || null,
          make:
            parsed?.make || existingLocal?.make || existingMerged.make || null,
          model:
            parsed?.model ||
            existingLocal?.model ||
            existingMerged.model ||
            null,
          createdAt: existingLocal?.createdAt || nowIso(),
          source: existingLocal?.source || "disc-scan",
          discRaw: parsed?.raw || existingLocal?.discRaw || null,
        };
        await saveVehiclesMap(localMap);

        const refreshedMerged = buildVehicleListFromSources(
          localMap,
          cachedVehicles,
        );
        setVehiclesList(refreshedMerged);
        return;
      }

      openCreateVehicleModal({
        regNumber: parsedReg,
        vin: parsed.vin,
        vehicleType: parsed.vehicleType,
        year: parsed.year,
        make: parsed.make,
        model: parsed.model,
        raw: parsed.raw,
      });
    },
    [openCreateVehicleModal, vehicle],
  );

  // When returning from /scan, read last scan and auto-fill
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

          const parsed = parseLicenceDisc(value);
          if (!parsed) {
            Alert.alert("Scan failed", "Could not read licence disc data.");
            return;
          }

          await ensureVehicleKnownOrPrompt(parsed);
        } catch (e) {
          console.log("[LOGBOOK] Failed to apply scan result", e);
        }
      })();

      return () => {
        mounted = false;
      };
    }, [ensureVehicleKnownOrPrompt]),
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

    const result = await ImagePicker.launchCameraAsync({ quality: 0.6 });
    if (result.canceled) return;

    const uri =
      result.assets && result.assets.length > 0 ? result.assets[0].uri : null;
    if (uri) setter(uri);
  };

  const handleScanDisc = () => {
    router.push({
      pathname: "/scan",
      params: {
        returnTo: "/logbook",
        field: "licenseDisc",
        label: "Scan licence disc",
      },
    });
  };

  const handleSaveNewVehicle = async () => {
    if (isSavingVehicleCreate) return;
    setIsSavingVehicleCreate(true);

    try {
      const reg = String(newRegNumber || "").trim();
      if (!reg) {
        Alert.alert(
          "Missing registration",
          "Please enter a registration number.",
        );
        return;
      }
      const make = String(newMake || "").trim();
      if (!make) {
        Alert.alert("Missing make", "Please enter the vehicle make.");
        return;
      }

      const meta = {
        regNumber: reg,
        vin: String(newVin || "").trim() || null,
        vehicleType: String(newVehicleType || "").trim() || null,
        year: String(newYear || "").trim() || null,
        make,
        model: String(newModel || "").trim() || null,
        createdAt: nowIso(),
        source: pendingDiscRaw ? "disc-scan" : "manual",
        discRaw: pendingDiscRaw || null,
      };

      const map = await loadVehiclesMap();
      map[reg.toUpperCase()] = meta;
      await saveVehiclesMap(map);

      const cachedVehicles = await loadCache(CACHE_VEHICLES_KEY, []);
      const nextVehicles = buildVehicleListFromSources(map, cachedVehicles);
      setVehiclesList(nextVehicles);

      try {
        const rowId = await saveVehicleCreate({
          orgId: asStringOrNull(orgId),
          userId: asStringOrNull(userId),
          regNumber: meta.regNumber,
          vin: meta.vin,
          vehicleType: meta.vehicleType,
          year: meta.year,
          make: meta.make,
          model: meta.model,
          source: meta.source,
          discRaw: meta.discRaw,
        });
        console.log("[LOGBOOK] vehicle-create saved rowId:", rowId);
      } catch (e) {
        console.log("[LOGBOOK] Failed to queue vehicle-create", e);
      }

      setRegNumber(reg);
      setVehicle(make);

      Alert.alert("Vehicle created", "Vehicle saved on this device.");
      closeCreateVehicleModal();
    } finally {
      setIsSavingVehicleCreate(false);
    }
  };

  const canProceedWithVehicle = useMemo(() => {
    return normReg(regNumber).length > 0;
  }, [regNumber]);

  const openTripModalFromMain = () => {
    if (!canProceedWithVehicle) {
      Alert.alert(
        "Select vehicle",
        "Please scan or enter a registration number first.",
      );
      return;
    }

    if (openTrip) {
      setTripType("end");
      setTripProjectId(openTrip.projectId || projectId || "");
      setTripTaskId(openTrip.taskId || taskId || "");
      setTripUsage(openTrip.usage || "");
      setTripOdometer("");
      setTripOdometerPhoto(null);
    } else {
      setTripType("start");
      setTripProjectId(projectId || "");
      setTripTaskId(taskId || "");
      setTripUsage("");
      setTripOdometer("");
      setTripOdometerPhoto(null);
    }
    setTripModalVisible(true);
  };

  async function persistOpenTrip(reg, tripObjOrNull) {
    const k = openTripKeyForReg(reg);
    if (!tripObjOrNull) {
      await AsyncStorage.removeItem(k);
      return;
    }
    await AsyncStorage.setItem(k, JSON.stringify(tripObjOrNull));
  }

  const handleSaveTrip = async () => {
    if (isSavingTrip) return;
    setIsSavingTrip(true);

    try {
      if (!tripOdometer?.trim()) {
        Alert.alert("Missing odometer", "Please enter the odometer reading.");
        return;
      }
      if (!tripOdometerPhoto) {
        Alert.alert(
          "Odometer photo required",
          "Please take an odometer photo.",
        );
        return;
      }

      const reg = normReg(regNumber);
      if (!reg) {
        Alert.alert("Missing vehicle", "Please set a registration number.");
        return;
      }

      const vehicleMeta = await getVehicleMetaForReg(regNumber);
      const location = await getDeviceLocationSafe();
      const ts = nowIso();

      if (tripType === "start") {
        if (!tripUsage) {
          Alert.alert(
            "Missing usage",
            "Please select usage (Business/Private).",
          );
          return;
        }

        const payload = {
          kind: "trip-start",
          orgId: asStringOrNull(orgId),
          userId: asStringOrNull(userId),
          regNumber: reg,
          vehicleLabel: String(vehicle || ""),
          vehicleMeta: vehicleMeta || null,

          projectId: asStringOrNull(tripProjectId),
          taskId: asStringOrNull(tripTaskId),
          usage: String(tripUsage),

          odometerStart: String(tripOdometer),
          odometerStartPhotoUri: tripOdometerPhoto,

          startedAt: ts,
          locationStart: location || null,

          createdAt: ts,
          updatedAt: ts,
        };

        const rowId = await saveVehicleTrip(payload);
        console.log("[LOGBOOK] trip-start saved rowId:", rowId);

        const open = {
          regNumber: reg,
          startedAt: ts,
          usage: tripUsage,
          projectId: asStringOrNull(tripProjectId),
          taskId: asStringOrNull(tripTaskId),
          odometerStart: String(tripOdometer),
          locationStart: location || null,
        };

        await persistOpenTrip(reg, open);
        setOpenTrip(open);

        Alert.alert("Trip started", "Trip start captured (offline-first).");
      } else {
        if (!openTrip) {
          Alert.alert(
            "No open trip",
            "There is no open trip for this vehicle on this device.",
          );
          return;
        }

        const payload = {
          kind: "trip-end",
          orgId: asStringOrNull(orgId),
          userId: asStringOrNull(userId),
          regNumber: reg,
          vehicleLabel: String(vehicle || ""),
          vehicleMeta: vehicleMeta || null,

          projectId: asStringOrNull(tripProjectId || openTrip.projectId),
          taskId: asStringOrNull(tripTaskId || openTrip.taskId),
          usage: String(openTrip.usage || ""),

          startedAt: openTrip.startedAt,
          odometerStart: String(openTrip.odometerStart || ""),

          endedAt: ts,
          odometerEnd: String(tripOdometer),
          odometerEndPhotoUri: tripOdometerPhoto,

          locationStart: openTrip.locationStart || null,
          locationEnd: location || null,

          createdAt: ts,
          updatedAt: ts,
        };

        const rowId = await saveVehicleTrip(payload);
        console.log("[LOGBOOK] trip-end saved rowId:", rowId);

        await persistOpenTrip(reg, null);
        setOpenTrip(null);

        Alert.alert("Trip ended", "Trip end captured (offline-first).");
      }

      setTripModalVisible(false);
      setTripOdometer("");
      setTripOdometerPhoto(null);
    } catch (e) {
      console.log("[LOGBOOK] Failed to save trip", e);
      Alert.alert("Error", e?.message || "Could not save trip on this device.");
    } finally {
      setIsSavingTrip(false);
    }
  };

  // Vendor select + add new (shared)
  const addNewVendor = async () => {
    const name = String(vendorDraft || "").trim();
    if (name.length < 2) {
      Alert.alert("Vendor name", "Please enter a vendor name.");
      return;
    }

    const existing = (vendors || []).some(
      (v) => String(v.label).toLowerCase() === name.toLowerCase(),
    );
    const next = existing
      ? vendors
      : [...(vendors || []), { id: name, label: name }].sort(sortByLabel);

    setVendors(next);
    await saveVendors(next);
    setVendorDraft("");

    // If a picker is open, do NOT auto-close; user can tap it immediately
  };

  // Purchase save
  const handleSavePurchase = async () => {
    if (isSavingPurchase) return;
    setIsSavingPurchase(true);

    try {
      if (!canProceedWithVehicle) {
        Alert.alert(
          "Select vehicle",
          "Please scan or enter a registration number first.",
        );
        return;
      }

      const reg = normReg(regNumber);
      const vehicleMeta = await getVehicleMetaForReg(regNumber);
      const location = await getDeviceLocationSafe();
      const dateTime = purchaseDate || formatNow();

      if (!purchaseVendor?.trim()) {
        Alert.alert("Missing vendor", "Please select or enter a vendor.");
        return;
      }

      if (!purchaseTypeId) {
        Alert.alert("Missing type", "Please select a type.");
        return;
      }

      if (!purchaseCost?.trim()) {
        Alert.alert("Missing cost", "Please enter the cost.");
        return;
      }

      if (!purchaseSlipPhoto) {
        Alert.alert("Slip photo required", "Please take a slip photo.");
        return;
      }

      const payload = {
        kind: "purchase",
        orgId: asStringOrNull(orgId),
        userId: asStringOrNull(userId),

        regNumber: reg,
        vehicleLabel: String(vehicle || ""),
        vehicleMeta: vehicleMeta || null,

        vendor: String(purchaseVendor || ""),
        typeId: String(purchaseTypeId),
        typeLabel: purchaseTypeObj ? String(purchaseTypeObj.label) : null,

        dateTime,

        projectId: asStringOrNull(purchaseProjectId),
        taskId: asStringOrNull(purchaseTaskId),

        cost: String(purchaseCost || ""),
        notes: String(purchaseNotes || ""),

        slipPhotoUri: purchaseSlipPhoto,

        location: location || null,

        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      const rowId = await saveVehiclePurchase(payload);
      console.log("[LOGBOOK] purchase saved rowId:", rowId);

      Alert.alert("Saved", "Purchase captured (offline-first).");

      setPurchaseModalVisible(false);
      setPurchaseVendor("");
      setPurchaseTypeId("");
      setPurchaseDate("");
      setPurchaseProjectId("");
      setPurchaseTaskId("");
      setPurchaseCost("");
      setPurchaseNotes("");
      setPurchaseSlipPhoto(null);
    } catch (e) {
      console.log("[LOGBOOK] Failed to save purchase", e);
      Alert.alert(
        "Error",
        e?.message || "Could not save purchase on this device.",
      );
    } finally {
      setIsSavingPurchase(false);
    }
  };

  // Log save
  const handleSaveLog = async () => {
    if (isSavingLog) return;
    setIsSavingLog(true);

    try {
      if (!canProceedWithVehicle) {
        Alert.alert(
          "Select vehicle",
          "Please scan or enter a registration number first.",
        );
        return;
      }

      const reg = normReg(regNumber);
      const vehicleMeta = await getVehicleMetaForReg(regNumber);
      const location = await getDeviceLocationSafe();
      const dateTime = logDate || formatNow();

      if (!logTypeId) {
        Alert.alert("Missing type", "Please select a type.");
        return;
      }

      if (!logVendor?.trim()) {
        Alert.alert("Missing vendor", "Please select or enter a vendor.");
        return;
      }

      const payload = {
        kind: "log",
        orgId: asStringOrNull(orgId),
        userId: asStringOrNull(userId),

        regNumber: reg,
        vehicleLabel: String(vehicle || ""),
        vehicleMeta: vehicleMeta || null,

        typeId: String(logTypeId),
        typeLabel: logTypeObj ? String(logTypeObj.label) : null,

        dateTime,
        odometer: String(logOdometer || ""),
        vendor: String(logVendor || ""),
        tag: String(logTag || ""),
        cost: String(logCost || ""),
        notes: String(logNotes || ""),

        completesReminderId: asStringOrNull(logCompletesReminderId),
        completesReminderLabel: selectedReminderObj
          ? String(selectedReminderObj.label)
          : null,

        photoUri: logPhoto || null,

        location: location || null,

        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      const rowId = await saveVehicleLog(payload);
      console.log("[LOGBOOK] log saved rowId:", rowId);

      Alert.alert("Saved", "Log captured (offline-first).");

      setLogModalVisible(false);
      setLogTypeId("");
      setLogDate("");
      setLogOdometer("");
      setLogVendor("");
      setLogTag("");
      setLogCost("");
      setLogNotes("");
      setLogCompletesReminderId("");
      setLogPhoto(null);
    } catch (e) {
      console.log("[LOGBOOK] Failed to save log", e);
      Alert.alert("Error", e?.message || "Could not save log on this device.");
    } finally {
      setIsSavingLog(false);
    }
  };

  const openPurchaseModal = () => {
    if (!canProceedWithVehicle) {
      Alert.alert(
        "Select vehicle",
        "Please scan or enter a registration number first.",
      );
      return;
    }

    // defaults (optional)
    setPurchaseProjectId(projectId || "");
    setPurchaseTaskId(taskId || "");
    setPurchaseDate("");
    setPurchaseVendor("");
    setPurchaseTypeId("");
    setPurchaseCost("");
    setPurchaseNotes("");
    setPurchaseSlipPhoto(null);

    setPurchaseModalVisible(true);
  };

  const openLogModal = () => {
    if (!canProceedWithVehicle) {
      Alert.alert(
        "Select vehicle",
        "Please scan or enter a registration number first.",
      );
      return;
    }

    setLogTypeId("");
    setLogDate("");
    setLogOdometer("");
    setLogVendor("");
    setLogTag("");
    setLogCost("");
    setLogNotes("");
    setLogCompletesReminderId("");
    setLogPhoto(null);

    setLogModalVisible(true);
  };

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <Image
            source={require("../assets/vehicle-screen.png")}
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

        {/* Reminder panel (only when a vehicle is selected) */}
        {canProceedWithVehicle ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Next reminder</Text>
            {!nextReminder ? (
              <Text style={styles.cardSubtitle}>
                No reminders found for {normReg(regNumber)}.
              </Text>
            ) : (
              <>
                <Text style={styles.reminderBig}>
                  {nextReminder.title || "Reminder"}
                </Text>
                {nextReminder.dueAt ? (
                  <Text style={styles.cardSubtitle}>
                    Due: {fmtDue(nextReminder.dueAt)}
                  </Text>
                ) : (
                  <Text style={styles.cardSubtitle}>Due date not set</Text>
                )}
              </>
            )}
          </View>
        ) : null}

        {/* Main vehicle card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Vehicle logbook</Text>

          <View style={styles.scanRow}>
            <TouchableOpacity
              style={styles.scanDiscButton}
              onPress={handleScanDisc}
            >
              <Image
                source={require("../assets/barcode.png")}
                style={styles.scanDiscIcon}
              />
              <Text style={styles.scanDiscText}>Scan disc</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.scanDiscButton, { marginLeft: 8 }]}
              onPress={() =>
                openCreateVehicleModal({
                  regNumber: normReg(regNumber),
                  make: vehicle,
                })
              }
            >
              <Text style={styles.scanDiscText}>+ Vehicle</Text>
            </TouchableOpacity>
          </View>

          <SelectField
            label="Vehicle"
            valueText={selectedVehicleOption ? selectedVehicleOption.label : ""}
            onPress={() => setVehiclePickerOpen(true)}
          />

          {canProceedWithVehicle ? (
            <Text style={styles.cardSubtitle}>
              Selected: {normReg(regNumber)}
              {vehicle ? ` • ${vehicle}` : ""}
            </Text>
          ) : null}

          {/* Main project/task dropdowns */}
          <SelectField
            label="Project (optional)"
            valueText={selectedProject ? pickName(selectedProject) : ""}
            onPress={() => setProjectPickerOpen(true)}
          />

          <SelectField
            label="Task (optional)"
            valueText={selectedTask ? pickName(selectedTask) : ""}
            onPress={() => setTaskPickerOpen(true)}
          />

          {/* Actions */}
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={openTripModalFromMain}
            >
              <Image
                source={require("../assets/trip.png")}
                style={styles.actionIcon}
              />
              <Text style={styles.actionLabel}>
                {openTrip ? "End trip" : "Start trip"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionButton}
              onPress={openPurchaseModal}
            >
              <Image
                source={require("../assets/purchases.png")}
                style={styles.actionIcon}
              />
              <Text style={styles.actionLabel}>Add purchase</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionButton}
              onPress={openLogModal}
            >
              <Image
                source={require("../assets/activity-log.png")}
                style={styles.actionIcon}
              />
              <Text style={styles.actionLabel}>Add log</Text>
            </TouchableOpacity>
          </View>

          {openTrip ? (
            <Text style={[styles.cardSubtitle, { marginTop: 10 }]}>
              Open trip: started{" "}
              {openTrip.startedAt?.slice?.(0, 16)?.replace?.("T", " ") || "-"} •{" "}
              {USAGE_TYPES.find((u) => u.key === openTrip.usage)?.label ||
                openTrip.usage ||
                "-"}
            </Text>
          ) : null}

          {typesLoading ? (
            <Text style={[styles.cardSubtitle, { marginTop: 6 }]}>
              Loading types…
            </Text>
          ) : entryTypes.length === 0 ? (
            <Text style={[styles.cardSubtitle, { marginTop: 6 }]}>
              Types not loaded (offline or endpoint mismatch). You can still
              save trips.
            </Text>
          ) : null}
        </View>
      </ScrollView>

      {/* VEHICLE PICKER */}
      <SelectModal
        visible={vehiclePickerOpen}
        title="Select vehicle"
        items={vehiclesList}
        selectedId={normReg(regNumber)}
        getId={(v) => v.regNumber}
        getLabel={(v) => v.label}
        onSelect={(v) => {
          applySelectedVehicle(v);
          setVehiclePickerOpen(false);
        }}
        onClose={() => setVehiclePickerOpen(false)}
        emptyText="No local vehicles yet. Scan a disc or create a vehicle first."
      />

      {/* MAIN PROJECT PICKER */}
      <SelectModal
        visible={projectPickerOpen}
        title="Select Project (optional)"
        items={projects}
        selectedId={projectId}
        onSelect={(p) => {
          const id = pickId(p);
          setProjectId(id);

          if (taskId) {
            const still = tasksForProject.find((t) => pickId(t) === taskId);
            if (!still) setTaskId("");
          }
          setProjectPickerOpen(false);
        }}
        onClose={() => setProjectPickerOpen(false)}
        emptyText="No projects cached yet. Refresh Offline lists."
      />

      {/* MAIN TASK PICKER */}
      <SelectModal
        visible={taskPickerOpen}
        title="Select Task (optional)"
        items={tasksForProject}
        selectedId={taskId}
        onSelect={(t) => {
          setTaskId(pickId(t));
          setTaskPickerOpen(false);
        }}
        onClose={() => setTaskPickerOpen(false)}
        emptyText="No tasks cached yet (or none for selected project)."
      />

      {/* CREATE VEHICLE MODAL */}
      <Modal
        visible={createVehicleVisible}
        transparent
        animationType="slide"
        onRequestClose={closeCreateVehicleModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Create vehicle</Text>
            <Text style={styles.cardSubtitle}>
              Make + Registration are required.
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Registration number"
              placeholderTextColor="#aaa"
              value={newRegNumber}
              onChangeText={setNewRegNumber}
              autoCapitalize="characters"
            />
            <TextInput
              style={styles.input}
              placeholder="VIN"
              placeholderTextColor="#aaa"
              value={newVin}
              onChangeText={setNewVin}
              autoCapitalize="characters"
            />
            <TextInput
              style={styles.input}
              placeholder="Type of vehicle (e.g. Bakkie, Truck)"
              placeholderTextColor="#aaa"
              value={newVehicleType}
              onChangeText={setNewVehicleType}
            />
            <TextInput
              style={styles.input}
              placeholder="Year"
              placeholderTextColor="#aaa"
              value={newYear}
              onChangeText={setNewYear}
              keyboardType="numeric"
            />
            <TextInput
              style={styles.input}
              placeholder="Make (required)"
              placeholderTextColor="#aaa"
              value={newMake}
              onChangeText={setNewMake}
            />
            <TextInput
              style={styles.input}
              placeholder="Model"
              placeholderTextColor="#aaa"
              value={newModel}
              onChangeText={setNewModel}
            />

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.modalButton,
                  isSavingVehicleCreate && { opacity: 0.6 },
                ]}
                onPress={handleSaveNewVehicle}
                disabled={isSavingVehicleCreate}
              >
                <Text style={styles.primaryButtonText}>
                  {isSavingVehicleCreate ? "Saving…" : "Save vehicle"}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalButton]}
                onPress={closeCreateVehicleModal}
                disabled={isSavingVehicleCreate}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* TRIP MODAL */}
      <Modal
        visible={tripModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() =>
          isSavingTrip ? null : setTripModalVisible(false)
        }
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {tripType === "start" ? "Start trip" : "End trip"}
            </Text>

            {tripType === "end" && openTrip ? (
              <Text style={styles.cardSubtitle}>
                Start odometer: {openTrip.odometerStart || "-"}
              </Text>
            ) : null}

            <SelectField
              label="Project (optional)"
              valueText={
                tripSelectedProject ? pickName(tripSelectedProject) : ""
              }
              onPress={() => setTripProjectPickerOpen(true)}
              disabled={isSavingTrip}
            />
            <SelectField
              label="Task (optional)"
              valueText={tripSelectedTask ? pickName(tripSelectedTask) : ""}
              onPress={() => setTripTaskPickerOpen(true)}
              disabled={isSavingTrip}
            />

            {tripType === "start" ? (
              <TouchableOpacity
                style={[styles.selectInput, isSavingTrip && { opacity: 0.5 }]}
                onPress={() =>
                  !isSavingTrip ? setUsagePickerVisible(true) : null
                }
                disabled={isSavingTrip}
              >
                <Text
                  style={
                    tripUsage
                      ? styles.selectInputText
                      : styles.selectInputPlaceholder
                  }
                >
                  {tripUsage
                    ? USAGE_TYPES.find((u) => u.key === tripUsage)?.label ||
                      "Usage"
                    : "Usage"}
                </Text>
                <Text style={styles.selectChevron}>▼</Text>
              </TouchableOpacity>
            ) : openTrip ? (
              <Text style={styles.cardSubtitle}>
                Usage:{" "}
                {USAGE_TYPES.find((u) => u.key === openTrip.usage)?.label ||
                  openTrip.usage ||
                  "-"}
              </Text>
            ) : null}

            <TextInput
              style={styles.input}
              placeholder="Odometer"
              placeholderTextColor="#aaa"
              value={tripOdometer}
              onChangeText={setTripOdometer}
              keyboardType="numeric"
              editable={!isSavingTrip}
            />

            {!tripOdometerPhoto ? (
              <TouchableOpacity
                style={[styles.photoButton, isSavingTrip && { opacity: 0.5 }]}
                onPress={() =>
                  !isSavingTrip ? takePhoto(setTripOdometerPhoto) : null
                }
                disabled={isSavingTrip}
              >
                <Image
                  source={require("../assets/camera.png")}
                  style={styles.photoIcon}
                />
                <Text style={styles.photoButtonText}>
                  Odometer photo (required)
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.photoPreview}>
                <Image
                  source={{ uri: tripOdometerPhoto }}
                  style={styles.photoPreviewImage}
                />
                <TouchableOpacity
                  style={[
                    styles.retryPhotoButton,
                    isSavingTrip && { opacity: 0.5 },
                  ]}
                  onPress={() =>
                    !isSavingTrip ? takePhoto(setTripOdometerPhoto) : null
                  }
                  disabled={isSavingTrip}
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
                  isSavingTrip && { opacity: 0.6 },
                ]}
                onPress={handleSaveTrip}
                disabled={isSavingTrip}
              >
                <Text style={styles.primaryButtonText}>
                  {isSavingTrip
                    ? "Saving…"
                    : tripType === "start"
                      ? "Save start"
                      : "Save end"}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.secondaryButton,
                  styles.modalButton,
                  isSavingTrip && { opacity: 0.5 },
                ]}
                onPress={() => setTripModalVisible(false)}
                disabled={isSavingTrip}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* TRIP PROJECT PICKER */}
      <SelectModal
        visible={tripProjectPickerOpen}
        title="Select Project (optional)"
        items={projects}
        selectedId={tripProjectId}
        onSelect={(p) => {
          const id = pickId(p);
          setTripProjectId(id);

          if (tripTaskId) {
            const still = tasksForTripProject.find(
              (t) => pickId(t) === tripTaskId,
            );
            if (!still) setTripTaskId("");
          }
          setTripProjectPickerOpen(false);
        }}
        onClose={() => setTripProjectPickerOpen(false)}
        emptyText="No projects cached yet. Refresh Offline lists."
      />

      {/* TRIP TASK PICKER */}
      <SelectModal
        visible={tripTaskPickerOpen}
        title="Select Task (optional)"
        items={tasksForTripProject}
        selectedId={tripTaskId}
        onSelect={(t) => {
          setTripTaskId(pickId(t));
          setTripTaskPickerOpen(false);
        }}
        onClose={() => setTripTaskPickerOpen(false)}
        emptyText="No tasks cached yet (or none for selected project)."
      />

      {/* PURCHASE MODAL */}
      <Modal
        visible={purchaseModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() =>
          isSavingPurchase ? null : setPurchaseModalVisible(false)
        }
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add purchase</Text>

            {/* Vendor: select or add */}
            <SelectField
              label="Vendor"
              valueText={purchaseVendor || ""}
              onPress={() => setPurchaseVendorPickerOpen(true)}
              disabled={isSavingPurchase}
            />

            {/* Type: backend list */}
            <SelectField
              label="Type"
              valueText={purchaseTypeObj ? purchaseTypeObj.label : ""}
              onPress={() => setPurchaseTypePickerOpen(true)}
              disabled={isSavingPurchase || entryTypes.length === 0}
            />

            <View style={styles.dateRow}>
              <TextInput
                style={[styles.input, styles.dateInput]}
                placeholder="Date / time"
                placeholderTextColor="#aaa"
                value={purchaseDate}
                onChangeText={setPurchaseDate}
                editable={!isSavingPurchase}
              />
              <TouchableOpacity
                style={[
                  styles.useNowButton,
                  isSavingPurchase && { opacity: 0.5 },
                ]}
                onPress={() => setPurchaseDate(formatNow())}
                disabled={isSavingPurchase}
              >
                <Text style={styles.useNowText}>Use now</Text>
              </TouchableOpacity>
            </View>

            {/* Project/Task optional dropdowns */}
            <SelectField
              label="Project (optional)"
              valueText={
                purchaseSelectedProject ? pickName(purchaseSelectedProject) : ""
              }
              onPress={() => setPurchaseProjectPickerOpen(true)}
              disabled={isSavingPurchase}
            />
            <SelectField
              label="Task (optional)"
              valueText={
                purchaseSelectedTask ? pickName(purchaseSelectedTask) : ""
              }
              onPress={() => setPurchaseTaskPickerOpen(true)}
              disabled={isSavingPurchase}
            />

            <TextInput
              style={styles.input}
              placeholder="Cost"
              placeholderTextColor="#aaa"
              value={purchaseCost}
              onChangeText={setPurchaseCost}
              keyboardType="numeric"
              editable={!isSavingPurchase}
            />

            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Notes"
              placeholderTextColor="#aaa"
              value={purchaseNotes}
              onChangeText={setPurchaseNotes}
              multiline
              editable={!isSavingPurchase}
            />

            {!purchaseSlipPhoto ? (
              <TouchableOpacity
                style={[
                  styles.photoButton,
                  isSavingPurchase && { opacity: 0.5 },
                ]}
                onPress={() =>
                  !isSavingPurchase ? takePhoto(setPurchaseSlipPhoto) : null
                }
                disabled={isSavingPurchase}
              >
                <Image
                  source={require("../assets/camera.png")}
                  style={styles.photoIcon}
                />
                <Text style={styles.photoButtonText}>
                  Slip photo (required)
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.photoPreview}>
                <Image
                  source={{ uri: purchaseSlipPhoto }}
                  style={styles.photoPreviewImage}
                />
                <TouchableOpacity
                  style={[
                    styles.retryPhotoButton,
                    isSavingPurchase && { opacity: 0.5 },
                  ]}
                  onPress={() =>
                    !isSavingPurchase ? takePhoto(setPurchaseSlipPhoto) : null
                  }
                  disabled={isSavingPurchase}
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
                  isSavingPurchase && { opacity: 0.6 },
                ]}
                onPress={handleSavePurchase}
                disabled={isSavingPurchase}
              >
                <Text style={styles.primaryButtonText}>
                  {isSavingPurchase ? "Saving…" : "Save purchase"}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.secondaryButton,
                  styles.modalButton,
                  isSavingPurchase && { opacity: 0.5 },
                ]}
                onPress={() => setPurchaseModalVisible(false)}
                disabled={isSavingPurchase}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* LOG MODAL */}
      <Modal
        visible={logModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => (isSavingLog ? null : setLogModalVisible(false))}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add log</Text>

            <SelectField
              label="Type"
              valueText={logTypeObj ? logTypeObj.label : ""}
              onPress={() => setLogTypePickerOpen(true)}
              disabled={isSavingLog || entryTypes.length === 0}
            />

            <View style={styles.dateRow}>
              <TextInput
                style={[styles.input, styles.dateInput]}
                placeholder="Date / time"
                placeholderTextColor="#aaa"
                value={logDate}
                onChangeText={setLogDate}
                editable={!isSavingLog}
              />
              <TouchableOpacity
                style={[styles.useNowButton, isSavingLog && { opacity: 0.5 }]}
                onPress={() => setLogDate(formatNow())}
                disabled={isSavingLog}
              >
                <Text style={styles.useNowText}>Use now</Text>
              </TouchableOpacity>
            </View>

            <TextInput
              style={styles.input}
              placeholder="Odometer"
              placeholderTextColor="#aaa"
              value={logOdometer}
              onChangeText={setLogOdometer}
              keyboardType="numeric"
              editable={!isSavingLog}
            />

            <SelectField
              label="Vendor"
              valueText={logVendor || ""}
              onPress={() => setLogVendorPickerOpen(true)}
              disabled={isSavingLog}
            />

            <TextInput
              style={styles.input}
              placeholder="Tag"
              placeholderTextColor="#aaa"
              value={logTag}
              onChangeText={setLogTag}
              editable={!isSavingLog}
            />

            <TextInput
              style={styles.input}
              placeholder="Cost"
              placeholderTextColor="#aaa"
              value={logCost}
              onChangeText={setLogCost}
              keyboardType="numeric"
              editable={!isSavingLog}
            />

            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Notes"
              placeholderTextColor="#aaa"
              value={logNotes}
              onChangeText={setLogNotes}
              multiline
              editable={!isSavingLog}
            />

            <SelectField
              label="Completes reminder (optional)"
              valueText={selectedReminderObj ? selectedReminderObj.label : ""}
              onPress={() => setLogReminderPickerOpen(true)}
              disabled={isSavingLog || reminderOptions.length === 0}
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
                <Text style={styles.photoButtonText}>Photo (optional)</Text>
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
                  {isSavingLog ? "Saving…" : "Save log"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.secondaryButton,
                  styles.modalButton,
                  isSavingLog && { opacity: 0.5 },
                ]}
                onPress={() => setLogModalVisible(false)}
                disabled={isSavingLog}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* PURCHASE VENDOR PICKER */}
      <SelectModal
        visible={purchaseVendorPickerOpen}
        title="Select vendor"
        items={vendors}
        selectedId={purchaseVendor}
        getId={(v) => v.label}
        getLabel={(v) => v.label}
        onSelect={(v) => {
          setPurchaseVendor(v.label);
          setPurchaseVendorPickerOpen(false);
        }}
        onClose={() => setPurchaseVendorPickerOpen(false)}
        emptyText="No vendors yet. Add one below."
        footer={
          <>
            <TextInput
              style={styles.input}
              placeholder="Add new vendor…"
              placeholderTextColor="#aaa"
              value={vendorDraft}
              onChangeText={setVendorDraft}
            />
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={addNewVendor}
            >
              <Text style={styles.secondaryButtonText}>Add vendor</Text>
            </TouchableOpacity>
          </>
        }
      />

      {/* LOG VENDOR PICKER */}
      <SelectModal
        visible={logVendorPickerOpen}
        title="Select vendor"
        items={vendors}
        selectedId={logVendor}
        getId={(v) => v.label}
        getLabel={(v) => v.label}
        onSelect={(v) => {
          setLogVendor(v.label);
          setLogVendorPickerOpen(false);
        }}
        onClose={() => setLogVendorPickerOpen(false)}
        emptyText="No vendors yet. Add one below."
        footer={
          <>
            <TextInput
              style={styles.input}
              placeholder="Add new vendor…"
              placeholderTextColor="#aaa"
              value={vendorDraft}
              onChangeText={setVendorDraft}
            />
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={addNewVendor}
            >
              <Text style={styles.secondaryButtonText}>Add vendor</Text>
            </TouchableOpacity>
          </>
        }
      />

      {/* PURCHASE TYPE PICKER */}
      <SelectModal
        visible={purchaseTypePickerOpen}
        title="Select type"
        items={entryTypes}
        selectedId={purchaseTypeId}
        getId={(t) => t.id}
        getLabel={(t) => t.label}
        onSelect={(t) => {
          setPurchaseTypeId(String(t.id));
          setPurchaseTypePickerOpen(false);
        }}
        onClose={() => setPurchaseTypePickerOpen(false)}
        emptyText="No types loaded. Check API base URL and endpoint."
      />

      {/* LOG TYPE PICKER */}
      <SelectModal
        visible={logTypePickerOpen}
        title="Select type"
        items={entryTypes}
        selectedId={logTypeId}
        getId={(t) => t.id}
        getLabel={(t) => t.label}
        onSelect={(t) => {
          setLogTypeId(String(t.id));
          setLogTypePickerOpen(false);
        }}
        onClose={() => setLogTypePickerOpen(false)}
        emptyText="No types loaded. Check API base URL and endpoint."
      />

      {/* PURCHASE PROJECT PICKER */}
      <SelectModal
        visible={purchaseProjectPickerOpen}
        title="Select Project (optional)"
        items={projects}
        selectedId={purchaseProjectId}
        onSelect={(p) => {
          const id = pickId(p);
          setPurchaseProjectId(id);

          if (purchaseTaskId) {
            const still = tasksForPurchaseProject.find(
              (t) => pickId(t) === purchaseTaskId,
            );
            if (!still) setPurchaseTaskId("");
          }

          setPurchaseProjectPickerOpen(false);
        }}
        onClose={() => setPurchaseProjectPickerOpen(false)}
        emptyText="No projects cached yet. Refresh Offline lists."
      />

      {/* PURCHASE TASK PICKER */}
      <SelectModal
        visible={purchaseTaskPickerOpen}
        title="Select Task (optional)"
        items={tasksForPurchaseProject}
        selectedId={purchaseTaskId}
        onSelect={(t) => {
          setPurchaseTaskId(pickId(t));
          setPurchaseTaskPickerOpen(false);
        }}
        onClose={() => setPurchaseTaskPickerOpen(false)}
        emptyText="No tasks cached yet (or none for selected project)."
      />

      {/* REMINDER PICKER */}
      <SelectModal
        visible={logReminderPickerOpen}
        title="Select reminder (optional)"
        items={reminderOptions}
        selectedId={logCompletesReminderId}
        getId={(r) => r.id}
        getLabel={(r) => r.label}
        onSelect={(r) => {
          setLogCompletesReminderId(String(r.id));
          setLogReminderPickerOpen(false);
        }}
        onClose={() => setLogReminderPickerOpen(false)}
        emptyText="No reminders available for this vehicle."
      />

      {/* USAGE PICKER MODAL */}
      <Modal
        visible={usagePickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setUsagePickerVisible(false)}
      >
        <View style={styles.typeModalOverlay}>
          <View style={styles.typeModalCard}>
            <Text style={styles.typeModalTitle}>Select usage</Text>
            {USAGE_TYPES.map((u) => (
              <TouchableOpacity
                key={u.key}
                style={styles.typeOption}
                onPress={() => {
                  setTripUsage(u.key);
                  setUsagePickerVisible(false);
                }}
              >
                <Text
                  style={[
                    styles.typeOptionText,
                    tripUsage === u.key && styles.typeOptionTextSelected,
                  ]}
                >
                  {u.label}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.secondaryButton, { marginTop: 8 }]}
              onPress={() => setUsagePickerVisible(false)}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
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
  topBarLogo: { flex: 1, height: 48 },
  homeButton: { padding: 4, marginLeft: 8 },
  homeIcon: { width: 32, height: 32 },

  card: {
    backgroundColor: "#ffffff",
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
    elevation: 2,
  },
  cardTitle: { fontSize: 16, fontWeight: "600", marginBottom: 4 },
  cardSubtitle: { fontSize: 12, color: "#666", marginBottom: 8 },

  reminderBig: {
    fontSize: 14,
    fontWeight: "700",
    marginTop: 4,
    marginBottom: 2,
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
  textArea: { height: 60, textAlignVertical: "top" },

  scanRow: {
    flexDirection: "row",
    justifyContent: "flex-start",
    marginBottom: 8,
  },
  scanDiscButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: THEME_COLOR,
    marginBottom: 8,
  },
  scanDiscIcon: { width: 48, height: 48, marginRight: 6 },
  scanDiscText: { color: THEME_COLOR, fontWeight: "500", fontSize: 13 },

  actionsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  actionButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    marginHorizontal: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ddd",
    backgroundColor: "#fafafa",
  },
  actionIcon: { width: 36, height: 36, marginBottom: 4 },
  actionLabel: { fontSize: 11, textAlign: "center" },

  // Select fields
  selectField: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
    backgroundColor: "#fafafa",
  },
  selectFieldLabel: { fontSize: 11, color: "#777", marginBottom: 4 },
  selectFieldValue: { fontSize: 14, color: "#111", fontWeight: "600" },

  // Select modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  selectModalCard: { backgroundColor: "#fff", borderRadius: 10, padding: 16 },
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
  selectRowActive: { backgroundColor: "#e8f8fa" },
  selectRowText: { fontSize: 14, color: "#111" },
  selectRowTextActive: { color: THEME_COLOR, fontWeight: "700" },
  modalCloseButton: {
    marginTop: 8,
    alignSelf: "center",
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  modalCloseText: { color: "#555", fontSize: 12 },

  // Trip usage select input
  selectInput: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 12,
    marginBottom: 10,
    backgroundColor: "#fafafa",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  selectInputText: { fontSize: 14, color: "#333" },
  selectInputPlaceholder: { fontSize: 14, color: "#aaa" },
  selectChevron: { fontSize: 12, color: "#777" },

  // Modals generic card
  modalCard: { backgroundColor: "#fff", borderRadius: 10, padding: 20 },
  modalTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 12,
    textAlign: "center",
  },
  modalButtonsRow: { flexDirection: "row", marginTop: 12 },
  modalButton: { flex: 1, marginHorizontal: 4 },

  primaryButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: "center",
  },
  primaryButtonText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  secondaryButton: {
    borderWidth: 1,
    borderColor: THEME_COLOR,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonText: { color: THEME_COLOR, fontSize: 14, fontWeight: "600" },

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
  photoIcon: { width: 32, height: 32, marginRight: 8 },
  photoButtonText: { color: THEME_COLOR, fontWeight: "600" },

  photoPreview: { alignItems: "center", marginBottom: 10 },
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
  retryPhotoText: { color: "#fff", fontWeight: "600" },

  dateRow: { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  dateInput: { flex: 1, marginBottom: 0 },
  useNowButton: {
    marginLeft: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: "#eee",
  },
  useNowText: { fontSize: 11, color: "#333" },

  // Usage picker modal
  typeModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    paddingHorizontal: 40,
  },
  typeModalCard: {
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingVertical: 16,
    paddingHorizontal: 12,
  },
  typeModalTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
    textAlign: "center",
  },
  typeOption: { paddingVertical: 8, paddingHorizontal: 6 },
  typeOptionText: { fontSize: 14, color: "#333", textAlign: "center" },
  typeOptionTextSelected: { color: THEME_COLOR, fontWeight: "700" },
});
