// logbook.jsx
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

// 🔹 DB helpers
import {
  saveVehicleCreate, // ✅ add this in database.js (vehicle-create offline event)
  saveVehicleLog,
  saveVehiclePurchase,
  saveVehicleTrip,
} from '../database';

const THEME_COLOR = '#22a6b3';

const USAGE_TYPES = [
  { key: 'business', label: 'Business' },
  { key: 'private', label: 'Private' },
];

const LAST_SCAN_KEY = '@moat:lastScan';
const VEHICLES_KEY = '@moat:vehicles';

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

// -------- Vehicle local store helpers --------
async function loadVehiclesMap() {
  try {
    const raw = await AsyncStorage.getItem(VEHICLES_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

async function saveVehiclesMap(mapObj) {
  await AsyncStorage.setItem(VEHICLES_KEY, JSON.stringify(mapObj || {}));
}

/**
 * Deterministic licence disc parse (based on your % positions):
 * registration - 6 : VIN - 12 : type - 8 : make - 9 : model - 10
 * type: only first word before space, and ignore Afrikaans after '/'
 */
function parseLicenceDisc(scanValue) {
  const raw = String(scanValue || '').trim();
  if (!raw) return null;

  // If the disc scanner ever returns JSON, still support it
  try {
    const obj = JSON.parse(raw);

    const reg =
      obj.registration ||
      obj.reg ||
      obj.regNumber ||
      obj.registrationNumber ||
      obj.plate ||
      obj.vehicleReg ||
      null;

    const vin = obj.vin || obj.VIN || null;
    const make = obj.make || obj.vehicleMake || null;
    const model = obj.model || obj.vehicleModel || null;
    const year = obj.year || obj.vehicleYear || null;
    const vehicleType = obj.type || obj.vehicleType || null;

    return {
      regNumber: reg ? String(reg).trim() : null,
      vin: vin ? String(vin).trim() : null,
      make: make ? String(make).trim() : null,
      model: model ? String(model).trim() : null,
      year: year ? String(year).trim() : null,
      vehicleType: vehicleType ? String(vehicleType).trim() : null,
      raw,
    };
  } catch {
    // Not JSON -> continue
  }

  // Percent-delimited disc string
  if (raw.includes('%')) {
    const parts = raw.split('%');
    const get = (idx) => (parts[idx] ? String(parts[idx]).trim() : null);

    const regNumber = get(6);
    const vin = get(12);

    let typeRaw = get(8);
    let vehicleType = null;
    if (typeRaw) {
      vehicleType = typeRaw.split('/')[0].split(' ')[0].trim();
    }

    const make = get(9);
    const model = get(10);

    if (!regNumber) return null;

    return {
      regNumber,
      vin: vin || null,
      make: make || null,
      model: model || null,
      year: null, // disc string didn’t include year in your mapping
      vehicleType: vehicleType || null,
      raw,
    };
  }

  // Fallback: treat raw as registration number
  return {
    regNumber: raw,
    vin: null,
    make: null,
    model: null,
    year: null,
    vehicleType: null,
    raw,
  };
}

export default function VehicleLogScreen() {
  const router = useRouter();

  // Main selection
  const [vehicle, setVehicle] = useState('');
  const [regNumber, setRegNumber] = useState('');
  const [project, setProject] = useState('');
  const [task, setTask] = useState('');

  // Reminder placeholder
  const [reminders] = useState([]);

  // Track current open trip (local only for now)
  const [openTrip, setOpenTrip] = useState(null);

  // Modals
  const [tripModalVisible, setTripModalVisible] = useState(false);
  const [purchaseModalVisible, setPurchaseModalVisible] = useState(false);
  const [logModalVisible, setLogModalVisible] = useState(false);

  // Create vehicle modal
  const [createVehicleVisible, setCreateVehicleVisible] = useState(false);
  const [newRegNumber, setNewRegNumber] = useState('');
  const [newVin, setNewVin] = useState('');
  const [newVehicleType, setNewVehicleType] = useState('');
  const [newYear, setNewYear] = useState('');
  const [newMake, setNewMake] = useState('');
  const [newModel, setNewModel] = useState('');
  const [pendingDiscRaw, setPendingDiscRaw] = useState(null);

  // Trip state
  const [tripType, setTripType] = useState('start'); // 'start' | 'end'
  const [tripProject, setTripProject] = useState('');
  const [tripTask, setTripTask] = useState('');
  const [tripUsage, setTripUsage] = useState('');
  const [tripOdometer, setTripOdometer] = useState('');
  const [tripOdometerPhoto, setTripOdometerPhoto] = useState(null);
  const [usagePickerVisible, setUsagePickerVisible] = useState(false);

  // Purchase state
  const [purchaseVendor, setPurchaseVendor] = useState('');
  const [purchaseType, setPurchaseType] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [purchaseProject, setPurchaseProject] = useState('');
  const [purchaseTask, setPurchaseTask] = useState('');
  const [purchaseCost, setPurchaseCost] = useState('');
  const [purchaseNotes, setPurchaseNotes] = useState('');
  const [purchaseOdometerPhoto, setPurchaseOdometerPhoto] = useState(null);

  // Log state
  const [logType, setLogType] = useState('');
  const [logDate, setLogDate] = useState('');
  const [logOdometer, setLogOdometer] = useState('');
  const [logVendor, setLogVendor] = useState('');
  const [logTag, setLogTag] = useState('');
  const [logCost, setLogCost] = useState('');
  const [logNotes, setLogNotes] = useState('');
  const [logCompletesReminder, setLogCompletesReminder] = useState('');
  const [logPhoto, setLogPhoto] = useState(null);

  const effectiveReg = regNumber?.trim();

  const openCreateVehicleModal = useCallback(
    (prefill = {}) => {
      setNewRegNumber(prefill.regNumber || effectiveReg || '');
      setNewVin(prefill.vin || '');
      setNewVehicleType(prefill.vehicleType || '');
      setNewYear(prefill.year || '');
      setNewMake(prefill.make || '');
      setNewModel(prefill.model || '');
      setPendingDiscRaw(prefill.raw || null);
      setCreateVehicleVisible(true);
    },
    [effectiveReg]
  );

  const closeCreateVehicleModal = () => {
    setCreateVehicleVisible(false);
    setPendingDiscRaw(null);
  };

  const getVehicleMetaForReg = useCallback(async (reg) => {
    const key = String(reg || '').trim().toUpperCase();
    if (!key) return null;

    const map = await loadVehiclesMap();
    const meta = map[key] || null;
    return meta;
  }, []);

  const ensureVehicleKnownOrPrompt = useCallback(
    async (parsed) => {
      const parsedReg = String(parsed?.regNumber || '').trim();
      if (!parsedReg) {
        Alert.alert('Scan failed', 'Could not detect a registration number.');
        return;
      }

      const regKey = parsedReg.toUpperCase();

      // Set reg immediately
      setRegNumber(parsedReg);

      // If scan contains make, use it as temporary display
      if (parsed?.make) {
        setVehicle(parsed.make);
      }

      // Check local store
      const map = await loadVehiclesMap();
      const existing = map[regKey];

      if (existing) {
        setVehicle(existing.make || parsed.make || vehicle || '');
        return;
      }

      // Not found -> prompt create vehicle (prefilled)
      openCreateVehicleModal({
        regNumber: parsedReg,
        vin: parsed.vin,
        vehicleType: parsed.vehicleType,
        year: parsed.year,
        make: parsed.make,
        model: parsed.model,
        raw: parsed.raw,
      });
    },
    [openCreateVehicleModal, vehicle]
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

          const parsed = parseLicenceDisc(value);
          if (!parsed) {
            Alert.alert('Scan failed', 'Could not read licence disc data.');
            return;
          }

          await ensureVehicleKnownOrPrompt(parsed);
        } catch (e) {
          console.log('[LOGBOOK] Failed to apply scan result', e);
        }
      })();

      return () => {
        mounted = false;
      };
    }, [ensureVehicleKnownOrPrompt])
  );

  // --- SHARED PHOTO HANDLER ---
  const takePhoto = async (setter) => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Camera permission',
        'Camera access is required to take a photo.'
      );
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      quality: 0.5,
    });

    if (result.canceled) return;

    const uri =
      result.assets && result.assets.length > 0 ? result.assets[0].uri : null;
    if (uri) setter(uri);
  };

  // --- DISC SCAN ---
  const handleScanDisc = () => {
    router.push({
      pathname: '/scan',
      params: {
        returnTo: '/logbook',
        field: 'licenseDisc',
        label: 'Scan licence disc',
      },
    });
  };

  const handleSaveNewVehicle = async () => {
    const reg = String(newRegNumber || '').trim();
    if (!reg) {
      Alert.alert('Missing registration', 'Please enter a registration number.');
      return;
    }
    const make = String(newMake || '').trim();
    if (!make) {
      Alert.alert('Missing make', 'Please enter the vehicle make.');
      return;
    }

    const meta = {
      regNumber: reg,
      vin: String(newVin || '').trim() || null,
      vehicleType: String(newVehicleType || '').trim() || null,
      year: String(newYear || '').trim() || null,
      make,
      model: String(newModel || '').trim() || null,
      createdAt: new Date().toISOString(),
      source: pendingDiscRaw ? 'disc-scan' : 'manual',
      discRaw: pendingDiscRaw || null,
    };

    // Save local cache (UX)
    const map = await loadVehiclesMap();
    map[reg.toUpperCase()] = meta;
    await saveVehiclesMap(map);

    // ✅ Save dedicated backend create event (outbox)
    try {
      const orgId = 'demo-org';
      const userId = 'demo-user';

      const rowId = await saveVehicleCreate({
        orgId,
        userId,
        regNumber: meta.regNumber,
        vin: meta.vin,
        vehicleType: meta.vehicleType,
        year: meta.year,
        make: meta.make,
        model: meta.model,
        source: meta.source,
        discRaw: meta.discRaw,
      });

      console.log('Vehicle create saved locally with id:', rowId);
    } catch (e) {
      console.log('Failed to queue vehicle-create event', e);
      // We still keep local cache; user can proceed offline.
    }

    // Populate main fields used by app
    setRegNumber(reg);
    setVehicle(make);

    Alert.alert('Vehicle created', 'Vehicle saved on this device.');
    closeCreateVehicleModal();
  };

  // Guard: encourage user to have reg before saving events
  const canProceedWithVehicle = useMemo(() => {
    return String(regNumber || '').trim().length > 0;
  }, [regNumber]);

  // --- TRIP BUTTON BEHAVIOUR ---
  const openTripModalFromMain = () => {
    if (!canProceedWithVehicle) {
      Alert.alert(
        'Select vehicle',
        'Please scan or enter a registration number first.'
      );
      return;
    }

    if (openTrip) {
      // End trip
      setTripType('end');
      setTripProject(openTrip.project || project);
      setTripTask(openTrip.task || task);
      setTripUsage(openTrip.usage);
      setTripOdometer('');
      setTripOdometerPhoto(null);
    } else {
      // Start trip
      setTripType('start');
      setTripProject(project);
      setTripTask(task);
      setTripUsage('');
      setTripOdometer('');
      setTripOdometerPhoto(null);
    }
    setTripModalVisible(true);
  };

  // --- SAVE HANDLERS ---

  const handleSaveTrip = async () => {
    if (!tripOdometer) {
      Alert.alert('Missing odometer', 'Please enter the odometer reading.');
      return;
    }

    const now = new Date();
    const coords = await getCurrentCoords();

    const orgId = 'demo-org';
    const userId = 'demo-user';

    const vehicleMeta = await getVehicleMetaForReg(regNumber);

    try {
      if (tripType === 'start') {
        if (!tripUsage) {
          Alert.alert(
            'Missing usage',
            'Please select usage (Business/Private).'
          );
          return;
        }

        const payload = {
          kind: 'trip-start',
          orgId,
          userId,
          vehicle, // UI label (make)
          regNumber,
          vehicleMeta, // full details for backend reliability
          project: tripProject || project || null,
          task: tripTask || task || null,
          usage: tripUsage,
          odometer: tripOdometer,
          photoUri: tripOdometerPhoto,
          startedAt: now.toISOString(),
          coordsStart: coords,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          syncStatus: 'pending',
        };

        const id = await saveVehicleTrip(payload);
        console.log('Vehicle trip START saved locally with id:', id);

        setOpenTrip({
          startAt: payload.startedAt,
          startOdometer: tripOdometer,
          usage: tripUsage,
          project: payload.project || undefined,
          task: payload.task || undefined,
          coordsStart: coords || undefined,
        });

        Alert.alert(
          'Trip started (demo)',
          'Trip start captured (not yet synced).'
        );
      } else {
        if (!openTrip) {
          Alert.alert(
            'No open trip',
            'There is no matching open trip to end on this device.'
          );
          return;
        }

        const payload = {
          kind: 'trip-end',
          orgId,
          userId,
          vehicle,
          regNumber,
          vehicleMeta,
          project: tripProject || openTrip.project || project || null,
          task: tripTask || openTrip.task || task || null,
          usage: openTrip.usage,
          startAt: openTrip.startAt,
          startOdometer: openTrip.startOdometer,
          endAt: now.toISOString(),
          endOdometer: tripOdometer,
          odometerPhotoUri: tripOdometerPhoto,
          coordsStart: openTrip.coordsStart || null,
          coordsEnd: coords,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          syncStatus: 'pending',
        };

        const id = await saveVehicleTrip(payload);
        console.log('Vehicle trip END saved locally with id:', id);

        setOpenTrip(null);
        Alert.alert('Trip ended (demo)', 'Trip end captured (not yet synced).');
      }

      setTripModalVisible(false);
      setTripOdometer('');
      setTripOdometerPhoto(null);
    } catch (e) {
      console.log('Failed to save trip', e);
      Alert.alert('Error', 'Could not save trip on this device.');
    }
  };

  const handleSavePurchase = async () => {
    if (!canProceedWithVehicle) {
      Alert.alert(
        'Select vehicle',
        'Please scan or enter a registration number first.'
      );
      return;
    }

    const coords = await getCurrentCoords();
    const dateTime = purchaseDate || formatNow();

    const orgId = 'demo-org';
    const userId = 'demo-user';

    const vehicleMeta = await getVehicleMetaForReg(regNumber);

    try {
      const payload = {
        orgId,
        userId,
        vehicle,
        regNumber,
        vehicleMeta,
        vendor: purchaseVendor,
        type: purchaseType,
        dateTime,
        project: purchaseProject || null,
        task: purchaseTask || null,
        cost: purchaseCost,
        notes: purchaseNotes,
        odometerPhotoUri: purchaseOdometerPhoto,
        coords,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        syncStatus: 'pending',
      };

      const id = await saveVehiclePurchase(payload);
      console.log('Vehicle purchase saved locally with id:', id);

      Alert.alert(
        'Purchase saved (demo)',
        'Vehicle purchase captured (not yet synced).'
      );

      setPurchaseModalVisible(false);
      setPurchaseVendor('');
      setPurchaseType('');
      setPurchaseDate('');
      setPurchaseProject('');
      setPurchaseTask('');
      setPurchaseCost('');
      setPurchaseNotes('');
      setPurchaseOdometerPhoto(null);
    } catch (e) {
      console.log('Failed to save purchase', e);
      Alert.alert('Error', 'Could not save purchase on this device.');
    }
  };

  const handleSaveLog = async () => {
    if (!canProceedWithVehicle) {
      Alert.alert(
        'Select vehicle',
        'Please scan or enter a registration number first.'
      );
      return;
    }

    const coords = await getCurrentCoords();
    const dateTime = logDate || formatNow();

    const orgId = 'demo-org';
    const userId = 'demo-user';

    const vehicleMeta = await getVehicleMetaForReg(regNumber);

    try {
      const payload = {
        orgId,
        userId,
        vehicle,
        regNumber,
        vehicleMeta,
        type: logType,
        dateTime,
        odometer: logOdometer,
        vendor: logVendor,
        tag: logTag,
        cost: logCost,
        notes: logNotes,
        completesReminder: logCompletesReminder,
        photoUri: logPhoto,
        coords,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        syncStatus: 'pending',
      };

      const id = await saveVehicleLog(payload);
      console.log('Vehicle log saved locally with id:', id);

      Alert.alert('Log saved (demo)', 'Vehicle log captured (not yet synced).');

      setLogModalVisible(false);
      setLogType('');
      setLogDate('');
      setLogOdometer('');
      setLogVendor('');
      setLogTag('');
      setLogCost('');
      setLogNotes('');
      setLogCompletesReminder('');
      setLogPhoto(null);
    } catch (e) {
      console.log('Failed to save vehicle log', e);
      Alert.alert('Error', 'Could not save log on this device.');
    }
  };

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Top bar with Vehicle Log logo + home button */}
        <View style={styles.topBar}>
          <Image
            source={require('../assets/vehicle-screen.png')}
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

        {/* Reminder card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Service reminder</Text>
          {reminders.length === 0 ? (
            <Text style={styles.cardSubtitle}>No active reminders.</Text>
          ) : (
            reminders.map((r) => (
              <Text key={r.id} style={styles.reminderText}>
                • {r.text}
              </Text>
            ))
          )}
        </View>

        {/* Main vehicle card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Vehicle log</Text>

          <View style={styles.scanRow}>
            <TouchableOpacity
              style={styles.scanDiscButton}
              onPress={handleScanDisc}
            >
              <Image
                source={require('../assets/barcode.png')}
                style={styles.scanDiscIcon}
              />
              <Text style={styles.scanDiscText}>Scan disc</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.scanDiscButton, { marginLeft: 8 }]}
              onPress={() => openCreateVehicleModal({ regNumber })}
            >
              <Text style={styles.scanDiscText}>+ Vehicle</Text>
            </TouchableOpacity>
          </View>

          <TextInput
            style={styles.input}
            placeholder="Vehicle (make)"
            placeholderTextColor="#aaa"
            value={vehicle}
            onChangeText={setVehicle}
          />

          <TextInput
            style={styles.input}
            placeholder="Registration no."
            placeholderTextColor="#aaa"
            value={regNumber}
            onChangeText={setRegNumber}
            autoCapitalize="characters"
          />

          <TextInput
            style={styles.input}
            placeholder="Project"
            placeholderTextColor="#aaa"
            value={project}
            onChangeText={setProject}
          />

          <TextInput
            style={styles.input}
            placeholder="Task"
            placeholderTextColor="#aaa"
            value={task}
            onChangeText={setTask}
          />

          {/* Action buttons */}
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={openTripModalFromMain}
            >
              <Image
                source={require('../assets/trip.png')}
                style={styles.actionIcon}
              />
              <Text style={styles.actionLabel}>
                {openTrip ? 'End trip' : 'Start trip'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => {
                if (!canProceedWithVehicle) {
                  Alert.alert(
                    'Select vehicle',
                    'Please scan or enter a registration number first.'
                  );
                  return;
                }
                setPurchaseModalVisible(true);
              }}
            >
              <Image
                source={require('../assets/purchases.png')}
                style={styles.actionIcon}
              />
              <Text style={styles.actionLabel}>Add purchase</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => {
                if (!canProceedWithVehicle) {
                  Alert.alert(
                    'Select vehicle',
                    'Please scan or enter a registration number first.'
                  );
                  return;
                }
                setLogModalVisible(true);
              }}
            >
              <Image
                source={require('../assets/activity-log.png')}
                style={styles.actionIcon}
              />
              <Text style={styles.actionLabel}>Add log</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      {/* CREATE VEHICLE MODAL */}
      <Modal
        visible={createVehicleVisible}
        transparent
        animationType="slide"
        onRequestClose={closeCreateVehicleModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Create vehicle</Text>
            <Text style={styles.cardSubtitle}>
              App uses Make + Registration. Backend can use full details.
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Registration number"
              placeholderTextColor="#aaa"
              value={newRegNumber}
              onChangeText={setNewRegNumber}
              autoCapitalize="characters"
            />

            <TextInput
              style={styles.input}
              placeholder="VIN"
              placeholderTextColor="#aaa"
              value={newVin}
              onChangeText={setNewVin}
              autoCapitalize="characters"
            />

            <TextInput
              style={styles.input}
              placeholder="Type of vehicle (e.g. Bakkie, Truck)"
              placeholderTextColor="#aaa"
              value={newVehicleType}
              onChangeText={setNewVehicleType}
            />

            <TextInput
              style={styles.input}
              placeholder="Year"
              placeholderTextColor="#aaa"
              value={newYear}
              onChangeText={setNewYear}
              keyboardType="numeric"
            />

            <TextInput
              style={styles.input}
              placeholder="Make (required)"
              placeholderTextColor="#aaa"
              value={newMake}
              onChangeText={setNewMake}
            />

            <TextInput
              style={styles.input}
              placeholder="Model"
              placeholderTextColor="#aaa"
              value={newModel}
              onChangeText={setNewModel}
            />

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.primaryButton, styles.modalButton]}
                onPress={handleSaveNewVehicle}
              >
                <Text style={styles.primaryButtonText}>Save vehicle</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalButton]}
                onPress={closeCreateVehicleModal}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* TRIP MODAL */}
      <Modal
        visible={tripModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setTripModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {tripType === 'start' ? 'Start trip' : 'End trip'}
            </Text>

            {tripType === 'end' && openTrip && (
              <Text style={styles.cardSubtitle}>
                Start odometer: {openTrip.startOdometer || '-'}
              </Text>
            )}

            <TextInput
              style={styles.input}
              placeholder="Project (optional override)"
              placeholderTextColor="#aaa"
              value={tripProject}
              onChangeText={setTripProject}
            />

            <TextInput
              style={styles.input}
              placeholder="Task (optional override)"
              placeholderTextColor="#aaa"
              value={tripTask}
              onChangeText={setTripTask}
            />

            {tripType === 'start' ? (
              <TouchableOpacity
                style={styles.selectInput}
                onPress={() => setUsagePickerVisible(true)}
              >
                <Text
                  style={
                    tripUsage
                      ? styles.selectInputText
                      : styles.selectInputPlaceholder
                  }
                >
                  {tripUsage
                    ? (USAGE_TYPES.find((u) => u.key === tripUsage) || {}).label ||
                      'Usage'
                    : 'Usage'}
                </Text>
                <Text style={styles.selectChevron}>▼</Text>
              </TouchableOpacity>
            ) : (
              openTrip && (
                <Text style={styles.cardSubtitle}>
                  Usage:{' '}
                  {(USAGE_TYPES.find((u) => u.key === openTrip.usage) || {})
                    .label || openTrip.usage}
                </Text>
              )
            )}

            <TextInput
              style={styles.input}
              placeholder="Odometer"
              placeholderTextColor="#aaa"
              value={tripOdometer}
              onChangeText={setTripOdometer}
              keyboardType="numeric"
            />

            {!tripOdometerPhoto ? (
              <TouchableOpacity
                style={styles.photoButton}
                onPress={() => takePhoto(setTripOdometerPhoto)}
              >
                <Image
                  source={require('../assets/camera.png')}
                  style={styles.photoIcon}
                />
                <Text style={styles.photoButtonText}>Odometer photo</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.photoPreview}>
                <Image
                  source={{ uri: tripOdometerPhoto }}
                  style={styles.photoPreviewImage}
                />
                <TouchableOpacity
                  style={styles.retryPhotoButton}
                  onPress={() => takePhoto(setTripOdometerPhoto)}
                >
                  <Text style={styles.retryPhotoText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.primaryButton, styles.modalButton]}
                onPress={handleSaveTrip}
              >
                <Text style={styles.primaryButtonText}>
                  {tripType === 'start' ? 'Save start' : 'Save end'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalButton]}
                onPress={() => setTripModalVisible(false)}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* PURCHASE MODAL */}
      <Modal
        visible={purchaseModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setPurchaseModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add purchase</Text>

            <TextInput
              style={styles.input}
              placeholder="Vendor"
              placeholderTextColor="#aaa"
              value={purchaseVendor}
              onChangeText={setPurchaseVendor}
            />
            <TextInput
              style={styles.input}
              placeholder="Type"
              placeholderTextColor="#aaa"
              value={purchaseType}
              onChangeText={setPurchaseType}
            />

            <View style={styles.dateRow}>
              <TextInput
                style={[styles.input, styles.dateInput]}
                placeholder="Date / time"
                placeholderTextColor="#aaa"
                value={purchaseDate}
                onChangeText={setPurchaseDate}
              />
              <TouchableOpacity
                style={styles.useNowButton}
                onPress={() => setPurchaseDate(formatNow())}
              >
                <Text style={styles.useNowText}>Use now</Text>
              </TouchableOpacity>
            </View>

            <TextInput
              style={styles.input}
              placeholder="Project"
              placeholderTextColor="#aaa"
              value={purchaseProject}
              onChangeText={setPurchaseProject}
            />
            <TextInput
              style={styles.input}
              placeholder="Task"
              placeholderTextColor="#aaa"
              value={purchaseTask}
              onChangeText={setPurchaseTask}
            />
            <TextInput
              style={styles.input}
              placeholder="Cost"
              placeholderTextColor="#aaa"
              value={purchaseCost}
              onChangeText={setPurchaseCost}
              keyboardType="numeric"
            />
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Notes"
              placeholderTextColor="#aaa"
              value={purchaseNotes}
              onChangeText={setPurchaseNotes}
              multiline
            />

            {!purchaseOdometerPhoto ? (
              <TouchableOpacity
                style={styles.photoButton}
                onPress={() => takePhoto(setPurchaseOdometerPhoto)}
              >
                <Image
                  source={require('../assets/camera.png')}
                  style={styles.photoIcon}
                />
                <Text style={styles.photoButtonText}>Odometer / slip photo</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.photoPreview}>
                <Image
                  source={{ uri: purchaseOdometerPhoto }}
                  style={styles.photoPreviewImage}
                />
                <TouchableOpacity
                  style={styles.retryPhotoButton}
                  onPress={() => takePhoto(setPurchaseOdometerPhoto)}
                >
                  <Text style={styles.retryPhotoText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.primaryButton, styles.modalButton]}
                onPress={handleSavePurchase}
              >
                <Text style={styles.primaryButtonText}>Save purchase</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalButton]}
                onPress={() => setPurchaseModalVisible(false)}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
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
            <Text style={styles.modalTitle}>Add log</Text>

            <TextInput
              style={styles.input}
              placeholder="Type"
              placeholderTextColor="#aaa"
              value={logType}
              onChangeText={setLogType}
            />

            <View style={styles.dateRow}>
              <TextInput
                style={[styles.input, styles.dateInput]}
                placeholder="Date / time"
                placeholderTextColor="#aaa"
                value={logDate}
                onChangeText={setLogDate}
              />
              <TouchableOpacity
                style={styles.useNowButton}
                onPress={() => setLogDate(formatNow())}
              >
                <Text style={styles.useNowText}>Use now</Text>
              </TouchableOpacity>
            </View>

            <TextInput
              style={styles.input}
              placeholder="Odometer"
              placeholderTextColor="#aaa"
              value={logOdometer}
              onChangeText={setLogOdometer}
              keyboardType="numeric"
            />
            <TextInput
              style={styles.input}
              placeholder="Vendor"
              placeholderTextColor="#aaa"
              value={logVendor}
              onChangeText={setLogVendor}
            />
            <TextInput
              style={styles.input}
              placeholder="Tag"
              placeholderTextColor="#aaa"
              value={logTag}
              onChangeText={setLogTag}
            />
            <TextInput
              style={styles.input}
              placeholder="Cost"
              placeholderTextColor="#aaa"
              value={logCost}
              onChangeText={setLogCost}
              keyboardType="numeric"
            />
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Notes"
              placeholderTextColor="#aaa"
              value={logNotes}
              onChangeText={setLogNotes}
              multiline
            />
            <TextInput
              style={styles.input}
              placeholder="Completes reminder (optional)"
              placeholderTextColor="#aaa"
              value={logCompletesReminder}
              onChangeText={setLogCompletesReminder}
            />

            {!logPhoto ? (
              <TouchableOpacity
                style={styles.photoButton}
                onPress={() => takePhoto(setLogPhoto)}
              >
                <Image
                  source={require('../assets/camera.png')}
                  style={styles.photoIcon}
                />
                <Text style={styles.photoButtonText}>Photo (optional)</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.photoPreview}>
                <Image
                  source={{ uri: logPhoto }}
                  style={styles.photoPreviewImage}
                />
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
          </View>
        </View>
      </Modal>

      {/* USAGE PICKER MODAL */}
      <Modal
        visible={usagePickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setUsagePickerVisible(false)}
      >
        <View style={styles.typeModalOverlay}>
          <View style={styles.typeModalCard}>
            <Text style={styles.typeModalTitle}>Select usage</Text>
            {USAGE_TYPES.map((u) => (
              <TouchableOpacity
                key={u.key}
                style={styles.typeOption}
                onPress={() => {
                  setTripUsage(u.key);
                  setUsagePickerVisible(false);
                }}
              >
                <Text
                  style={[
                    styles.typeOptionText,
                    tripUsage === u.key && styles.typeOptionTextSelected,
                  ]}
                >
                  {u.label}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.secondaryButton, { marginTop: 8 }]}
              onPress={() => setUsagePickerVisible(false)}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
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
  cardSubtitle: {
    fontSize: 12,
    color: '#666',
    marginBottom: 8,
  },
  reminderText: {
    fontSize: 12,
    color: '#333',
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
    height: 60,
    textAlignVertical: 'top',
  },
  scanRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginBottom: 8,
  },
  scanDiscButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: THEME_COLOR,
    marginBottom: 8,
  },
  scanDiscIcon: {
    width: 48,
    height: 48,
    marginRight: 6,
  },
  scanDiscText: {
    color: THEME_COLOR,
    fontWeight: '500',
    fontSize: 13,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  actionButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    marginHorizontal: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    backgroundColor: '#fafafa',
  },
  actionIcon: {
    width: 36,
    height: 36,
    marginBottom: 4,
  },
  actionLabel: {
    fontSize: 11,
    textAlign: 'center',
  },
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
    marginBottom: 12,
    textAlign: 'center',
  },
  modalButtonsRow: {
    flexDirection: 'row',
    marginTop: 12,
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
  selectInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 12,
    marginBottom: 10,
    backgroundColor: '#fafafa',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selectInputText: {
    fontSize: 14,
    color: '#333',
  },
  selectInputPlaceholder: {
    fontSize: 14,
    color: '#aaa',
  },
  selectChevron: {
    fontSize: 12,
    color: '#777',
  },
  // Usage picker modal
  typeModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  typeModalCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 16,
    paddingHorizontal: 12,
  },
  typeModalTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  typeOption: {
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  typeOptionText: {
    fontSize: 14,
    color: '#333',
    textAlign: 'center',
  },
  typeOptionTextSelected: {
    color: THEME_COLOR,
    fontWeight: '700',
  },
});
