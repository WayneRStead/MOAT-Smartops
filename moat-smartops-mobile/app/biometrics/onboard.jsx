// app/biometrics/onboard.jsx
// FULL DROP-IN REPLACEMENT
// Biometric onboarding (manager-only), offline-first -> inserts into offline_events
// ✅ FlatList is the ONLY vertical scroller
// ✅ Group-only filter (no project/task filters)
// ✅ Uses Firebase token email -> finds Mongo user in cached users -> uses roles correctly
// ✅ Saves biometric-enroll event to SQLite offline_events
// ✅ Caches profile photo URI in AsyncStorage for Clocking manual visual confirmation
// ✅ Debug buttons: token payload, resolved IDs, last 5 onboardings

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
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

const THEME_COLOR = "#22a6b3";

// Caches (match your Offline screen)
const CACHE_GROUPS_KEY = "@moat:cache:groups";
const CACHE_USERS_KEY = "@moat:cache:users";

// Possible token keys (your debug showed @moat:token exists)
const TOKEN_KEYS_TO_TRY = [
  "@moat:token",
  "@moat:cache:token",
  "token",
  "@token",
];

// Possible org keys
const ORG_KEYS_TO_TRY = [
  "@moat:cache:orgid",
  "@moat:cache:orgId",
  "@moat:orgid",
  "@moat:orgId",
  "moat:orgid",
  "moat:orgId",
];

// Cache profile photo for manual clocking confirmation
const BIOMETRICS_PROFILE_PHOTO_PREFIX = "@moat:biometrics:profilePhoto:";

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function pickId(x) {
  return String(x?._id || x?.id || x?.userId || x?.uid || "");
}

function pickName(x) {
  return (
    x?.name ||
    x?.title ||
    x?.code ||
    x?.ref ||
    x?.number ||
    x?.email ||
    pickId(x)
  );
}

function pickUserLabel(u) {
  if (!u) return "";
  const name = u?.name || "";
  const email = u?.email || "";
  if (name && email) return `${name} (${email})`;
  return name || email || pickId(u);
}

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return JSON.stringify({});
  }
}

function safeJsonArray(value) {
  try {
    return JSON.stringify(Array.isArray(value) ? value : []);
  } catch {
    return JSON.stringify([]);
  }
}

function decodeJwtPayload(token) {
  try {
    const part = token?.split?.(".")?.[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);

    if (typeof atob === "function") return safeJsonParse(atob(pad));
    if (typeof Buffer !== "undefined") {
      return safeJsonParse(Buffer.from(pad, "base64").toString("utf8"));
    }
    return null;
  } catch {
    return null;
  }
}

function extractEmailFromTokenPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const email =
    payload.email ||
    payload.user?.email ||
    payload.profile?.email ||
    payload.firebase?.identities?.email?.[0] ||
    "";
  return String(email || "")
    .trim()
    .toLowerCase();
}

function extractFirebaseUidFromTokenPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const uid = payload.user_id || payload.sub || payload.uid || "";
  return String(uid || "").trim();
}

function normalizeRoles(user) {
  const roles = [];
  if (Array.isArray(user?.roles)) roles.push(...user.roles);
  if (typeof user?.role === "string") roles.push(user.role);
  return Array.from(
    new Set(roles.map((r) => String(r).toLowerCase()).filter(Boolean)),
  );
}

