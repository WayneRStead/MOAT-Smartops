// moat-smartops-mobile/inspections.jsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import SignatureScreen from "react-native-signature-canvas";
import { saveInspectionRun } from "../database";
import { syncOutbox } from "../syncOutbox";

const THEME_COLOR = "#22a6b3";
const CACHE_INSPECTION_FORMS_KEY = "@moat:cache:inspections";
const CACHE_PROJECTS_KEY = "@moat:cache:projects";
const CACHE_TASKS_KEY = "@moat:cache:tasks";
const CACHE_MILESTONES_KEY = "@moat:cache:milestones";
const CACHE_MILESTONES_BY_TASK_KEY = "@moat:cache:milestonesByTask";
const CACHE_ASSETS_KEY = "@moat:cache:assets";
const CACHE_VEHICLES_KEY = "@moat:cache:vehicles";
const CACHE_USERS_KEY = "@moat:cache:users";
const LAST_SCAN_KEY = "@moat:lastScan";
const TOKEN_KEY = "@moat:cache:token";

const ORG_ID_KEYS = [
  "@moat:orgId",
  "@moat:orgid",
  "@moat:cache:orgId",
  "@moat:cache:orgid",
  "moat:orgId",
  "moat:orgid",
];

const USER_ID_KEYS = ["@moat:userId", "@moat:userid", "moat:userid"];

function formatNow() {
  const d = new Date();
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
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

async function getFirstStorageValue(keys) {
  for (const key of keys) {
    try {
      const value = await AsyncStorage.getItem(key);
      if (value) return value;
    } catch {}
  }
  return "";
}

async function getCurrentUserMeta() {
  let token = "";
  try {
    token = (await AsyncStorage.getItem(TOKEN_KEY)) || "";
  } catch {}

  const payload = token ? decodeJwtPayload(token) : null;

  let userId = await getFirstStorageValue(USER_ID_KEYS);
  let orgId = await getFirstStorageValue(ORG_ID_KEYS);

  if (!userId && payload?.sub) userId = String(payload.sub);
  if (!orgId && payload?.orgId) orgId = String(payload.orgId);
  if (!orgId && payload?.org?._id) orgId = String(payload.org._id);

  return {
    token,
    payload,
    userId: String(userId || ""),
    orgId: String(orgId || ""),
    name: String(
      payload?.name ||
        payload?.user?.name ||
        payload?.email ||
        payload?.user?.email ||
        "",
    ),
  };
}

async function getCurrentCoords() {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      console.log("[INSPECTIONS] Location permission not granted");
      return null;
    }

    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    const lat = Number(pos?.coords?.latitude);
    const lng = Number(pos?.coords?.longitude);
    const accuracy = Number(pos?.coords?.accuracy);
    const altitude = Number(pos?.coords?.altitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      lat,
      lng,
      ...(Number.isFinite(accuracy) ? { accuracy } : {}),
      ...(Number.isFinite(altitude) ? { altitude } : {}),
      at: new Date().toISOString(),
    };
  } catch (e) {
    console.log("[INSPECTIONS] Location error", e);
    return null;
  }
}

function pickId(input) {
  return String(input?._id || input?.id || "").trim();
}

function pickProjectName(input) {
  return String(input?.name || input?.title || pickId(input) || "").trim();
}

function pickTaskName(input) {
  return String(input?.title || input?.name || pickId(input) || "").trim();
}

function pickMilestoneName(input) {
  return String(input?.name || input?.title || pickId(input) || "").trim();
}

function pickMilestoneId(input) {
  if (!input) return "";
  if (typeof input === "string") return String(input).trim();
  return String(
    input?._id || input?.id || input?.milestoneId || input?.code || "",
  ).trim();
}

function milestoneTaskId(input) {
  if (!input || typeof input === "string") return "";
  return String(
    input?.taskId?._id ||
      input?.taskId?.id ||
      input?.taskId ||
      input?.task ||
      "",
  ).trim();
}

function getMilestonesForTask(taskIdValue, store, flatMilestones) {
  if (!taskIdValue) return [];
  const tid = String(taskIdValue).trim();
  if (!tid) return [];

  if (Array.isArray(store)) {
    return store.filter((m) => milestoneTaskId(m) === tid);
  }

  if (store && typeof store === "object") {
    let list =
      store[tid] ||
      store?.byTask?.[tid] ||
      store?.milestonesByTask?.[tid] ||
      null;

    if (list && Array.isArray(list.items)) list = list.items;
    if (list && Array.isArray(list.data)) list = list.data;

    if (Array.isArray(list)) {
      return list.filter((m) => {
        const mTaskId = milestoneTaskId(m);
        return !mTaskId || mTaskId === tid;
      });
    }

    if (Array.isArray(store.items)) {
      return store.items.filter((m) => milestoneTaskId(m) === tid);
    }

    if (Array.isArray(store.data)) {
      return store.data.filter((m) => milestoneTaskId(m) === tid);
    }
  }

  const flat = Array.isArray(flatMilestones) ? flatMilestones : [];
  return flat.filter((m) => milestoneTaskId(m) === tid);
}

function getEmbeddedMilestonesFromTask(taskObj) {
  if (!taskObj || typeof taskObj !== "object") return [];

  if (Array.isArray(taskObj?.milestones)) return taskObj.milestones;
  if (Array.isArray(taskObj?.taskMilestones)) return taskObj.taskMilestones;

  return [];
}

async function ensureInspectionMilestonesLoadedForTask(
  taskObj,
  milestonesByTask,
  setMilestonesByTask,
) {
  const tid = pickId(taskObj);
  if (!tid) return;

  const existing = getMilestonesForTask(tid, milestonesByTask, []);
  if (Array.isArray(existing) && existing.length) return;

  const embedded = getEmbeddedMilestonesFromTask(taskObj);
  if (embedded.length) {
    const next =
      milestonesByTask &&
      typeof milestonesByTask === "object" &&
      !Array.isArray(milestonesByTask)
        ? { ...(milestonesByTask || {}), [tid]: embedded }
        : { [tid]: embedded };

    setMilestonesByTask(next);

    try {
      await AsyncStorage.setItem(
        CACHE_MILESTONES_BY_TASK_KEY,
        JSON.stringify(next),
      );
    } catch {}

    console.log(
      "[INSPECTIONS] loaded embedded milestones for task",
      tid,
      embedded.length,
    );
  }
}

function buildResultRulesText(scoring) {
  const mode = String(scoring?.mode || "any-fail").toLowerCase();

  if (mode === "percent") {
    const min = Number.isFinite(Number(scoring?.minPassPercent))
      ? Number(scoring.minPassPercent)
      : 100;
    return `Pass when score is ${min}% or above, unless a critical item fails.`;
  }

  if (mode === "tolerance") {
    const maxFails = Number.isFinite(Number(scoring?.maxNonCriticalFails))
      ? Number(scoring.maxNonCriticalFails)
      : 0;
    return `Pass when non-critical fails are ${maxFails} or fewer, unless a critical item fails.`;
  }

  return "Fail if any fail condition is triggered, especially critical items.";
}

function getScopeType(input) {
  const rawScope = String(input?.scope?.type || input?.scope || "global")
    .trim()
    .toLowerCase();

  if (
    rawScope === "scoped" ||
    rawScope === "project" ||
    rawScope === "task" ||
    rawScope === "milestone" ||
    rawScope === "project-scoped" ||
    rawScope === "task-scoped"
  ) {
    return "scoped";
  }

  return "global";
}

function getSubjectLabel(subject) {
  return String(
    subject?.lockLabel ||
      subject?.lockToLabel ||
      subject?.label ||
      subject?.name ||
      subject?.title ||
      subject?.subjectLabel ||
      subject?.type ||
      "",
  ).trim();
}

function getSubjectType(subject) {
  return String(
    subject?.type || subject?.subjectType || subject?.lockType || "none",
  )
    .trim()
    .toLowerCase();
}

function getRelatedProjectId(input) {
  return String(
    input?.projectId?._id ||
      input?.projectId ||
      input?.assignedProjectId?._id ||
      input?.assignedProjectId ||
      "",
  ).trim();
}

