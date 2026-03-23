import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  fetchMobileLibraryDocuments,
  getAuthHeaders,
  getDocumentOfflineStatus,
  getStoredUserId,
  openProtectedDocument,
} from "../apiClient";
import { getDocumentReadMap, saveDocumentRead } from "../database";
import { loadCachedLists } from "../refreshLists";

const THEME_COLOR = "#22a6b3";
const THEME_BG = "#f5f5f5";

const EMPTY_DOCUMENT_CATEGORIES = [
  {
    id: "policies",
    name: "Policies",
    icon: require("../assets/policies.png"),
    documents: [],
  },
  {
    id: "safety",
    name: "Safety",
    icon: require("../assets/safety.png"),
    documents: [],
  },
  {
    id: "general",
    name: "General",
    icon: require("../assets/general.png"),
    documents: [],
  },
];

function guessDocType(doc) {
  const mime = String(
    doc?.latest?.mime || doc?.offlineMimeType || "",
  ).toLowerCase();
  const filename = String(
    doc?.latest?.filename || doc?.offlineFilename || "",
  ).toLowerCase();

  if (mime.includes("pdf") || filename.endsWith(".pdf")) return "PDF";
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("video/")) return "VIDEO";
  if (mime.startsWith("audio/")) return "AUDIO";
  if (
    mime.includes("word") ||
    filename.endsWith(".doc") ||
    filename.endsWith(".docx")
  ) {
    return "WORD";
  }
  if (
    mime.includes("excel") ||
    filename.endsWith(".xls") ||
    filename.endsWith(".xlsx")
  ) {
    return "EXCEL";
  }
  return "FILE";
}

function normalizeDocId(raw) {
  return String(raw?.id || raw?._id || raw?.backendId || "").trim();
}

function normalizeOfflineStatus(raw) {
  if (raw?.offlineSaved || raw?.offlineUri) return "available";
  if (raw?.latest?.url) return "not-downloaded";
  return "no-file";
}

function buildCategoriesFromBackend(docs = []) {
  const categories = EMPTY_DOCUMENT_CATEGORIES.map((c) => ({
    ...c,
    documents: [],
  }));

  for (const raw of docs) {
    const folder = String(raw?.folder || "")
      .trim()
      .toLowerCase();

    const bucket = categories.find((c) => c.id === folder);
    if (!bucket) continue;

    const id = normalizeDocId(raw);
    const offlineStatus = normalizeOfflineStatus(raw);

    bucket.documents.push({
      id,
      backendId: id,
      title: raw?.title || "Untitled document",
      type: guessDocType(raw),
      updatedAt: raw?.updatedAt || raw?.createdAt || "",
      description:
        Array.isArray(raw?.tags) && raw.tags.length
          ? `Tags: ${raw.tags.join(", ")}`
          : "Company document",
      latest: raw?.latest || null,
      folder,
      channel: raw?.channel || "mobile-library",

      offlineSaved: !!raw?.offlineSaved,
      offlineUri: raw?.offlineUri || "",
      offlineFilename: raw?.offlineFilename || raw?.latest?.filename || "",
      offlineMimeType: raw?.offlineMimeType || raw?.latest?.mime || "",
      offlineCheckedAt: raw?.offlineCheckedAt || null,
      offlineStatus,
    });
  }

  return categories;
}

function flattenCategories(categories = []) {
  const out = [];
  for (const cat of Array.isArray(categories) ? categories : []) {
    for (const doc of Array.isArray(cat?.documents) ? cat.documents : []) {
      out.push(doc);
    }
  }
  return out;
}

function buildStatusMapFromDocs(docs = []) {
  const map = {};
  for (const doc of docs) {
    const id = normalizeDocId(doc);
    if (!id) continue;

    map[id] = {
      status: normalizeOfflineStatus(doc),
      uri: doc?.offlineUri || "",
      checkedAt: doc?.offlineCheckedAt || null,
    };
  }
  return map;
}

