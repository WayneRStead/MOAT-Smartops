import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  apiGet,
  ensureProtectedDocumentOffline,
  fetchMobileLibraryDocuments,
  getOfflineDocumentUri,
} from "./apiClient";
import { upsertOfflineDocumentCacheBatch } from "./database";

export const CACHE_PROJECTS = "@moat:cache:projects";
export const CACHE_TASKS = "@moat:cache:tasks";
export const CACHE_MILESTONES = "@moat:cache:milestones";
export const CACHE_MILESTONES_BY_TASK = "@moat:cache:milestonesByTask";
export const CACHE_USERS = "@moat:cache:users";
export const CACHE_VEHICLES = "@moat:cache:vehicles";
export const CACHE_ASSETS = "@moat:cache:assets";
export const CACHE_DOCUMENTS = "@moat:cache:documents";
export const CACHE_GROUPS = "@moat:cache:groups";
export const CACHE_INSPECTIONS = "@moat:cache:inspections";
export const CACHE_VENDORS = "@moat:cache:vehicleVendors";
export const CACHE_DEFINITIONS = "@moat:cache:definitions";
export const CACHE_LAST_REFRESH = "@moat:cache:lastRefresh";

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function safeObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw || "");
  } catch {
    return fallback;
  }
}

function buildMilestonesByTask(milestones) {
  const out = {};
  for (const m of Array.isArray(milestones) ? milestones : []) {
    const taskId = String(
      m?.taskId?._id || m?.taskId || m?.parentTaskId || "",
    ).trim();
    if (!taskId) continue;
    if (!Array.isArray(out[taskId])) out[taskId] = [];
    out[taskId].push(m);
  }
  return out;
}

function docIdOf(doc) {
  return String(doc?.id || doc?._id || "").trim();
}

function filterMobileLibraryDocuments(documents) {
  const allowedFolders = new Set(["policies", "safety", "general"]);

  return safeArray(documents).filter((doc) => {
    const channel = String(doc?.channel || "")
      .trim()
      .toLowerCase();

    const folder = String(doc?.folder || "")
      .trim()
      .toLowerCase();

    return channel === "mobile-library" && allowedFolders.has(folder);
  });
}

function buildOfflineDocumentCacheRow(doc, offlineInfo = null) {
  const id = docIdOf(doc);
  const hasFile = !!doc?.latest?.url;
  const offlineSaved = !!offlineInfo?.uri;

  return {
    id,
    _id: id,
    title: String(doc?.title || "").trim(),
    folder: String(doc?.folder || "")
      .trim()
      .toLowerCase(),
    channel: String(doc?.channel || "")
      .trim()
      .toLowerCase(),
    tags: Array.isArray(doc?.tags) ? doc.tags : [],
    updatedAt: doc?.updatedAt || doc?.createdAt || null,
    createdAt: doc?.createdAt || null,
    latest: doc?.latest || null,

    hasFile,
    offlineSaved,
    offlineStatus: offlineSaved
      ? "available"
      : hasFile
        ? "not-downloaded"
        : "no-file",
    offlineUri: offlineInfo?.uri || "",
    offlineFilename: offlineInfo?.filename || doc?.latest?.filename || "",
    offlineMimeType: offlineInfo?.mimeType || doc?.latest?.mime || "",
    offlineTitle: offlineInfo?.title || doc?.title || "",
    offlineCheckedAt: new Date().toISOString(),
  };
}

