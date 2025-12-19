import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
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
import MapView, { Marker, Polygon } from 'react-native-maps';
import {
  saveActivityLog,
  saveProjectUpdate,
  saveTaskUpdate,
  saveUserDocumentAttachment,
} from '../database';

export default function ProductionScreen() {
  const router = useRouter();

  // Productivity mode
  const [mode, setMode] = useState('project');

  // Project management form state
  const [project, setProject] = useState('');
  const [task, setTask] = useState('');
  const [status, setStatus] = useState('');
  const [managerNote, setManagerNote] = useState('');

  // Task management form state
  const [taskMgmtTask, setTaskMgmtTask] = useState('');
  const [taskMgmtMilestone, setTaskMgmtMilestone] = useState('');
  const [taskMgmtStatus, setTaskMgmtStatus] = useState('');
  const [taskMgmtNote, setTaskMgmtNote] = useState('');

  // Activity log state
  const [activityTask, setActivityTask] = useState('');
  const [activityMilestone, setActivityMilestone] = useState('');
  const [activityNote, setActivityNote] = useState('');
  const [activityPhoto, setActivityPhoto] = useState(null);
  const [activityFencePoints, setActivityFencePoints] = useState([]); // array of { latitude, longitude }

  // Attach User Document modal state
  const [attachVisible, setAttachVisible] = useState(false);
  const [attachProject, setAttachProject] = useState('');
  const [attachUser, setAttachUser] = useState('');
  const [attachTitle, setAttachTitle] = useState('');
  const [attachTag, setAttachTag] = useState('');
  const [attachPhoto, setAttachPhoto] = useState(null);

  // Fence map modal state
  const [fenceModalVisible, setFenceModalVisible] = useState(false);
  const [mapRegion, setMapRegion] = useState(null);

  // Auto capture state for fence
  const [autoCapturing, setAutoCapturing] = useState(false);
  const captureTimerRef = useRef(null);

  const openAttachModal = () => {
    setAttachProject(project || '');
    setAttachVisible(true);
  };

  const closeAttachModal = () => {
    setAttachVisible(false);
  };

  // --- CAMERA: ATTACH USER DOCUMENT ---
  const handleTakePhoto = async () => {
    const { status: camStatus } = await ImagePicker.requestCameraPermissionsAsync();
    if (camStatus !== 'granted') {
      Alert.alert('Camera permission', 'Camera access is required to take a photo.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({ quality: 0.5 });

    if (result.canceled) return;

    const photoUri =
      result.assets && result.assets.length > 0 ? result.assets[0].uri : null;

    if (photoUri) setAttachPhoto(photoUri);
  };

  // --- SAVE: ATTACH USER DOCUMENT → SQLite outbox ---
  const handleSaveAttachment = async () => {
    try {
      if (!attachPhoto) {
        Alert.alert('Missing document', 'Please take a photo of the document before saving.');
        return;
      }

      const nowIso = new Date().toISOString();
      const orgId = 'demo-org';
      const userId = 'demo-user'; // actor (logged in)

      const doc = {
        orgId,
        userId,
        projectId: attachProject || null,
        targetUserId: attachUser || null, // who the doc is for
        title: attachTitle || null,
        tag: attachTag || null,
        photoUri: attachPhoto,
        syncStatus: 'pending',
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const rowId = await saveUserDocumentAttachment(doc);
      console.log('User document saved locally with id:', rowId);

      Alert.alert('Saved', 'User document stored on this device for sync.');

      // Reset attach form
      setAttachUser('');
      setAttachTitle('');
      setAttachTag('');
      setAttachPhoto(null);
      setAttachVisible(false);
    } catch (e) {
      console.error('Failed to save user document', e);
      Alert.alert('Error', 'Could not save the user document on this device.');
    }
  };

  // --- SAVE: TASK MANAGEMENT → SQLite outbox ---
  const handleSaveTaskManagement = async () => {
    try {
      if (!taskMgmtTask && !taskMgmtNote) {
        Alert.alert('Missing details', 'Please enter at least a task and note before saving.');
        return;
      }

      const nowIso = new Date().toISOString();
      const orgId = 'demo-org';
      const userId = 'demo-user';

      const update = {
        orgId,
        userId,
        projectId: project || null,
        taskId: taskMgmtTask || null,
        milestone: taskMgmtMilestone || null,
        status: taskMgmtStatus || null,
        note: taskMgmtNote || '',
        syncStatus: 'pending',
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const rowId = await saveTaskUpdate(update);
      console.log('Task update saved locally with id:', rowId);

      Alert.alert('Saved', 'Task update stored on this device.');

      // Reset task management form
      setTaskMgmtTask('');
      setTaskMgmtMilestone('');
      setTaskMgmtStatus('');
      setTaskMgmtNote('');
    } catch (e) {
      console.error('Failed to save task update', e);
      Alert.alert('Error', 'Could not save the task update on this device.');
    }
  };

  // --- SAVE: PROJECT MANAGEMENT → SQLite outbox ---
  const handleSaveProjectManagement = async () => {
    try {
      if (!project && !managerNote) {
        Alert.alert('Missing details', 'Please enter at least a project and note before saving.');
        return;
      }

      const nowIso = new Date().toISOString();
      const orgId = 'demo-org';
      const userId = 'demo-user';

      const update = {
        orgId,
        userId,
        projectId: project || null,
        taskId: task || null,
        status: status || null,
        managerNote: managerNote || '',
        syncStatus: 'pending',
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const rowId = await saveProjectUpdate(update);
      console.log('Project update saved locally with id:', rowId);

      Alert.alert('Saved', 'Project update stored on this device.');

      // Reset project management form (keep project if you prefer)
      setTask('');
      setStatus('');
      setManagerNote('');
    } catch (e) {
      console.error('Failed to save project update', e);
      Alert.alert('Error', 'Could not save the project update on this device.');
    }
  };

  // --- CAMERA: ACTIVITY LOG ---
  const handleTakeActivityPhoto = async () => {
    const { status: camStatus } = await ImagePicker.requestCameraPermissionsAsync();
    if (camStatus !== 'granted') {
      Alert.alert('Camera permission', 'Camera access is required to take a photo.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({ quality: 0.5 });

    if (result.canceled) return;

    const photoUri =
      result.assets && result.assets.length > 0 ? result.assets[0].uri : null;

    if (photoUri) setActivityPhoto(photoUri);
  };

  // --- FENCE CAPTURE ---
  const handleStartFenceCapture = async () => {
    const { status: locStatus } = await Location.requestForegroundPermissionsAsync();
    if (locStatus !== 'granted') {
      Alert.alert('Location permission', 'Location access is required to capture an activity fence/point.');
      return;
    }

    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    const region = {
      latitude: loc.coords.latitude,
      longitude: loc.coords.longitude,
      latitudeDelta: 0.005,
      longitudeDelta: 0.005,
    };

    setMapRegion(region);
    setFenceModalVisible(true);
  };

  const startAutoCapture = async () => {
    try {
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      const firstPoint = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
      setActivityFencePoints((prev) => [...prev, firstPoint]);
    } catch (e) {
      console.log('Error getting initial location', e);
    }

    const timer = setInterval(async () => {
      try {
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        const point = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
        setActivityFencePoints((prev) => [...prev, point]);
      } catch (e) {
        console.log('Error getting location in interval', e);
      }
    }, 5000);

    captureTimerRef.current = timer;
    setAutoCapturing(true);
  };

  const stopAutoCapture = () => {
    if (captureTimerRef.current) {
      clearInterval(captureTimerRef.current);
      captureTimerRef.current = null;
    }
    setAutoCapturing(false);
  };

  const handleConfirmFence = () => {
    if (activityFencePoints.length === 0) {
      Alert.alert('No points', 'Please capture at least one point for this activity fence.');
      return;
    }
    stopAutoCapture();
    setFenceModalVisible(false);
  };

  const handleCloseFenceModal = () => {
    stopAutoCapture();
    setFenceModalVisible(false);
  };

  const getFenceSummary = () => {
    if (activityFencePoints.length === 0) return null;
    if (activityFencePoints.length === 1) {
      const p = activityFencePoints[0];
      return `Point at ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;
    }
    return `${activityFencePoints.length} points captured for fence`;
  };

  // --- SAVE ACTIVITY LOG TO SQLITE ---
  const handleSaveActivityLog = async () => {
    try {
      const nowIso = new Date().toISOString();
      const orgId = 'demo-org';
      const userId = 'demo-user';

      const fenceJson =
        activityFencePoints && activityFencePoints.length > 0
          ? JSON.stringify({ type: 'polyline', points: activityFencePoints })
          : null;

      const log = {
        orgId,
        userId,
        projectId: project || null,
        taskId: activityTask || null,
        milestone: activityMilestone || null,
        note: activityNote || '',
        photoUri: activityPhoto || null,
        fenceJson,
        syncStatus: 'pending',
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const insertId = await saveActivityLog(log);

      console.log('Activity log saved locally with id:', insertId);

      Alert.alert('Saved', 'Activity log saved on this device (not yet synced).');

      setActivityTask('');
      setActivityMilestone('');
      setActivityNote('');
      setActivityPhoto(null);
      setActivityFencePoints([]);
    } catch (e) {
      console.error('Failed to save activity log', e);
      Alert.alert('Error', 'Could not save the activity log on this device.');
    }
  };

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.topBar}>
          <Image
            source={require('../assets/productivity-screen.png')}
            style={styles.topBarLogo}
            resizeMode="contain"
          />
          <TouchableOpacity style={styles.homeButton} onPress={() => router.replace('/home')}>
            <Image source={require('../assets/home.png')} style={styles.homeIcon} />
          </TouchableOpacity>
        </View>

        <View style={styles.modeRow}>
          <ModeButton
            label="Project management"
            selected={mode === 'project'}
            onPress={() => setMode('project')}
            icon={require('../assets/project-management.png')}
          />
          <ModeButton
            label="Task management"
            selected={mode === 'task'}
            onPress={() => setMode('task')}
            icon={require('../assets/task-management.png')}
          />
          <ModeButton
            label="Add activity log"
            selected={mode === 'activity'}
            onPress={() => setMode('activity')}
            icon={require('../assets/activity-log.png')}
          />
        </View>

        {mode === 'project' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Project management update</Text>

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
              placeholder="Status"
              placeholderTextColor="#aaa"
              value={status}
              onChangeText={setStatus}
            />

            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Manager note"
              placeholderTextColor="#aaa"
              value={managerNote}
              onChangeText={setManagerNote}
              multiline
            />

            <TouchableOpacity style={styles.attachButton} onPress={openAttachModal}>
              <Image source={require('../assets/camera.png')} style={styles.attachIcon} />
              <Text style={styles.attachText}>Attach user document</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.saveButton} onPress={handleSaveProjectManagement}>
              <Text style={styles.saveButtonText}>Save update</Text>
            </TouchableOpacity>
          </View>
        )}

        {mode === 'task' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Task management update</Text>
            <Text style={styles.cardSubtitle}>
              Add task-level status and notes. Later this will feed the task manager timeline on the backend.
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Task selected"
              placeholderTextColor="#aaa"
              value={taskMgmtTask}
              onChangeText={setTaskMgmtTask}
            />

            <TextInput
              style={styles.input}
              placeholder="Milestone selected (optional)"
              placeholderTextColor="#aaa"
              value={taskMgmtMilestone}
              onChangeText={setTaskMgmtMilestone}
            />

            <TextInput
              style={styles.input}
              placeholder="Status"
              placeholderTextColor="#aaa"
              value={taskMgmtStatus}
              onChangeText={setTaskMgmtStatus}
            />

            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Task note"
              placeholderTextColor="#aaa"
              value={taskMgmtNote}
              onChangeText={setTaskMgmtNote}
              multiline
            />

            <TouchableOpacity style={styles.saveButton} onPress={handleSaveTaskManagement}>
              <Text style={styles.saveButtonText}>Save task update</Text>
            </TouchableOpacity>
          </View>
        )}

        {mode === 'activity' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Add activity log</Text>
            <Text style={styles.cardSubtitle}>
              Capture task, milestone, note, photo and fence for this activity.
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Task selected"
              placeholderTextColor="#aaa"
              value={activityTask}
              onChangeText={setActivityTask}
            />

            <TextInput
              style={styles.input}
              placeholder="Milestone (optional)"
              placeholderTextColor="#aaa"
              value={activityMilestone}
              onChangeText={setActivityMilestone}
            />

            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Activity note"
              placeholderTextColor="#aaa"
              value={activityNote}
              onChangeText={setActivityNote}
              multiline
            />

            {!activityPhoto ? (
              <TouchableOpacity style={styles.takePhotoButton} onPress={handleTakeActivityPhoto}>
                <Image source={require('../assets/camera.png')} style={styles.cameraIcon} />
                <Text style={styles.takePhotoText}>Add photo</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.photoPreview}>
                <Image source={{ uri: activityPhoto }} style={styles.photoPreviewImage} />
                <TouchableOpacity style={styles.retryPhotoButton} onPress={handleTakeActivityPhoto}>
                  <Text style={styles.retryPhotoText}>Retry photo</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity style={styles.takePhotoButton} onPress={handleStartFenceCapture}>
              <Image source={require('../assets/add-fence.png')} style={styles.cameraIcon} />
              <Text style={styles.takePhotoText}>Add activity fence / point</Text>
            </TouchableOpacity>

            {getFenceSummary() && (
              <View style={styles.photoPreview}>
                <Text style={styles.cardSubtitle}>{getFenceSummary()}</Text>
              </View>
            )}

            <TouchableOpacity style={styles.saveButton} onPress={handleSaveActivityLog}>
              <Text style={styles.saveButtonText}>Save activity log</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <Modal visible={attachVisible} transparent animationType="fade" onRequestClose={closeAttachModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Attach User Document</Text>

            <TextInput
              style={styles.input}
              placeholder="Select project"
              value={attachProject}
              onChangeText={setAttachProject}
            />

            <TextInput
              style={styles.input}
              placeholder="Select user"
              value={attachUser}
              onChangeText={setAttachUser}
            />

            <TextInput
              style={styles.input}
              placeholder="Title"
              value={attachTitle}
              onChangeText={setAttachTitle}
            />

            <TextInput
              style={styles.input}
              placeholder="Tag"
              value={attachTag}
              onChangeText={setAttachTag}
            />

            {!attachPhoto ? (
              <TouchableOpacity style={styles.takePhotoButton} onPress={handleTakePhoto}>
                <Image source={require('../assets/camera.png')} style={styles.cameraIcon} />
                <Text style={styles.takePhotoText}>Take photo</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.photoPreview}>
                <Image source={{ uri: attachPhoto }} style={styles.photoPreviewImage} />
                <TouchableOpacity style={styles.retryPhotoButton} onPress={handleTakePhoto}>
                  <Text style={styles.retryPhotoText}>Retry photo</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity style={styles.saveButton} onPress={handleSaveAttachment}>
              <Text style={styles.saveButtonText}>Save attachment</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.modalCloseButton} onPress={closeAttachModal}>
              <Text style={styles.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={fenceModalVisible}
        transparent={false}
        animationType="slide"
        onRequestClose={handleCloseFenceModal}
      >
        <View style={styles.fenceContainer}>
          {mapRegion ? (
            <MapView
              style={styles.fenceMap}
              initialRegion={mapRegion}
              region={mapRegion}
              onRegionChangeComplete={setMapRegion}
            >
              <Polygon
                coordinates={DUMMY_TASK_FENCE}
                strokeColor="rgba(34,166,179,1)"
                fillColor="rgba(34,166,179,0.2)"
                strokeWidth={2}
              />

              {activityFencePoints.length === 1 && (
                <Marker
                  coordinate={activityFencePoints[0]}
                  title="Activity point"
                  description="Captured from GPS"
                />
              )}

              {activityFencePoints.length >= 2 && (
                <Polygon
                  coordinates={activityFencePoints}
                  strokeColor="rgba(231, 76, 60, 1)"
                  fillColor="rgba(231, 76, 60, 0.2)"
                  strokeWidth={2}
                />
              )}
            </MapView>
          ) : (
            <View style={styles.fenceLoading}>
              <Text style={styles.cardSubtitle}>Getting location…</Text>
            </View>
          )}

          <View style={styles.fenceControls}>
            <TouchableOpacity
              style={[
                styles.saveButton,
                styles.fenceControlButton,
                autoCapturing && { backgroundColor: '#95a5a6' },
              ]}
              onPress={autoCapturing ? stopAutoCapture : startAutoCapture}
            >
              <Text style={styles.saveButtonText}>
                {autoCapturing ? 'Stop capture' : 'Start capture'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.takePhotoButton, styles.fenceControlButton, { marginBottom: 0 }]}
              onPress={handleConfirmFence}
            >
              <Text style={styles.takePhotoText}>Done</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.takePhotoButton, styles.fenceControlButton, { marginBottom: 0 }]}
              onPress={handleCloseFenceModal}
            >
              <Text style={styles.takePhotoText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

function ModeButton({ label, selected, onPress, icon }) {
  return (
    <TouchableOpacity
      style={[styles.modeButton, selected && styles.modeButtonSelected]}
      onPress={onPress}
    >
      <Image source={icon} style={styles.modeIcon} />
      <Text style={[styles.modeLabel, selected && styles.modeLabelSelected]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const THEME_COLOR = '#22a6b3';

const DUMMY_TASK_FENCE = [
  { latitude: -29.8445, longitude: 30.8936 },
  { latitude: -29.8445, longitude: 30.9036 },
  { latitude: -29.8545, longitude: 30.9036 },
  { latitude: -29.8545, longitude: 30.8936 },
];

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
    marginBottom: 12,
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
  modeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  modeButton: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    paddingVertical: 10,
    marginHorizontal: 4,
    alignItems: 'center',
    elevation: 2,
  },
  modeButtonSelected: {
    borderWidth: 2,
    borderColor: THEME_COLOR,
  },
  modeIcon: {
    width: 48,
    height: 48,
    marginBottom: 4,
  },
  modeLabel: {
    fontSize: 11,
    textAlign: 'center',
  },
  modeLabelSelected: {
    color: THEME_COLOR,
    fontWeight: '600',
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
  },
  textArea: {
    height: 80,
    textAlignVertical: 'top',
  },
  attachButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: THEME_COLOR,
    marginTop: 4,
    marginBottom: 12,
  },
  attachIcon: {
    width: 32,
    height: 32,
    marginRight: 8,
  },
  attachText: {
    fontSize: 13,
    color: THEME_COLOR,
    fontWeight: '500',
  },
  takePhotoButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderWidth: 1,
    borderColor: THEME_COLOR,
    borderRadius: 6,
    marginBottom: 12,
  },
  takePhotoText: {
    marginLeft: 8,
    color: THEME_COLOR,
    fontWeight: '600',
  },
  cameraIcon: {
    width: 32,
    height: 32,
  },
  photoPreview: {
    padding: 10,
    borderRadius: 6,
    backgroundColor: '#eef',
    marginBottom: 12,
    alignItems: 'center',
  },
  photoPreviewImage: {
    width: 120,
    height: 120,
    marginBottom: 8,
    borderRadius: 6,
  },
  retryPhotoButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: '#f39c12',
  },
  retryPhotoText: {
    color: '#fff',
    fontWeight: '600',
  },
  saveButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: 'center',
    marginTop: 4,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
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
    marginBottom: 16,
    textAlign: 'center',
  },
  modalCloseButton: {
    marginTop: 8,
    alignSelf: 'center',
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  modalCloseText: {
    color: '#555',
    fontSize: 12,
  },
  fenceContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  fenceMap: {
    flex: 1,
  },
  fenceControls: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: '#fff',
  },
  fenceControlButton: {
    flex: 1,
    marginHorizontal: 4,
  },
  fenceLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
