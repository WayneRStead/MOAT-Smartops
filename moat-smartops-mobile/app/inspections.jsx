import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { saveInspectionRun } from "../database";
import { syncOutbox } from "../syncOutbox";

const THEME_COLOR = "#22a6b3";
const CACHE_INSPECTION_FORMS_KEY = "@moat:cache:inspectionForms";
const CACHE_PROJECTS_KEY = "@moat:cache:projects";
const CACHE_TASKS_KEY = "@moat:cache:tasks";
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

function normalizeRole(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function pickProjectId(input) {
  return String(input?._id || input?.id || "").trim();
}

function pickTaskId(input) {
  return String(input?._id || input?.id || "").trim();
}

function pickProjectName(input) {
  return String(
    input?.name || input?.title || pickProjectId(input) || "",
  ).trim();
}

function pickTaskName(input) {
  return String(input?.title || input?.name || pickTaskId(input) || "").trim();
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

function normalizeInspectionForm(input) {
  if (!input || typeof input !== "object") return null;

  const scopeType =
    String(input?.scope?.type || input?.scope || "global").toLowerCase() ===
    "scoped"
      ? "scoped"
      : "global";

  const itemsRaw = Array.isArray(input?.items) ? input.items : [];
  const items = itemsRaw
    .map((item, index) => {
      const itemId = String(
        item?._id || item?.id || `item-${index + 1}`,
      ).trim();
      const title = String(
        item?.label || item?.title || `Item ${index + 1}`,
      ).trim();
      if (!itemId || !title) return null;

      return {
        id: itemId,
        title,
        description: String(item?.description || "").trim(),
        allowPhoto: !!item?.allowPhoto,
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

export default function InspectionsScreen() {
  const router = useRouter();

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

  const [currentForm, setCurrentForm] = useState(null);
  const [itemsState, setItemsState] = useState([]);
  const [expandedItemId, setExpandedItemId] = useState(null);

  const [headerLocation, setHeaderLocation] = useState("");
  const [headerProject, setHeaderProject] = useState("");
  const [headerTask, setHeaderTask] = useState("");
  const [headerMilestone, setHeaderMilestone] = useState("");
  const [headerSubject, setHeaderSubject] = useState("");

  const [inspectorName, setInspectorName] = useState("");
  const [overallNote, setOverallNote] = useState("");
  const [runDateTime, setRunDateTime] = useState(formatNow());
  const [isSubmitting, setIsSubmitting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;

      (async () => {
        const [meta, cachedForms, cachedProjects, cachedTasks] =
          await Promise.all([
            getCurrentUserMeta(),
            loadCache(CACHE_INSPECTION_FORMS_KEY, []),
            loadCache(CACHE_PROJECTS_KEY, []),
            loadCache(CACHE_TASKS_KEY, []),
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
      })();

      return () => {
        alive = false;
      };
    }, []),
  );

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

  const markScanDoneForItem = (itemId) => {
    Alert.alert(
      "Scan",
      "This item is marked as scanned. Scanner wiring can be added next.",
    );

    setItemsState((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, scanDone: true } : item,
      ),
    );
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
        "Actions required",
        "Please add an action or note for this failed item before moving on.",
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
    setHeaderLocation("");
    setHeaderProject("");
    setHeaderTask("");
    setHeaderMilestone("");
    setHeaderSubject("");
    setInspectorName("");
    setOverallNote("");
    setRunDateTime(formatNow());
    setIsSubmitting(false);
  };

  const startFormRun = (form) => {
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

    const scopeInfo = form?.scopeInfo || {};
    const lockedProjectName = String(scopeInfo?.projectName || "").trim();
    const lockedTaskName = String(scopeInfo?.taskName || "").trim();
    const lockedMilestoneName = String(scopeInfo?.milestoneName || "").trim();
    const lockedSubjectLabel = String(form?.subject?.lockLabel || "").trim();

    setHeaderLocation("");
    setHeaderProject(lockedProjectName);
    setHeaderTask(lockedTaskName);
    setHeaderMilestone(lockedMilestoneName);
    setHeaderSubject(lockedSubjectLabel);

    setInspectorName(userMeta?.name || "");
    setOverallNote("");
    setRunDateTime(formatNow());
    setMode("run");
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
        "Missing signature",
        "Please enter your name as a signature before submitting.",
      );
      return;
    }

    const invalidFails = itemsState.filter(
      (i) =>
        i.status === "fail" &&
        i.requireCorrectiveOnFail &&
        (!i.note || i.note.trim().length === 0),
    );

    if (invalidFails.length > 0) {
      Alert.alert(
        "Actions required",
        "Some failed items still need an action or note before submitting.",
      );
      return;
    }

    setIsSubmitting(true);

    try {
      const coords = await getCurrentCoords();
      const submittedAt = new Date().toISOString();
      const achievedScore = computePercentScore(itemsState);
      const overallResult = computeOverallResult(itemsState, currentForm);

      const matchedProject =
        projects.find((p) => pickProjectName(p) === headerProject) ||
        projects.find((p) => pickProjectId(p) === headerProject) ||
        null;

      const matchedTask =
        tasks.find((t) => pickTaskName(t) === headerTask) ||
        tasks.find((t) => pickTaskId(t) === headerTask) ||
        null;

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
        header: {
          location: String(headerLocation || "").trim(),
          project: String(headerProject || "").trim(),
          task: String(headerTask || "").trim(),
          milestone: String(headerMilestone || "").trim(),
          subject: String(headerSubject || "").trim(),
          description: currentForm.description || "",
          resultRules: currentForm.resultRules || "",
          achievedScore,
          overallResult,
        },
        links: {
          projectId:
            String(currentForm?.scopeInfo?.projectId || "").trim() ||
            (matchedProject ? pickProjectId(matchedProject) : ""),
          taskId:
            String(currentForm?.scopeInfo?.taskId || "").trim() ||
            (matchedTask ? pickTaskId(matchedTask) : ""),
          milestoneId: String(currentForm?.scopeInfo?.milestoneId || "").trim(),
        },
        subjectAtRun: {
          type: String(currentForm?.subject?.type || "none").toLowerCase(),
          id: currentForm?.subject?.lockToId || undefined,
          label: String(
            headerSubject || currentForm?.subject?.lockLabel || "",
          ).trim(),
        },
        signoff: {
          confirmed: true,
          name: String(inspectorName || "").trim(),
          date: submittedAt,
          signatureDataUrl: "",
        },
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
            scanRef: item.scanDone ? "mobile-scan-complete" : "",
            note: String(item.note || "").trim(),
          },
        })),
        createdAt: submittedAt,
        updatedAt: submittedAt,
      };

      const localId = await saveInspectionRun({
        orgId: userMeta?.orgId || null,
        userId: userMeta?.userId || null,
        formId: currentForm.id,
        payload,
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

  const formsForScope = useMemo(() => {
    return forms.filter((f) => f.scope === scope);
  }, [forms, scope]);

  const currentAchievedScore = useMemo(() => {
    return computePercentScore(itemsState);
  }, [itemsState]);

  return (
    <>
      {mode === "select" && (
        <ScrollView contentContainerStyle={styles.container}>
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
        <ScrollView contentContainerStyle={styles.container}>
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
                  overallNote
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
              Achieved score: {currentAchievedScore}%
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Location"
              placeholderTextColor="#aaa"
              value={headerLocation}
              onChangeText={setHeaderLocation}
            />

            <TextInput
              style={styles.input}
              placeholder="Project"
              placeholderTextColor="#aaa"
              value={headerProject}
              onChangeText={setHeaderProject}
            />

            <TextInput
              style={styles.input}
              placeholder="Task"
              placeholderTextColor="#aaa"
              value={headerTask}
              onChangeText={setHeaderTask}
            />

            <TextInput
              style={styles.input}
              placeholder="Milestone"
              placeholderTextColor="#aaa"
              value={headerMilestone}
              onChangeText={setHeaderMilestone}
            />

            <TextInput
              style={styles.input}
              placeholder="Subject"
              placeholderTextColor="#aaa"
              value={headerSubject}
              onChangeText={setHeaderSubject}
            />

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

                      <TextInput
                        style={[styles.input, styles.textArea]}
                        placeholder="Action / note"
                        placeholderTextColor="#aaa"
                        value={state.note || ""}
                        onChangeText={(t) => setNoteForItem(item.id, t)}
                        multiline
                        editable={!isSubmitting}
                      />

                      <View style={styles.actionRow}>
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
                      </View>

                      {state.photoUri ? (
                        <Image
                          source={{ uri: state.photoUri }}
                          style={styles.itemPhoto}
                        />
                      ) : null}

                      {state.scanDone && (
                        <Text style={styles.scanDoneText}>Scan completed.</Text>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Sign off</Text>
            <Text style={styles.cardSubtitle}>
              This currently uses a typed name as signature.
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Inspector name (signature)"
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

function getStatusBadgeStyle(status) {
  let backgroundColor = "#ccc";
  if (status === "pass") backgroundColor = "#27ae60";
  else if (status === "na") backgroundColor = "#614410ff";
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
  disabledField: {
    opacity: 0.5,
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
    height: 70,
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
    borderColor: "#614410ff",
    backgroundColor: "#ecf0f1",
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
});
