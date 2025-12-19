import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { saveAssetCreate, saveAssetLog } from '../database';

const THEME_COLOR = '#22a6b3';

const LAST_SCAN_KEY = '@moat:lastScan';
const ASSETS_KEY = '@moat:assets';

// ---- Role gating (stub for now) ----
// Later: replace with real auth role coming from backend/user profile
const DEMO_ROLE = 'worker'; // try: 'project_manager'
const CAN_CREATE_ROLES = new Set(['project_manager', 'manager', 'admin', 'super_admin']);

function formatNow() {
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
}

async function getCurrentCoords() {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      console.log('Location permission not granted');
      return null;
    }
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
    };
  } catch (e) {
    console.log('Location error', e);
    return null;
  }
}

// -------- Asset local store helpers --------
async function loadAssetsMap() {
  try {
    const raw = await AsyncStorage.getItem(ASSETS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

async function saveAssetsMap(mapObj) {
  await AsyncStorage.setItem(ASSETS_KEY, JSON.stringify(mapObj || {}));
}

/**
 * Parse scan value for asset code:
 * - If JSON, attempt common keys
 * - Else treat raw as asset code/tag
 */
function parseAssetScan(scanValue) {
  const raw = String(scanValue || '').trim();
  if (!raw) return null;

  try {
    const obj = JSON.parse(raw);
    const code =
      obj.assetCode ||
      obj.code ||
      obj.tag ||
      obj.assetTag ||
      obj.id ||
      obj.assetId ||
      null;

    return {
      assetCode: code ? String(code).trim() : null,
      raw,
      meta: obj,
    };
  } catch {
    // not JSON
  }

  return { assetCode: raw, raw, meta: null };
}

export default function AssetsScreen() {
  const router = useRouter();

  // In future: role comes from auth/profile
  const userRole = DEMO_ROLE;
  const canCreateAsset = CAN_CREATE_ROLES.has(String(userRole || '').toLowerCase());

  // Asset fields
  const [assetCode, setAssetCode] = useState('');
  const [assetName, setAssetName] = useState('');
  const [assetCategory, setAssetCategory] = useState('');
  const [assetProject, setAssetProject] = useState('');
  const [assetLocation, setAssetLocation] = useState('');

  // Create asset modal
  const [createVisible, setCreateVisible] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newProject, setNewProject] = useState('');
  const [newLocation, setNewLocation] = useState('');
  const [pendingScanRaw, setPendingScanRaw] = useState(null);

  // Log modal
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logDateTime, setLogDateTime] = useState(formatNow());
  const [logNote, setLogNote] = useState('');
  const [logPhoto, setLogPhoto] = useState(null);

  const effectiveCode = String(assetCode || '').trim();

  const openCreateModal = useCallback(
    (prefill = {}) => {
      setNewCode(prefill.assetCode || effectiveCode || '');
      setNewName(prefill.assetName || '');
      setNewCategory(prefill.assetCategory || '');
      setNewProject(prefill.assetProject || '');
      setNewLocation(prefill.assetLocation || '');
      setPendingScanRaw(prefill.raw || null);
      setCreateVisible(true);
    },
    [effectiveCode]
  );

  const closeCreateModal = () => {
    setCreateVisible(false);
    setPendingScanRaw(null);
  };

  const applyAssetFromStore = useCallback(async (code) => {
    const key = String(code || '').trim().toUpperCase();
    if (!key) return null;

    const map = await loadAssetsMap();
    return map[key] || null;
  }, []);

  const ensureAssetKnownOrPrompt = useCallback(
    async (parsed) => {
      const parsedCode = String(parsed?.assetCode || '').trim();
      if (!parsedCode) {
        Alert.alert('Scan failed', 'Could not detect an asset code/tag.');
        return;
      }

      setAssetCode(parsedCode);

      const existing = await applyAssetFromStore(parsedCode);
      if (existing) {
        setAssetName(existing.assetName || '');
        setAssetCategory(existing.assetCategory || '');
        setAssetProject(existing.assetProject || '');
        setAssetLocation(existing.assetLocation || '');
        return;
      }

      // Not found
      if (!canCreateAsset) {
        Alert.alert(
          'Asset not found',
          'This asset is not on your device yet. Only a Project Manager (or above) can add new assets.'
        );
        // Keep code filled so user can re-scan / report code
        return;
      }

      openCreateModal({
        assetCode: parsedCode,
        raw: parsed.raw,
      });
    },
    [applyAssetFromStore, canCreateAsset, openCreateModal]
  );

  // When returning from /scan, read last scan and auto-fill
  useFocusEffect(
    useCallback(() => {
      let mounted = true;

      (async () => {
        try {
          const raw = await AsyncStorage.getItem(LAST_SCAN_KEY);
          if (!raw) return;

          const scan = JSON.parse(raw);
          await AsyncStorage.removeItem(LAST_SCAN_KEY);

          if (!mounted) return;

          const value = scan?.value ? String(scan.value) : '';
          if (!value) return;

          const parsed = parseAssetScan(value);
          await ensureAssetKnownOrPrompt(parsed);
        } catch (e) {
          console.log('[ASSETS] Failed to apply scan result', e);
        }
      })();

      return () => {
        mounted = false;
      };
    }, [ensureAssetKnownOrPrompt])
  );

  // Shared camera helper
  const takePhoto = async (setter) => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Camera permission', 'Camera access is required to take a photo.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({ quality: 0.5 });
    if (result.canceled) return;

    const uri =
      result.assets && result.assets.length > 0 ? result.assets[0].uri : null;
    if (uri) setter(uri);
  };

  // --- SCAN ASSET ---
  const handleScanAsset = () => {
    router.push({
      pathname: '/scan',
      params: {
        returnTo: '/assets',
        field: 'asset',
        label: 'Scan asset',
      },
    });
  };

  const canProceedWithAsset = useMemo(() => {
    return String(assetCode || '').trim().length > 0;
  }, [assetCode]);

  const handleSaveNewAsset = async () => {
    if (!canCreateAsset) {
      Alert.alert('Not allowed', 'Only a Project Manager (or above) can add assets.');
      return;
    }

    const code = String(newCode || '').trim();
    if (!code) {
      Alert.alert('Missing code', 'Please enter an asset code/tag.');
      return;
    }

    const name = String(newName || '').trim();
    if (!name) {
      Alert.alert('Missing name', 'Please enter an asset name.');
      return;
    }

    const meta = {
      assetCode: code,
      assetName: name,
      assetCategory: String(newCategory || '').trim() || null,
      assetProject: String(newProject || '').trim() || null,
      assetLocation: String(newLocation || '').trim() || null,
      createdAt: new Date().toISOString(),
      source: pendingScanRaw ? 'scan' : 'manual',
      scanRaw: pendingScanRaw || null,
    };

    // Save locally for lookups
    const map = await loadAssetsMap();
    map[code.toUpperCase()] = meta;
    await saveAssetsMap(map);

    // Populate screen fields
    setAssetCode(code);
    setAssetName(name);
    setAssetCategory(meta.assetCategory || '');
    setAssetProject(meta.assetProject || '');
    setAssetLocation(meta.assetLocation || '');

    // ALSO queue offline event for backend to create asset
    try {
      const orgId = 'demo-org';
      const userId = 'demo-user';

      await saveAssetCreate({
        orgId,
        userId,
        ...meta,
        syncStatus: 'pending',
        updatedAt: new Date().toISOString(),
      });

      console.log('[ASSETS] asset-create queued for sync');
    } catch (e) {
      console.log('[ASSETS] Failed to queue asset-create', e);
      // Still keep local asset created; sync can be retried later
    }

    Alert.alert('Asset created', 'Asset saved on this device.');
    closeCreateModal();
  };

  const openLogModal = () => {
    if (!canProceedWithAsset) {
      Alert.alert('No asset selected', 'Please scan or enter an asset before adding a log.');
      return;
    }

    // If asset exists locally, fill from store (best effort)
    (async () => {
      const existing = await applyAssetFromStore(assetCode);
      if (existing) {
        setAssetName(existing.assetName || assetName);
        setAssetCategory(existing.assetCategory || assetCategory);
        setAssetProject(existing.assetProject || assetProject);
        setAssetLocation(existing.assetLocation || assetLocation);
      }
    })();

    setLogDateTime(formatNow());
    setLogNote('');
    setLogPhoto(null);
    setLogModalVisible(true);
  };

  const handleSaveLog = async () => {
    const coords = await getCurrentCoords();
    const nowIso = new Date().toISOString();

    const payload = {
      orgId: 'demo-org',
      userId: 'demo-user',
      assetCode,
      assetName,
      assetCategory,
      assetProject,
      assetLocation,
      dateTime: logDateTime,
      note: logNote,
      photoUri: logPhoto,
      coords,
      createdAt: nowIso,
      updatedAt: nowIso,
      syncStatus: 'pending',
    };

    try {
      const id = await saveAssetLog(payload);
      console.log('Asset log saved locally with id:', id);
      Alert.alert('Saved', 'Asset log captured (not yet synced).');
      setLogModalVisible(false);
    } catch (e) {
      console.log('Failed to save asset log', e);
      Alert.alert('Save failed', 'Could not save asset log on this device.');
    }
  };

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Top bar with Assets logo + home */}
        <View style={styles.topBar}>
          <Image
            source={require('../assets/assets-screen.png')}
            style={styles.topBarLogo}
            resizeMode="contain"
          />
          <TouchableOpacity
            style={styles.homeButton}
            onPress={() => router.replace('/home')}
          >
            <Image source={require('../assets/home.png')} style={styles.homeIcon} />
          </TouchableOpacity>
        </View>

        {/* Main asset card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Assets</Text>

          <View style={styles.scanRow}>
            <TouchableOpacity style={styles.scanButton} onPress={handleScanAsset}>
              <Image source={require('../assets/barcode.png')} style={styles.scanIcon} />
              <Text style={styles.scanText}>Scan asset</Text>
            </TouchableOpacity>

            {canCreateAsset && (
              <TouchableOpacity
                style={[styles.scanButton, { marginLeft: 8 }]}
                onPress={() =>
                  openCreateModal({
                    assetCode: assetCode || '',
                    assetName,
                    assetCategory,
                    assetProject,
                    assetLocation,
                  })
                }
              >
                <Text style={styles.scanText}>+ Asset</Text>
              </TouchableOpacity>
            )}
          </View>

          <TextInput
            style={styles.input}
            placeholder="Asset code / tag"
            placeholderTextColor="#aaa"
            value={assetCode}
            onChangeText={setAssetCode}
            autoCapitalize="characters"
          />

          <TextInput
            style={styles.input}
            placeholder="Asset name"
            placeholderTextColor="#aaa"
            value={assetName}
            onChangeText={setAssetName}
          />

          <TextInput
            style={styles.input}
            placeholder="Category / type"
            placeholderTextColor="#aaa"
            value={assetCategory}
            onChangeText={setAssetCategory}
          />

          <TextInput
            style={styles.input}
            placeholder="Project (optional)"
            placeholderTextColor="#aaa"
            value={assetProject}
            onChangeText={setAssetProject}
          />

          <TextInput
            style={styles.input}
            placeholder="Location / area (optional)"
            placeholderTextColor="#aaa"
            value={assetLocation}
            onChangeText={setAssetLocation}
          />

          <TouchableOpacity style={styles.primaryButton} onPress={openLogModal}>
            <Image source={require('../assets/activity-log.png')} style={styles.logIcon} />
            <Text style={styles.primaryButtonText}>Add log</Text>
          </TouchableOpacity>

          {!canCreateAsset && (
            <Text style={styles.hintText}>
              Note: Only Project Managers (or above) can add new assets.
            </Text>
          )}
        </View>
      </ScrollView>

      {/* CREATE ASSET MODAL */}
      <Modal
        visible={createVisible}
        transparent
        animationType="slide"
        onRequestClose={closeCreateModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Create asset</Text>
            <Text style={styles.modalSubtitle}>Only PM+ can add assets.</Text>

            <TextInput
              style={styles.input}
              placeholder="Asset code/tag (required)"
              placeholderTextColor="#aaa"
              value={newCode}
              onChangeText={setNewCode}
              autoCapitalize="characters"
            />

            <TextInput
              style={styles.input}
              placeholder="Asset name (required)"
              placeholderTextColor="#aaa"
              value={newName}
              onChangeText={setNewName}
            />

            <TextInput
              style={styles.input}
              placeholder="Category/type"
              placeholderTextColor="#aaa"
              value={newCategory}
              onChangeText={setNewCategory}
            />

            <TextInput
              style={styles.input}
              placeholder="Project (optional)"
              placeholderTextColor="#aaa"
              value={newProject}
              onChangeText={setNewProject}
            />

            <TextInput
              style={styles.input}
              placeholder="Location/area (optional)"
              placeholderTextColor="#aaa"
              value={newLocation}
              onChangeText={setNewLocation}
            />

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.primaryButton, styles.modalButton]}
                onPress={handleSaveNewAsset}
              >
                <Text style={styles.primaryButtonText}>Save asset</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalButton]}
                onPress={closeCreateModal}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>

            {pendingScanRaw ? (
              <Text style={styles.modalHint}>Prefilled from scan.</Text>
            ) : null}
          </View>
        </View>
      </Modal>

      {/* LOG MODAL */}
      <Modal
        visible={logModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setLogModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Asset log</Text>
            <Text style={styles.modalSubtitle}>
              {assetName || assetCode || 'Current asset'}
            </Text>

            <View style={styles.dateRow}>
              <TextInput
                style={[styles.input, styles.dateInput]}
                placeholder="Date / time"
                placeholderTextColor="#aaa"
                value={logDateTime}
                onChangeText={setLogDateTime}
              />
              <TouchableOpacity
                style={styles.useNowButton}
                onPress={() => setLogDateTime(formatNow())}
              >
                <Text style={styles.useNowText}>Use now</Text>
              </TouchableOpacity>
            </View>

            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Note"
              placeholderTextColor="#aaa"
              value={logNote}
              onChangeText={setLogNote}
              multiline
            />

            {!logPhoto ? (
              <TouchableOpacity
                style={styles.photoButton}
                onPress={() => takePhoto(setLogPhoto)}
              >
                <Image source={require('../assets/camera.png')} style={styles.photoIcon} />
                <Text style={styles.photoButtonText}>Take photo</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.photoPreview}>
                <Image source={{ uri: logPhoto }} style={styles.photoPreviewImage} />
                <TouchableOpacity
                  style={styles.retryPhotoButton}
                  onPress={() => takePhoto(setLogPhoto)}
                >
                  <Text style={styles.retryPhotoText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.primaryButton, styles.modalButton]}
                onPress={handleSaveLog}
              >
                <Text style={styles.primaryButtonText}>Save log</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalButton]}
                onPress={() => setLogModalVisible(false)}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.modalHint}>
              After saving, scan the next asset or go home from the header.
            </Text>
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
    backgroundColor: '#f5f5f5',
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
  scanRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginBottom: 8,
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: THEME_COLOR,
    marginBottom: 8,
  },
  scanIcon: {
    width: 48,
    height: 48,
    marginRight: 6,
  },
  scanText: {
    color: THEME_COLOR,
    fontWeight: '500',
    fontSize: 13,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
    backgroundColor: '#fafafa',
    fontSize: 14,
  },
  textArea: {
    height: 80,
    textAlignVertical: 'top',
  },
  primaryButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 4,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 6,
  },
  logIcon: {
    width: 32,
    height: 32,
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
  hintText: {
    marginTop: 10,
    fontSize: 11,
    color: '#777',
    textAlign: 'center',
  },
  // Modal styles
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
    marginBottom: 6,
    textAlign: 'center',
  },
  modalSubtitle: {
    fontSize: 12,
    color: '#666',
    marginBottom: 12,
    textAlign: 'center',
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
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
    backgroundColor: '#eee',
  },
  useNowText: {
    fontSize: 11,
    color: '#333',
  },
  photoButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: THEME_COLOR,
    marginBottom: 10,
  },
  photoIcon: {
    width: 32,
    height: 32,
    marginRight: 8,
  },
  photoButtonText: {
    color: THEME_COLOR,
    fontWeight: '600',
  },
  photoPreview: {
    alignItems: 'center',
    marginBottom: 10,
  },
  photoPreviewImage: {
    width: 140,
    height: 140,
    borderRadius: 8,
    marginBottom: 6,
  },
  retryPhotoButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: '#f39c12',
  },
  retryPhotoText: {
    color: '#fff',
    fontWeight: '600',
  },
  modalButtonsRow: {
    flexDirection: 'row',
    marginTop: 12,
  },
  modalButton: {
    flex: 1,
    marginHorizontal: 4,
  },
  modalHint: {
    marginTop: 10,
    fontSize: 11,
    color: '#777',
    textAlign: 'center',
  },
});