async function readExistingCachedDocuments() {
  try {
    const raw = await AsyncStorage.getItem(CACHE_DOCUMENTS);
    const rows = safeJsonParse(raw, []);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function refreshMobileLibraryOfflineDocuments() {
  let mobileDocs = [];
  let savedCount = 0;
  let failedCount = 0;
  let usedExistingCache = false;

  const existingCachedRows = await readExistingCachedDocuments();

  try {
    const data = await fetchMobileLibraryDocuments();
    const rows = Array.isArray(data)
      ? data
      : Array.isArray(data?.documents)
        ? data.documents
        : [];

    mobileDocs = filterMobileLibraryDocuments(rows);
  } catch (e) {
    console.log("[refreshLists] failed to fetch mobile library documents", e);
    usedExistingCache = true;

    return {
      mobileDocs: [],
      cachedRows: existingCachedRows,
      savedCount: 0,
      failedCount: 0,
      usedExistingCache,
    };
  }

  const cachedRows = [];

  for (const doc of mobileDocs) {
    try {
      const hasFile = !!doc?.latest?.url;

      if (!hasFile) {
        cachedRows.push(buildOfflineDocumentCacheRow(doc, null));
        continue;
      }

      const existing = await getOfflineDocumentUri(doc);

      if (existing?.exists) {
        savedCount += 1;
        cachedRows.push(
          buildOfflineDocumentCacheRow(doc, {
            uri: existing.uri || "",
            filename: existing.filename || doc?.latest?.filename || "",
            mimeType: existing.mimeType || doc?.latest?.mime || "",
            title: existing.title || doc?.title || "",
          }),
        );
        continue;
      }

      const saved = await ensureProtectedDocumentOffline(doc);

      if (saved?.uri) {
        savedCount += 1;
        cachedRows.push(
          buildOfflineDocumentCacheRow(doc, {
            uri: saved.uri || "",
            filename: saved.filename || doc?.latest?.filename || "",
            mimeType: saved.mimeType || doc?.latest?.mime || "",
            title: saved.title || doc?.title || "",
          }),
        );
      } else {
        failedCount += 1;
        cachedRows.push(buildOfflineDocumentCacheRow(doc, null));
      }
    } catch (e) {
      failedCount += 1;
      console.log(
        "[refreshLists] failed to cache document offline:",
        doc?.title || doc?.id || doc?._id,
        e?.message || e,
      );
      cachedRows.push(buildOfflineDocumentCacheRow(doc, null));
    }
  }

  return {
    mobileDocs,
    cachedRows,
    savedCount,
    failedCount,
    usedExistingCache,
  };
}

/**
 * Fetch lists from backend and cache for offline dropdowns.
 * Documents cache is intentionally LIMITED to the mobile-library documents only.
 */
export async function refreshListsFromServer() {
  const data = await apiGet("/api/mobile/lists");

  console.log("[refreshLists] /api/mobile/lists response counts", {
    projects: Array.isArray(data?.projects) ? data.projects.length : "n/a",
    tasks: Array.isArray(data?.tasks) ? data.tasks.length : "n/a",
    milestones: Array.isArray(data?.milestones)
      ? data.milestones.length
      : Array.isArray(data?.taskMilestones)
        ? data.taskMilestones.length
        : "n/a",
    users: Array.isArray(data?.users) ? data.users.length : "n/a",
    vehicles: Array.isArray(data?.vehicles) ? data.vehicles.length : "n/a",
    assets: Array.isArray(data?.assets) ? data.assets.length : "n/a",
    groups: Array.isArray(data?.groups) ? data.groups.length : "n/a",
    inspections: Array.isArray(data?.inspectionForms)
      ? data.inspectionForms.length
      : Array.isArray(data?.inspections)
        ? data.inspections.length
        : "n/a",
    vendors: Array.isArray(data?.vendors) ? data.vendors.length : "n/a",
    definitions: data?.definitions ? Object.keys(data.definitions) : [],
  });

  const projects = safeArray(data?.projects);
  const tasks = safeArray(data?.tasks);
  const milestones = safeArray(data?.milestones || data?.taskMilestones);
  const milestonesByTask = buildMilestonesByTask(milestones);
  const users = safeArray(data?.users);
  const vehicles = safeArray(data?.vehicles);
  const assets = safeArray(data?.assets);
  const groups = safeArray(data?.groups);
  const inspections = safeArray(data?.inspectionForms || data?.inspections);
  const vendors = safeArray(data?.vendors);
  const definitions = safeObject(data?.definitions);

  const {
    mobileDocs,
    cachedRows: mobileLibraryDocumentCache,
    savedCount: mobileLibrarySavedCount,
    failedCount: mobileLibraryFailedCount,
    usedExistingCache,
  } = await refreshMobileLibraryOfflineDocuments();

  await AsyncStorage.multiSet([
    [CACHE_PROJECTS, JSON.stringify(projects)],
    [CACHE_TASKS, JSON.stringify(tasks)],
    [CACHE_MILESTONES, JSON.stringify(milestones)],
    [CACHE_MILESTONES_BY_TASK, JSON.stringify(milestonesByTask)],
    [CACHE_USERS, JSON.stringify(users)],
    [CACHE_VEHICLES, JSON.stringify(vehicles)],
    [CACHE_ASSETS, JSON.stringify(assets)],
    [CACHE_DOCUMENTS, JSON.stringify(mobileLibraryDocumentCache)],
    [CACHE_GROUPS, JSON.stringify(groups)],
    [CACHE_INSPECTIONS, JSON.stringify(inspections)],
    [CACHE_VENDORS, JSON.stringify(vendors)],
    [CACHE_DEFINITIONS, JSON.stringify(definitions)],
    [CACHE_LAST_REFRESH, new Date().toISOString()],
  ]);

  try {
    await upsertOfflineDocumentCacheBatch(mobileLibraryDocumentCache);
  } catch (e) {
    console.log(
      "[refreshLists] warning: failed to mirror offline docs into sqlite",
      e,
    );
  }

  return {
    projectsCount: projects.length,
    tasksCount: tasks.length,
    milestonesCount: milestones.length,
    usersCount: users.length,
    vehiclesCount: vehicles.length,
    assetsCount: assets.length,
    documentsCount: mobileLibraryDocumentCache.length,
    groupsCount: groups.length,
    inspectionsCount: inspections.length,
    vendorsCount: vendors.length,
    vehicleEntryTypesCount: Array.isArray(definitions?.vehicleEntryTypes)
      ? definitions.vehicleEntryTypes.length
      : 0,

    mobileLibraryDocumentsCount: usedExistingCache
      ? mobileLibraryDocumentCache.length
      : mobileDocs.length,
    mobileLibrarySavedOfflineCount: mobileLibrarySavedCount,
    mobileLibraryFailedOfflineCount: mobileLibraryFailedCount,
    mobileLibraryUsedExistingCache: usedExistingCache,
  };
}

export async function loadCachedLists() {
  const kv = await AsyncStorage.multiGet([
    CACHE_PROJECTS,
    CACHE_TASKS,
    CACHE_MILESTONES,
    CACHE_MILESTONES_BY_TASK,
    CACHE_USERS,
    CACHE_VEHICLES,
    CACHE_ASSETS,
    CACHE_DOCUMENTS,
    CACHE_GROUPS,
    CACHE_INSPECTIONS,
    CACHE_VENDORS,
    CACHE_DEFINITIONS,
    CACHE_LAST_REFRESH,
  ]);

  const map = Object.fromEntries(kv);

  const parse = (s, fallback) => {
    try {
      return JSON.parse(s || "");
    } catch {
      return fallback;
    }
  };

  return {
    projects: parse(map[CACHE_PROJECTS], []),
    tasks: parse(map[CACHE_TASKS], []),
    milestones: parse(map[CACHE_MILESTONES], []),
    milestonesByTask: parse(map[CACHE_MILESTONES_BY_TASK], {}),
    users: parse(map[CACHE_USERS], []),
    vehicles: parse(map[CACHE_VEHICLES], []),
    assets: parse(map[CACHE_ASSETS], []),
    documents: parse(map[CACHE_DOCUMENTS], []),
    groups: parse(map[CACHE_GROUPS], []),
    inspections: parse(map[CACHE_INSPECTIONS], []),
    vendors: parse(map[CACHE_VENDORS], []),
    definitions: parse(map[CACHE_DEFINITIONS], {}),
    lastRefresh: map[CACHE_LAST_REFRESH] || null,
  };
}
