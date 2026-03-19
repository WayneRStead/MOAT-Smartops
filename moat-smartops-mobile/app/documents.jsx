// app/documents.js
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
  getStoredUserId,
} from "../apiClient";
import { getDocumentReadMap, saveDocumentRead } from "../database";

const THEME_COLOR = "#22a6b3";

// categories & documents
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
  const mime = String(doc?.latest?.mime || "").toLowerCase();
  const filename = String(doc?.latest?.filename || "").toLowerCase();

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

    bucket.documents.push({
      id: raw?.id || raw?._id,
      backendId: raw?.id || raw?._id,
      title: raw?.title || "Untitled document",
      type: guessDocType(raw),
      updatedAt: raw?.updatedAt || raw?.createdAt || "",
      description:
        Array.isArray(raw?.tags) && raw.tags.length
          ? `Tags: ${raw.tags.join(", ")}`
          : "Library document",
      latest: raw?.latest || null,
      folder,
      channel: raw?.channel || "mobile-library",
    });
  }

  return categories;
}

const THEME_BG = "#f5f5f5";

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
  const [savingOfflineDoc, setSavingOfflineDoc] = useState(false);

  const selectedCategory =
    documentCategories.find((c) => c.id === selectedCategoryId) ||
    documentCategories[0] ||
    EMPTY_DOCUMENT_CATEGORIES[0];

  const viewedDocHasFile = useMemo(() => {
    return !!viewDoc?.latest?.url;
  }, [viewDoc]);

  const handleOpenDoc = (doc) => {
    setViewDoc(doc);
  };

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

      setDocumentCategories(buildCategoriesFromBackend(rows));
    } catch (e) {
      console.log("Failed to load mobile library documents", e);
      setDocumentsError(e?.message || "Failed to load documents");
      setDocumentCategories(EMPTY_DOCUMENT_CATEGORIES);
    } finally {
      setLoadingDocs(false);
    }
  };

  useEffect(() => {
    loadDocuments();
    loadReadHistory();
  }, []);

  const loadReadHistory = async () => {
    try {
      const userId = await getStoredUserId();
      const readMap = await getDocumentReadMap(userId || null);

      const uiMap = {};
      for (const [documentId, value] of Object.entries(readMap || {})) {
        uiMap[documentId] = value?.firstReadAt || value?.lastReadAt || null;
      }

      setReadTimestamps(uiMap);
    } catch (e) {
      console.log("Failed to load document read history", e);
    }
  };

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
        "Reading a document will record a read time for this device.",
      );
    } catch (e) {
      console.log("Failed to save document read", e);
      Alert.alert(
        "Error",
        "Could not record the read time on this device. It will still show as read in this session.",
      );
    }
  };

  const handleOpenDocument = async () => {
    if (!viewDoc) return;

    if (!viewDoc?.latest?.url) {
      Alert.alert(
        "No file",
        "This document does not have a file uploaded yet.",
      );
      return;
    }

    try {
      setOpeningDoc(true);
      const { openProtectedDocument } = await import("../apiClient");
      await openProtectedDocument(viewDoc);
    } catch (e) {
      console.log("Failed to open document", e);
      Alert.alert("Open failed", e?.message || "Could not open this document.");
    } finally {
      setOpeningDoc(false);
    }
  };

  const handleSaveOffline = async () => {
    if (!viewDoc) return;

    if (!viewDoc?.latest?.url) {
      Alert.alert(
        "No file",
        "This document does not have a file uploaded yet.",
      );
      return;
    }

    try {
      setSavingOfflineDoc(true);
      const { saveProtectedDocumentOffline } = await import("../apiClient");
      await saveProtectedDocumentOffline(viewDoc);

      Alert.alert(
        "Saved offline",
        "This document has been saved to this device for offline use.",
      );
    } catch (e) {
      console.log("Failed to save document offline", e);
      Alert.alert(
        "Save failed",
        e?.message || "Could not save this document offline.",
      );
    } finally {
      setSavingOfflineDoc(false);
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
            Select a folder to view policies, safety documents or general
            information. Reading a document will record a last read time for
            this device.
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
                    {lastRead ? (
                      <Text style={styles.docRead}>First read: {lastRead}</Text>
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

                <Text style={styles.modalHint}>
                  Open will fetch the protected backend file. Save offline will
                  store a copy on the device for offline access.
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
                      {openingDoc ? "Opening..." : "Open"}
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.secondaryButton,
                      styles.modalButtonFull,
                      !viewedDocHasFile && styles.buttonDisabledSecondary,
                    ]}
                    onPress={handleSaveOffline}
                    disabled={!viewedDocHasFile || savingOfflineDoc}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {savingOfflineDoc ? "Saving..." : "Save offline"}
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
  buttonDisabledSecondary: {
    borderColor: "#9ccfd5",
  },
});