function getRelatedTaskId(input) {
  return String(
    input?.taskId?._id ||
      input?.taskId ||
      input?.assignedTaskId?._id ||
      input?.assignedTaskId ||
      "",
  ).trim();
}

function getAssetLabel(input) {
  return String(
    input?.name ||
      input?.assetName ||
      input?.code ||
      input?.tag ||
      pickId(input) ||
      "",
  ).trim();
}

function getVehicleLabel(input) {
  const reg = String(input?.reg || input?.regNumber || "").trim();
  const make = String(input?.make || "").trim();
  const model = String(input?.model || "").trim();
  return String(
    reg || [make, model].filter(Boolean).join(" ") || pickId(input) || "",
  ).trim();
}

function getUserLabel(input) {
  return String(
    input?.name || input?.fullName || input?.email || pickId(input) || "",
  ).trim();
}

function userMatchesProjectOrTask(user, projectId, taskId) {
  const projectIds = []
    .concat(user?.projectIds || [])
    .concat(user?.assignedProjectIds || [])
    .concat(user?.projects || [])
    .map((x) => String(x?._id || x?.id || x || "").trim())
    .filter(Boolean);

  const taskIds = []
    .concat(user?.taskIds || [])
    .concat(user?.assignedTaskIds || [])
    .concat(user?.tasks || [])
    .map((x) => String(x?._id || x?.id || x || "").trim())
    .filter(Boolean);

  if (taskId) return taskIds.includes(String(taskId).trim());
  if (projectId) return projectIds.includes(String(projectId).trim());
  return true;
}

function normalizeInspectionForm(input) {
  if (!input || typeof input !== "object") return null;

  const scopeType = getScopeType(input);

  const itemsRaw = Array.isArray(input?.items) ? input.items : [];
  const items = itemsRaw
    .map((item, index) => {
      const itemId = String(
        item?._id || item?.id || `item-${index + 1}`,
      ).trim();
      const title = String(
        item?.label || item?.title || item?.name || `Item ${index + 1}`,
      ).trim();

      if (!itemId || !title) return null;

      return {
        id: itemId,
        title,
        description: String(item?.description || "").trim(),
        allowPhoto: item?.allowPhoto !== false,
        allowScan: !!item?.allowScan,
        allowNote: item?.allowNote !== false,
        requireEvidenceOnFail: !!item?.requireEvidenceOnFail,
        requireCorrectiveOnFail: item?.requireCorrectiveOnFail !== false,
        criticalOnFail: !!item?.criticalOnFail,
      };
    })
    .filter(Boolean);

  return {
    id: String(input?._id || input?.id || "").trim(),
    scope: scopeType,
    name: String(input?.title || input?.name || "Inspection form").trim(),
    formType: String(input?.formType || "standard").trim(),
    description: String(input?.description || "").trim(),
    resultRules: buildResultRulesText(input?.scoring),
    scoring: input?.scoring || {
      mode: "any-fail",
      maxNonCriticalFails: 0,
      minPassPercent: 100,
    },
    subject: input?.subject || { type: "none" },
    scopeInfo: input?.scope || {},
    rolesAllowed: Array.isArray(input?.rolesAllowed) ? input.rolesAllowed : [],
    audience: input?.audience || {},
    items,
    raw: input,
  };
}

function computePercentScore(itemsState) {
  const items = Array.isArray(itemsState) ? itemsState : [];
  if (!items.length) return 0;

  const considered = items.filter((i) => i.status !== "na");
  if (!considered.length) return 100;

  const passCount = considered.filter((i) => i.status === "pass").length;
  return Math.round((passCount / considered.length) * 100);
}

function computeOverallResult(itemsState, form) {
  const items = Array.isArray(itemsState) ? itemsState : [];
  const scoring = form?.scoring || {};
  const mode = String(scoring?.mode || "any-fail").toLowerCase();

  const hasCriticalFail = items.some(
    (i) => i.status === "fail" && i.criticalOnFail === true,
  );
  if (hasCriticalFail) return "fail";

  const applicable = items.filter((i) => i.status !== "na");
  const nonCriticalFails = applicable.filter(
    (i) => i.status === "fail" && !i.criticalOnFail,
  ).length;
  const percentScore = computePercentScore(items);

  if (mode === "tolerance") {
    const maxFails = Number.isFinite(Number(scoring?.maxNonCriticalFails))
      ? Number(scoring.maxNonCriticalFails)
      : 0;
    return nonCriticalFails > maxFails ? "fail" : "pass";
  }

  if (mode === "percent") {
    const min = Number.isFinite(Number(scoring?.minPassPercent))
      ? Number(scoring.minPassPercent)
      : 100;
    return percentScore >= min ? "pass" : "fail";
  }

  return nonCriticalFails > 0 ? "fail" : "pass";
}

async function saveSignatureDataUrlToFile(dataUrl) {
  const value = String(dataUrl || "").trim();
  if (!value.startsWith("data:image")) return "";

  const commaIndex = value.indexOf(",");
  if (commaIndex < 0) return "";

  const metaPart = value.slice(0, commaIndex);
  const base64Part = value.slice(commaIndex + 1);

  const ext = metaPart.includes("image/jpeg")
    ? "jpg"
    : metaPart.includes("image/svg")
      ? "svg"
      : "png";

  const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!dir) return "";

  const fileUri = `${dir}inspection-signature-${Date.now()}.${ext}`;

  await FileSystem.writeAsStringAsync(fileUri, base64Part, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return fileUri;
}

function SelectField({ label, valueText, onPress, disabled = false }) {
  return (
    <TouchableOpacity
      style={[styles.selectField, disabled && styles.disabledField]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.selectFieldLabel}>{label}</Text>
      <Text style={styles.selectFieldValue} numberOfLines={1}>
        {valueText || "Tap to select"}
      </Text>
    </TouchableOpacity>
  );
}