function mergeDocsWithOfflineStatus(docs = [], statusMap = {}) {
  return docs.map((doc) => {
    const id = normalizeDocId(doc);
    const statusEntry = statusMap[id] || null;
    const saved = statusEntry?.status === "available";

    return {
      ...doc,
      id,
      _id: id,
      backendId: id,
      offlineSaved: saved,
      offlineUri: statusEntry?.uri || doc?.offlineUri || "",
      offlineCheckedAt: statusEntry?.checkedAt || new Date().toISOString(),
      offlineStatus: saved
        ? "available"
        : doc?.latest?.url
          ? "not-downloaded"
          : "no-file",
    };
  });
}

function getOfflineStatusLabel(status) {
  if (status === "available") return "Available offline";
  if (status === "not-downloaded") return "Ready to download";
  return "No file available";
}

function getOfflineStatusColor(status) {
  if (status === "available") return "#27ae60";
  if (status === "not-downloaded") return "#d68910";
  return "#999";
}

export default function DocumentsScreen() {
  const router = useRouter();

  const [selectedCategoryId, setSelectedCategoryId] = useState("policies");
  const [viewDoc, setViewDoc] = useState(null);
  const [readTimestamps, setReadTimestamps] = useState({});
  const [documentCategories, setDocumentCategories] = useState(
    EMPTY_DOCUMENT_CATEGORIES,
  );
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [documentsError, setDocumentsError] = useState("");
  const [openingDoc, setOpeningDoc] = useState(false);
  const [offlineStatusMap, setOfflineStatusMap] = useState({});

  const selectedCategory =
    documentCategories.find((c) => c.id === selectedCategoryId) ||
    documentCategories[0] ||
    EMPTY_DOCUMENT_CATEGORIES[0];

  const viewedDocHasFile = useMemo(() => {
    if (!viewDoc) return false;
    if (viewDoc?.offlineStatus === "available") return true;
    return !!viewDoc?.latest?.url;
  }, [viewDoc]);

  const formatNow = () => {
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
  };

  const formatDisplayDate = (value) => {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
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
  };

  const loadReadHistory = async () => {
    try {
      const userId = await getStoredUserId();
      const readMap = await getDocumentReadMap(userId || null);

      const uiMap = {};
      for (const [documentId, value] of Object.entries(readMap || {})) {
        uiMap[documentId] = value?.lastReadAt || value?.firstReadAt || null;
      }

      setReadTimestamps(uiMap);
    } catch (e) {
      console.log("Failed to load document read history", e);
    }
  };

  const loadCachedDocuments = async () => {
    try {
      const cached = await loadCachedLists();
      const docs = Array.isArray(cached?.documents) ? cached.documents : [];

      if (docs.length > 0) {
        const categories = buildCategoriesFromBackend(docs);
        setDocumentCategories(categories);
        setOfflineStatusMap(buildStatusMapFromDocs(docs));
      }
    } catch (e) {
      console.log("Failed to load cached documents", e);
    }
  };

  const refreshOfflineStatuses = async (docs = []) => {
    const safeDocs = Array.isArray(docs) ? docs : [];
    const entries = await Promise.all(
      safeDocs.map(async (doc) => {
        const id = normalizeDocId(doc);
        if (!id) return null;

        try {
          const check = await getDocumentOfflineStatus(doc);
          return [
            id,
            {
              status: check?.exists
                ? "available"
                : doc?.latest?.url
                  ? "not-downloaded"
                  : "no-file",
              uri: check?.exists ? check.uri || "" : "",
              checkedAt: new Date().toISOString(),
            },
          ];
        } catch {
          return [
            id,
            {
              status: doc?.offlineSaved
                ? "available"
                : doc?.latest?.url
                  ? "not-downloaded"
                  : "no-file",
              uri: doc?.offlineUri || "",
              checkedAt: new Date().toISOString(),
            },
          ];
        }
      }),
    );

    const nextMap = {};
    for (const item of entries) {
      if (!item) continue;
      nextMap[item[0]] = item[1];
    }
    return nextMap;
  };

  const loadDocuments = async () => {
    try {
      setLoadingDocs(true);
      setDocumentsError("");

      const data = await fetchMobileLibraryDocuments();
      const rows = Array.isArray(data)
        ? data
        : Array.isArray(data?.documents)
          ? data.documents
          : [];

      const liveCategories = buildCategoriesFromBackend(rows);
      const flatDocs = flattenCategories(liveCategories);
      const liveStatusMap = await refreshOfflineStatuses(flatDocs);
      const mergedRows = mergeDocsWithOfflineStatus(rows, liveStatusMap);

      setDocumentCategories(buildCategoriesFromBackend(mergedRows));
      setOfflineStatusMap(liveStatusMap);
    } catch (e) {
      console.log("Failed to load mobile library documents", e);

      const currentlyShown = flattenCategories(documentCategories);
      if (currentlyShown.length > 0) {
        setDocumentsError("Showing saved documents");
      } else {
        setDocumentsError(e?.message || "Could not load documents");
        setDocumentCategories(EMPTY_DOCUMENT_CATEGORIES);
      }
    } finally {
      setLoadingDocs(false);
    }
  };

  const refreshSingleDocumentStatus = async (doc) => {
    if (!doc) return null;

    try {
      const check = await getDocumentOfflineStatus(doc);
      const nextStatus = check?.exists
        ? "available"
        : doc?.latest?.url
          ? "not-downloaded"
          : "no-file";

      const id = normalizeDocId(doc);

      setOfflineStatusMap((prev) => ({
        ...prev,
        [id]: {
          status: nextStatus,
          uri: check?.exists ? check.uri || "" : "",
          checkedAt: new Date().toISOString(),
        },
      }));

      setDocumentCategories((prev) =>
        prev.map((cat) => ({
          ...cat,
          documents: cat.documents.map((item) => {
            const same = normalizeDocId(item) === id;
            if (!same) return item;

            return {
              ...item,
              offlineSaved: nextStatus === "available",
              offlineUri: check?.exists ? check.uri || "" : "",
              offlineCheckedAt: new Date().toISOString(),
              offlineStatus: nextStatus,
            };
          }),
        })),
      );

      setViewDoc((prev) => {
        if (!prev) return prev;
        if (normalizeDocId(prev) !== id) return prev;

        return {
          ...prev,
          offlineSaved: nextStatus === "available",
          offlineUri: check?.exists ? check.uri || "" : "",
          offlineCheckedAt: new Date().toISOString(),
          offlineStatus: nextStatus,
        };
      });

      return nextStatus;
    } catch (e) {
      console.log("Failed to refresh document offline status", e);
      return null;
    }
  };

  const handleOpenDoc = async (doc) => {
    setViewDoc(doc);
    await refreshSingleDocumentStatus(doc);
  };

  useEffect(() => {
    loadCachedDocuments();
    loadReadHistory();
    loadDocuments();
  }, []);

  const handleMarkAsRead = async () => {
    if (!viewDoc) return;

    const timestamp = formatNow();
    const nowIso = new Date().toISOString();
    const auth = await getAuthHeaders({ json: true });
    const userId = await getStoredUserId();

    const payload = {
      orgId: auth?.orgId || "",
      userId: userId || "",
      documentId: viewDoc.backendId || viewDoc.id,
      categoryId: selectedCategoryId,
      title: viewDoc.title,
      type: viewDoc.type,
      docUpdatedAt: viewDoc.updatedAt,
      readAt: timestamp,
      createdAt: nowIso,
      updatedAt: nowIso,
      syncStatus: "pending",
    };

    try {
      const localId = await saveDocumentRead(payload);
      console.log(
        "Document marked as read and saved locally with id:",
        localId,
      );

      await loadReadHistory();

      setViewDoc(null);
      Alert.alert(
        "Marked as read",
        "This document has been marked as read on this device.",
      );
    } catch (e) {
      console.log("Failed to save document read", e);
      Alert.alert(
        "Error",
        "Could not mark this document as read on this device.",
      );
    }
  };

  const handleOpenDocument = async () => {
    if (!viewDoc) return;

    if (!viewedDocHasFile) {
      Alert.alert("No file", "There is no file attached to this document yet.");
      return;
    }

    try {
      setOpeningDoc(true);
      await openProtectedDocument(viewDoc);
      await refreshSingleDocumentStatus(viewDoc);
    } catch (e) {
      console.log("Failed to open document", e);
      Alert.alert("Open failed", e?.message || "Could not open this document.");
    } finally {
      setOpeningDoc(false);
    }
  };

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.topBar}>
          <Image
            source={require("../assets/documents-screen.png")}
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
          <Text style={styles.cardTitle}>Documents</Text>
          <Text style={styles.cardSubtitle}>
            Browse company documents by folder. Documents already opened or
            refreshed on this device can be used offline.
          </Text>

          <View style={styles.categoryRow}>
            {documentCategories.map((cat) => {
              const selected = cat.id === selectedCategoryId;
              return (
                <TouchableOpacity
                  key={cat.id}
                  style={[
                    styles.categoryButton,
                    selected && styles.categoryButtonSelected,
                  ]}
                  onPress={() => setSelectedCategoryId(cat.id)}
                >
                  <Image source={cat.icon} style={styles.categoryIcon} />
                  <Text
                    style={[
                      styles.categoryText,
                      selected && styles.categoryTextSelected,
                    ]}
                  >
                    {cat.name}
                  </Text>
                  <Text style={styles.categoryCount}>
                    {cat.documents.length} docs
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {selectedCategory.name} documents
          </Text>

          {loadingDocs ? (
            <Text style={styles.emptyText}>Loading documents…</Text>
          ) : documentsError ? (
            <Text style={styles.emptyText}>{documentsError}</Text>
          ) : null}

          {loadingDocs ? null : selectedCategory.documents.length === 0 ? (
            <Text style={styles.emptyText}>No documents in this folder.</Text>
          ) : (
            selectedCategory.documents.map((doc) => {
              const lastRead = readTimestamps[doc.id];
              const status =
                doc?.offlineStatus ||
                offlineStatusMap[doc.id]?.status ||
                "not-downloaded";

              return (
                <TouchableOpacity
                  key={doc.id}
                  style={styles.docRow}
                  onPress={() => handleOpenDoc(doc)}
                >
                  <View style={styles.docIconWrapper}>
                    <Image
                      source={require("../assets/app-icon.png")}
                      style={styles.docTypeIcon}
                    />
                  </View>

                  <View style={{ flex: 1 }}>
                    <Text style={styles.docTitle}>{doc.title}</Text>
                    <Text style={styles.docMeta}>
                      Type: {doc.type} | Updated:{" "}
                      {formatDisplayDate(doc.updatedAt)}
                    </Text>

                    <Text
                      style={[
                        styles.docOffline,
                        { color: getOfflineStatusColor(status) },
                      ]}
                    >
                      {getOfflineStatusLabel(status)}
                    </Text>

                    {lastRead ? (
                      <Text style={styles.docRead}>Last read: {lastRead}</Text>
                    ) : (
                      <Text style={styles.docNotRead}>Not read yet</Text>
                    )}
                  </View>

                  <Image
                    source={require("../assets/trip.png")}
                    style={styles.docOpenIcon}
                  />
                </TouchableOpacity>
              );
            })
          )}
        </View>
      </ScrollView>

      <Modal
        visible={!!viewDoc}
        transparent
        animationType="slide"
        onRequestClose={() => setViewDoc(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            {viewDoc && (
              <>
                <Text style={styles.modalTitle}>{viewDoc.title}</Text>

                <Text style={styles.modalMeta}>
                  Type: {viewDoc.type} | Updated:{" "}
                  {formatDisplayDate(viewDoc.updatedAt)}
                </Text>

                <Text style={styles.modalDescription}>
                  {viewDoc.description}
                </Text>

                <Text
                  style={[
                    styles.modalStatus,
                    {
                      color: getOfflineStatusColor(
                        viewDoc?.offlineStatus || "not-downloaded",
                      ),
                    },
                  ]}
                >
                  {getOfflineStatusLabel(
                    viewDoc?.offlineStatus || "not-downloaded",
                  )}
                </Text>

                <Text style={styles.modalHint}>
                  When a document is available offline, it will open from this
                  device. If it is not saved yet, the app will download it when
                  you open it and keep it for offline use next time.
                </Text>

                <View style={styles.modalButtonsColumn}>
                  <TouchableOpacity
                    style={[
                      styles.primaryButton,
                      styles.modalButtonFull,
                      !viewedDocHasFile && styles.buttonDisabled,
                    ]}
                    onPress={handleOpenDocument}
                    disabled={!viewedDocHasFile || openingDoc}
                  >
                    <Text style={styles.primaryButtonText}>
                      {openingDoc ? "Opening..." : "Open document"}
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.primaryButton, styles.modalButtonFull]}
                    onPress={handleMarkAsRead}
                  >
                    <Text style={styles.primaryButtonText}>Mark as read</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.modalButtonFull]}
                    onPress={() => setViewDoc(null)}
                  >
                    <Text style={styles.secondaryButtonText}>Close</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
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
    backgroundColor: THEME_BG,
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
  emptyText: {
    fontSize: 12,
    color: "#999",
  },
  categoryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  categoryButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 8,
    marginHorizontal: 4,
    alignItems: "center",
    backgroundColor: "#fafafa",
  },
  categoryButtonSelected: {
    borderColor: THEME_COLOR,
    backgroundColor: "#e6f9fb",
  },
  categoryIcon: {
    width: 40,
    height: 40,
    marginBottom: 4,
  },
  categoryText: {
    fontSize: 13,
    color: "#555",
    fontWeight: "500",
  },
  categoryTextSelected: {
    color: THEME_COLOR,
  },
  categoryCount: {
    fontSize: 11,
    color: "#777",
    marginTop: 2,
  },
  docRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  docIconWrapper: {
    width: 32,
    height: 32,
    marginRight: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  docTypeIcon: {
    width: 28,
    height: 28,
    borderRadius: 4,
  },
  docTitle: {
    fontSize: 14,
    fontWeight: "500",
  },
  docMeta: {
    fontSize: 11,
    color: "#777",
    marginTop: 2,
  },
  docOffline: {
    fontSize: 11,
    marginTop: 2,
    fontWeight: "600",
  },
  docRead: {
    fontSize: 11,
    color: "#27ae60",
    marginTop: 2,
  },
  docNotRead: {
    fontSize: 11,
    color: "#999",
    marginTop: 2,
  },
  docOpenIcon: {
    width: 24,
    height: 24,
    marginLeft: 8,
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
    marginBottom: 4,
    textAlign: "center",
  },
  modalMeta: {
    fontSize: 12,
    color: "#666",
    marginBottom: 12,
    textAlign: "center",
  },
  modalDescription: {
    fontSize: 13,
    color: "#333",
    marginBottom: 12,
  },
  modalStatus: {
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 8,
  },
  modalHint: {
    fontSize: 11,
    color: "#777",
    marginBottom: 16,
  },
  modalButtonsColumn: {
    marginTop: 4,
  },
  modalButtonFull: {
    width: "100%",
    marginBottom: 10,
  },
  primaryButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
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
  buttonDisabled: {
    backgroundColor: "#9ccfd5",
  },
});
