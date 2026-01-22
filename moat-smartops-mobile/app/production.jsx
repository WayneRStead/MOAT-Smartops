// moat-smartops-mobile/production.jsx
// FULL DROP-IN REPLACEMENT
//
// What this version does (important):
// ✅ Uses OFFLINE-CACHED dropdown lists (projects / my tasks / milestones)
// ✅ When online, you can tap "Refresh lists" to pull latest from server and cache on device
// ✅ Saves updates to SQLite outbox exactly like before (offline-first)
// ✅ Tries a best-effort sync after each save (won’t break if offline)
//
// NOTE (so you don’t get stuck):
// - I don’t know your exact backend endpoints for “projects list”, “my tasks”, “milestones”.
// - This file supports multiple common endpoint shapes and fails gracefully.
// - You only need to adjust the ENDPOINTS in one place below if your routes differ.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import MapView, { Marker, Polygon } from "react-native-maps";

import { API_BASE_URL, ORG_KEY, TOKEN_KEY } from "../apiClient";
import { syncOutbox } from "../syncOutbox";

import {
  saveActivityLog,
  saveProjectUpdate,
  saveTaskUpdate,
  saveUserDocumentAttachment,
} from "../database";

/* ---------------------------------------------
   CONFIG: adjust these if your backend differs
----------------------------------------------*/

// “Projects list”
const ENDPOINT_PROJECTS = [
  "/api/projects", // common
  "/projects", // common (if /api mounted)
];

// “Tasks assigned to me”
const ENDPOINT_MY_TASKS = [
  "/api/tasks?scope=mine",
  "/api/tasks?assigned=me",
  "/api/tasks?assignedTo=me",
  "/api/tasks?mine=true",
  "/api/tasks",
  "/tasks",
];

// “Milestones for a task”
function endpointsMilestonesForTask(taskId) {
  return [
    `/api/tasks/${taskId}/milestones`,
    `/api/tasks/${taskId}/task-milestones`,
    `/api/tasks/${taskId}`,
    `/tasks/${taskId}`,
  ];
}

/* ---------------------------------------------
   OFFLINE CACHE KEYS
----------------------------------------------*/
const CACHE_PROJECTS_KEY = "@moat:cache:projects:v1";
const CACHE_TASKS_KEY = "@moat:cache:tasks:v1";
const CACHE_MILESTONES_KEY = "@moat:cache:milestonesByTask:v1";

// Optional (if you already store it on login, great)
const USER_ID_KEY = "@moat:userId";

/* ---------------------------------------------
   NETWORK HELPERS
----------------------------------------------*/
async function getAuthHeaders() {
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  const orgId = await AsyncStorage.getItem(ORG_KEY);

  const headers = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (orgId) headers["x-org-id"] = orgId;

  return { headers, token, orgId };
}

async function fetchJsonTry(path) {
  const { headers } = await getAuthHeaders();
  const res = await fetch(`${API_BASE_URL}${path}`, { headers });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) return { ok: false, status: res.status, json, text };
  return { ok: true, status: res.status, json, text };
}

function normalizeListFromUnknownShape(json) {
  // Accept:
  // - [ ... ]
  // - { items: [...] }
  // - { data: [...] }
  // - { projects: [...] }
  // - { tasks: [...] }
  if (!json) return [];
  if (Array.isArray(json)) return json;

  const candidates = [
    json.items,
    json.data,
    json.projects,
    json.tasks,
    json.results,
  ].filter(Boolean);

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  return [];
}

function pickId(x) {
  return String(x?._id || x?.id || x?.taskId || x?.projectId || "");
}

function pickName(x) {
  return (
    x?.name ||
    x?.title ||
    x?.projectName ||
    x?.taskName ||
    x?.code ||
    x?.ref ||
    x?.number ||
    pickId(x)
  );
}

function dedupeById(list) {
  const map = new Map();
  for (const item of list || []) {
    const id = pickId(item);
    if (!id) continue;
    if (!map.has(id)) map.set(id, item);
  }
  return Array.from(map.values());
}

async function loadCache(key, fallback = null) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveCache(key, value) {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value ?? null));
  } catch {}
}

