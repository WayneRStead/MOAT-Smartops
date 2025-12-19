import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { saveDocumentRead } from '../database'; // ✅ NEW: wire to local DB stub

const THEME_COLOR = '#22a6b3';

// Demo categories & documents – later this comes from backend / document vault
const DOCUMENT_CATEGORIES = [
  {
    id: 'policies',
    name: 'Policies',
    icon: require('../assets/policies.png'),
    documents: [
      {
        id: 'pol-001',
        title: 'Health & Safety Policy',
        type: 'PDF',
        updatedAt: '2025-10-01',
        description:
          'Company-wide health and safety policy, roles and responsibilities.',
      },
      {
        id: 'pol-002',
        title: 'Code of Conduct',
        type: 'PDF',
        updatedAt: '2025-09-15',
        description:
          'Behaviour standards, disciplinary procedures and reporting channels.',
      },
    ],
  },
  {
    id: 'safety',
    name: 'Safety',
    icon: require('../assets/safety.png'),
    documents: [
      {
        id: 'safe-001',
        title: 'Working at Heights Procedure',
        type: 'PDF',
        updatedAt: '2025-09-20',
        description:
          'Safe system of work for ladders, scaffolding and elevated platforms.',
      },
      {
        id: 'safe-002',
        title: 'PPE Requirements',
        type: 'PDF',
        updatedAt: '2025-08-05',
        description:
          'Required personal protective equipment per task / area.',
      },
    ],
  },
  {
    id: 'general',
    name: 'General',
    icon: require('../assets/general.png'),
    documents: [
      {
        id: 'gen-001',
        title: 'Site Induction Guide',
        type: 'PDF',
        updatedAt: '2025-07-10',
        description:
          'Overview of site rules, facilities, emergency information and contacts.',
      },
      {
        id: 'gen-002',
        title: 'Environmental Policy',
        type: 'PDF',
        updatedAt: '2025-06-30',
        description:
          'Company commitment to environmental protection and waste management.',
      },
    ],
  },
];

const THEME_BG = '#f5f5f5';

