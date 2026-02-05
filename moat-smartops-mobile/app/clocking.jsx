// app/clocking.jsx
// FULL DROP-IN REPLACEMENT
//
// What this version does (plain English):
// ✅ Project/Task optional (dropdowns from cache)
// ✅ Group required (dropdown from cache)
// ✅ Admin/Manager/PM can select ANY group (filtered by project/task if chosen)
// ✅ Group Leader (any role) can select only groups they lead
// ✅ People list shows only members in the selected group
// ✅ If Clock Type = OUT, only shows people currently clocked IN (based on local history)
// ✅ Start opens a "Select people" screen (NOT biometrics yet)
// ✅ Scan Face button is there (placeholder for later biometric match)
// ✅ Manual clocking is ONLY allowed when you press “Manual (biometric failed)”
// ✅ Manual requires: NEW NOTE + PHOTO for that person (overrides batch note for that person)
// ✅ Saves everything offline-first into SQLite offline_events via saveClockBatch(batch, people)
//
// IMPORTANT:
// - This expects your database.js to export saveClockBatch(batch, people).
// - If you do NOT have saveClockBatch yet, tell me and I’ll give you the exact database.js add-on.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import * as SQLite from "expo-sqlite";
import { useEffect, useMemo, useState } from "react";
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

import { saveClockBatch } from "../database";

const THEME_COLOR = "#22a6b3";

/* -----------------------------
   Offline cache keys (match your Offline screen)
------------------------------*/
const CACHE_PROJECTS_KEY = "@moat:cache:projects";
const CACHE_TASKS_KEY = "@moat:cache:tasks";
const CACHE_GROUPS_KEY = "@moat:cache:groups";
const CACHE_USERS_KEY = "@moat:cache:users";
const ORG_KEY = "@moat:cache:orgid";
const TOKEN_KEY = "@moat:cache:token";
const USER_ID_KEYS = ["@moat:userId", "@moat:userid", "moat:userid"];

/* -----------------------------
   Clock Types
------------------------------*/
const CLOCK_TYPES = [
  { key: "in", label: "In" },
  { key: "out", label: "Out" },
  { key: "training", label: "Training" },
  { key: "sick", label: "Sick" },
  { key: "iod", label: "IOD" },
  { key: "leave", label: "Leave" },
  { key: "overtime", label: "Overtime" },
];

function getClockTypeLabel(key) {
  const found = CLOCK_TYPES.find((t) => t.key === key);
  return found ? found.label : key;
}

/* -----------------------------
   Helpers (safe)
------------------------------*/
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

