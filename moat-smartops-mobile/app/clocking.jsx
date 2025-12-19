import { useRouter } from 'expo-router';
import { useState } from 'react';
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
import { saveClockBatch } from '../database'; // 🔹 new import

const THEME_COLOR = '#22a6b3';

const CLOCK_TYPES = [
  { key: 'in', label: 'In' },
  { key: 'out', label: 'Out' },
  { key: 'training', label: 'Training' },
  { key: 'sick', label: 'Sick' },
  { key: 'iod', label: 'IOD' },
  { key: 'leave', label: 'Leave' },
  { key: 'overtime', label: 'Overtime' },
];

function getClockTypeLabel(key) {
  const found = CLOCK_TYPES.find((t) => t.key === key);
  return found ? found.label : key;
}

export default function ClockingScreen() {
  const router = useRouter();

  // Top-level selection
  const [project, setProject] = useState('');
  const [task, setTask] = useState('');
  const [group, setGroup] = useState('');
  const [clockType, setClockType] = useState(''); // dropdown
  const [batchNote, setBatchNote] = useState('');

  // Group scan modal
  const [scanModalVisible, setScanModalVisible] = useState(false);

  // Clock type picker modal
  const [clockTypePickerVisible, setClockTypePickerVisible] = useState(false);

  // People in this clocking batch
  const [scannedPeople, setScannedPeople] = useState([]);

  const openScanModal = () => {
    if (!project || !group || !clockType) {
      Alert.alert(
        'Missing info',
        'Please select project, group and clocking type before scanning.'
      );
      return;
    }
    setScanModalVisible(true);
  };

  const closeScanModal = () => {
    setScanModalVisible(false);
  };

  // 🔹 Demo "scan face" – later: real biometric + onboarding photo
  const handleScanFace = () => {
    const index = scannedPeople.length + 1;
    const newPerson = {
      id: Date.now().toString() + '-' + index,
      name: `Scanned person ${index}`,
      method: 'face', // later: real biometric match
      status: 'present', // 'present' | 'sick' | 'absent'
      note: '',
    };

    setScannedPeople((prev) => [...prev, newPerson]);
    Alert.alert(
      'Demo only',
      'This is where the onboarding photo + confirmation will appear once wired to the backend + biometric engine.'
    );
  };

  // 🔹 Demo manual select – later: pick real member + force photo
  const handleManualSelect = () => {
    const index = scannedPeople.length + 1;
    const newPerson = {
      id: Date.now().toString() + '-manual-' + index,
      name: `Manual person ${index}`,
      method: 'manual',
      status: 'present',
      note: '',
      // later: add manualPhotoUri from camera
    };
    setScannedPeople((prev) => [...prev, newPerson]);
    Alert.alert(
      'Demo only',
      'Later this will let you pick someone from the group and take a photo for manual clocking.'
    );
  };

  const cycleStatus = (personId) => {
    setScannedPeople((prev) =>
      prev.map((p) => {
        if (p.id !== personId) return p;
        let nextStatus = 'present';
        if (p.status === 'present') nextStatus = 'sick';
        else if (p.status === 'sick') nextStatus = 'absent';
        else if (p.status === 'absent') nextStatus = 'present';
        return { ...p, status: nextStatus };
      })
    );
  };

  // 🔹 Save batch via DB stub (later SQLite)
  const handleSaveBatch = async () => {
    if (!project || !group || !clockType) {
      Alert.alert(
        'Missing info',
        'Please select project, group and clocking type.'
      );
      return;
    }

    if (scannedPeople.length === 0) {
      Alert.alert(
        'No people scanned',
        'Please scan or manually select at least one person.'
      );
      return;
    }

    const timestamp = new Date().toISOString();

    // Header row for this batch – this is the shape we’ll later use in SQLite + backend
    const batch = {
      orgId: 'demo-org', // later: from logged-in user
      projectId: project || null, // later: actual projectId
      taskId: task || null,
      groupId: group || null,
      clockType, // 'in' | 'out' | ...
      note: batchNote || '',
      createdAt: timestamp,
      updatedAt: timestamp,
      syncStatus: 'pending', // later: 'pending' -> 'synced'
    };

    // Detail rows for each person
    const people = scannedPeople.map((p) => ({
      userId: p.id, // later: real userId from roster
      name: p.name,
      method: p.method, // 'face' | 'manual'
      status: p.status, // 'present' | 'sick' | 'absent'
      note: p.note || '',
    }));

    try {
      const localId = await saveClockBatch(batch, people);
      console.log('Clocking batch saved locally with id:', localId);

      Alert.alert('Saved (demo)', 'Clocking batch captured (not yet synced).');

      // Clear current batch
      setScannedPeople([]);
      setBatchNote('');
    } catch (e) {
      console.error('Failed to save clocking batch', e);
      Alert.alert(
        'Save failed',
        'Could not save this clocking batch on the device.'
      );
    }
  };

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Top bar with module-specific logo + home button */}
        <View style={styles.topBar}>
          <Image
            source={require('../assets/clockings-screen.png')}
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

        {/* Selection card */}
        <View style={styles.card}>
          <TextInput
            style={styles.input}
            placeholder="Project selected"
            placeholderTextColor="#aaa"
            value={project}
            onChangeText={setProject}
          />

          <TextInput
            style={styles.input}
            placeholder="Task selected (optional)"
            placeholderTextColor="#aaa"
            value={task}
            onChangeText={setTask}
          />

          <TextInput
            style={styles.input}
            placeholder="Shows user group"
            placeholderTextColor="#aaa"
            value={group}
            onChangeText={setGroup}
          />

          {/* Clocking type dropdown */}
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
              {clockType ? getClockTypeLabel(clockType) : 'Clocking type'}
            </Text>
            <Text style={styles.selectChevron}>▼</Text>
          </TouchableOpacity>

          <TextInput
            style={[styles.input, styles.textArea]}
            placeholder="Note (optional)"
            placeholderTextColor="#aaa"
            value={batchNote}
            onChangeText={setBatchNote}
            multiline
          />

          <TouchableOpacity
            style={styles.primaryButton}
            onPress={openScanModal}
          >
            <Image
              source={require('../assets/scan.png')}
              style={styles.scanIcon}
            />
            <Text style={styles.primaryButtonText}>
              Scan face / Start group
            </Text>
          </TouchableOpacity>
        </View>

        {/* Summary of scanned people */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Names</Text>
          <Text style={styles.cardSubtitle}>
            Tap a person to cycle status (Present → Sick → Absent).
          </Text>

          {scannedPeople.length === 0 ? (
            <Text style={styles.emptyText}>
              No people scanned yet. Use the scan button to begin.
            </Text>
          ) : (
            scannedPeople.map((p) => (
              <TouchableOpacity
                key={p.id}
                style={styles.personRow}
                onPress={() => cycleStatus(p.id)}
              >
                <View style={styles.personInfo}>
                  <Text style={styles.personName}>{p.name}</Text>
                  <Text style={styles.personMethod}>
                    {p.method === 'face' ? 'Scan' : 'Manual'}
                  </Text>
                </View>
                <View style={styles.statusBadge(p.status)}>
                  <Text style={styles.statusBadgeText}>
                    {p.status === 'present'
                      ? 'Present'
                      : p.status === 'sick'
                      ? 'Sick'
                      : 'Absent'}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          )}

          <TouchableOpacity
            style={[
              styles.primaryButton,
              scannedPeople.length === 0 && { opacity: 0.4 },
            ]}
            onPress={handleSaveBatch}
            disabled={scannedPeople.length === 0}
          >
            <Text style={styles.primaryButtonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* SCAN MODAL */}
      <Modal
        visible={scanModalVisible}
        transparent
        animationType="slide"
        onRequestClose={closeScanModal}
      >
        <View style={styles.scanModalOverlay}>
          <View style={styles.scanModalCard}>
            <Text style={styles.scanTitle}>Scan group</Text>
            <Text style={styles.scanSubtitle}>
              Project: {project || '-'} {'\n'}
              Task: {task || '-'} {'\n'}
              Group: {group || '-'} {'\n'}
              Type: {clockType ? getClockTypeLabel(clockType) : '-'}
            </Text>

            {/* Scan + manual buttons */}
            <View style={styles.scanButtonsRow}>
              <TouchableOpacity
                style={[styles.primaryButton, styles.scanButton]}
                onPress={handleScanFace}
              >
                <Image
                  source={require('../assets/scan.png')}
                  style={styles.scanIcon}
                />
                <Text style={styles.primaryButtonText}>Scan face</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.secondaryButton, styles.scanButton]}
                onPress={handleManualSelect}
              >
                <Text style={styles.secondaryButtonText}>Manual clock</Text>
              </TouchableOpacity>
            </View>

            {/* Short list inside modal for feedback */}
            <View style={styles.scanList}>
              {scannedPeople.length === 0 ? (
                <Text style={styles.emptyText}>
                  No people in this batch yet.
                </Text>
              ) : (
                scannedPeople.slice(-3).map((p) => (
                  <Text key={p.id} style={styles.scanRecentText}>
                    • {p.name} ({p.method === 'face' ? 'scan' : 'manual'})
                  </Text>
                ))
              )}
            </View>

            <View style={styles.scanFooterButtons}>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.scanFooterButton]}
                onPress={closeScanModal}
              >
                <Text style={styles.secondaryButtonText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* CLOCK TYPE PICKER MODAL */}
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
    marginBottom: 12,
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
  scanIcon: {
    width: 32,
    height: 32,
  },
  emptyText: {
    fontSize: 12,
    color: '#999',
  },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  personInfo: {
    flex: 1,
  },
  personName: {
    fontSize: 14,
    fontWeight: '500',
  },
  personMethod: {
    fontSize: 11,
    color: '#777',
  },
  statusBadge: (status) => ({
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor:
      status === 'present'
        ? '#27ae60'
        : status === 'sick'
        ? '#f39c12'
        : '#e74c3c',
  }),
  statusBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  // Scan modal styles
  scanModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  scanModalCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 20,
  },
  scanTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  scanSubtitle: {
    fontSize: 12,
    color: '#666',
    marginBottom: 12,
    textAlign: 'center',
  },
  scanButtonsRow: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  scanButton: {
    flex: 1,
    marginHorizontal: 4,
  },
  scanList: {
    minHeight: 40,
    marginBottom: 12,
  },
  scanRecentText: {
    fontSize: 12,
    color: '#333',
  },
  scanFooterButtons: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  scanFooterButton: {
    flex: 1,
    marginHorizontal: 4,
  },
  // Clock type picker modal
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
