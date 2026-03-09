import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiGet } from "./apiClient";

export const CACHE_PROJECTS = "@moat:cache:projects";
export const CACHE_TASKS = "@moat:cache:tasks";
export const CACHE_MILESTONES = "@moat:cache:milestones";
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

/**
 * Fetch lists from backend and cache for offline dropdowns.
 * Expected backend response:
 * {
 *   projects: [...],
 *   tasks: [...],
 *   milestones: [...],
 *   users: [...],
 *   vehicles: [...],
 *   assets: [...],
 *   documents: [...],
 *   groups: [...],
 *   vendors: [...],
 *   inspections: [...],
 *   definitions: { vehicleEntryTypes: [...] }
 * }
 */
export async function refreshListsFromServer() {
  const data = await apiGet("/api/mobile/lists");

  const projects = safeArray(data?.projects);
  const tasks = safeArray(data?.tasks);
  const milestones = safeArray(data?.milestones || data?.taskMilestones);
  const users = safeArray(data?.users);
  const vehicles = safeArray(data?.vehicles);
  const assets = safeArray(data?.assets);
  const documents = safeArray(data?.documents);
  const groups = safeArray(data?.groups);
  const inspections = safeArray(data?.inspections);
  const vendors = safeArray(data?.vendors);
  const definitions = safeObject(data?.definitions);

  await AsyncStorage.multiSet([
    [CACHE_PROJECTS, JSON.stringify(projects)],
    [CACHE_TASKS, JSON.stringify(tasks)],
    [CACHE_MILESTONES, JSON.stringify(milestones)],
    [CACHE_USERS, JSON.stringify(users)],
    [CACHE_VEHICLES, JSON.stringify(vehicles)],
    [CACHE_ASSETS, JSON.stringify(assets)],
    [CACHE_DOCUMENTS, JSON.stringify(documents)],
    [CACHE_GROUPS, JSON.stringify(groups)],
    [CACHE_INSPECTIONS, JSON.stringify(inspections)],
    [CACHE_VENDORS, JSON.stringify(vendors)],
    [CACHE_DEFINITIONS, JSON.stringify(definitions)],
    [CACHE_LAST_REFRESH, new Date().toISOString()],
  ]);

  return {
    projectsCount: projects.length,
    tasksCount: tasks.length,
    milestonesCount: milestones.length,
    usersCount: users.length,
    vehiclesCount: vehicles.length,
    assetsCount: assets.length,
    documentsCount: documents.length,
    groupsCount: groups.length,
    inspectionsCount: inspections.length,
    vendorsCount: vendors.length,
    vehicleEntryTypesCount: Array.isArray(definitions?.vehicleEntryTypes)
      ? definitions.vehicleEntryTypes.length
      : 0,
  };
}

export async function loadCachedLists() {
  const kv = await AsyncStorage.multiGet([
    CACHE_PROJECTS,
    CACHE_TASKS,
    CACHE_MILESTONES,
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