function extractRolesFromTokenPayload(payload) {
  if (!payload || typeof payload !== "object") return [];

  const direct =
    payload.roles ||
    payload.role ||
    payload.userRoles ||
    payload["https://moat/roles"] ||
    payload["https://moattechnologies.com/roles"] ||
    [];

  if (Array.isArray(direct)) return direct.map((r) => String(r).toLowerCase());
  if (typeof direct === "string") return [direct.toLowerCase()];

  const nested = payload.claims?.roles || payload.claims?.role || [];
  if (Array.isArray(nested)) return nested.map((r) => String(r).toLowerCase());
  if (typeof nested === "string") return [nested.toLowerCase()];

  return [];
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

function userHasManagerRights({ user, tokenRoles = [] }) {
  const roles = Array.isArray(user?.roles)
    ? user.roles.map((r) => String(r).toLowerCase())
    : [];
  const all = [...roles, ...(tokenRoles || [])].map((r) =>
    String(r).toLowerCase(),
  );

  const allow = new Set([
    "admin",
    "superadmin",
    "owner",
    "manager",
    "project-manager",
    "projectmanager",
    "pm",
  ]);

  return all.some((r) => allow.has(r));
}

function isLeaderForGroup(group, userId, userEmail) {
  if (!group) return false;

  const uid = userId ? String(userId) : "";
  const uemail = userEmail ? String(userEmail).toLowerCase() : "";

  const idCandidates = [
    group.leaderUserId,
    group.leaderId,
    group.managerUserId,
    group.groupLeaderId,
    group.groupLeaderUserId,
    group.leaderUserID,
  ]
    .filter(Boolean)
    .map(String);

  if (uid && idCandidates.includes(uid)) return true;

  const emailCandidates = [
    group.leaderEmail,
    group.managerEmail,
    group.groupLeaderEmail,
    group.createdBy,
    group.updatedBy,
  ]
    .filter(Boolean)
    .map((e) => String(e).toLowerCase());

  if (uemail && emailCandidates.includes(uemail)) return true;

  const arrays = [
    group.leaderUserIds,
    group.leaders,
    group.leaderIds,
    group.managerUserIds,
    group.groupLeaders,
    group.leaderUsers,
  ].filter(Boolean);

  for (const a of arrays) {
    if (!Array.isArray(a)) continue;

    if (uid) {
      const ids = a
        .map((x) => String(x?._id || x?.id || x || ""))
        .filter(Boolean);
      if (ids.includes(uid)) return true;
    }

    if (uemail) {
      const emails = a
        .map((x) => String(x?.email || x?.mail || x || ""))
        .map((s) => s.toLowerCase())
        .filter(Boolean);
      if (emails.includes(uemail)) return true;
    }
  }

  return false;
}

function getGroupMemberUserIds(group) {
  if (!group) return [];

  const arrays = [
    group.memberUserIds,
    group.members,
    group.userIds,
    group.users,
    group.staffUserIds,
    group.staff,
  ].filter(Boolean);

  for (const a of arrays) {
    if (!Array.isArray(a)) continue;
    const ids = a
      .map((x) => String(x?._id || x?.id || x || ""))
      .filter(Boolean);
    if (ids.length) return ids;
  }

  return [];
}

function groupMatchesContext(group, projectId, taskId) {
  if (!group) return false;

  // If no context selected, everything matches
  if (!projectId && !taskId) return true;

  const pid = projectId ? String(projectId) : "";
  const tid = taskId ? String(taskId) : "";

  // Most reliable: group has explicit arrays
  const projectIdsArr = Array.isArray(group.projectIds)
    ? group.projectIds
        .map((x) => String(x?._id || x?.id || x || ""))
        .filter(Boolean)
    : [];

  const taskIdsArr = Array.isArray(group.taskIds)
    ? group.taskIds
        .map((x) => String(x?._id || x?.id || x || ""))
        .filter(Boolean)
    : [];

  // Also accept single fields
  const groupProject =
    group.projectId?._id ||
    group.projectId?.id ||
    group.projectId ||
    group.project ||
    "";

  const groupTask =
    group.taskId?._id || group.taskId?.id || group.taskId || group.task || "";

  const projectOk =
    !pid ||
    String(groupProject) === pid ||
    projectIdsArr.includes(pid) ||
    // also accept task-linked group where task belongs to project (handled elsewhere)
    false;

  const taskOk = !tid || String(groupTask) === tid || taskIdsArr.includes(tid);

  return projectOk && taskOk;
}

/* -----------------------------
   SQLite: infer "currently clocked in"
------------------------------*/
async function openDb() {
  return await SQLite.openDatabaseAsync("moatSmartOps.db");
}

function extractClockBatchFromRow(row) {
  const payload = safeJsonParse(row?.payloadJson || "{}") || {};
  const batch = payload?.batch || payload;
  const people =
    payload?.people || payload?.selectedPeople || payload?.members || [];
  return { batch, people };
}

async function computeCurrentlyInUserIds({ orgId = null } = {}) {
  try {
    const db = await openDb();
    const rows = await db.getAllAsync(
      `SELECT id, eventType, payloadJson, createdAt
       FROM offline_events
       WHERE eventType IN ('clock-batch', 'clocking-batch', 'clock-batch-v1', 'clocking', 'clock-batch-v2')
       ORDER BY createdAt ASC
       LIMIT 5000`,
    );

    const lastByUser = new Map();

    for (const r of rows || []) {
      const { batch, people } = extractClockBatchFromRow(r);

      if (orgId && batch?.orgId && String(batch.orgId) !== String(orgId))
        continue;

      const ct = String(batch?.clockType || "").toLowerCase();
      if (!ct) continue;

      const when = String(batch?.createdAt || r?.createdAt || "");

      const arr = Array.isArray(people) ? people : [];
      for (const p of arr) {
        const uid = String(p?.userId || p?._id || p?.id || "");
        if (!uid) continue;
        lastByUser.set(uid, { clockType: ct, createdAt: when });
      }
    }

    const inSet = new Set();
    for (const [uid, last] of lastByUser.entries()) {
      if (String(last?.clockType) === "out") continue;
      inSet.add(uid);
    }

    return Array.from(inSet);
  } catch {
    return [];
  }
}

/* -----------------------------
   Simple Select Modal
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
              style={{ maxHeight: 420 }}
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
   Manual Clock Modal (forces NOTE + PHOTO)
------------------------------*/
function ManualClockModal({ visible, person, onCancel, onConfirm }) {
  const [note, setNote] = useState("");
  const [photoUri, setPhotoUri] = useState(null);

  useEffect(() => {
    if (visible) {
      setNote("");
      setPhotoUri(null);
    }
  }, [visible]);

  async function takePhoto() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Camera permission", "Camera access is required.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.6 });
    if (result.canceled) return;
    const uri =
      result.assets && result.assets.length > 0 ? result.assets[0].uri : null;
    if (uri) setPhotoUri(uri);
  }

  const ok = note.trim().length >= 3 && !!photoUri;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.manualCard}>
          <Text style={styles.manualTitle}>
            Manual clocking (biometric failed)
          </Text>
          <Text style={styles.manualSub}>
            Worker: {person?.name || person?.email || person?.userId || "-"}
          </Text>

          <TextInput
            style={styles.input}
            placeholder="REQUIRED note (why manual clocking?)"
            placeholderTextColor="#aaa"
            value={note}
            onChangeText={setNote}
          />

          <TouchableOpacity style={styles.secondaryButton} onPress={takePhoto}>
            <Text style={styles.secondaryButtonText}>
              {photoUri ? "Retake photo" : "Take photo (required)"}
            </Text>
          </TouchableOpacity>

          {photoUri ? (
            <View style={{ alignItems: "center", marginTop: 10 }}>
              <Image source={{ uri: photoUri }} style={styles.manualPhoto} />
              <Text style={styles.smallInfoText}>Manual proof photo</Text>
            </View>
          ) : null}

          <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
            <TouchableOpacity
              style={[styles.secondaryButton, { flex: 1 }]}
              onPress={onCancel}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.primaryButton, { flex: 1, opacity: ok ? 1 : 0.5 }]}
              disabled={!ok}
              onPress={() => onConfirm({ note: note.trim(), photoUri })}
            >
              <Text style={[styles.primaryButtonText, { marginLeft: 0 }]}>
                Confirm manual
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/* -----------------------------
   Main Screen
------------------------------*/
export default function ClockingScreen() {
  const router = useRouter();

  // Cached lists
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);

  // Current identity
  const [currentUserId, setCurrentUserId] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [orgId, setOrgId] = useState("");
  const [tokenRoles, setTokenRoles] = useState([]);
  const [currentUserEmail, setCurrentUserEmail] = useState("");

  // Selections
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [clockType, setClockType] = useState("");
  const [batchNote, setBatchNote] = useState("");

  // Modals
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  const [clockTypePickerVisible, setClockTypePickerVisible] = useState(false);

  // People selection modal
  const [scanModalVisible, setScanModalVisible] = useState(false);
  const [personSearch, setPersonSearch] = useState("");
  const [selectedPeople, setSelectedPeople] = useState([]); // [{ userId, name, method, status, note, manualPhotoUri }]

  // manual modal state
  const [manualModalVisible, setManualModalVisible] = useState(false);
  const [manualTarget, setManualTarget] = useState(null); // person object (user)

  // For "clock out" filtering
  const [inUserIds, setInUserIds] = useState([]);
  const [loadingInSet, setLoadingInSet] = useState(false);

  useEffect(() => {
    (async () => {
      const [p, t, g, u] = await Promise.all([
        loadCache(CACHE_PROJECTS_KEY, []),
        loadCache(CACHE_TASKS_KEY, []),
        loadCache(CACHE_GROUPS_KEY, []),
        loadCache(CACHE_USERS_KEY, []),
      ]);

      setProjects(Array.isArray(p) ? p : []);
      setTasks(Array.isArray(t) ? t : []);
      setGroups(Array.isArray(g) ? g : []);
      setUsers(Array.isArray(u) ? u : []);

      const uid = await getCurrentUserId();
      setCurrentUserId(uid);

      const oid = (await AsyncStorage.getItem(ORG_KEY)) || "";
      setOrgId(oid);

      const token = await AsyncStorage.getItem(TOKEN_KEY);
      const payload = token ? decodeJwtPayload(token) : null;

      const rolesFromToken = extractRolesFromTokenPayload(payload);
      setTokenRoles(rolesFromToken);

      const emailFromToken =
        payload?.email ||
        payload?.user_email ||
        payload?.upn ||
        payload?.preferred_username ||
        "";
      setCurrentUserEmail(String(emailFromToken || "").toLowerCase());

      const cu =
        (Array.isArray(u) ? u : []).find(
          (x) => String(pickId(x)) === String(uid),
        ) ||
        (Array.isArray(u) ? u : []).find(
          (x) =>
            String(x?.email || "").toLowerCase() ===
            String(emailFromToken || "").toLowerCase(),
        ) ||
        null;

      setCurrentUser(cu);
    })();
  }, []);

  // If clockType is "out", compute who is currently in
  useEffect(() => {
    (async () => {
      if (String(clockType).toLowerCase() !== "out") return;
      setLoadingInSet(true);
      const ids = await computeCurrentlyInUserIds({ orgId: orgId || null });
      setInUserIds(ids);
      setLoadingInSet(false);
    })();
  }, [clockType, orgId]);

  const isManager = userHasManagerRights({ user: currentUser, tokenRoles });

  const selectedProject = projects.find((p) => pickId(p) === projectId) || null;
  const selectedTask = tasks.find((t) => pickId(t) === taskId) || null;
  const selectedGroup = groups.find((g) => pickId(g) === groupId) || null;

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

  // ✅ IMPORTANT FIX:
  // If project/task selected, we filter groups by:
  //   1) group.projectIds / group.taskIds (if present)
  //   2) task.assignedGroupIds (if task selected)
  //   3) otherwise we do NOT block groups just because group has no projectIds/taskIds
  const taskAssignedGroupIds = useMemo(() => {
    if (!selectedTask) return [];
    const arr = selectedTask?.assignedGroupIds || selectedTask?.groupIds || [];
    return Array.isArray(arr) ? arr.map(String) : [];
  }, [selectedTask]);

  const groupsForContext = useMemo(() => {
    // base filter: org match (if group has orgId)
    const base = groups.filter((g) => {
      if (!g?.orgId) return true; // keep groups with null orgId (like seeded)
      if (!orgId) return true;
      return String(g.orgId) === String(orgId);
    });

    // if no project/task selected -> show all base groups
    if (!projectId && !taskId) return base;

    const pid = String(projectId || "");
    const tid = String(taskId || "");

    return base.filter((g) => {
      const gid = String(pickId(g));

      // 1) direct group linkage fields (if you ever add them)
      const directOk = groupMatchesContext(g, pid || null, tid || null);
      if (directOk) return true;

      // 2) if task selected and task has assignedGroupIds, allow those groups
      if (tid && taskAssignedGroupIds.length) {
        if (taskAssignedGroupIds.includes(gid)) return true;
      }

      // 3) otherwise do not block
      // (This is the key: your groups currently don’t carry projectIds/taskIds,
      //  so we must not hide them when project/task is selected.)
      return true;
    });
  }, [groups, orgId, projectId, taskId, taskAssignedGroupIds]);

  // Group filtering based on permissions (manager/admin sees all, leader sees only their leader groups)
  const allowedGroups = useMemo(() => {
    if (isManager) return groupsForContext;

    if (!currentUserId && !currentUserEmail) return [];
    return groupsForContext.filter((g) =>
      isLeaderForGroup(g, currentUserId, currentUserEmail),
    );
  }, [groupsForContext, isManager, currentUserId, currentUserEmail]);

  // People list: members of selected group
  const groupMemberUsers = useMemo(() => {
    if (!selectedGroup) return [];
    const ids = getGroupMemberUserIds(selectedGroup);
    if (!ids.length) return [];
    const setIds = new Set(ids.map(String));
    return users.filter((u) => setIds.has(String(pickId(u))));
  }, [selectedGroup, users]);

  // For clock out: only show currently in
  const visibleUsersForClocking = useMemo(() => {
    const ct = String(clockType).toLowerCase();
    let base = groupMemberUsers;

    if (ct === "out") {
      const inSet = new Set((inUserIds || []).map(String));
      base = base.filter((u) => inSet.has(String(pickId(u))));
    }

    const q = personSearch.trim().toLowerCase();
    if (!q) return base;

    return base.filter((u) => {
      const name = String(u?.name || "").toLowerCase();
      const email = String(u?.email || "").toLowerCase();
      const staff = String(u?.staffNumber || "").toLowerCase();
      return name.includes(q) || email.includes(q) || staff.includes(q);
    });
  }, [groupMemberUsers, clockType, inUserIds, personSearch]);

  function isSelected(uid) {
    return selectedPeople.some((p) => String(p.userId) === String(uid));
  }

  function togglePerson(userObj, method = "list") {
    const uid = String(pickId(userObj));
    if (!uid) return;

    setSelectedPeople((prev) => {
      const exists = prev.find((p) => String(p.userId) === uid);
      if (exists) return prev.filter((p) => String(p.userId) !== uid);

      return [
        ...prev,
        {
          userId: uid,
          name: userObj?.name || userObj?.email || uid,
          method, // list/manual/face
          status: "present",
          note: "", // per-person override note (used for manual)
          manualPhotoUri: null, // required for manual
        },
      ];
    });
  }

  function cycleStatus(userId) {
    setSelectedPeople((prev) =>
      prev.map((p) => {
        if (String(p.userId) !== String(userId)) return p;
        let next = "present";
        if (p.status === "present") next = "sick";
        else if (p.status === "sick") next = "absent";
        else next = "present";
        return { ...p, status: next };
      }),
    );
  }

  const openPeopleModal = () => {
    if (!groupId || !clockType) {
      Alert.alert(
        "Missing info",
        "Please select group and clocking type first.",
      );
      return;
    }
    setScanModalVisible(true);
  };

  const closePeopleModal = () => setScanModalVisible(false);

  // placeholder biometric scan
  const handleScanFace = () => {
    Alert.alert(
      "Biometrics (next step)",
      "This will scan a face and auto-select the correct worker. For now, use the list below.",
    );
  };

  // manual only after biometric fails
  const startManualForUser = (userObj) => {
    // open manual modal for this person
    const uid = String(pickId(userObj));
    if (!uid) return;

    // ensure person is selected before manual proof is applied
    if (!isSelected(uid)) {
      togglePerson(userObj, "manual");
    }
    setManualTarget(userObj);
    setManualModalVisible(true);
  };

  const applyManualProof = ({ note, photoUri }) => {
    const uid = String(pickId(manualTarget));
    setSelectedPeople((prev) =>
      prev.map((p) => {
        if (String(p.userId) !== uid) return p;
        return {
          ...p,
          method: "manual",
          // ✅ override note for this person (replaces batch note for this person)
          note,
          manualPhotoUri: photoUri,
        };
      }),
    );
    setManualModalVisible(false);
    setManualTarget(null);
    Alert.alert(
      "Manual captured",
      "Manual note + photo saved for this person.",
    );
  };

  const handleSaveBatch = async () => {
    if (!groupId || !clockType) {
      Alert.alert("Missing info", "Please select group and clocking type.");
      return;
    }
    if (selectedPeople.length === 0) {
      Alert.alert("No people selected", "Please select at least one person.");
      return;
    }

    // ✅ enforce manual rule: anyone marked manual MUST have note + photo
    const missingManual = selectedPeople.find(
      (p) =>
        String(p.method) === "manual" &&
        (!p.note?.trim?.() || !p.manualPhotoUri),
    );
    if (missingManual) {
      Alert.alert(
        "Manual requires note + photo",
        `Manual clocking is missing a note/photo for: ${missingManual.name || missingManual.userId}`,
      );
      return;
    }

    const timestamp = new Date().toISOString();

    const batch = {
      orgId: orgId || null,
      projectId: projectId || null,
      taskId: taskId || null,
      groupId: groupId || null,
      clockType,
      // batch note applies to everyone EXCEPT manual people (manual overrides per-person)
      note: batchNote || "",
      createdAt: timestamp,
      updatedAt: timestamp,
      syncStatus: "pending",
    };

    const people = selectedPeople.map((p) => ({
      userId: p.userId,
      name: p.name,
      method: p.method || "list",
      status: p.status || "present",

      // ✅ if manual: override note, else batch note is enough
      note: String(p.method) === "manual" ? p.note || "" : batchNote || "",

      // ✅ manual proof photo stored per-person
      manualPhotoUri: p.manualPhotoUri || null,
    }));

    try {
      await saveClockBatch(batch, people);
      Alert.alert("Saved", "Clocking batch captured (offline-first).");

      // reset
      setSelectedPeople([]);
      setBatchNote("");
      setScanModalVisible(false);
      setPersonSearch("");

      if (String(clockType).toLowerCase() === "out") {
        setLoadingInSet(true);
        const ids = await computeCurrentlyInUserIds({ orgId: orgId || null });
        setInUserIds(ids);
        setLoadingInSet(false);
      }
    } catch (e) {
      console.error("Failed to save clocking batch", e);
      Alert.alert(
        "Save failed",
        e?.message || "Could not save this clocking batch.",
      );
    }
  };

  const goToBiometricOnboarding = () => {
    if (!isManager) {
      Alert.alert("Not allowed", "Only managers/admin can onboard biometrics.");
      return;
    }
    router.push("/biometrics/onboard");
  };

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <Image
            source={require("../assets/clockings-screen.png")}
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

        {/* Selection card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Clocking</Text>
          <Text style={styles.cardSubtitle}>
            Project & Task optional. Group and clocking type required.
          </Text>

          <SelectField
            label="Project (optional)"
            valueText={selectedProject ? pickName(selectedProject) : ""}
            onPress={() => setProjectPickerOpen(true)}
          />

          <SelectField
            label="Task (optional)"
            valueText={selectedTask ? pickName(selectedTask) : ""}
            onPress={() => setTaskPickerOpen(true)}
            disabled={!projectId && tasks.length === 0}
          />

          <SelectField
            label={
              isManager ? "Group (all groups)" : "Group (your leader groups)"
            }
            valueText={selectedGroup ? pickName(selectedGroup) : ""}
            onPress={() => setGroupPickerOpen(true)}
          />

          <TouchableOpacity
            style={styles.selectInput}
            onPress={() => setClockTypePickerVisible(true)}
          >
            <Text
              style={
                clockType
                  ? styles.selectInputText
                  : styles.selectInputPlaceholder
              }
            >
              {clockType ? getClockTypeLabel(clockType) : "Clocking type"}
            </Text>
            <Text style={styles.selectChevron}>▼</Text>
          </TouchableOpacity>

          {String(clockType).toLowerCase() === "out" ? (
            <Text style={styles.smallInfoText}>
              {loadingInSet
                ? "Loading who is currently clocked in…"
                : "Clock OUT: only currently clocked-in staff will show."}
            </Text>
          ) : null}

          <TextInput
            style={[styles.input, styles.textArea]}
            placeholder="Batch note (optional)"
            placeholderTextColor="#aaa"
            value={batchNote}
            onChangeText={setBatchNote}
            multiline
          />

          <TouchableOpacity
            style={styles.primaryButton}
            onPress={openPeopleModal}
          >
            <Image
              source={require("../assets/scan.png")}
              style={styles.scanIcon}
            />
            <Text style={styles.primaryButtonText}>Start (select people)</Text>
          </TouchableOpacity>

          {isManager ? (
            <TouchableOpacity
              style={[styles.secondaryButton, { marginTop: 10 }]}
              onPress={goToBiometricOnboarding}
            >
              <Text style={styles.secondaryButtonText}>Onboard biometrics</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Selected people summary */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Selected people</Text>
          <Text style={styles.cardSubtitle}>
            Tap a person to cycle status (Present → Sick → Absent).
          </Text>

          {selectedPeople.length === 0 ? (
            <Text style={styles.emptyText}>No people selected yet.</Text>
          ) : (
            selectedPeople.map((p) => (
              <TouchableOpacity
                key={p.userId}
                style={styles.personRow}
                onPress={() => cycleStatus(p.userId)}
              >
                <View style={styles.personInfo}>
                  <Text style={styles.personName}>{p.name}</Text>
                  <Text style={styles.personMethod}>
                    {p.method === "face"
                      ? "Scan"
                      : p.method === "manual"
                        ? "Manual"
                        : "List"}
                    {p.method === "manual" && p.note
                      ? ` • Note: ${p.note}`
                      : ""}
                  </Text>
                </View>

                <View style={styles.statusBadge(p.status)}>
                  <Text style={styles.statusBadgeText}>
                    {p.status === "present"
                      ? "Present"
                      : p.status === "sick"
                        ? "Sick"
                        : "Absent"}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          )}

          <TouchableOpacity
            style={[
              styles.primaryButton,
              selectedPeople.length === 0 && { opacity: 0.4 },
            ]}
            onPress={handleSaveBatch}
            disabled={selectedPeople.length === 0}
          >
            <Text style={[styles.primaryButtonText, { marginLeft: 0 }]}>
              Done
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* -------------------- Modals -------------------- */}
      <SelectModal
        visible={projectPickerOpen}
        title="Select Project (optional)"
        items={projects}
        selectedId={projectId}
        onSelect={(p) => {
          const id = pickId(p);
          setProjectId(id);

          // clear task if it no longer matches
          if (taskId) {
            const still = tasksForProject.find((t) => pickId(t) === taskId);
            if (!still) setTaskId("");
          }

          // clear group + selected people when context changes
          setGroupId("");
          setSelectedPeople([]);
          setPersonSearch("");

          setProjectPickerOpen(false);
        }}
        onClose={() => setProjectPickerOpen(false)}
        emptyText="No projects cached yet. Go to Offline screen and refresh lists."
      />

      <SelectModal
        visible={taskPickerOpen}
        title="Select Task (optional)"
        items={tasksForProject}
        selectedId={taskId}
        onSelect={(t) => {
          setTaskId(pickId(t));

          // clear group + selected people when context changes
          setGroupId("");
          setSelectedPeople([]);
          setPersonSearch("");

          setTaskPickerOpen(false);
        }}
        onClose={() => setTaskPickerOpen(false)}
        emptyText="No tasks cached yet. Go to Offline screen and refresh lists."
      />

      <SelectModal
        visible={groupPickerOpen}
        title="Select Group"
        items={allowedGroups}
        selectedId={groupId}
        onSelect={(g) => {
          setGroupId(pickId(g));
          setSelectedPeople([]);
          setPersonSearch("");
          setGroupPickerOpen(false);
        }}
        onClose={() => setGroupPickerOpen(false)}
        emptyText={
          isManager
            ? "No groups cached yet. Go to Offline screen and refresh lists."
            : "No leader groups found for you yet. Ask admin to assign you as group leader (or refresh lists)."
        }
      />

      {/* CLOCK TYPE PICKER */}
      <Modal
        visible={clockTypePickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setClockTypePickerVisible(false)}
      >
        <View style={styles.typeModalOverlay}>
          <View style={styles.typeModalCard}>
            <Text style={styles.typeModalTitle}>Select clocking type</Text>
            {CLOCK_TYPES.map((t) => (
              <TouchableOpacity
                key={t.key}
                style={styles.typeOption}
                onPress={() => {
                  setClockType(t.key);
                  setSelectedPeople([]);
                  setPersonSearch("");
                  setClockTypePickerVisible(false);
                }}
              >
                <Text
                  style={[
                    styles.typeOptionText,
                    clockType === t.key && styles.typeOptionTextSelected,
                  ]}
                >
                  {t.label}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.secondaryButton, { marginTop: 8 }]}
              onPress={() => setClockTypePickerVisible(false)}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* PEOPLE SELECT MODAL */}
      <Modal
        visible={scanModalVisible}
        transparent
        animationType="slide"
        onRequestClose={closePeopleModal}
      >
        <View style={styles.scanModalOverlay}>
          <View style={styles.scanModalCard}>
            <Text style={styles.scanTitle}>Select people</Text>
            <Text style={styles.scanSubtitle}>
              Project: {selectedProject ? pickName(selectedProject) : "-"}{" "}
              {"\n"}
              Task: {selectedTask ? pickName(selectedTask) : "-"} {"\n"}
              Group: {selectedGroup ? pickName(selectedGroup) : "-"} {"\n"}
              Type: {clockType ? getClockTypeLabel(clockType) : "-"}
            </Text>

            <View style={styles.scanButtonsRow}>
              <TouchableOpacity
                style={[styles.primaryButton, styles.scanButton]}
                onPress={handleScanFace}
              >
                <Image
                  source={require("../assets/scan.png")}
                  style={styles.scanIcon}
                />
                <Text style={styles.primaryButtonText}>Scan face</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.smallInfoText}>
              Manual is only used when biometric fails (per person).
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Search name / email / staff #"
              placeholderTextColor="#aaa"
              value={personSearch}
              onChangeText={setPersonSearch}
            />

            {!groupId ? (
              <Text style={styles.emptyText}>Select a group first.</Text>
            ) : visibleUsersForClocking.length === 0 ? (
              <Text style={styles.emptyText}>
                {String(clockType).toLowerCase() === "out"
                  ? "No one is currently clocked in (based on local history)."
                  : "No users found for this group (or not cached yet)."}
              </Text>
            ) : (
              <FlatList
                data={visibleUsersForClocking}
                keyExtractor={(u) => String(pickId(u))}
                style={{ maxHeight: 320 }}
                renderItem={({ item }) => {
                  const uid = String(pickId(item));
                  const selected = isSelected(uid);

                  return (
                    <View style={styles.userRow}>
                      <TouchableOpacity
                        style={[
                          styles.userMain,
                          selected && styles.userMainSelected,
                        ]}
                        onPress={() => togglePerson(item, "list")}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.userRowName}>
                            {item?.name || item?.email || uid}
                          </Text>
                          <Text style={styles.userRowMeta}>
                            {item?.email ? item.email : ""}{" "}
                            {item?.staffNumber ? `| ${item.staffNumber}` : ""}
                          </Text>
                        </View>
                        <Text
                          style={[
                            styles.userRowTick,
                            selected && { color: THEME_COLOR },
                          ]}
                        >
                          {selected ? "✓" : ""}
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={styles.manualMiniBtn}
                        onPress={() => startManualForUser(item)}
                      >
                        <Text style={styles.manualMiniText}>Manual</Text>
                      </TouchableOpacity>
                    </View>
                  );
                }}
              />
            )}

            <View style={styles.scanFooterButtons}>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.scanFooterButton]}
                onPress={closePeopleModal}
              >
                <Text style={styles.secondaryButtonText}>Close</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.scanFooterButton,
                  selectedPeople.length === 0 && { opacity: 0.5 },
                ]}
                onPress={closePeopleModal}
                disabled={selectedPeople.length === 0}
              >
                <Text style={[styles.primaryButtonText, { marginLeft: 0 }]}>
                  Done
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Manual proof modal */}
      <ManualClockModal
        visible={manualModalVisible}
        person={{
          userId: manualTarget ? pickId(manualTarget) : "",
          name: manualTarget?.name,
          email: manualTarget?.email,
        }}
        onCancel={() => {
          setManualModalVisible(false);
          setManualTarget(null);
        }}
        onConfirm={applyManualProof}
      />
    </>
  );
}