/* ---------------------------------------------
   SIMPLE “SELECT MODAL” COMPONENT
----------------------------------------------*/
function SelectModal({
  visible,
  title,
  items,
  selectedId,
  onSelect,
  onClose,
  emptyText = "No items available offline yet. Tap Refresh lists when online.",
}) {
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
              keyExtractor={(it) => pickId(it)}
              style={{ maxHeight: 380 }}
              renderItem={({ item }) => {
                const id = pickId(item);
                const name = pickName(item);
                const active = selectedId && id === selectedId;
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
                      {name}
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

function SelectField({ label, valueText, onPress }) {
  return (
    <TouchableOpacity style={styles.selectField} onPress={onPress}>
      <Text style={styles.selectFieldLabel}>{label}</Text>
      <Text style={styles.selectFieldValue} numberOfLines={1}>
        {valueText || "Tap to select"}
      </Text>
    </TouchableOpacity>
  );
}

export default function ProductionScreen() {
  const router = useRouter();

  // Productivity mode
  const [mode, setMode] = useState("project");

  /* -------------------- OFFLINE LIST STATE -------------------- */
  const [loadingLists, setLoadingLists] = useState(false);
  const [projects, setProjects] = useState([]);
  const [myTasks, setMyTasks] = useState([]);
  const [milestonesByTask, setMilestonesByTask] = useState({}); // { [taskId]: [milestoneObj|string] }

  // selection modals
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [milestonePickerOpen, setMilestonePickerOpen] = useState(false);
  const [activeMilestoneTaskId, setActiveMilestoneTaskId] = useState(null);

  // Project management form state (store IDs, show names)
  const [projectId, setProjectId] = useState("");
  const [taskIdForProject, setTaskIdForProject] = useState("");
  const [status, setStatus] = useState("");
  const [managerNote, setManagerNote] = useState("");

  // Task management form state
  const [taskMgmtTaskId, setTaskMgmtTaskId] = useState("");
  const [taskMgmtMilestoneId, setTaskMgmtMilestoneId] = useState("");
  const [taskMgmtStatus, setTaskMgmtStatus] = useState("");
  const [taskMgmtNote, setTaskMgmtNote] = useState("");

  // Activity log state
  const [activityTaskId, setActivityTaskId] = useState("");
  const [activityMilestoneId, setActivityMilestoneId] = useState("");
  const [activityNote, setActivityNote] = useState("");
  const [activityPhoto, setActivityPhoto] = useState(null);
  const [activityFencePoints, setActivityFencePoints] = useState([]);

  // Attach User Document modal state
  const [attachVisible, setAttachVisible] = useState(false);
  const [attachProjectId, setAttachProjectId] = useState("");
  const [attachUser, setAttachUser] = useState(""); // you’ll later swap to a real user selector
  const [attachTitle, setAttachTitle] = useState("");
  const [attachTag, setAttachTag] = useState("");
  const [attachPhoto, setAttachPhoto] = useState(null);

  // Fence map modal state
  const [fenceModalVisible, setFenceModalVisible] = useState(false);
  const [mapRegion, setMapRegion] = useState(null);

  // Auto capture state for fence
  const [autoCapturing, setAutoCapturing] = useState(false);
  const captureTimerRef = useRef(null);

  /* -------------------- HELPERS: selected item text -------------------- */
  const selectedProject = projects.find((p) => pickId(p) === projectId) || null;

  // tasks “allocated to user” only: we assume myTasks is already filtered by backend.
  const selectedTaskForProject =
    myTasks.find((t) => pickId(t) === taskIdForProject) || null;
  const selectedTaskMgmtTask =
    myTasks.find((t) => pickId(t) === taskMgmtTaskId) || null;
  const selectedActivityTask =
    myTasks.find((t) => pickId(t) === activityTaskId) || null;

  function getMilestonesForTask(taskId) {
    const list = milestonesByTask?.[taskId] || [];
    return list;
  }

  function pickMilestoneId(m) {
    if (m == null) return "";
    if (typeof m === "string") return m;
    return String(m?._id || m?.id || m?.code || m?.name || "");
  }

  function pickMilestoneName(m) {
    if (m == null) return "";
    if (typeof m === "string") return m;
    return m?.name || m?.title || m?.code || pickMilestoneId(m);
  }

  function selectedMilestoneText(taskId, milestoneId) {
    if (!taskId || !milestoneId) return "";
    const ms = getMilestonesForTask(taskId);
    const found = ms.find((m) => pickMilestoneId(m) === milestoneId);
    return found ? pickMilestoneName(found) : milestoneId;
  }

  /* -------------------- LOAD CACHED LISTS ON BOOT -------------------- */
  useEffect(() => {
    (async () => {
      const cachedProjects = await loadCache(CACHE_PROJECTS_KEY, []);
      const cachedTasks = await loadCache(CACHE_TASKS_KEY, []);
      const cachedMilestones = await loadCache(CACHE_MILESTONES_KEY, {});

      setProjects(Array.isArray(cachedProjects) ? cachedProjects : []);
      setMyTasks(Array.isArray(cachedTasks) ? cachedTasks : []);
      setMilestonesByTask(
        cachedMilestones && typeof cachedMilestones === "object"
          ? cachedMilestones
          : {},
      );
    })();
  }, []);

  /* -------------------- ONLINE REFRESH (manual button) -------------------- */
  async function refreshListsFromServer() {
    try {
      setLoadingLists(true);

      // 1) Projects
      let projectsOut = [];
      for (const ep of ENDPOINT_PROJECTS) {
        const r = await fetchJsonTry(ep);
        if (r.ok) {
          projectsOut = normalizeListFromUnknownShape(r.json);
          break;
        }
      }

      // 2) My tasks
      let tasksOut = [];
      for (const ep of ENDPOINT_MY_TASKS) {
        const r = await fetchJsonTry(ep);
        if (r.ok) {
          tasksOut = normalizeListFromUnknownShape(r.json);
          break;
        }
      }

      projectsOut = dedupeById(projectsOut);
      tasksOut = dedupeById(tasksOut);

      setProjects(projectsOut);
      setMyTasks(tasksOut);

      await saveCache(CACHE_PROJECTS_KEY, projectsOut);
      await saveCache(CACHE_TASKS_KEY, tasksOut);

      Alert.alert("Updated", "Lists refreshed and stored for offline use.");
    } catch (e) {
      Alert.alert(
        "Could not refresh",
        e?.message || "Failed to load lists from server.",
      );
    } finally {
      setLoadingLists(false);
    }
  }

  /* -------------------- LOAD MILESTONES (per task, cached) -------------------- */
  async function ensureMilestonesLoaded(taskObj) {
    const taskId = pickId(taskObj);
    if (!taskId) return;

    // Already have cached milestones?
    const existing = milestonesByTask?.[taskId];
    if (Array.isArray(existing) && existing.length) return;

    // If the task object already includes milestones, use them
    const embedded = Array.isArray(taskObj?.milestones)
      ? taskObj.milestones
      : Array.isArray(taskObj?.taskMilestones)
        ? taskObj.taskMilestones
        : null;

    if (embedded && embedded.length) {
      const next = { ...(milestonesByTask || {}), [taskId]: embedded };
      setMilestonesByTask(next);
      await saveCache(CACHE_MILESTONES_KEY, next);
      return;
    }

    // Otherwise try endpoints
    try {
      for (const ep of endpointsMilestonesForTask(taskId)) {
        const r = await fetchJsonTry(ep);
        if (!r.ok) continue;

        // If endpoint returns a task, try to find its milestones
        if (r.json && !Array.isArray(r.json)) {
          const maybe = Array.isArray(r.json?.milestones)
            ? r.json.milestones
            : Array.isArray(r.json?.taskMilestones)
              ? r.json.taskMilestones
              : Array.isArray(r.json?.items)
                ? r.json.items
                : null;

          if (maybe && maybe.length) {
            const next = { ...(milestonesByTask || {}), [taskId]: maybe };
            setMilestonesByTask(next);
            await saveCache(CACHE_MILESTONES_KEY, next);
            return;
          }
        }

        // If endpoint returns array directly
        const list = normalizeListFromUnknownShape(r.json);
        if (list?.length) {
          const next = { ...(milestonesByTask || {}), [taskId]: list };
          setMilestonesByTask(next);
          await saveCache(CACHE_MILESTONES_KEY, next);
          return;
        }
      }
    } catch {
      // ignore: offline or server mismatch
    }
  }

  /* -------------------- ORG / USER from storage -------------------- */
  async function getOrgAndUser() {
    const orgId = await AsyncStorage.getItem(ORG_KEY);
    if (!orgId)
      throw new Error(
        "Missing orgId on device. Please set ORG_KEY after login.",
      );

    // userId is optional; backend can infer from token later.
    const userId = await AsyncStorage.getItem(USER_ID_KEY);
    return { orgId, userId: userId || null };
  }

  /* -------------------- Attach Modal -------------------- */
  const openAttachModal = () => {
    setAttachProjectId(projectId || "");
    setAttachVisible(true);
  };
  const closeAttachModal = () => setAttachVisible(false);

  /* -------------------- CAMERA: ATTACH USER DOCUMENT -------------------- */
  const handleTakePhoto = async () => {
    const { status: camStatus } =
      await ImagePicker.requestCameraPermissionsAsync();
    if (camStatus !== "granted") {
      Alert.alert(
        "Camera permission",
        "Camera access is required to take a photo.",
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.5 });
    if (result.canceled) return;

    const photoUri =
      result.assets && result.assets.length > 0 ? result.assets[0].uri : null;
    if (photoUri) setAttachPhoto(photoUri);
  };

  /* -------------------- SAVE: ATTACH USER DOCUMENT -------------------- */
  const handleSaveAttachment = async () => {
    try {
      if (!attachPhoto) {
        Alert.alert(
          "Missing document",
          "Please take a photo of the document before saving.",
        );
        return;
      }

      const nowIso = new Date().toISOString();
      const { orgId, userId } = await getOrgAndUser();

      const doc = {
        orgId,
        userId,
        projectId: attachProjectId || null,
        targetUserId: attachUser || null,
        title: attachTitle || null,
        tag: attachTag || null,
        photoUri: attachPhoto,
        syncStatus: "pending",
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const rowId = await saveUserDocumentAttachment(doc);

      Alert.alert("Saved", "User document stored on this device for sync.");

      // Reset attach form
      setAttachUser("");
      setAttachTitle("");
      setAttachTag("");
      setAttachPhoto(null);
      setAttachVisible(false);

      // best-effort sync
      try {
        await syncOutbox({ limit: 10 });
      } catch {}
    } catch (e) {
      console.error("Failed to save user document", e);
      Alert.alert(
        "Error",
        e?.message || "Could not save the user document on this device.",
      );
    }
  };

  /* -------------------- SAVE: TASK MANAGEMENT -------------------- */
  const handleSaveTaskManagement = async () => {
    try {
      if (!taskMgmtTaskId && !taskMgmtNote) {
        Alert.alert(
          "Missing details",
          "Please select a task and/or enter a note before saving.",
        );
        return;
      }

      const nowIso = new Date().toISOString();
      const { orgId, userId } = await getOrgAndUser();

      const update = {
        orgId,
        userId,
        projectId: projectId || null,
        taskId: taskMgmtTaskId || null,
        milestone: taskMgmtMilestoneId || null,
        status: taskMgmtStatus || null,
        note: taskMgmtNote || "",
        syncStatus: "pending",
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      await saveTaskUpdate(update);

      Alert.alert("Saved", "Task update stored on this device.");

      // Reset
      setTaskMgmtTaskId("");
      setTaskMgmtMilestoneId("");
      setTaskMgmtStatus("");
      setTaskMgmtNote("");

      try {
        await syncOutbox({ limit: 10 });
      } catch {}
    } catch (e) {
      console.error("Failed to save task update", e);
      Alert.alert(
        "Error",
        e?.message || "Could not save the task update on this device.",
      );
    }
  };

  /* -------------------- SAVE: PROJECT MANAGEMENT -------------------- */
  const handleSaveProjectManagement = async () => {
    try {
      if (!projectId && !managerNote) {
        Alert.alert(
          "Missing details",
          "Please select a project and/or enter a note before saving.",
        );
        return;
      }

      const nowIso = new Date().toISOString();
      const { orgId, userId } = await getOrgAndUser();

      const update = {
        orgId,
        userId,
        projectId: projectId || null,
        taskId: taskIdForProject || null,
        status: status || null,
        managerNote: managerNote || "",
        syncStatus: "pending",
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      await saveProjectUpdate(update);

      Alert.alert("Saved", "Project update stored on this device.");

      // Reset (keep project if you want)
      setTaskIdForProject("");
      setStatus("");
      setManagerNote("");

      try {
        await syncOutbox({ limit: 10 });
      } catch {}
    } catch (e) {
      console.error("Failed to save project update", e);
      Alert.alert(
        "Error",
        e?.message || "Could not save the project update on this device.",
      );
    }
  };

  /* -------------------- CAMERA: ACTIVITY LOG -------------------- */
  const handleTakeActivityPhoto = async () => {
    const { status: camStatus } =
      await ImagePicker.requestCameraPermissionsAsync();
    if (camStatus !== "granted") {
      Alert.alert(
        "Camera permission",
        "Camera access is required to take a photo.",
      );
      return;
    }

    const result = await ImagePicker.launchCameraAsync({ quality: 0.5 });
    if (result.canceled) return;

    const photoUri =
      result.assets && result.assets.length > 0 ? result.assets[0].uri : null;
    if (photoUri) setActivityPhoto(photoUri);
  };

  /* -------------------- FENCE CAPTURE -------------------- */
  const handleStartFenceCapture = async () => {
    const { status: locStatus } =
      await Location.requestForegroundPermissionsAsync();
    if (locStatus !== "granted") {
      Alert.alert(
        "Location permission",
        "Location access is required to capture an activity fence/point.",
      );
      return;
    }

    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    setMapRegion({
      latitude: loc.coords.latitude,
      longitude: loc.coords.longitude,
      latitudeDelta: 0.005,
      longitudeDelta: 0.005,
    });

    setFenceModalVisible(true);
  };

  const startAutoCapture = async () => {
    try {
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const firstPoint = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      };
      setActivityFencePoints((prev) => [...prev, firstPoint]);
    } catch (e) {
      console.log("Error getting initial location", e);
    }

    const timer = setInterval(async () => {
      try {
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        const point = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        };
        setActivityFencePoints((prev) => [...prev, point]);
      } catch (e) {
        console.log("Error getting location in interval", e);
      }
    }, 5000);

    captureTimerRef.current = timer;
    setAutoCapturing(true);
  };

  const stopAutoCapture = () => {
    if (captureTimerRef.current) {
      clearInterval(captureTimerRef.current);
      captureTimerRef.current = null;
    }
    setAutoCapturing(false);
  };

  const handleConfirmFence = () => {
    if (activityFencePoints.length === 0) {
      Alert.alert(
        "No points",
        "Please capture at least one point for this activity fence.",
      );
      return;
    }
    stopAutoCapture();
    setFenceModalVisible(false);
  };

  const handleCloseFenceModal = () => {
    stopAutoCapture();
    setFenceModalVisible(false);
  };

  const getFenceSummary = () => {
    if (activityFencePoints.length === 0) return null;
    if (activityFencePoints.length === 1) {
      const p = activityFencePoints[0];
      return `Point at ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;
    }
    return `${activityFencePoints.length} points captured for fence`;
  };

  /* -------------------- SAVE ACTIVITY LOG -------------------- */
  const handleSaveActivityLog = async () => {
    try {
      const nowIso = new Date().toISOString();
      const { orgId, userId } = await getOrgAndUser();

      const fenceJson =
        activityFencePoints && activityFencePoints.length > 0
          ? JSON.stringify({ type: "polyline", points: activityFencePoints })
          : null;

      const log = {
        orgId,
        userId,
        projectId: projectId || null,
        taskId: activityTaskId || null,
        milestone: activityMilestoneId || null,
        note: activityNote || "",
        photoUri: activityPhoto || null,
        fenceJson,
        syncStatus: "pending",
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      await saveActivityLog(log);

      Alert.alert(
        "Saved",
        "Activity log saved on this device (offline-first).",
      );

      setActivityTaskId("");
      setActivityMilestoneId("");
      setActivityNote("");
      setActivityPhoto(null);
      setActivityFencePoints([]);

      try {
        await syncOutbox({ limit: 10 });
      } catch {}
    } catch (e) {
      console.error("Failed to save activity log", e);
      Alert.alert(
        "Error",
        e?.message || "Could not save the activity log on this device.",
      );
    }
  };

  /* -------------------- SELECT HANDLERS -------------------- */
  async function onSelectProject(p) {
    const id = pickId(p);
    setProjectId(id);
    setProjectPickerOpen(false);

    // reset dependent picks
    setTaskIdForProject("");
    setTaskMgmtMilestoneId("");
    setActivityMilestoneId("");
    setAttachProjectId(id);
  }

  async function onSelectTaskForProject(t) {
    const id = pickId(t);
    setTaskIdForProject(id);
    setTaskPickerOpen(false);
    await ensureMilestonesLoaded(t);
  }

  async function onSelectTaskMgmtTask(t) {
    const id = pickId(t);
    setTaskMgmtTaskId(id);
    setTaskMgmtMilestoneId("");
    setTaskPickerOpen(false);
    await ensureMilestonesLoaded(t);
  }

  async function onSelectActivityTask(t) {
    const id = pickId(t);
    setActivityTaskId(id);
    setActivityMilestoneId("");
    setTaskPickerOpen(false);
    await ensureMilestonesLoaded(t);
  }

  async function openMilestonePickerFor(taskId) {
    if (!taskId) {
      Alert.alert(
        "Select task first",
        "Please select a task before choosing a milestone.",
      );
      return;
    }
    const taskObj = myTasks.find((x) => pickId(x) === taskId);
    if (taskObj) await ensureMilestonesLoaded(taskObj);

    setActiveMilestoneTaskId(taskId);
    setMilestonePickerOpen(true);
  }

  function onSelectMilestone(m) {
    const id = pickMilestoneId(m);
    if (!activeMilestoneTaskId) {
      setMilestonePickerOpen(false);
      return;
    }

    if (activeMilestoneTaskId === taskMgmtTaskId) {
      setTaskMgmtMilestoneId(id);
    } else if (activeMilestoneTaskId === activityTaskId) {
      setActivityMilestoneId(id);
    } else if (activeMilestoneTaskId === taskIdForProject) {
      // not used, but safe
    }
    setMilestonePickerOpen(false);
    setActiveMilestoneTaskId(null);
  }

  /* -------------------- TASK FILTERING: “allocated to user” --------------------
     For now we rely on backend returning “my tasks”.
     If your backend returns all tasks, we can filter by fields like:
       task.assignedUserId == my userId
       task.assignedTo == email
     but I’m not guessing those fields here to avoid breaking.
  ----------------------------------------------------------------------------- */

  // Which “task picker” is open?
  const [taskPickerContext, setTaskPickerContext] = useState("project"); // 'project'|'task'|'activity'|'attachProject'

  function openTaskPicker(context) {
    setTaskPickerContext(context);
    setTaskPickerOpen(true);
  }

  function handleTaskPicked(item) {
    if (taskPickerContext === "project") return onSelectTaskForProject(item);
    if (taskPickerContext === "task") return onSelectTaskMgmtTask(item);
    if (taskPickerContext === "activity") return onSelectActivityTask(item);
    return onSelectTaskForProject(item);
  }

  /* -------------------- UI -------------------- */
  const milestoneItems = activeMilestoneTaskId
    ? getMilestonesForTask(activeMilestoneTaskId)
    : [];

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.topBar}>
          <Image
            source={require("../assets/productivity-screen.png")}
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

        {/* Refresh lists */}
        <View style={styles.refreshRow}>
          <TouchableOpacity
            style={styles.refreshButton}
            onPress={refreshListsFromServer}
            disabled={loadingLists}
          >
            {loadingLists ? (
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <ActivityIndicator color="#fff" />
                <Text style={[styles.refreshButtonText, { marginLeft: 8 }]}>
                  Refreshing…
                </Text>
              </View>
            ) : (
              <Text style={styles.refreshButtonText}>
                Refresh lists (online)
              </Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Mode buttons */}
        <View style={styles.modeRow}>
          <ModeButton
            label="Project management"
            selected={mode === "project"}
            onPress={() => setMode("project")}
            icon={require("../assets/project-management.png")}
          />
          <ModeButton
            label="Task management"
            selected={mode === "task"}
            onPress={() => setMode("task")}
            icon={require("../assets/task-management.png")}
          />
          <ModeButton
            label="Add activity log"
            selected={mode === "activity"}
            onPress={() => setMode("activity")}
            icon={require("../assets/activity-log.png")}
          />
        </View>

        {/* ---------------- Project Management ---------------- */}
        {mode === "project" && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Project management update</Text>

            <SelectField
              label="Project"
              valueText={selectedProject ? pickName(selectedProject) : ""}
              onPress={() => setProjectPickerOpen(true)}
            />

            <SelectField
              label="Task (optional) - my tasks"
              valueText={
                selectedTaskForProject ? pickName(selectedTaskForProject) : ""
              }
              onPress={() => openTaskPicker("project")}
            />

            <TextInput
              style={styles.input}
              placeholder="Status"
              placeholderTextColor="#aaa"
              value={status}
              onChangeText={setStatus}
            />

            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Manager note"
              placeholderTextColor="#aaa"
              value={managerNote}
              onChangeText={setManagerNote}
              multiline
            />

            <TouchableOpacity
              style={styles.attachButton}
              onPress={openAttachModal}
            >
              <Image
                source={require("../assets/camera.png")}
                style={styles.attachIcon}
              />
              <Text style={styles.attachText}>Attach user document</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.saveButton}
              onPress={handleSaveProjectManagement}
            >
              <Text style={styles.saveButtonText}>Save update</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ---------------- Task Management ---------------- */}
        {mode === "task" && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Task management update</Text>
            <Text style={styles.cardSubtitle}>
              Only tasks allocated to you should appear here (offline cached).
            </Text>

            <SelectField
              label="Task (my tasks)"
              valueText={
                selectedTaskMgmtTask ? pickName(selectedTaskMgmtTask) : ""
              }
              onPress={() => openTaskPicker("task")}
            />

            <SelectField
              label="Milestone (optional)"
              valueText={selectedMilestoneText(
                taskMgmtTaskId,
                taskMgmtMilestoneId,
              )}
              onPress={() => openMilestonePickerFor(taskMgmtTaskId)}
            />

            <TextInput
              style={styles.input}
              placeholder="Status"
              placeholderTextColor="#aaa"
              value={taskMgmtStatus}
              onChangeText={setTaskMgmtStatus}
            />

            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Task note"
              placeholderTextColor="#aaa"
              value={taskMgmtNote}
              onChangeText={setTaskMgmtNote}
              multiline
            />

            <TouchableOpacity
              style={styles.saveButton}
              onPress={handleSaveTaskManagement}
            >
              <Text style={styles.saveButtonText}>Save task update</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ---------------- Activity Log ---------------- */}
        {mode === "activity" && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Add activity log</Text>
            <Text style={styles.cardSubtitle}>
              Only your tasks should show here (offline cached).
            </Text>

            <SelectField
              label="Task (my tasks)"
              valueText={
                selectedActivityTask ? pickName(selectedActivityTask) : ""
              }
              onPress={() => openTaskPicker("activity")}
            />

            <SelectField
              label="Milestone (optional)"
              valueText={selectedMilestoneText(
                activityTaskId,
                activityMilestoneId,
              )}
              onPress={() => openMilestonePickerFor(activityTaskId)}
            />

            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Activity note"
              placeholderTextColor="#aaa"
              value={activityNote}
              onChangeText={setActivityNote}
              multiline
            />

            {!activityPhoto ? (
              <TouchableOpacity
                style={styles.takePhotoButton}
                onPress={handleTakeActivityPhoto}
              >
                <Image
                  source={require("../assets/camera.png")}
                  style={styles.cameraIcon}
                />
                <Text style={styles.takePhotoText}>Add photo</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.photoPreview}>
                <Image
                  source={{ uri: activityPhoto }}
                  style={styles.photoPreviewImage}
                />
                <TouchableOpacity
                  style={styles.retryPhotoButton}
                  onPress={handleTakeActivityPhoto}
                >
                  <Text style={styles.retryPhotoText}>Retry photo</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity
              style={styles.takePhotoButton}
              onPress={handleStartFenceCapture}
            >
              <Image
                source={require("../assets/add-fence.png")}
                style={styles.cameraIcon}
              />
              <Text style={styles.takePhotoText}>
                Add activity fence / point
              </Text>
            </TouchableOpacity>

            {getFenceSummary() && (
              <View style={styles.photoPreview}>
                <Text style={styles.cardSubtitle}>{getFenceSummary()}</Text>
              </View>
            )}

            <TouchableOpacity
              style={styles.saveButton}
              onPress={handleSaveActivityLog}
            >
              <Text style={styles.saveButtonText}>Save activity log</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* -------------------- Select Modals -------------------- */}
      <SelectModal
        visible={projectPickerOpen}
        title="Select Project"
        items={projects}
        selectedId={projectId}
        onSelect={onSelectProject}
        onClose={() => setProjectPickerOpen(false)}
        emptyText="No projects cached yet. Tap Refresh lists when online."
      />

      <SelectModal
        visible={taskPickerOpen}
        title="Select Task (My Tasks)"
        items={myTasks}
        selectedId={
          taskPickerContext === "project"
            ? taskIdForProject
            : taskPickerContext === "task"
              ? taskMgmtTaskId
              : activityTaskId
        }
        onSelect={handleTaskPicked}
        onClose={() => setTaskPickerOpen(false)}
        emptyText="No tasks cached yet. Tap Refresh lists when online."
      />

      <SelectModal
        visible={milestonePickerOpen}
        title="Select Milestone"
        items={milestoneItems}
        selectedId={
          activeMilestoneTaskId === taskMgmtTaskId
            ? taskMgmtMilestoneId
            : activeMilestoneTaskId === activityTaskId
              ? activityMilestoneId
              : ""
        }
        onSelect={onSelectMilestone}
        onClose={() => {
          setMilestonePickerOpen(false);
          setActiveMilestoneTaskId(null);
        }}
        emptyText="No milestones cached for this task yet. If online, tap Refresh lists then reopen."
      />

      {/* -------------------- Attach User Document Modal -------------------- */}
      <Modal
        visible={attachVisible}
        transparent
        animationType="fade"
        onRequestClose={closeAttachModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Attach User Document</Text>

            <SelectField
              label="Project"
              valueText={
                attachProjectId
                  ? pickName(
                      projects.find((p) => pickId(p) === attachProjectId) || {
                        _id: attachProjectId,
                        name: attachProjectId,
                      },
                    )
                  : ""
              }
              onPress={() => {
                setProjectPickerOpen(true);
                // when project modal closes, we keep whatever projectId is set
                // and sync attachProjectId from projectId
              }}
            />

            <TextInput
              style={styles.input}
              placeholder="Select user (temporary: type userId/email)"
              value={attachUser}
              onChangeText={setAttachUser}
            />

            <TextInput
              style={styles.input}
              placeholder="Title"
              value={attachTitle}
              onChangeText={setAttachTitle}
            />
            <TextInput
              style={styles.input}
              placeholder="Tag"
              value={attachTag}
              onChangeText={setAttachTag}
            />

            {!attachPhoto ? (
              <TouchableOpacity
                style={styles.takePhotoButton}
                onPress={handleTakePhoto}
              >
                <Image
                  source={require("../assets/camera.png")}
                  style={styles.cameraIcon}
                />
                <Text style={styles.takePhotoText}>Take photo</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.photoPreview}>
                <Image
                  source={{ uri: attachPhoto }}
                  style={styles.photoPreviewImage}
                />
                <TouchableOpacity
                  style={styles.retryPhotoButton}
                  onPress={handleTakePhoto}
                >
                  <Text style={styles.retryPhotoText}>Retry photo</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity
              style={styles.saveButton}
              onPress={handleSaveAttachment}
            >
              <Text style={styles.saveButtonText}>Save attachment</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={closeAttachModal}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* -------------------- Fence Modal -------------------- */}
      <Modal
        visible={fenceModalVisible}
        transparent={false}
        animationType="slide"
        onRequestClose={handleCloseFenceModal}
      >
        <View style={styles.fenceContainer}>
          {mapRegion ? (
            <MapView
              style={styles.fenceMap}
              initialRegion={mapRegion}
              region={mapRegion}
              onRegionChangeComplete={setMapRegion}
            >
              <Polygon
                coordinates={DUMMY_TASK_FENCE}
                strokeColor="rgba(34,166,179,1)"
                fillColor="rgba(34,166,179,0.2)"
                strokeWidth={2}
              />

              {activityFencePoints.length === 1 && (
                <Marker
                  coordinate={activityFencePoints[0]}
                  title="Activity point"
                  description="Captured from GPS"
                />
              )}

              {activityFencePoints.length >= 2 && (
                <Polygon
                  coordinates={activityFencePoints}
                  strokeColor="rgba(231, 76, 60, 1)"
                  fillColor="rgba(231, 76, 60, 0.2)"
                  strokeWidth={2}
                />
              )}
            </MapView>
          ) : (
            <View style={styles.fenceLoading}>
              <Text style={styles.cardSubtitle}>Getting location…</Text>
            </View>
          )}

          <View style={styles.fenceControls}>
            <TouchableOpacity
              style={[
                styles.saveButton,
                styles.fenceControlButton,
                autoCapturing && { backgroundColor: "#95a5a6" },
              ]}
              onPress={autoCapturing ? stopAutoCapture : startAutoCapture}
            >
              <Text style={styles.saveButtonText}>
                {autoCapturing ? "Stop capture" : "Start capture"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.takePhotoButton,
                styles.fenceControlButton,
                { marginBottom: 0 },
              ]}
              onPress={handleConfirmFence}
            >
              <Text style={styles.takePhotoText}>Done</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.takePhotoButton,
                styles.fenceControlButton,
                { marginBottom: 0 },
              ]}
              onPress={handleCloseFenceModal}
            >
              <Text style={styles.takePhotoText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

function ModeButton({ label, selected, onPress, icon }) {
  return (
    <TouchableOpacity
      style={[styles.modeButton, selected && styles.modeButtonSelected]}
      onPress={onPress}
    >
      <Image source={icon} style={styles.modeIcon} />
      <Text style={[styles.modeLabel, selected && styles.modeLabelSelected]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const THEME_COLOR = "#22a6b3";

const DUMMY_TASK_FENCE = [
  { latitude: -29.8445, longitude: 30.8936 },
  { latitude: -29.8445, longitude: 30.9036 },
  { latitude: -29.8545, longitude: 30.9036 },
  { latitude: -29.8545, longitude: 30.8936 },
];

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

  refreshRow: {
    marginBottom: 10,
  },
  refreshButton: {
    backgroundColor: "#2c3e50",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  refreshButtonText: {
    color: "#fff",
    fontWeight: "700",
  },

  modeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  modeButton: {
    flex: 1,
    backgroundColor: "#ffffff",
    borderRadius: 10,
    paddingVertical: 10,
    marginHorizontal: 4,
    alignItems: "center",
    elevation: 2,
  },
  modeButtonSelected: {
    borderWidth: 2,
    borderColor: THEME_COLOR,
  },
  modeIcon: {
    width: 48,
    height: 48,
    marginBottom: 4,
  },
  modeLabel: {
    fontSize: 11,
    textAlign: "center",
  },
  modeLabelSelected: {
    color: THEME_COLOR,
    fontWeight: "600",
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

  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
    backgroundColor: "#fafafa",
  },
  textArea: {
    height: 80,
    textAlignVertical: "top",
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

  attachButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: THEME_COLOR,
    marginTop: 4,
    marginBottom: 12,
  },
  attachIcon: {
    width: 32,
    height: 32,
    marginRight: 8,
  },
  attachText: {
    fontSize: 13,
    color: THEME_COLOR,
    fontWeight: "500",
  },

  takePhotoButton: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    borderWidth: 1,
    borderColor: THEME_COLOR,
    borderRadius: 6,
    marginBottom: 12,
  },
  takePhotoText: {
    marginLeft: 8,
    color: THEME_COLOR,
    fontWeight: "600",
  },
  cameraIcon: {
    width: 32,
    height: 32,
  },

  photoPreview: {
    padding: 10,
    borderRadius: 6,
    backgroundColor: "#eef",
    marginBottom: 12,
    alignItems: "center",
  },
  photoPreviewImage: {
    width: 120,
    height: 120,
    marginBottom: 8,
    borderRadius: 6,
  },
  retryPhotoButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: "#f39c12",
  },
  retryPhotoText: {
    color: "#fff",
    fontWeight: "600",
  },

  saveButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: "center",
    marginTop: 4,
  },
  saveButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
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
    marginBottom: 16,
    textAlign: "center",
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

  // select modal styles
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

  fenceContainer: {
    flex: 1,
    backgroundColor: "#fff",
  },
  fenceMap: {
    flex: 1,
  },
  fenceControls: {
    flexDirection: "row",
    padding: 12,
    backgroundColor: "#fff",
  },
  fenceControlButton: {
    flex: 1,
    marginHorizontal: 4,
  },
  fenceLoading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