function PickerModal({ visible, title, items, onSelect, onClose }) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{title}</Text>

          <FlatList
            data={items}
            keyExtractor={(item, index) =>
              String(item?.id || item?.label || index)
            }
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.modalRow}
                onPress={() => {
                  onSelect?.(item);
                  onClose?.();
                }}
              >
                <Text style={styles.modalRowText}>{item?.label || ""}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <Text style={styles.emptyText}>Nothing available.</Text>
            }
          />

          <TouchableOpacity style={styles.modalCloseBtn} onPress={onClose}>
            <Text style={styles.modalCloseBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

export default function InspectionsScreen() {
  const router = useRouter();
  const signatureRef = useRef(null);
  const latestSignatureDataUrlRef = useRef("");
  const latestSignatureFileUriRef = useRef("");
  const signatureCaptureResolverRef = useRef(null);

  const [mode, setMode] = useState("select");
  const [scope, setScope] = useState("global");

  const [userMeta, setUserMeta] = useState({
    userId: "",
    orgId: "",
    name: "",
  });

  const [forms, setForms] = useState([]);
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [milestones, setMilestones] = useState([]);
  const [milestonesByTask, setMilestonesByTask] = useState({});
  const [assets, setAssets] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [users, setUsers] = useState([]);

  const [currentForm, setCurrentForm] = useState(null);
  const [itemsState, setItemsState] = useState([]);
  const [expandedItemId, setExpandedItemId] = useState(null);

  const [locationCoords, setLocationCoords] = useState(null);
  const [locationText, setLocationText] = useState("");

  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [selectedMilestoneId, setSelectedMilestoneId] = useState("");

  const [headerSubject, setHeaderSubject] = useState("");
  const [selectedSubjectId, setSelectedSubjectId] = useState("");
  const [selectedSubjectLabel, setSelectedSubjectLabel] = useState("");

  const [inspectorName, setInspectorName] = useState("");
  const [overallNote, setOverallNote] = useState("");
  const [runDateTime, setRunDateTime] = useState(formatNow());
  const [followUpDate, setFollowUpDate] = useState("");
  const [showFollowUpPicker, setShowFollowUpPicker] = useState(false);
  const [confirmAccurate, setConfirmAccurate] = useState(false);
  const [signatureDataUrl, setSignatureDataUrl] = useState("");
  const [signatureFileUri, setSignatureFileUri] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerTitle, setPickerTitle] = useState("");
  const [pickerItems, setPickerItems] = useState([]);
  const [pickerOnSelect, setPickerOnSelect] = useState(null);

  const [pendingScanItemId, setPendingScanItemId] = useState("");

  const [pageScrollEnabled, setPageScrollEnabled] = useState(true);

  useEffect(() => {
    latestSignatureDataUrlRef.current = String(signatureDataUrl || "").trim();
  }, [signatureDataUrl]);

  useEffect(() => {
    latestSignatureFileUriRef.current = String(signatureFileUri || "").trim();
  }, [signatureFileUri]);

  const closePicker = () => {
    setPickerVisible(false);
    setPickerTitle("");
    setPickerItems([]);
    setPickerOnSelect(null);
  };

  const openPicker = (title, items, onSelect) => {
    setPickerTitle(title);
    setPickerItems(Array.isArray(items) ? items : []);
    setPickerOnSelect(() => onSelect);
    setPickerVisible(true);
  };

  useFocusEffect(
    useCallback(() => {
      let alive = true;

      (async () => {
        const [
          meta,
          cachedForms,
          cachedProjects,
          cachedTasks,
          cachedMilestones,
          cachedMilestonesByTask,
          cachedAssets,
          cachedVehicles,
          cachedUsers,
        ] = await Promise.all([
          getCurrentUserMeta(),
          loadCache(CACHE_INSPECTION_FORMS_KEY, []),
          loadCache(CACHE_PROJECTS_KEY, []),
          loadCache(CACHE_TASKS_KEY, []),
          loadCache(CACHE_MILESTONES_KEY, []),
          loadCache(CACHE_MILESTONES_BY_TASK_KEY, {}),
          loadCache(CACHE_ASSETS_KEY, []),
          loadCache(CACHE_VEHICLES_KEY, []),
          loadCache(CACHE_USERS_KEY, []),
        ]);

        if (!alive) return;

        const normalizedForms = (Array.isArray(cachedForms) ? cachedForms : [])
          .map(normalizeInspectionForm)
          .filter(
            (f) => f && f.id && Array.isArray(f.items) && f.items.length > 0,
          );

        setUserMeta(meta);
        setForms(normalizedForms);
        setProjects(Array.isArray(cachedProjects) ? cachedProjects : []);
        setTasks(Array.isArray(cachedTasks) ? cachedTasks : []);
        setMilestones(Array.isArray(cachedMilestones) ? cachedMilestones : []);
        setMilestonesByTask(
          cachedMilestonesByTask &&
            typeof cachedMilestonesByTask === "object" &&
            !Array.isArray(cachedMilestonesByTask)
            ? cachedMilestonesByTask
            : {},
        );
        setAssets(Array.isArray(cachedAssets) ? cachedAssets : []);
        setVehicles(Array.isArray(cachedVehicles) ? cachedVehicles : []);
        setUsers(Array.isArray(cachedUsers) ? cachedUsers : []);

        try {
          const rawLastScan = await AsyncStorage.getItem(LAST_SCAN_KEY);
          if (!alive || !rawLastScan || !pendingScanItemId) return;

          const lastScan = JSON.parse(rawLastScan || "{}");
          const scannedValue = String(lastScan?.value || "").trim();

          if (scannedValue) {
            setItemsState((prev) =>
              prev.map((item) =>
                item.id === pendingScanItemId
                  ? {
                      ...item,
                      scanDone: true,
                      scanValue: scannedValue,
                      note:
                        item.note && item.note.trim().length > 0
                          ? item.note
                          : `Scan: ${scannedValue}`,
                    }
                  : item,
              ),
            );
          }

          await AsyncStorage.removeItem(LAST_SCAN_KEY);
          setPendingScanItemId("");
        } catch {}
      })();

      return () => {
        alive = false;
      };
    }, [pendingScanItemId]),
  );

  const formsForScope = useMemo(() => {
    const scopedForms = forms.filter((f) => f.scope === scope);

    if (scope !== "scoped") return scopedForms;

    return scopedForms.filter((form) => {
      const scopeInfo = form?.scopeInfo || {};

      const formProjectId = String(scopeInfo?.projectId || "").trim();
      const formTaskId = String(scopeInfo?.taskId || "").trim();
      const formMilestoneId = String(scopeInfo?.milestoneId || "").trim();

      const myUserId = String(userMeta?.userId || "").trim();

      const audience = form?.audience || {};
      const audienceUserIds = Array.isArray(audience?.userIds)
        ? audience.userIds.map((x) => String(x || "").trim())
        : [];
      const audienceProjectIds = Array.isArray(audience?.projectIds)
        ? audience.projectIds.map((x) => String(x || "").trim())
        : [];
      const audienceTaskIds = Array.isArray(audience?.taskIds)
        ? audience.taskIds.map((x) => String(x || "").trim())
        : [];

      const myProjectIds = (Array.isArray(projects) ? projects : [])
        .map((p) => pickId(p))
        .filter(Boolean);

      const myTaskIds = (Array.isArray(tasks) ? tasks : [])
        .map((t) => pickId(t))
        .filter(Boolean);

      if (audienceUserIds.length && audienceUserIds.includes(myUserId)) {
        return true;
      }

      if (
        audienceProjectIds.length &&
        audienceProjectIds.some((id) => myProjectIds.includes(id))
      ) {
        return true;
      }

      if (
        audienceTaskIds.length &&
        audienceTaskIds.some((id) => myTaskIds.includes(id))
      ) {
        return true;
      }

      if (formTaskId) {
        return myTaskIds.includes(formTaskId);
      }

      if (formProjectId) {
        return myProjectIds.includes(formProjectId);
      }

      if (formMilestoneId) {
        return true;
      }

      if (
        !audienceUserIds.length &&
        !audienceProjectIds.length &&
        !audienceTaskIds.length &&
        !formProjectId &&
        !formTaskId &&
        !formMilestoneId
      ) {
        return true;
      }

      return false;
    });
  }, [forms, scope, userMeta, projects, tasks]);

  const currentAchievedScore = useMemo(() => {
    return computePercentScore(itemsState);
  }, [itemsState]);

  const overallResult = useMemo(() => {
    return computeOverallResult(itemsState, currentForm);
  }, [itemsState, currentForm]);

  const scopedProjectId = String(
    currentForm?.scopeInfo?.projectId || "",
  ).trim();
  const scopedTaskId = String(currentForm?.scopeInfo?.taskId || "").trim();
  const scopedMilestoneId = String(
    currentForm?.scopeInfo?.milestoneId || "",
  ).trim();

  const effectiveProjectId = scopedProjectId || selectedProjectId;
  const effectiveTaskId = scopedTaskId || selectedTaskId;
  const effectiveMilestoneId = scopedMilestoneId || selectedMilestoneId;

  const availableTasks = useMemo(() => {
    const all = Array.isArray(tasks) ? tasks : [];
    if (!effectiveProjectId) return all;

    return all.filter((t) => {
      const tProjectId = String(t?.projectId?._id || t?.projectId || "").trim();
      return tProjectId === effectiveProjectId;
    });
  }, [tasks, effectiveProjectId]);

  const availableMilestones = useMemo(() => {
    const allMilestones = Array.isArray(milestones) ? milestones : [];

    if (effectiveTaskId) {
      return getMilestonesForTask(
        effectiveTaskId,
        milestonesByTask,
        allMilestones,
      );
    }

    if (effectiveProjectId) {
      const projectTaskIds = (Array.isArray(tasks) ? tasks : [])
        .filter((t) => {
          const tProjectId = String(
            t?.projectId?._id || t?.projectId || "",
          ).trim();
          return tProjectId === effectiveProjectId;
        })
        .map((t) => pickId(t))
        .filter(Boolean);

      const combined = projectTaskIds.flatMap((tid) =>
        getMilestonesForTask(tid, milestonesByTask, allMilestones),
      );

      const seen = new Set();
      return combined.filter((m) => {
        const id = pickMilestoneId(m);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }

    return [];
  }, [
    milestones,
    milestonesByTask,
    effectiveTaskId,
    effectiveProjectId,
    tasks,
  ]);

  const projectDisplay = useMemo(() => {
    const id = effectiveProjectId;
    if (!id) return "";
    const found = projects.find((p) => pickId(p) === id);
    return found
      ? pickProjectName(found)
      : String(currentForm?.scopeInfo?.projectName || "").trim();
  }, [projects, effectiveProjectId, currentForm]);

  const taskDisplay = useMemo(() => {
    const id = effectiveTaskId;
    if (!id) return "";
    const found = tasks.find((t) => pickId(t) === id);
    return found
      ? pickTaskName(found)
      : String(currentForm?.scopeInfo?.taskName || "").trim();
  }, [tasks, effectiveTaskId, currentForm]);

  const milestoneDisplay = useMemo(() => {
    const id = effectiveMilestoneId;
    if (!id) return "";
    const found = availableMilestones.find((m) => pickMilestoneId(m) === id);
    return found
      ? pickMilestoneName(found)
      : String(currentForm?.scopeInfo?.milestoneName || "").trim();
  }, [availableMilestones, effectiveMilestoneId, currentForm]);

  const subjectType = useMemo(() => {
    return getSubjectType(currentForm?.subject);
  }, [currentForm]);

  const availableSubjectOptions = useMemo(() => {
    if (!currentForm) return [];

    if (subjectType === "asset") {
      return (Array.isArray(assets) ? assets : [])
        .filter((a) => {
          const projectId = getRelatedProjectId(a);
          const taskId = getRelatedTaskId(a);

          if (effectiveTaskId) return taskId === effectiveTaskId;
          if (effectiveProjectId) return projectId === effectiveProjectId;
          return true;
        })
        .map((a) => ({
          id: pickId(a),
          label: getAssetLabel(a),
          raw: a,
        }))
        .filter((x) => x.id && x.label);
    }

    if (subjectType === "vehicle") {
      return (Array.isArray(vehicles) ? vehicles : [])
        .filter((v) => {
          const projectId = getRelatedProjectId(v);
          const taskId = getRelatedTaskId(v);

          if (effectiveTaskId) return taskId === effectiveTaskId;
          if (effectiveProjectId) return projectId === effectiveProjectId;
          return true;
        })
        .map((v) => ({
          id: pickId(v),
          label: getVehicleLabel(v),
          raw: v,
        }))
        .filter((x) => x.id && x.label);
    }

    if (
      subjectType === "performance" ||
      subjectType === "person" ||
      subjectType === "user" ||
      subjectType === "employee" ||
      subjectType === "staff"
    ) {
      return (Array.isArray(users) ? users : [])
        .filter((u) =>
          userMatchesProjectOrTask(u, effectiveProjectId, effectiveTaskId),
        )
        .map((u) => ({
          id: pickId(u),
          label: getUserLabel(u),
          raw: u,
        }))
        .filter((x) => x.id && x.label);
    }

    return [];
  }, [
    currentForm,
    subjectType,
    assets,
    vehicles,
    users,
    effectiveProjectId,
    effectiveTaskId,
  ]);

  const subjectDisplay = useMemo(() => {
    return headerSubject || "No specific subject";
  }, [headerSubject]);

  const subjectIsLocked = useMemo(() => {
    const subject = currentForm?.subject || {};
    return !!String(
      subject?.lockToId || subject?.lockLabel || subject?.lockToLabel || "",
    ).trim();
  }, [currentForm]);

  const selectedSubjectValueDisplay = useMemo(() => {
    return selectedSubjectLabel || "Tap to select";
  }, [selectedSubjectLabel]);

  const subjectSelectionLabel = useMemo(() => {
    if (subjectType === "vehicle") return "Vehicle";
    if (subjectType === "asset") return "Asset";
    if (
      subjectType === "performance" ||
      subjectType === "person" ||
      subjectType === "user" ||
      subjectType === "employee" ||
      subjectType === "staff"
    ) {
      return "Person";
    }
    return "Selection";
  }, [subjectType]);

  const formatDateOnly = (date) => {
    const d = date instanceof Date ? date : new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const handleFollowUpDateChange = (_event, selectedDate) => {
    setShowFollowUpPicker(false);
    if (!selectedDate) return;
    setFollowUpDate(formatDateOnly(selectedDate));
  };

  const refreshLocation = async () => {
    const coords = await getCurrentCoords();
    setLocationCoords(coords);

    if (coords?.lat != null && coords?.lng != null) {
      setLocationText(
        `${Number(coords.lat).toFixed(6)}, ${Number(coords.lng).toFixed(6)}`,
      );
    } else {
      setLocationText("Location not available");
    }
  };

  const takePhotoForItem = async (itemId) => {
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

    if (!uri) return;

    setItemsState((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, photoUri: uri } : item,
      ),
    );
  };

  const markScanDoneForItem = async (itemId) => {
    setPendingScanItemId(String(itemId || "").trim());

    try {
      await AsyncStorage.removeItem(LAST_SCAN_KEY);
    } catch {}

    router.push({
      pathname: "/scan",
      params: {
        field: "inspectionItemScan",
        label: "Scan inspection item",
      },
    });
  };

  const setStatusForItem = (itemId, status) => {
    setItemsState((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, status } : item)),
    );
  };

  const setNoteForItem = (itemId, note) => {
    setItemsState((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, note } : item)),
    );
  };

  const canLeaveCurrentItem = () => {
    if (!expandedItemId || !currentForm) return true;

    const current = itemsState.find((i) => i.id === expandedItemId);
    if (!current) return true;

    if (
      current.status === "fail" &&
      current.requireCorrectiveOnFail &&
      (!current.note || current.note.trim().length === 0)
    ) {
      Alert.alert(
        "Corrective action required",
        "Please enter corrective action before moving on from this failed item.",
      );
      return false;
    }

    if (
      current.status === "fail" &&
      current.requireEvidenceOnFail &&
      !current.photoUri &&
      !current.scanDone &&
      (!current.note || current.note.trim().length === 0)
    ) {
      Alert.alert(
        "Evidence required",
        "This failed item needs evidence before you continue.",
      );
      return false;
    }

    return true;
  };

  const toggleExpandItem = (itemId) => {
    if (expandedItemId === itemId) {
      setExpandedItemId(null);
      return;
    }

    if (!canLeaveCurrentItem()) return;
    setExpandedItemId(itemId);
  };

  const resetRunState = () => {
    setMode("select");
    setCurrentForm(null);
    setItemsState([]);
    setExpandedItemId(null);
    setLocationCoords(null);
    setLocationText("");
    setSelectedProjectId("");
    setSelectedTaskId("");
    setSelectedMilestoneId("");
    setHeaderSubject("");
    setSelectedSubjectId("");
    setSelectedSubjectLabel("");
    setInspectorName("");
    setOverallNote("");
    setRunDateTime(formatNow());
    setFollowUpDate("");
    setShowFollowUpPicker(false);
    setConfirmAccurate(false);
    latestSignatureDataUrlRef.current = "";
    latestSignatureFileUriRef.current = "";
    if (signatureCaptureResolverRef.current) {
      signatureCaptureResolverRef.current = null;
    }
    setSignatureDataUrl("");
    setSignatureFileUri("");
    setIsSubmitting(false);
    setPageScrollEnabled(true);
    setPendingScanItemId("");
    closePicker();
  };

  const startFormRun = async (form) => {
    const initialState = (Array.isArray(form?.items) ? form.items : []).map(
      (item) => ({
        id: item.id,
        itemId: item.id,
        label: item.title,
        description: item.description || "",
        status: "pending",
        note: "",
        photoUri: null,
        scanDone: false,
        allowPhoto: !!item.allowPhoto,
        allowScan: !!item.allowScan,
        allowNote: item.allowNote !== false,
        requireEvidenceOnFail: !!item.requireEvidenceOnFail,
        requireCorrectiveOnFail: item.requireCorrectiveOnFail !== false,
        criticalOnFail: !!item.criticalOnFail,
      }),
    );

    setCurrentForm(form);
    setItemsState(initialState);
    setExpandedItemId(initialState[0]?.id || null);

    setSelectedProjectId("");
    setSelectedTaskId("");
    setSelectedMilestoneId("");

    setHeaderSubject(getSubjectLabel(form?.subject));
    setSelectedSubjectId(String(form?.subject?.lockToId || "").trim());
    setSelectedSubjectLabel(
      String(
        form?.subject?.lockLabel || form?.subject?.lockToLabel || "",
      ).trim(),
    );
    setInspectorName(userMeta?.name || "");
    setOverallNote("");
    setRunDateTime(formatNow());
    setFollowUpDate("");
    setConfirmAccurate(false);
    latestSignatureDataUrlRef.current = "";
    latestSignatureFileUriRef.current = "";
    if (signatureCaptureResolverRef.current) {
      signatureCaptureResolverRef.current = null;
    }
    setSignatureDataUrl("");
    setSignatureFileUri("");
    setMode("run");

    await refreshLocation();
  };

  const showProjectPicker = () => {
    const options = (Array.isArray(projects) ? projects : []).map((p) => ({
      id: pickId(p),
      label: pickProjectName(p),
      raw: p,
    }));

    if (!options.length) {
      Alert.alert("No projects", "No projects are cached on this device.");
      return;
    }

    openPicker("Select project", options, (item) => {
      const projectId = item.id;
      setSelectedProjectId(projectId);
      setSelectedTaskId("");
      setSelectedMilestoneId("");
      setSelectedSubjectId(String(currentForm?.subject?.lockToId || "").trim());
      setSelectedSubjectLabel(
        subjectIsLocked
          ? String(
              currentForm?.subject?.lockLabel ||
                currentForm?.subject?.lockToLabel ||
                "",
            ).trim()
          : "",
      );
    });
  };

  const showTaskPicker = () => {
    const options = availableTasks.map((t) => ({
      id: pickId(t),
      label: pickTaskName(t),
      raw: t,
    }));

    if (!options.length) {
      Alert.alert(
        "No tasks",
        "No tasks are available for the selected project.",
      );
      return;
    }

    openPicker("Select task", options, async (item) => {
      setSelectedTaskId(item.id);
      setSelectedMilestoneId("");
      setSelectedSubjectId(String(currentForm?.subject?.lockToId || "").trim());
      setSelectedSubjectLabel(
        subjectIsLocked
          ? String(
              currentForm?.subject?.lockLabel ||
                currentForm?.subject?.lockToLabel ||
                "",
            ).trim()
          : "",
      );

      await ensureInspectionMilestonesLoadedForTask(
        item.raw,
        milestonesByTask,
        setMilestonesByTask,
      );
    });
  };

  const showMilestonePicker = () => {
    const options = availableMilestones.map((m) => ({
      id: pickMilestoneId(m),
      label: pickMilestoneName(m),
      raw: m,
    }));

    if (!options.length) {
      Alert.alert(
        "No deliverables",
        effectiveTaskId
          ? "No deliverables are available for the selected task."
          : effectiveProjectId
            ? "No deliverables are available for the selected project."
            : "Select a project or task first.",
      );
      return;
    }

    openPicker("Select deliverable", options, (item) => {
      setSelectedMilestoneId(item.id);
    });
  };

  const showSubjectPicker = () => {
    if (!availableSubjectOptions.length) {
      Alert.alert(
        "No subjects",
        "No matching subjects are available for the current project/task selection.",
      );
      return;
    }

    openPicker("Select subject", availableSubjectOptions, (item) => {
      setSelectedSubjectId(item.id);
      setSelectedSubjectLabel(item.label);
    });
  };

  const handleSignatureOK = async (sig) => {
    const value = String(sig || "").trim();

    latestSignatureDataUrlRef.current = value;
    setSignatureDataUrl(value);

    let uri = "";
    try {
      uri = value ? await saveSignatureDataUrlToFile(value) : "";
    } catch (e) {
      console.log("[INSPECTIONS] failed to save signature file", e);
      uri = "";
    }

    latestSignatureFileUriRef.current = uri || "";
    setSignatureFileUri(uri || "");
    setPageScrollEnabled(true);

    if (signatureCaptureResolverRef.current) {
      signatureCaptureResolverRef.current({
        dataUrl: value,
        fileUri: uri || "",
      });
      signatureCaptureResolverRef.current = null;
    }
  };

  const clearSignature = () => {
    latestSignatureDataUrlRef.current = "";
    latestSignatureFileUriRef.current = "";
    if (signatureCaptureResolverRef.current) {
      signatureCaptureResolverRef.current = null;
    }
    setSignatureDataUrl("");
    setSignatureFileUri("");
    signatureRef.current?.clearSignature?.();
  };

  const captureSignatureNow = async () => {
    const existingDataUrl = String(
      latestSignatureDataUrlRef.current || signatureDataUrl || "",
    ).trim();
    const existingFileUri = String(
      latestSignatureFileUriRef.current || signatureFileUri || "",
    ).trim();

    if (existingDataUrl && existingFileUri) {
      return {
        dataUrl: existingDataUrl,
        fileUri: existingFileUri,
      };
    }

    return await new Promise((resolve) => {
      let settled = false;

      signatureCaptureResolverRef.current = (result) => {
        if (settled) return;
        settled = true;
        resolve({
          dataUrl: String(result?.dataUrl || "").trim(),
          fileUri: String(result?.fileUri || "").trim(),
        });
      };

      try {
        signatureRef.current?.readSignature?.();
      } catch (e) {
        console.log("[INSPECTIONS] readSignature failed", e);
      }

      setTimeout(() => {
        if (settled) return;
        settled = true;
        if (signatureCaptureResolverRef.current) {
          signatureCaptureResolverRef.current = null;
        }
        resolve({
          dataUrl: String(
            latestSignatureDataUrlRef.current || signatureDataUrl || "",
          ).trim(),
          fileUri: String(
            latestSignatureFileUriRef.current || signatureFileUri || "",
          ).trim(),
        });
      }, 1500);
    });
  };

  const handleSaveSignaturePress = async () => {
    try {
      const captured = await captureSignatureNow();

      const dataUrl = String(captured?.dataUrl || "").trim();
      const fileUri = String(captured?.fileUri || "").trim();

      if (!dataUrl) {
        Alert.alert(
          "No signature detected",
          "Please sign inside the signature box first.",
        );
        return;
      }

      latestSignatureDataUrlRef.current = dataUrl;
      latestSignatureFileUriRef.current = fileUri;
      setSignatureDataUrl(dataUrl);
      setSignatureFileUri(fileUri);

      Alert.alert("Signature saved", "Your signature has been captured.");
    } catch (e) {
      console.log("[INSPECTIONS] handleSaveSignaturePress failed", e);
      Alert.alert("Signature error", "Could not capture the signature.");
    }
  };

  const handleSubmitInspection = async () => {
    if (!currentForm || isSubmitting) return;

    const pendingItems = itemsState.filter((i) => i.status === "pending");
    if (pendingItems.length > 0) {
      Alert.alert(
        "Incomplete inspection",
        "Please complete all items before submitting.",
      );
      return;
    }

    if (!inspectorName.trim()) {
      Alert.alert(
        "Missing signature name",
        "Please enter your name before submitting.",
      );
      return;
    }

    if (
      (subjectType === "asset" ||
        subjectType === "vehicle" ||
        subjectType === "performance" ||
        subjectType === "person" ||
        subjectType === "user" ||
        subjectType === "employee" ||
        subjectType === "staff") &&
      !selectedSubjectId
    ) {
      Alert.alert(
        "Subject required",
        "Please select the relevant subject before submitting.",
      );
      return;
    }

    if (!confirmAccurate) {
      Alert.alert(
        "Confirmation required",
        "Please confirm the inspection is accurate to the best of your knowledge.",
      );
      return;
    }

    let finalSignature = String(
      latestSignatureDataUrlRef.current || signatureDataUrl || "",
    ).trim();

    let finalSignatureFileUri = String(
      latestSignatureFileUriRef.current || signatureFileUri || "",
    ).trim();

    if (!finalSignature || !finalSignatureFileUri) {
      try {
        const captured = await captureSignatureNow();
        finalSignature = String(
          captured?.dataUrl || latestSignatureDataUrlRef.current || "",
        ).trim();
        finalSignatureFileUri = String(
          captured?.fileUri || latestSignatureFileUriRef.current || "",
        ).trim();
      } catch (e) {
        console.log("[INSPECTIONS] captureSignatureNow failed", e);
      }
    }

    if (!finalSignature) {
      Alert.alert(
        "Signature required",
        "Please sign in the signature box before submitting.",
      );
      return;
    }

    if (!finalSignatureFileUri && finalSignature) {
      try {
        finalSignatureFileUri =
          await saveSignatureDataUrlToFile(finalSignature);
      } catch (e) {
        console.log(
          "[INSPECTIONS] failed to build signature file during submit",
          e,
        );
        finalSignatureFileUri = "";
      }
    }

    latestSignatureDataUrlRef.current = finalSignature;
    latestSignatureFileUriRef.current = finalSignatureFileUri || "";
    setSignatureDataUrl(finalSignature);
    setSignatureFileUri(finalSignatureFileUri || "");

    const invalidFails = itemsState.filter(
      (i) =>
        i.status === "fail" &&
        i.requireCorrectiveOnFail &&
        (!i.note || i.note.trim().length === 0),
    );

    if (invalidFails.length > 0) {
      Alert.alert(
        "Corrective action required",
        "Some failed items still need corrective action before submitting.",
      );
      return;
    }

    if (overallResult === "fail" && !String(followUpDate || "").trim()) {
      Alert.alert(
        "Follow-up required",
        "Please enter a follow-up date for a failed inspection.",
      );
      return;
    }

    setIsSubmitting(true);

    try {
      const freshCoords = await getCurrentCoords();
      const coords = freshCoords || locationCoords;
      const submittedAt = new Date().toISOString();
      const achievedScore = computePercentScore(itemsState);

      const payload = {
        orgId: userMeta?.orgId || null,
        userId: userMeta?.userId || null,
        formId: currentForm.id,
        formName: currentForm.name,
        formType: currentForm.formType || "standard",
        scope: currentForm.scope,
        runDateTime,
        submittedAt,
        inspectorName: String(inspectorName || "").trim(),
        overallNote: String(overallNote || "").trim(),
        followUpDate:
          overallResult === "fail" && followUpDate ? followUpDate : null,
        header: {
          location: locationText || "",
          project: projectDisplay || "",
          task: taskDisplay || "",
          milestone: milestoneDisplay || "",
          subject: selectedSubjectLabel || headerSubject || "",
          description: currentForm.description || "",
          resultRules: currentForm.resultRules || "",
          achievedScore,
          overallResult,
        },
        links: {
          projectId: effectiveProjectId || "",
          taskId: effectiveTaskId || "",
          milestoneId: effectiveMilestoneId || "",
        },
        subjectAtRun: {
          type: String(currentForm?.subject?.type || "none").toLowerCase(),
          id: selectedSubjectId || currentForm?.subject?.lockToId || undefined,
          label: String(
            selectedSubjectLabel ||
              headerSubject ||
              currentForm?.subject?.lockLabel ||
              currentForm?.subject?.lockToLabel ||
              "",
          ).trim(),
        },
        signoff: {
          confirmed: true,
          name: String(inspectorName || "").trim(),
          date: submittedAt,
          signatureDataUrl: finalSignature || "",
          signatureFileUri: finalSignatureFileUri || "",
        },
        signatureUploadIndex: finalSignatureFileUri ? 0 : -1,
        location: coords || undefined,
        coords: coords || undefined,
        items: itemsState.map((item) => ({
          itemId: item.itemId,
          label: item.label,
          result: item.status === "pending" ? "na" : item.status,
          correctiveAction:
            item.status === "fail" ? String(item.note || "").trim() : "",
          criticalTriggered: item.status === "fail" && !!item.criticalOnFail,
          evidence: {
            photoUrl: item.photoUri || "",
            scanRef:
              item.scanValue || (item.scanDone ? "mobile-scan-complete" : ""),
            note: String(item.note || "").trim(),
          },
        })),
        createdAt: submittedAt,
        updatedAt: submittedAt,
      };

      const payloadForLocalSave = {
        ...payload,
      };

      const localId = await saveInspectionRun({
        orgId: userMeta?.orgId || null,
        userId: userMeta?.userId || null,
        formId: currentForm.id,
        payload: payloadForLocalSave,
      });

      console.log("[INSPECTIONS] Inspection saved locally with id:", localId);

      try {
        await syncOutbox({ limit: 10 });
      } catch (e) {
        console.log("[INSPECTIONS] immediate sync failed", e);
      }

      Alert.alert(
        "Inspection saved",
        "Inspection captured on this device and queued for sync.",
      );

      resetRunState();
    } catch (e) {
      console.error("[INSPECTIONS] Failed to save inspection", e);
      Alert.alert("Save failed", "Could not save inspection on this device.");
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <PickerModal
        visible={pickerVisible}
        title={pickerTitle}
        items={pickerItems}
        onSelect={pickerOnSelect}
        onClose={closePicker}
      />

      {mode === "select" && (
        <ScrollView
          contentContainerStyle={styles.container}
          scrollEnabled={pageScrollEnabled}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.topBar}>
            <Image
              source={require("../assets/inspections-screen.png")}
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
            <Text style={styles.cardTitle}>MOAT Inspections</Text>
            <Text style={styles.cardSubtitle}>
              Select an inspection form available to you and complete it on this
              device.
            </Text>

            <View style={styles.scopeRow}>
              <TouchableOpacity
                style={[
                  styles.scopeButton,
                  scope === "global" && styles.scopeButtonSelected,
                ]}
                onPress={() => setScope("global")}
              >
                <Image
                  source={require("../assets/insp-select.png")}
                  style={styles.scopeIcon}
                />
                <Text
                  style={[
                    styles.scopeText,
                    scope === "global" && styles.scopeTextSelected,
                  ]}
                >
                  Global
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.scopeButton,
                  scope === "scoped" && styles.scopeButtonSelected,
                ]}
                onPress={() => setScope("scoped")}
              >
                <Image
                  source={require("../assets/inspections.png")}
                  style={styles.scopeIcon}
                />
                <Text
                  style={[
                    styles.scopeText,
                    scope === "scoped" && styles.scopeTextSelected,
                  ]}
                >
                  Scoped
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {scope === "global"
                ? "Global inspection forms"
                : "Scoped inspection forms"}
            </Text>

            {formsForScope.length === 0 ? (
              <Text style={styles.emptyText}>
                No forms available for this scope on your device yet.
              </Text>
            ) : (
              formsForScope.map((form) => (
                <TouchableOpacity
                  key={form.id}
                  style={styles.formRow}
                  onPress={() => startFormRun(form)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.formName}>{form.name}</Text>
                    <Text style={styles.formDescription}>
                      {form.description || "Inspection form"}
                    </Text>
                  </View>
                  <Image
                    source={require("../assets/trip.png")}
                    style={styles.formIcon}
                  />
                </TouchableOpacity>
              ))
            )}
          </View>
        </ScrollView>
      )}

      {mode === "run" && currentForm && (
        <ScrollView
          contentContainerStyle={styles.container}
          scrollEnabled={pageScrollEnabled}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.topBar}>
            <Image
              source={require("../assets/inspections-screen.png")}
              style={styles.topBarLogo}
              resizeMode="contain"
            />
            <TouchableOpacity
              style={styles.homeButton}
              onPress={() => {
                if (
                  itemsState.some((i) => i.status !== "pending") ||
                  inspectorName ||
                  overallNote ||
                  signatureDataUrl
                ) {
                  Alert.alert(
                    "Leave inspection?",
                    "You have started filling this inspection. Leaving now will lose unsaved progress.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Leave",
                        style: "destructive",
                        onPress: resetRunState,
                      },
                    ],
                  );
                } else {
                  resetRunState();
                }
              }}
            >
              <Image
                source={require("../assets/home.png")}
                style={styles.homeIcon}
              />
            </TouchableOpacity>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>{currentForm.name}</Text>
            <Text style={styles.cardSubtitle}>
              Form type: {currentForm.formType || "—"}
              {"\n"}
              Scope: {scope === "global" ? "Global" : "Scoped"} | Items:{" "}
              {currentForm.items.length}
              {"\n"}
              Achieved score: {currentAchievedScore}% | Overall:{" "}
              {overallResult.toUpperCase()}
            </Text>

            <SelectField
              label="Current location"
              valueText={locationText || "Tap to capture current location"}
              onPress={refreshLocation}
              disabled={isSubmitting}
            />

            <SelectField
              label="Project"
              valueText={projectDisplay}
              onPress={showProjectPicker}
              disabled={!!scopedProjectId || isSubmitting}
            />

            <SelectField
              label="Task"
              valueText={taskDisplay}
              onPress={showTaskPicker}
              disabled={!!scopedTaskId || isSubmitting}
            />

            <SelectField
              label="Deliverable"
              valueText={milestoneDisplay}
              onPress={showMilestonePicker}
              disabled={!!scopedMilestoneId || isSubmitting}
            />

            <View style={styles.readonlyField}>
              <Text style={styles.selectFieldLabel}>Subject</Text>
              <Text style={styles.selectFieldValue}>{subjectDisplay}</Text>
            </View>

            {subjectType === "asset" ||
            subjectType === "vehicle" ||
            subjectType === "performance" ||
            subjectType === "person" ||
            subjectType === "user" ||
            subjectType === "employee" ||
            subjectType === "staff" ? (
              <SelectField
                label={subjectSelectionLabel}
                valueText={selectedSubjectValueDisplay}
                onPress={showSubjectPicker}
                disabled={subjectIsLocked || isSubmitting}
              />
            ) : null}

            {currentForm.description ? (
              <Text style={styles.headerInfoText}>
                Description: {currentForm.description}
              </Text>
            ) : null}

            {currentForm.resultRules ? (
              <Text style={styles.headerInfoText}>
                Result rules: {currentForm.resultRules}
              </Text>
            ) : null}

            <View style={styles.dateRow}>
              <TextInput
                style={[styles.input, styles.dateInput]}
                placeholder="Date / time"
                placeholderTextColor="#aaa"
                value={runDateTime}
                onChangeText={setRunDateTime}
                editable={!isSubmitting}
              />
              <TouchableOpacity
                style={[styles.useNowButton, isSubmitting && { opacity: 0.5 }]}
                onPress={() => setRunDateTime(formatNow())}
                disabled={isSubmitting}
              >
                <Text style={styles.useNowText}>Use now</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.headerInspectorText}>
              Inspector: {inspectorName || "Not signed yet"}
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Items</Text>

            {currentForm.items.map((item) => {
              const state = itemsState.find((s) => s.id === item.id) || {};
              const status = state.status || "pending";
              const isExpanded = expandedItemId === item.id;
              const needsCorrective =
                status === "fail" && state.requireCorrectiveOnFail;

              return (
                <View key={item.id} style={styles.itemContainer}>
                  <TouchableOpacity
                    style={styles.itemHeader}
                    onPress={() => toggleExpandItem(item.id)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemTitle}>{item.title}</Text>
                      <Text style={styles.itemDescription}>
                        {item.description || "Inspection item"}
                      </Text>
                    </View>
                    <View style={getStatusBadgeStyle(status)}>
                      <Text style={styles.statusBadgeText}>
                        {status === "pending"
                          ? "Pending"
                          : status === "pass"
                            ? "Pass"
                            : status === "na"
                              ? "N/A"
                              : "Fail"}
                      </Text>
                    </View>
                  </TouchableOpacity>

                  {isExpanded && (
                    <View style={styles.itemBody}>
                      <View style={styles.statusRow}>
                        <TouchableOpacity
                          style={[
                            styles.statusButton,
                            status === "pass" &&
                              styles.statusButtonSelectedPass,
                          ]}
                          onPress={() => setStatusForItem(item.id, "pass")}
                        >
                          <Text
                            style={[
                              styles.statusButtonText,
                              status === "pass" &&
                                styles.statusButtonTextSelected,
                            ]}
                          >
                            Pass
                          </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={[
                            styles.statusButton,
                            status === "na" && styles.statusButtonSelectedNA,
                          ]}
                          onPress={() => setStatusForItem(item.id, "na")}
                        >
                          <Text
                            style={[
                              styles.statusButtonText,
                              status === "na" &&
                                styles.statusButtonTextSelected,
                            ]}
                          >
                            N/A
                          </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={[
                            styles.statusButton,
                            status === "fail" &&
                              styles.statusButtonSelectedFail,
                          ]}
                          onPress={() => setStatusForItem(item.id, "fail")}
                        >
                          <Text
                            style={[
                              styles.statusButtonText,
                              status === "fail" &&
                                styles.statusButtonTextSelected,
                            ]}
                          >
                            Fail
                          </Text>
                        </TouchableOpacity>
                      </View>

                      {state.allowNote !== false && (
                        <TextInput
                          style={[styles.input, styles.textArea]}
                          placeholder={
                            needsCorrective
                              ? "Corrective action (required)"
                              : "Note / evidence / comment"
                          }
                          placeholderTextColor="#aaa"
                          value={state.note || ""}
                          onChangeText={(t) => setNoteForItem(item.id, t)}
                          multiline
                          editable={!isSubmitting}
                        />
                      )}

                      <View style={styles.actionRow}>
                        {state.allowPhoto ? (
                          <TouchableOpacity
                            style={[
                              styles.smallActionButton,
                              isSubmitting && { opacity: 0.5 },
                            ]}
                            onPress={() => takePhotoForItem(item.id)}
                            disabled={isSubmitting}
                          >
                            <Image
                              source={require("../assets/camera.png")}
                              style={styles.smallActionIcon}
                            />
                            <Text style={styles.smallActionText}>Photo</Text>
                          </TouchableOpacity>
                        ) : null}

                        {state.allowScan ? (
                          <TouchableOpacity
                            style={[
                              styles.smallActionButton,
                              isSubmitting && { opacity: 0.5 },
                            ]}
                            onPress={() => markScanDoneForItem(item.id)}
                            disabled={isSubmitting}
                          >
                            <Image
                              source={require("../assets/barcode.png")}
                              style={styles.smallActionIcon}
                            />
                            <Text style={styles.smallActionText}>Scan</Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>

                      {state.photoUri ? (
                        <Image
                          source={{ uri: state.photoUri }}
                          style={styles.itemPhoto}
                        />
                      ) : null}

                      {state.scanDone && (
                        <Text style={styles.scanDoneText}>
                          {state.scanValue
                            ? `Scan completed: ${state.scanValue}`
                            : "Scan completed."}
                        </Text>
                      )}

                      {needsCorrective && (
                        <Text style={styles.requiredHint}>
                          Corrective action is required for this failed item.
                        </Text>
                      )}

                      {status === "fail" && state.requireEvidenceOnFail && (
                        <Text style={styles.requiredHint}>
                          Evidence is required for this failed item.
                        </Text>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </View>

          {overallResult === "fail" && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Follow-up</Text>
              <Text style={styles.cardSubtitle}>
                Because this inspection result is fail, a follow-up date is
                required.
              </Text>

              <TouchableOpacity
                style={[
                  styles.selectField,
                  isSubmitting && styles.disabledField,
                ]}
                onPress={() => setShowFollowUpPicker(true)}
                disabled={isSubmitting}
              >
                <Text style={styles.selectFieldLabel}>Follow-up date</Text>
                <Text style={styles.selectFieldValue}>
                  {followUpDate || "Tap to select date"}
                </Text>
              </TouchableOpacity>

              {showFollowUpPicker && (
                <DateTimePicker
                  value={followUpDate ? new Date(followUpDate) : new Date()}
                  mode="date"
                  display="default"
                  onChange={handleFollowUpDateChange}
                />
              )}
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Sign off</Text>
            <Text style={styles.cardSubtitle}>
              Confirm accuracy and sign on the screen.
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Inspector name"
              placeholderTextColor="#aaa"
              value={inspectorName}
              onChangeText={setInspectorName}
              editable={!isSubmitting}
            />

            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Overall notes (optional)"
              placeholderTextColor="#aaa"
              value={overallNote}
              onChangeText={setOverallNote}
              multiline
              editable={!isSubmitting}
            />

            <TouchableOpacity
              style={styles.confirmRow}
              onPress={() => setConfirmAccurate((v) => !v)}
              disabled={isSubmitting}
            >
              <View
                style={[
                  styles.checkbox,
                  confirmAccurate && styles.checkboxSelected,
                ]}
              >
                {confirmAccurate ? (
                  <Text style={styles.checkboxTick}>✓</Text>
                ) : null}
              </View>
              <Text style={styles.confirmText}>
                I confirm the above is accurate to the best of my knowledge.
              </Text>
            </TouchableOpacity>

            <Text style={styles.signatureLabel}>Signature</Text>
            <View style={styles.signatureBox}>
              <SignatureScreen
                ref={signatureRef}
                onOK={handleSignatureOK}
                onEmpty={() => {
                  latestSignatureDataUrlRef.current = "";
                  latestSignatureFileUriRef.current = "";
                  if (signatureCaptureResolverRef.current) {
                    signatureCaptureResolverRef.current = null;
                  }
                  setSignatureDataUrl("");
                  setSignatureFileUri("");
                }}
                onBegin={() => setPageScrollEnabled(false)}
                onEnd={() => {
                  setPageScrollEnabled(true);

                  setTimeout(() => {
                    try {
                      signatureRef.current?.readSignature?.();
                    } catch (e) {
                      console.log(
                        "[INSPECTIONS] auto readSignature onEnd failed",
                        e,
                      );
                    }
                  }, 250);
                }}
                webStyle={signaturePadStyle}
                autoClear={false}
                imageType="image/png"
                descriptionText=""
                clearText="Clear"
                confirmText="Save Signature"
              />
            </View>

            <TouchableOpacity
              style={styles.clearSigButton}
              onPress={clearSignature}
              disabled={isSubmitting}
            >
              <Text style={styles.clearSigText}>Clear signature</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.saveSigButton}
              onPress={handleSaveSignaturePress}
              disabled={isSubmitting}
            >
              <Text style={styles.saveSigText}>Save signature</Text>
            </TouchableOpacity>

            <Text style={styles.signatureStatusText}>
              {signatureFileUri
                ? "Signature captured successfully."
                : "Signature not yet captured."}
            </Text>

            <TouchableOpacity
              style={[styles.primaryButton, isSubmitting && { opacity: 0.6 }]}
              onPress={handleSubmitInspection}
              disabled={isSubmitting}
            >
              <Text style={styles.primaryButtonText}>
                {isSubmitting ? "Saving..." : "Submit inspection"}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}
    </>
  );
}

const signaturePadStyle = `
.m-signature-pad {
  box-shadow: none;
  border: none;
  height: 100%;
}
.m-signature-pad--body {
  border: none;
}
.m-signature-pad--body canvas {
  background-color: white;
}
.m-signature-pad--footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 80px;
  padding: 10px;
  margin: 0;
  background: #ffffff;
}
button {
  background-color: #22a6b3;
  color: white;
  border-radius: 8px;
  padding: 10px 14px;
  border: none;
  box-shadow: none;
  font-size: 14px;
}
`;

function getStatusBadgeStyle(status) {
  let backgroundColor = "#ccc";
  if (status === "pass") backgroundColor = "#27ae60";
  else if (status === "na") backgroundColor = "#7a5c19";
  else if (status === "fail") backgroundColor = "#e74c3c";

  return {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor,
  };
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
  cardSubtitle: {
    fontSize: 12,
    color: "#666",
    marginBottom: 12,
  },
  headerInfoText: {
    fontSize: 11,
    color: "#555",
    marginBottom: 4,
  },
  headerInspectorText: {
    fontSize: 11,
    color: "#555",
    marginTop: 4,
  },
  selectField: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
    backgroundColor: "#fafafa",
  },
  readonlyField: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
    backgroundColor: "#f1f1f1",
  },
  disabledField: {
    opacity: 0.55,
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
    height: 90,
    textAlignVertical: "top",
  },
  emptyText: {
    fontSize: 12,
    color: "#999",
  },
  scopeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  scopeButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingVertical: 10,
    marginHorizontal: 4,
    alignItems: "center",
    backgroundColor: "#fafafa",
  },
  scopeButtonSelected: {
    borderColor: THEME_COLOR,
    backgroundColor: "#e6f9fb",
  },
  scopeIcon: {
    width: 48,
    height: 48,
    marginBottom: 4,
  },
  scopeText: {
    fontSize: 13,
    color: "#555",
  },
  scopeTextSelected: {
    color: THEME_COLOR,
    fontWeight: "600",
  },
  formRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  formName: {
    fontSize: 14,
    fontWeight: "500",
  },
  formDescription: {
    fontSize: 11,
    color: "#777",
    marginTop: 2,
  },
  formIcon: {
    width: 24,
    height: 24,
    marginLeft: 8,
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
  itemContainer: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
    marginBottom: 4,
    paddingBottom: 4,
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "center",
  },
  itemTitle: {
    fontSize: 14,
    fontWeight: "500",
  },
  itemDescription: {
    fontSize: 11,
    color: "#777",
    marginTop: 2,
  },
  statusBadgeText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
  },
  itemBody: {
    marginTop: 8,
  },
  statusRow: {
    flexDirection: "row",
    marginBottom: 8,
  },
  statusButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    paddingVertical: 6,
    marginHorizontal: 2,
    alignItems: "center",
  },
  statusButtonSelectedPass: {
    borderColor: "#27ae60",
    backgroundColor: "#e6f9f0",
  },
  statusButtonSelectedNA: {
    borderColor: "#7a5c19",
    backgroundColor: "#f4efe0",
  },
  statusButtonSelectedFail: {
    borderColor: "#e74c3c",
    backgroundColor: "#fdecea",
  },
  statusButtonText: {
    fontSize: 12,
    color: "#555",
  },
  statusButtonTextSelected: {
    fontWeight: "600",
  },
  actionRow: {
    flexDirection: "row",
    marginBottom: 8,
  },
  smallActionButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: THEME_COLOR,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginHorizontal: 2,
  },
  smallActionIcon: {
    width: 24,
    height: 24,
    marginRight: 4,
  },
  smallActionText: {
    fontSize: 11,
    color: THEME_COLOR,
    fontWeight: "500",
  },
  itemPhoto: {
    width: 120,
    height: 120,
    borderRadius: 6,
    marginTop: 4,
  },
  scanDoneText: {
    fontSize: 11,
    color: "#555",
    marginTop: 4,
  },
  requiredHint: {
    fontSize: 11,
    color: "#b03a2e",
    marginTop: 4,
    fontWeight: "600",
  },
  confirmRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 14,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 1,
    borderColor: "#999",
    borderRadius: 4,
    marginRight: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  checkboxSelected: {
    backgroundColor: THEME_COLOR,
    borderColor: THEME_COLOR,
  },
  checkboxTick: {
    color: "#fff",
    fontWeight: "700",
  },
  confirmText: {
    flex: 1,
    fontSize: 13,
    color: "#333",
    lineHeight: 18,
  },
  signatureLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#333",
    marginBottom: 8,
  },
  signatureBox: {
    height: 420,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: "#fff",
    marginBottom: 10,
  },
  clearSigButton: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: "#eee",
    marginBottom: 12,
  },
  clearSigText: {
    fontSize: 12,
    color: "#333",
    fontWeight: "600",
  },
  saveSigButton: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: THEME_COLOR,
    marginBottom: 12,
  },
  saveSigText: {
    fontSize: 12,
    color: "#fff",
    fontWeight: "600",
  },
  signatureStatusText: {
    fontSize: 12,
    color: "#555",
    marginBottom: 12,
  },
  primaryButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: "center",
    marginTop: 4,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    maxHeight: "75%",
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
    color: "#222",
  },
  modalRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  modalRowText: {
    fontSize: 14,
    color: "#222",
  },
  modalCloseBtn: {
    marginTop: 12,
    backgroundColor: THEME_COLOR,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  modalCloseBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 13,
  },
});
