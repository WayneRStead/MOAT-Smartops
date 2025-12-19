import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { saveInspectionRun } from '../database'; // 👈 NEW

const THEME_COLOR = '#22a6b3';

// Demo forms – later these come from backend
const DEMO_FORMS = [
  {
    id: 'global-1',
    scope: 'global',
    name: 'General Site Safety Inspection',
    formType: 'Safety',
    subject: 'Daily safety walk',
    description: 'Daily site safety walk across the active work area.',
    resultRules: 'Fail if any critical item fails. Target score 90% or above.',
    maxScore: 100,
    items: [
      {
        id: 'i1',
        title: 'PPE compliance',
        description:
          'All workers wearing required PPE (helmets, boots, vests, eye & ear protection).',
        requireActionOnFail: true,
      },
      {
        id: 'i2',
        title: 'Housekeeping',
        description: 'Site kept tidy, no trip hazards or blocked walkways.',
        requireActionOnFail: true,
      },
      {
        id: 'i3',
        title: 'Fire equipment',
        description: 'Fire extinguishers accessible and up to date.',
        requireActionOnFail: true,
      },
    ],
  },
  {
    id: 'scoped-1',
    scope: 'scoped',
    name: 'Excavation Inspection',
    formType: 'Safety / Excavation',
    subject: 'Excavation safety check',
    description: 'Excavations, shoring, access and barriers.',
    resultRules: 'All items must pass or be N/A to achieve 100%.',
    maxScore: 100,
    items: [
      {
        id: 'i1',
        title: 'Shoring / benching',
        description:
          'Correct shoring or benching in place as per design.',
        requireActionOnFail: true,
      },
      {
        id: 'i2',
        title: 'Barricades',
        description: 'Area barricaded and warning signage in place.',
        requireActionOnFail: true,
      },
      {
        id: 'i3',
        title: 'Access / egress',
        description: 'Safe access in and out of excavation.',
        requireActionOnFail: true,
      },
    ],
  },
];

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