function userHasManagerRightsFromRoles(roles = []) {
  const allow = new Set([
    "admin",
    "superadmin",
    "owner",
    "manager",
    "project-manager",
    "projectmanager",
    "pm",
  ]);
  return (roles || []).some((r) => allow.has(String(r).toLowerCase()));
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

async function getTokenBestEffort() {
  for (const k of TOKEN_KEYS_TO_TRY) {
    const v = await AsyncStorage.getItem(k);
    if (v) return v;
  }
  return "";
}

async function getOrgIdBestEffort() {
  for (const k of ORG_KEYS_TO_TRY) {
    const v = await AsyncStorage.getItem(k);
    if (v) return String(v);
  }

  // fallback from token payload
  const token = await getTokenBestEffort();
  const payload = token ? decodeJwtPayload(token) : null;
  const org =
    payload?.orgId ||
    payload?.orgID ||
    payload?.organisationId ||
    payload?.organizationId ||
    payload?.tenantId ||
    payload?.tenant ||
    "";
  return String(org || "");
}

async function openDb() {
  return await SQLite.openDatabaseAsync("moatSmartOps.db");
}

async function insertOfflineEvent({
  eventType,
  orgId,
  userId,
  entityRef = null,
  payload = {},
  fileUris = [],
}) {
  const db = await openDb();
  const createdAt = nowIso();
  const updatedAt = createdAt;

  const payloadJson = safeJson(payload);
  const fileUrisJson = safeJsonArray(fileUris);

  const result = await db.runAsync(
    `INSERT INTO offline_events
      (eventType, orgId, userId, entityRef, payloadJson, fileUrisJson, syncStatus, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      eventType,
      orgId ?? null,
      userId ?? null,
      entityRef,
      payloadJson,
      fileUrisJson,
      createdAt,
      updatedAt,
    ],
  );

  return result?.lastInsertRowId;
}

async function cacheProfilePhotoForUser(targetUserId, uri) {
  try {
    if (!targetUserId || !uri) return;
    await AsyncStorage.setItem(
      `${BIOMETRICS_PROFILE_PHOTO_PREFIX}${String(targetUserId)}`,
      String(uri),
    );
  } catch (e) {
    console.log("[Biometrics][DEBUG] cacheProfilePhotoForUser error:", e);
  }
}

async function getLastBiometricEnrollEvents(limit = 5) {
  try {
    const db = await openDb();
    const rows = await db.getAllAsync(
      `SELECT id, eventType, orgId, userId, entityRef, createdAt, payloadJson
       FROM offline_events
       WHERE eventType = 'biometric-enroll'
       ORDER BY createdAt DESC
       LIMIT ?`,
      [limit],
    );

    return (rows || []).map((r) => {
      const payload = safeJsonParse(r?.payloadJson || "{}") || {};
      return {
        id: r?.id,
        orgId: r?.orgId,
        userId: r?.userId,
        targetUserId: r?.entityRef || payload?.targetUserId,
        createdAt: r?.createdAt,
      };
    });
  } catch (e) {
    console.log("[Biometrics][DEBUG] getLastBiometricEnrollEvents error:", e);
    return [];
  }
}

// ✅ Core resolver: Firebase token -> email -> find Mongo user in cached users
async function resolveCurrentIdentity(cachedUsers = []) {
  const token = await getTokenBestEffort();
  const payload = token ? decodeJwtPayload(token) : null;

  const firebaseUid = extractFirebaseUidFromTokenPayload(payload);
  const email = extractEmailFromTokenPayload(payload);

  const usersArr = Array.isArray(cachedUsers) ? cachedUsers : [];
  const mongoUser =
    (email
      ? usersArr.find(
          (u) =>
            String(u?.email || "")
              .trim()
              .toLowerCase() === email,
        )
      : null) || null;

  const mongoUserId = mongoUser
    ? String(mongoUser._id || mongoUser.id || "")
    : "";
  const roles = mongoUser ? normalizeRoles(mongoUser) : [];

  return {
    token,
    payload,
    email,
    firebaseUid,
    mongoUser,
    mongoUserId,
    roles,
    canOnboard: userHasManagerRightsFromRoles(roles),
  };
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

/* -----------------------------
   Main Screen
------------------------------*/
export default function BiometricsOnboardScreen() {
  const router = useRouter();

  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);

  const [orgId, setOrgId] = useState("");

  // resolved identity (Mongo user + roles)
  const [resolved, setResolved] = useState({
    email: "",
    firebaseUid: "",
    mongoUserId: "",
    roles: [],
    canOnboard: false,
    mongoUser: null,
    payload: null,
  });

  const [groupId, setGroupId] = useState("");
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);

  const [userSearch, setUserSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedUser, setSelectedUser] = useState(null);

  const [profilePhotoUri, setProfilePhotoUri] = useState(null);
  const [bioFrontUri, setBioFrontUri] = useState(null);
  const [bioLeftUri, setBioLeftUri] = useState(null);
  const [bioRightUri, setBioRightUri] = useState(null);

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [g, u] = await Promise.all([
        loadCache(CACHE_GROUPS_KEY, []),
        loadCache(CACHE_USERS_KEY, []),
      ]);

      setGroups(Array.isArray(g) ? g : []);
      setUsers(Array.isArray(u) ? u : []);

      const oid = await getOrgIdBestEffort();
      setOrgId(String(oid || ""));

      // IMPORTANT: resolve identity using cached users list (email match)
      const ident = await resolveCurrentIdentity(Array.isArray(u) ? u : []);
      setResolved(ident);
    })();
  }, []);

  const groupsForContext = useMemo(() => {
    const oid = String(orgId || "").trim();
    return (groups || []).filter((g) => {
      if (g?.isDeleted) return false;
      if (!oid) return true;
      return String(g?.orgId || "") === oid;
    });
  }, [groups, orgId]);

  const selectedGroup = groups.find((g) => pickId(g) === groupId) || null;

  const peopleForList = useMemo(() => {
    if (selectedGroup) {
      const ids = getGroupMemberUserIds(selectedGroup);
      if (ids.length) {
        const setIds = new Set(ids.map(String));
        return users.filter((u) => setIds.has(String(pickId(u))));
      }
      return users;
    }
    return users;
  }, [users, selectedGroup]);

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return peopleForList;

    return peopleForList.filter((u) => {
      const name = String(u?.name || "").toLowerCase();
      const email = String(u?.email || "").toLowerCase();
      const staff = String(u?.staffNumber || "").toLowerCase();
      return name.includes(q) || email.includes(q) || staff.includes(q);
    });
  }, [peopleForList, userSearch]);

  function resetUserCapture() {
    setProfilePhotoUri(null);
    setBioFrontUri(null);
    setBioLeftUri(null);
    setBioRightUri(null);
  }

  async function takePhoto(setter, label) {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Camera permission", "Camera access is required.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.6 });
    if (result.canceled) return;

    const uri =
      result.assets && result.assets.length > 0 ? result.assets[0].uri : null;
    if (uri) setter(uri);
    if (label) console.log("[Biometrics] captured:", label, uri);
  }

  async function saveEnrollment() {
    try {
      // ✅ Enforce manager/admin
      // If we cannot resolve roles, we treat it as NOT allowed (safe default).
      if (!resolved?.canOnboard) {
        const email = resolved?.email || "(unknown email)";
        Alert.alert(
          "Not allowed",
          "Only managers/admin can onboard biometrics.\n\n" +
            `I logged in as: ${email}\n` +
            "But I cannot find your MOAT user/roles in cached users.\n\n" +
            "Fix: Go to Offline screen and refresh Users, then try again.",
        );
        return;
      }

      if (!selectedUserId) {
        Alert.alert("Select worker", "Please select a worker first.");
        return;
      }
      if (!profilePhotoUri) {
        Alert.alert("Profile photo", "Please capture a profile photo first.");
        return;
      }
      if (!bioFrontUri || !bioLeftUri || !bioRightUri) {
        Alert.alert(
          "Biometric photos",
          "Please capture all 3 biometric photos (Front, Left, Right).",
        );
        return;
      }

      let resolvedOrgId = String(orgId || "").trim();
      if (!resolvedOrgId) resolvedOrgId = await getOrgIdBestEffort();

      setSaving(true);

      // cache profile photo for manual clocking confirmation
      await cacheProfilePhotoForUser(selectedUserId, profilePhotoUri);

      const payload = {
        // context
        orgId: resolvedOrgId || null,

        // who performed onboarding (Mongo + Firebase)
        performedByUserId: resolved?.mongoUserId || null, // ✅ Mongo _id
        performedByFirebaseUid: resolved?.firebaseUid || null,
        performedByEmail: resolved?.email || null,
        performedByRoles: resolved?.roles || [],

        // target
        targetUserId: selectedUserId,
        groupId: groupId || null,

        // photos (URIs for offline sync pipeline)
        profilePhotoUri,
        biometricPhotoUris: [bioFrontUri, bioLeftUri, bioRightUri],

        biometricStatus: "pending",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      const fileUris = [
        profilePhotoUri,
        bioFrontUri,
        bioLeftUri,
        bioRightUri,
      ].filter(Boolean);

      // NOTE: offline_events has a "userId" column. We store Mongo performer id there.
      const localId = await insertOfflineEvent({
        eventType: "biometric-enroll",
        orgId: resolvedOrgId || null,
        userId: resolved?.mongoUserId || null,
        entityRef: selectedUserId,
        payload,
        fileUris,
      });

      Alert.alert("Saved", `Captured offline (rowId ${localId}).`);
      resetUserCapture();
    } catch (e) {
      console.log("[Biometrics] save error", e);
      Alert.alert(
        "Error",
        e?.message || "Could not save biometric onboarding.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <FlatList
        data={filteredUsers.slice(0, 200)}
        keyExtractor={(u) => String(pickId(u))}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            {/* Top bar */}
            <View style={styles.topBar}>
              <Image
                source={require("../../assets/biometrics-screen.png")}
                style={styles.topBarLogo}
                resizeMode="contain"
              />
              <TouchableOpacity
                style={styles.homeButton}
                onPress={() => router.replace("/home")}
              >
                <Image
                  source={require("../../assets/home.png")}
                  style={styles.homeIcon}
                />
              </TouchableOpacity>
            </View>

            {/* Filters */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Biometrics onboarding</Text>
              <Text style={styles.cardSubtitle}>
                Managers/Admin only. Use Group to narrow workers (optional).
              </Text>

              <SelectField
                label="Group (optional)"
                valueText={selectedGroup ? pickName(selectedGroup) : ""}
                onPress={() => setGroupPickerOpen(true)}
              />

              {/* Quick status line */}
              <Text style={[styles.smallHint, { marginTop: 6 }]}>
                Logged in: {resolved?.email || "(unknown)"}{" "}
                {resolved?.canOnboard ? "✓ allowed" : "✗ not allowed"}
              </Text>
              {!resolved?.canOnboard ? (
                <Text style={[styles.emptyText, { marginTop: 4 }]}>
                  If you ARE admin: go to Offline screen → refresh Users (so
                  your MOAT user + roles are cached).
                </Text>
              ) : null}
            </View>

            {/* Worker selection header */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Select worker</Text>

              <TextInput
                style={styles.input}
                placeholder="Search name / email / staff #"
                placeholderTextColor="#aaa"
                value={userSearch}
                onChangeText={setUserSearch}
              />

              {filteredUsers.length === 0 ? (
                <Text style={styles.emptyText}>
                  No users found (or users not cached yet). Go to Offline screen
                  and refresh Users.
                </Text>
              ) : (
                <Text style={styles.smallHint}>
                  Tap a worker below to select.
                </Text>
              )}
            </View>

            {/* Capture */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Capture</Text>
              <Text style={styles.cardSubtitle}>
                Selected:{" "}
                {selectedUser ? pickUserLabel(selectedUser) : "(none)"}
              </Text>

              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  !selectedUserId && { opacity: 0.5 },
                ]}
                onPress={() => takePhoto(setProfilePhotoUri, "profile")}
                disabled={!selectedUserId}
              >
                <Image
                  source={require("../../assets/camera.png")}
                  style={styles.cameraIcon}
                />
                <Text style={styles.primaryButtonText}>
                  {profilePhotoUri
                    ? "Retake profile photo"
                    : "Take profile photo"}
                </Text>
              </TouchableOpacity>

              {profilePhotoUri ? (
                <View style={styles.photoPreview}>
                  <Image
                    source={{ uri: profilePhotoUri }}
                    style={styles.photoImg}
                  />
                  <Text style={styles.previewLabel}>Profile</Text>
                </View>
              ) : null}

              <View style={styles.photoRow}>
                <TouchableOpacity
                  style={[
                    styles.secondaryButton,
                    styles.photoButton,
                    !selectedUserId && { opacity: 0.5 },
                  ]}
                  onPress={() => takePhoto(setBioFrontUri, "bio-front")}
                  disabled={!selectedUserId}
                >
                  <Text style={styles.secondaryButtonText}>
                    {bioFrontUri ? "Retake Front" : "Front"}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.secondaryButton,
                    styles.photoButton,
                    !selectedUserId && { opacity: 0.5 },
                  ]}
                  onPress={() => takePhoto(setBioLeftUri, "bio-left")}
                  disabled={!selectedUserId}
                >
                  <Text style={styles.secondaryButtonText}>
                    {bioLeftUri ? "Retake Left" : "Left"}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.secondaryButton,
                    styles.photoButton,
                    !selectedUserId && { opacity: 0.5 },
                  ]}
                  onPress={() => takePhoto(setBioRightUri, "bio-right")}
                  disabled={!selectedUserId}
                >
                  <Text style={styles.secondaryButtonText}>
                    {bioRightUri ? "Retake Right" : "Right"}
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={styles.previewGrid}>
                {bioFrontUri ? (
                  <View style={styles.photoPreviewSmall}>
                    <Image
                      source={{ uri: bioFrontUri }}
                      style={styles.photoImgSmall}
                    />
                    <Text style={styles.previewLabelSmall}>Front</Text>
                  </View>
                ) : null}
                {bioLeftUri ? (
                  <View style={styles.photoPreviewSmall}>
                    <Image
                      source={{ uri: bioLeftUri }}
                      style={styles.photoImgSmall}
                    />
                    <Text style={styles.previewLabelSmall}>Left</Text>
                  </View>
                ) : null}
                {bioRightUri ? (
                  <View style={styles.photoPreviewSmall}>
                    <Image
                      source={{ uri: bioRightUri }}
                      style={styles.photoImgSmall}
                    />
                    <Text style={styles.previewLabelSmall}>Right</Text>
                  </View>
                ) : null}
              </View>

              <TouchableOpacity
                style={[
                  styles.saveButton,
                  (saving || !resolved?.canOnboard) && { opacity: 0.6 },
                ]}
                onPress={saveEnrollment}
                disabled={saving || !resolved?.canOnboard}
              >
                <Text style={styles.saveButtonText}>
                  {saving ? "Saving…" : "Save onboarding (offline)"}
                </Text>
              </TouchableOpacity>

              {/* Debug */}
              <View style={{ marginTop: 12 }}>
                <TouchableOpacity
                  style={[styles.secondaryButton, { marginBottom: 8 }]}
                  onPress={async () => {
                    const token = await getTokenBestEffort();
                    const payload = token ? decodeJwtPayload(token) : null;
                    const email = extractEmailFromTokenPayload(payload);
                    const firebaseUid =
                      extractFirebaseUidFromTokenPayload(payload);
                    Alert.alert(
                      "Debug: token payload (summary)",
                      `email: ${email || "(missing)"}\nfirebaseUid: ${firebaseUid || "(missing)"}\niss: ${payload?.iss || "(missing)"}\naud: ${payload?.aud || "(missing)"}\nexp: ${payload?.exp || "(missing)"}`,
                    );
                  }}
                >
                  <Text style={styles.secondaryButtonText}>
                    Debug: show token payload
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.secondaryButton, { marginBottom: 8 }]}
                  onPress={async () => {
                    const oid = await getOrgIdBestEffort();
                    const ident = await resolveCurrentIdentity(users);
                    Alert.alert(
                      "Debug: resolved IDs",
                      `orgId: ${oid || "(missing)"}\n` +
                        `email: ${ident.email || "(missing)"}\n` +
                        `firebaseUid: ${ident.firebaseUid || "(missing)"}\n` +
                        `mongoUserId: ${ident.mongoUserId || "(missing)"}\n` +
                        `roles: ${(ident.roles || []).join(", ") || "(missing)"}\n` +
                        `allowed: ${ident.canOnboard ? "YES" : "NO"}`,
                    );
                  }}
                >
                  <Text style={styles.secondaryButtonText}>
                    Debug: show resolved IDs
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={async () => {
                    const rows = await getLastBiometricEnrollEvents(5);
                    if (!rows.length) {
                      Alert.alert("Debug: last 5 onboardings", "(none yet)");
                      return;
                    }
                    const lines = rows.map((r) => {
                      return `#${r.id} target=${r.targetUserId}\n  org=${r.orgId || "-"} user=${r.userId || "-"}\n  ${r.createdAt}`;
                    });
                    Alert.alert(
                      "Debug: last 5 onboardings",
                      lines.join("\n\n"),
                    );
                  }}
                >
                  <Text style={styles.secondaryButtonText}>
                    Debug: last 5 onboardings
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        }
        renderItem={({ item }) => {
          const uid = String(pickId(item));
          const selected = uid === String(selectedUserId);

          return (
            <TouchableOpacity
              style={[styles.userRow, selected && styles.userRowSelected]}
              onPress={() => {
                setSelectedUserId(uid);
                setSelectedUser(item);
                resetUserCapture();
              }}
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
                style={[styles.userRowTick, selected && { color: THEME_COLOR }]}
              >
                {selected ? "✓" : ""}
              </Text>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={{ paddingHorizontal: 16 }}>
            <Text style={styles.emptyText}>
              No users found (or users not cached yet). Go to Offline screen and
              refresh Users.
            </Text>
          </View>
        }
      />

      {/* Group modal */}
      <SelectModal
        visible={groupPickerOpen}
        title="Select Group (optional)"
        items={groupsForContext}
        selectedId={groupId}
        onSelect={(g) => {
          setGroupId(pickId(g));
          setGroupPickerOpen(false);
        }}
        onClose={() => setGroupPickerOpen(false)}
        emptyText="No groups cached yet. Go to Offline screen and refresh Groups."
      />
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
  cardSubtitle: { fontSize: 12, color: "#666", marginBottom: 12 },
  smallHint: { fontSize: 12, color: "#666" },

  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
    backgroundColor: "#fafafa",
    fontSize: 14,
  },

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

  primaryButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 4,
    marginBottom: 10,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    marginLeft: 8,
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
  secondaryButtonText: { color: THEME_COLOR, fontSize: 13, fontWeight: "700" },

  saveButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: "center",
    marginTop: 10,
  },
  saveButtonText: { color: "#fff", fontSize: 14, fontWeight: "700" },

  emptyText: { fontSize: 12, color: "#999" },

  userRow: {
    backgroundColor: "#fff",
    borderRadius: 10,
    elevation: 1,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
  },
  userRowSelected: { borderWidth: 2, borderColor: THEME_COLOR },
  userRowName: { fontSize: 14, fontWeight: "700" },
  userRowMeta: { fontSize: 11, color: "#777", marginTop: 2 },
  userRowTick: {
    width: 24,
    textAlign: "center",
    fontSize: 18,
    fontWeight: "900",
    color: "#bbb",
  },

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

  cameraIcon: { width: 28, height: 28 },

  photoPreview: {
    alignItems: "center",
    marginBottom: 10,
    padding: 10,
    borderRadius: 8,
    backgroundColor: "#eef",
  },
  photoImg: { width: 140, height: 140, borderRadius: 8 },
  previewLabel: {
    marginTop: 8,
    fontSize: 12,
    color: "#333",
    fontWeight: "700",
  },

  photoRow: { flexDirection: "row", gap: 8 },
  photoButton: { flex: 1 },

  previewGrid: { flexDirection: "row", gap: 8, marginTop: 10 },
  photoPreviewSmall: {
    flex: 1,
    alignItems: "center",
    padding: 8,
    borderRadius: 8,
    backgroundColor: "#eef",
  },
  photoImgSmall: { width: 90, height: 90, borderRadius: 8 },
  previewLabelSmall: {
    marginTop: 6,
    fontSize: 11,
    color: "#333",
    fontWeight: "700",
  },
});