export default function DocumentsScreen() {
  const router = useRouter();

  const [selectedCategoryId, setSelectedCategoryId] = useState('policies');
  const [viewDoc, setViewDoc] = useState(null); // the document being viewed
  const [readTimestamps, setReadTimestamps] = useState({}); // { [docId]: 'YYYY-MM-DD HH:mm' }

  const selectedCategory =
    DOCUMENT_CATEGORIES.find((c) => c.id === selectedCategoryId) ||
    DOCUMENT_CATEGORIES[0];

  const handleOpenDoc = (doc) => {
    setViewDoc(doc);
  };

  const formatNow = () => {
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return (
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      ' ' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes())
    );
  };

  // ✅ Now async and wired to DB stub
  const handleMarkAsRead = async () => {
    if (!viewDoc) return;

    const timestamp = formatNow();

    // Update local UI state
    setReadTimestamps((prev) => ({
      ...prev,
      [viewDoc.id]: timestamp,
    }));

    // Build payload for DB / sync
    const nowIso = new Date().toISOString();
    const payload = {
      orgId: 'demo-org',        // 🔁 later from logged-in org
      userId: 'demo-user',      // 🔁 later from logged-in user
      documentId: viewDoc.id,
      categoryId: selectedCategoryId,
      title: viewDoc.title,
      type: viewDoc.type,
      docUpdatedAt: viewDoc.updatedAt,
      readAt: timestamp,        // user-facing time
      createdAt: nowIso,
      updatedAt: nowIso,
      syncStatus: 'pending',    // ready for offline sync engine
    };

    try {
      const localId = await saveDocumentRead(payload);
      console.log('Document marked as read and saved locally with id:', localId);

      Alert.alert('Marked as read', 'Your read time has been recorded (demo).');
    } catch (e) {
      console.log('Failed to save document read', e);
      Alert.alert(
        'Error',
        'Could not record the read time on this device. It will still show as read in this session.'
      );
    }
  };

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Top bar with Documents logo + home */}
        <View style={styles.topBar}>
          <Image
            source={require('../assets/documents-screen.png')}
            style={styles.topBarLogo}
            resizeMode="contain"
          />
          <TouchableOpacity
            style={styles.homeButton}
            onPress={() => router.replace('/home')}
          >
            <Image
              source={require('../assets/home.png')}
              style={styles.homeIcon}
            />
          </TouchableOpacity>
        </View>

        {/* Category selector */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Documents</Text>
          <Text style={styles.cardSubtitle}>
            Select a folder to view policies, safety documents or general
            information. Reading a document will record a last read time for
            this device.
          </Text>

          <View style={styles.categoryRow}>
            {DOCUMENT_CATEGORIES.map((cat) => {
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

        {/* Document list for selected category */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{selectedCategory.name} documents</Text>

          {selectedCategory.documents.length === 0 ? (
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
                      source={require('../assets/app-icon.png')}
                      style={styles.docTypeIcon}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.docTitle}>{doc.title}</Text>
                    <Text style={styles.docMeta}>
                      Type: {doc.type} | Updated: {doc.updatedAt}
                    </Text>
                    {lastRead ? (
                      <Text style={styles.docRead}>
                        Last read: {lastRead}
                      </Text>
                    ) : (
                      <Text style={styles.docNotRead}>Not read yet</Text>
                    )}
                  </View>
                  <Image
                    source={require('../assets/trip.png')}
                    style={styles.docOpenIcon}
                  />
                </TouchableOpacity>
              );
            })
          )}
        </View>
      </ScrollView>

      {/* VIEW DOCUMENT MODAL */}
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
                  Type: {viewDoc.type} | Updated: {viewDoc.updatedAt}
                </Text>

                <Text style={styles.modalDescription}>
                  {viewDoc.description}
                </Text>

                <Text style={styles.modalHint}>
                  In the final version this will open the full document (PDF /
                  image / HTML) from the MOAT Document Vault. For now this is a
                  preview placeholder so we can wire the flows and read
                  tracking.
                </Text>

                <View style={styles.modalButtonsRow}>
                  <TouchableOpacity
                    style={[styles.primaryButton, styles.modalButton]}
                    onPress={handleMarkAsRead}
                  >
                    <Text style={styles.primaryButtonText}>Mark as read</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.modalButton]}
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  cardSubtitle: {
    fontSize: 12,
    color: '#666',
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 12,
    color: '#999',
  },
  // Categories
  categoryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  categoryButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 8,
    marginHorizontal: 4,
    alignItems: 'center',
    backgroundColor: '#fafafa',
  },
  categoryButtonSelected: {
    borderColor: THEME_COLOR,
    backgroundColor: '#e6f9fb',
  },
  categoryIcon: {
    width: 40,
    height: 40,
    marginBottom: 4,
  },
  categoryText: {
    fontSize: 13,
    color: '#555',
    fontWeight: '500',
  },
  categoryTextSelected: {
    color: THEME_COLOR,
  },
  categoryCount: {
    fontSize: 11,
    color: '#777',
    marginTop: 2,
  },
  // Docs list
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  docIconWrapper: {
    width: 32,
    height: 32,
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  docTypeIcon: {
    width: 28,
    height: 28,
    borderRadius: 4,
  },
  docTitle: {
    fontSize: 14,
    fontWeight: '500',
  },
  docMeta: {
    fontSize: 11,
    color: '#777',
    marginTop: 2,
  },
  docRead: {
    fontSize: 11,
    color: '#27ae60',
    marginTop: 2,
  },
  docNotRead: {
    fontSize: 11,
    color: '#999',
    marginTop: 2,
  },
  docOpenIcon: {
    width: 24,
    height: 24,
    marginLeft: 8,
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 4,
    textAlign: 'center',
  },
  modalMeta: {
    fontSize: 12,
    color: '#666',
    marginBottom: 12,
    textAlign: 'center',
  },
  modalDescription: {
    fontSize: 13,
    color: '#333',
    marginBottom: 12,
  },
  modalHint: {
    fontSize: 11,
    color: '#777',
    marginBottom: 16,
  },
  modalButtonsRow: {
    flexDirection: 'row',
    marginTop: 4,
  },
  modalButton: {
    flex: 1,
    marginHorizontal: 4,
  },
  primaryButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: THEME_COLOR,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: THEME_COLOR,
    fontSize: 14,
    fontWeight: '600',
  },
});