export default function InspectionsScreen() {
  const router = useRouter();

  // Mode: select form vs running a form
  const [mode, setMode] = useState('select'); // 'select' | 'run'

  // Global vs scoped
  const [scope, setScope] = useState('global'); // 'global' | 'scoped'

  // Current form + items state when running
  const [currentForm, setCurrentForm] = useState(null); // DEMO_FORMS[x]
  const [itemsState, setItemsState] = useState([]); // [{ id, status, note, photoUri, scanDone }]
  const [expandedItemId, setExpandedItemId] = useState(null);

  // Header fields for the run
  const [headerLocation, setHeaderLocation] = useState('');
  const [headerProject, setHeaderProject] = useState('');
  const [headerTask, setHeaderTask] = useState('');
  const [headerMilestone, setHeaderMilestone] = useState('');
  const [headerSubject, setHeaderSubject] = useState('');

  // Signature + summary
  const [inspectorName, setInspectorName] = useState('');
  const [overallNote, setOverallNote] = useState('');
  const [runDateTime, setRunDateTime] = useState(formatNow());

  // Photo helper
  const takePhotoForItem = async (itemId) => {
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
    if (!uri) return;

    setItemsState((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, photoUri: uri } : item
      )
    );
  };

  const markScanDoneForItem = (itemId) => {
    Alert.alert(
      'Scan (demo)',
      'Later this will perform the configured scan action for this item.'
    );
    setItemsState((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, scanDone: true } : item
      )
    );
  };

  const setStatusForItem = (itemId, status, requireActionOnFail) => {
    // status: 'pending' | 'pass' | 'na' | 'fail'
    setItemsState((prev) =>
      prev.map((item) =>
        item.id === itemId
          ? { ...item, status, requireActionOnFail }
          : item
      )
    );
  };

  const setNoteForItem = (itemId, note) => {
    setItemsState((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, note } : item))
    );
  };

  const canLeaveCurrentItem = () => {
    if (!expandedItemId || !currentForm) return true;
    const current = itemsState.find((i) => i.id === expandedItemId);
    if (!current) return true;

    if (current.status === 'fail' && current.requireActionOnFail) {
      // Simple rule: must at least have a note
      if (!current.note || current.note.trim().length === 0) {
        Alert.alert(
          'Actions required',
          'Please add an action/note for this failed item before moving to the next.'
        );
        return false;
      }
    }
    return true;
  };

  const toggleExpandItem = (itemId) => {
    if (expandedItemId === itemId) {
      setExpandedItemId(null);
      return;
    }

    if (!canLeaveCurrentItem()) {
      return;
    }

    setExpandedItemId(itemId);
  };

  const startFormRun = (form) => {
    const initialState = form.items.map((item) => ({
      id: item.id,
      status: 'pending', // 'pending' | 'pass' | 'na' | 'fail'
      note: '',
      photoUri: null,
      scanDone: false,
      requireActionOnFail: !!item.requireActionOnFail,
    }));

    setCurrentForm(form);
    setItemsState(initialState);
    setExpandedItemId(form.items[0]?.id || null);

    // Prefill header fields from form where sensible
    setHeaderLocation(form.location || '');
    setHeaderProject(form.project || '');
    setHeaderTask(form.task || '');
    setHeaderMilestone(form.milestone || '');
    setHeaderSubject(form.subject || '');

    setInspectorName('');
    setOverallNote('');
    setRunDateTime(formatNow());
    setMode('run');
  };

  const handleSubmitInspection = async () => {
    if (!currentForm) return;

    const pendingItems = itemsState.filter((i) => i.status === 'pending');
    if (pendingItems.length > 0) {
      Alert.alert(
        'Incomplete inspection',
        'Please complete all items before submitting.'
      );
      return;
    }

    if (!inspectorName.trim()) {
      Alert.alert(
        'Missing signature',
        'Please enter your name as a signature before submitting.'
      );
      return;
    }

    // Final check for failed items with missing actions
    const invalidFails = itemsState.filter(
      (i) =>
        i.status === 'fail' &&
        i.requireActionOnFail &&
        (!i.note || i.note.trim().length === 0)
    );
    if (invalidFails.length > 0) {
      Alert.alert(
        'Actions required',
        'Some failed items still need an action/note before submitting.'
      );
      return;
    }

    const coords = await getCurrentCoords();
    const submittedAt = new Date().toISOString();

    // Simple achieved score (pass = 1, everything else = 0)
    const totalItems = currentForm.items.length || 1;
    const passedCount = itemsState.filter((i) => i.status === 'pass').length;
    const achievedScore = Math.round((passedCount / totalItems) * 100);

    // 👉 Build inspection run object for DB
    const run = {
      orgId: 'demo-org',
      userId: 'demo-user',
      formId: currentForm.id,
      formName: currentForm.name,
      formType: currentForm.formType,
      scope,
      header: {
        location: headerLocation,
        project: headerProject,
        task: headerTask,
        milestone: headerMilestone,
        subject: headerSubject,
        description: currentForm.description,
        resultRules: currentForm.resultRules,
        achievedScore,
      },
      runDateTime,
      submittedAt,
      inspectorName,
      overallNote,
      coords,
      items: itemsState,
      syncStatus: 'pending',
      createdAt: submittedAt,
      updatedAt: submittedAt,
    };

    try {
      const localId = await saveInspectionRun(run);
      console.log('Inspection saved locally with id:', localId);

      Alert.alert(
        'Inspection saved',
        'Inspection captured on this device (sync pending).'
      );
    } catch (e) {
      console.error('Failed to save inspection', e);
      Alert.alert(
        'Save failed',
        'Could not save inspection on this device.'
      );
      return;
    }

    // Reset back to select mode
    setMode('select');
    setCurrentForm(null);
    setItemsState([]);
    setExpandedItemId(null);
    setHeaderLocation('');
    setHeaderProject('');
    setHeaderTask('');
    setHeaderMilestone('');
    setHeaderSubject('');
  };

  const formsForScope = DEMO_FORMS.filter((f) => f.scope === scope);

  // Simple achieved score for showing live in header
  const currentAchievedScore = (() => {
    if (!currentForm || !currentForm.items?.length) return 0;
    const totalItems = currentForm.items.length || 1;
    const passedCount = itemsState.filter((i) => i.status === 'pass').length;
    return Math.round((passedCount / totalItems) * 100);
  })();

  return (
    <>
      {mode === 'select' && (
        <ScrollView contentContainerStyle={styles.container}>
          {/* Top bar with Inspections logo + home */}
          <View style={styles.topBar}>
            <Image
              source={require('../assets/inspections-screen.png')}
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

          {/* Scope selector */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>MOAT Inspections</Text>
            <Text style={styles.cardSubtitle}>
              Choose between global or scoped inspections, then select a form to
              run.
            </Text>

            <View style={styles.scopeRow}>
              <TouchableOpacity
                style={[
                  styles.scopeButton,
                  scope === 'global' && styles.scopeButtonSelected,
                ]}
                onPress={() => setScope('global')}
              >
                <Image
                  source={require('../assets/insp-select.png')}
                  style={styles.scopeIcon}
                />
                <Text
                  style={[
                    styles.scopeText,
                    scope === 'global' && styles.scopeTextSelected,
                  ]}
                >
                  Global
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.scopeButton,
                  scope === 'scoped' && styles.scopeButtonSelected,
                ]}
                onPress={() => setScope('scoped')}
              >
                <Image
                  source={require('../assets/inspections.png')}
                  style={styles.scopeIcon}
                />
                <Text
                  style={[
                    styles.scopeText,
                    scope === 'scoped' && styles.scopeTextSelected,
                  ]}
                >
                  Scoped
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Forms list */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {scope === 'global'
                ? 'Global inspection forms'
                : 'Scoped inspection forms'}
            </Text>

            {formsForScope.length === 0 ? (
              <Text style={styles.emptyText}>
                No forms available for this scope.
              </Text>
            ) : (
              formsForScope.map((form) => (
                <TouchableOpacity
                  key={form.id}
                  style={styles.formRow}
                  onPress={() => startFormRun(form)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.formName}>{form.name}</Text>
                    <Text style={styles.formDescription}>
                      {form.description}
                    </Text>
                  </View>
                  <Image
                    source={require('../assets/trip.png')}
                    style={styles.formIcon}
                  />
                </TouchableOpacity>
              ))
            )}
          </View>
        </ScrollView>
      )}

      {mode === 'run' && currentForm && (
        <ScrollView contentContainerStyle={styles.container}>
          {/* Top bar with form logo + home/back */}
          <View style={styles.topBar}>
            <Image
              source={require('../assets/inspections-screen.png')}
              style={styles.topBarLogo}
              resizeMode="contain"
            />
            <TouchableOpacity
              style={styles.homeButton}
              onPress={() => {
                if (
                  itemsState.some((i) => i.status !== 'pending') ||
                  inspectorName ||
                  overallNote
                ) {
                  Alert.alert(
                    'Leave inspection?',
                    'You have started filling this inspection. Leaving now will lose unsaved progress.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Leave',
                        style: 'destructive',
                        onPress: () => {
                          setMode('select');
                          setCurrentForm(null);
                          setItemsState([]);
                          setExpandedItemId(null);
                          setHeaderLocation('');
                          setHeaderProject('');
                          setHeaderTask('');
                          setHeaderMilestone('');
                          setHeaderSubject('');
                        },
                      },
                    ]
                  );
                } else {
                  setMode('select');
                  setCurrentForm(null);
                  setItemsState([]);
                  setExpandedItemId(null);
                  setHeaderLocation('');
                  setHeaderProject('');
                  setHeaderTask('');
                  setHeaderMilestone('');
                  setHeaderSubject('');
                }
              }}
            >
              <Image
                source={require('../assets/home.png')}
                style={styles.homeIcon}
              />
            </TouchableOpacity>
          </View>

          {/* Form header with extra fields */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{currentForm.name}</Text>
            <Text style={styles.cardSubtitle}>
              Form type: {currentForm.formType || '—'}
              {'\n'}
              Scope: {scope === 'global' ? 'Global' : 'Scoped'} | Items:{' '}
              {currentForm.items.length}
              {'\n'}
              Achieved score: {currentAchievedScore}%
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Location"
              placeholderTextColor="#aaa"
              value={headerLocation}
              onChangeText={setHeaderLocation}
            />

            <TextInput
              style={styles.input}
              placeholder="Project"
              placeholderTextColor="#aaa"
              value={headerProject}
              onChangeText={setHeaderProject}
            />

            <TextInput
              style={styles.input}
              placeholder="Task"
              placeholderTextColor="#aaa"
              value={headerTask}
              onChangeText={setHeaderTask}
            />

            <TextInput
              style={styles.input}
              placeholder="Milestone"
              placeholderTextColor="#aaa"
              value={headerMilestone}
              onChangeText={setHeaderMilestone}
            />

            <TextInput
              style={styles.input}
              placeholder="Subject"
              placeholderTextColor="#aaa"
              value={headerSubject}
              onChangeText={setHeaderSubject}
            />

            {/* Description + rules as readonly text */}
            {currentForm.description ? (
              <Text style={styles.headerInfoText}>
                Description: {currentForm.description}
              </Text>
            ) : null}
            {currentForm.resultRules ? (
              <Text style={styles.headerInfoText}>
                Result rules: {currentForm.resultRules}
              </Text>
            ) : null}

            <View style={styles.dateRow}>
              <TextInput
                style={[styles.input, styles.dateInput]}
                placeholder="Date / time"
                placeholderTextColor="#aaa"
                value={runDateTime}
                onChangeText={setRunDateTime}
              />
              <TouchableOpacity
                style={styles.useNowButton}
                onPress={() => setRunDateTime(formatNow())}
              >
                <Text style={styles.useNowText}>Use now</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.headerInspectorText}>
              Inspector: {inspectorName || 'Not signed yet'}
            </Text>
          </View>

          {/* Items */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Items</Text>

            {currentForm.items.map((item) => {
              const state = itemsState.find((s) => s.id === item.id) || {};
              const status = state.status || 'pending';
              const isExpanded = expandedItemId === item.id;

              return (
                <View key={item.id} style={styles.itemContainer}>
                  <TouchableOpacity
                    style={styles.itemHeader}
                    onPress={() => toggleExpandItem(item.id)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemTitle}>{item.title}</Text>
                      <Text style={styles.itemDescription}>
                        {item.description}
                      </Text>
                    </View>
                    <View style={getStatusBadgeStyle(status)}>
                      <Text style={styles.statusBadgeText}>
                        {status === 'pending'
                          ? 'Pending'
                          : status === 'pass'
                          ? 'Pass'
                          : status === 'na'
                          ? 'N/A'
                          : 'Fail'}
                      </Text>
                    </View>
                  </TouchableOpacity>

                  {isExpanded && (
                    <View style={styles.itemBody}>
                      {/* Pass / N/A / Fail */}
                      <View style={styles.statusRow}>
                        <TouchableOpacity
                          style={[
                            styles.statusButton,
                            status === 'pass' &&
                              styles.statusButtonSelectedPass,
                          ]}
                          onPress={() =>
                            setStatusForItem(
                              item.id,
                              'pass',
                              !!item.requireActionOnFail
                            )
                          }
                        >
                          <Text
                            style={[
                              styles.statusButtonText,
                              status === 'pass' &&
                                styles.statusButtonTextSelected,
                            ]}
                          >
                            Pass
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[
                            styles.statusButton,
                            status === 'na' &&
                              styles.statusButtonSelectedNA,
                          ]}
                          onPress={() =>
                            setStatusForItem(
                              item.id,
                              'na',
                              !!item.requireActionOnFail
                            )
                          }
                        >
                          <Text
                            style={[
                              styles.statusButtonText,
                              status === 'na' &&
                                styles.statusButtonTextSelected,
                            ]}
                          >
                            N/A
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[
                            styles.statusButton,
                            status === 'fail' &&
                              styles.statusButtonSelectedFail,
                          ]}
                          onPress={() =>
                            setStatusForItem(
                              item.id,
                              'fail',
                              !!item.requireActionOnFail
                            )
                          }
                        >
                          <Text
                            style={[
                              styles.statusButtonText,
                              status === 'fail' &&
                                styles.statusButtonTextSelected,
                            ]}
                          >
                            Fail
                          </Text>
                        </TouchableOpacity>
                      </View>

                      {/* Note / action */}
                      <TextInput
                        style={[styles.input, styles.textArea]}
                        placeholder="Action / note"
                        placeholderTextColor="#aaa"
                        value={state.note || ''}
                        onChangeText={(t) => setNoteForItem(item.id, t)}
                        multiline
                      />

                      {/* Photo + Scan row */}
                      <View style={styles.actionRow}>
                        <TouchableOpacity
                          style={styles.smallActionButton}
                          onPress={() => takePhotoForItem(item.id)}
                        >
                          <Image
                            source={require('../assets/camera.png')}
                            style={styles.smallActionIcon}
                          />
                          <Text style={styles.smallActionText}>Photo</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.smallActionButton}
                          onPress={() => markScanDoneForItem(item.id)}
                        >
                          <Image
                            source={require('../assets/barcode.png')}
                            style={styles.smallActionIcon}
                          />
                          <Text style={styles.smallActionText}>Scan</Text>
                        </TouchableOpacity>
                      </View>

                      {/* Photo preview small */}
                      {state.photoUri ? (
                        <Image
                          source={{ uri: state.photoUri }}
                          style={styles.itemPhoto}
                        />
                      ) : null}

                      {state.scanDone && (
                        <Text style={styles.scanDoneText}>
                          Scan completed (demo flag).
                        </Text>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </View>

          {/* Signature and submit */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Sign off</Text>
            <Text style={styles.cardSubtitle}>
              For now this uses a typed name as signature. Later we can replace
              this with a touch-screen signature pad.
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Inspector name (signature)"
              placeholderTextColor="#aaa"
              value={inspectorName}
              onChangeText={setInspectorName}
            />

            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Overall notes (optional)"
              placeholderTextColor="#aaa"
              value={overallNote}
              onChangeText={setOverallNote}
              multiline
            />

            <TouchableOpacity
              style={styles.primaryButton}
              onPress={handleSubmitInspection}
            >
              <Text style={styles.primaryButtonText}>Submit inspection</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}
    </>
  );
}

function getStatusBadgeStyle(status) {
  let backgroundColor = '#ccc';
  if (status === 'pass') backgroundColor = '#27ae60';
  else if (status === 'na') backgroundColor = '#614410ff';
  else if (status === 'fail') backgroundColor = '#e74c3c';
  return {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor,
  };
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
  headerInfoText: {
    fontSize: 11,
    color: '#555',
    marginBottom: 4,
  },
  headerInspectorText: {
    fontSize: 11,
    color: '#555',
    marginTop: 4,
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
    height: 70,
    textAlignVertical: 'top',
  },
  emptyText: {
    fontSize: 12,
    color: '#999',
  },
  scopeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  scopeButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingVertical: 10,
    marginHorizontal: 4,
    alignItems: 'center',
    backgroundColor: '#fafafa',
  },
  scopeButtonSelected: {
    borderColor: THEME_COLOR,
    backgroundColor: '#e6f9fb',
  },
  scopeIcon: {
    width: 48,
    height: 48,
    marginBottom: 4,
  },
  scopeText: {
    fontSize: 13,
    color: '#555',
  },
  scopeTextSelected: {
    color: THEME_COLOR,
    fontWeight: '600',
  },
  formRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  formName: {
    fontSize: 14,
    fontWeight: '500',
  },
  formDescription: {
    fontSize: 11,
    color: '#777',
    marginTop: 2,
  },
  formIcon: {
    width: 24,
    height: 24,
    marginLeft: 8,
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
  itemContainer: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
    marginBottom: 4,
    paddingBottom: 4,
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemTitle: {
    fontSize: 14,
    fontWeight: '500',
  },
  itemDescription: {
    fontSize: 11,
    color: '#777',
    marginTop: 2,
  },
  statusBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  itemBody: {
    marginTop: 8,
  },
  statusRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  statusButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingVertical: 6,
    marginHorizontal: 2,
    alignItems: 'center',
  },
  statusButtonSelectedPass: {
    borderColor: '#27ae60',
    backgroundColor: '#e6f9f0',
  },
  statusButtonSelectedNA: {
    borderColor: '#614410ff',
    backgroundColor: '#ecf0f1',
  },
  statusButtonSelectedFail: {
    borderColor: '#e74c3c',
    backgroundColor: '#fdecea',
  },
  statusButtonText: {
    fontSize: 12,
    color: '#555',
  },
  statusButtonTextSelected: {
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  smallActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: THEME_COLOR,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginHorizontal: 2,
  },
  smallActionIcon: {
    width: 24,
    height: 24,
    marginRight: 4,
  },
  smallActionText: {
    fontSize: 11,
    color: THEME_COLOR,
    fontWeight: '500',
  },
  itemPhoto: {
    width: 120,
    height: 120,
    borderRadius: 6,
    marginTop: 4,
  },
  scanDoneText: {
    fontSize: 11,
    color: '#555',
    marginTop: 4,
  },
  primaryButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