/* -----------------------------
   Styles
------------------------------*/
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
  cardSubtitle: { fontSize: 12, color: "#666", marginBottom: 12 },

  smallInfoText: { fontSize: 11, color: "#666", marginBottom: 10 },

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
  secondaryButton: {
    borderWidth: 1,
    borderColor: THEME_COLOR,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  secondaryButtonText: { color: THEME_COLOR, fontSize: 14, fontWeight: "600" },

  scanIcon: { width: 32, height: 32 },
  emptyText: { fontSize: 12, color: "#999" },

  personRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  personInfo: { flex: 1 },
  personName: { fontSize: 14, fontWeight: "500" },
  personMethod: { fontSize: 11, color: "#777", marginTop: 2 },
  statusBadge: (status) => ({
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor:
      status === "present"
        ? "#27ae60"
        : status === "sick"
          ? "#f39c12"
          : "#e74c3c",
  }),
  statusBadgeText: { color: "#fff", fontSize: 11, fontWeight: "600" },

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

  // Clock type picker modal
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

  // People modal
  scanModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  scanModalCard: { backgroundColor: "#fff", borderRadius: 10, padding: 20 },
  scanTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 8,
    textAlign: "center",
  },
  scanSubtitle: {
    fontSize: 12,
    color: "#666",
    marginBottom: 12,
    textAlign: "center",
  },
  scanButtonsRow: { flexDirection: "row", marginBottom: 12 },
  scanButton: { flex: 1, marginHorizontal: 4 },

  userRow: { flexDirection: "row", alignItems: "stretch", marginBottom: 6 },
  userMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    borderRadius: 8,
    backgroundColor: "#fff",
  },
  userMainSelected: { backgroundColor: "#e8f8fa" },

  manualMiniBtn: {
    marginLeft: 8,
    width: 78,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: THEME_COLOR,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  manualMiniText: { color: THEME_COLOR, fontWeight: "800", fontSize: 12 },

  userRowName: { fontSize: 14, fontWeight: "600" },
  userRowMeta: { fontSize: 11, color: "#777", marginTop: 2 },
  userRowTick: {
    width: 24,
    textAlign: "center",
    fontSize: 18,
    fontWeight: "900",
    color: "#bbb",
  },

  scanFooterButtons: { flexDirection: "row", marginTop: 10 },
  scanFooterButton: { flex: 1, marginHorizontal: 4 },

  // Manual modal
  manualCard: { backgroundColor: "#fff", borderRadius: 10, padding: 16 },
  manualTitle: {
    fontSize: 16,
    fontWeight: "800",
    marginBottom: 6,
    textAlign: "center",
  },
  manualSub: {
    fontSize: 12,
    color: "#666",
    marginBottom: 10,
    textAlign: "center",
  },
  manualPhoto: { width: 140, height: 140, borderRadius: 10 },
});
