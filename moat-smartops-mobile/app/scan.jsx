import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
    Alert,
    Image,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';

const THEME_COLOR = '#22a6b3';
const LAST_SCAN_KEY = '@moat:lastScan';

export default function ScanScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  // Optional params from caller:
  // returnTo: '/logbook' (or omit to just router.back())
  // field: 'regNumber' (caller uses this to know where to put the value)
  // label: 'Scan vehicle QR'
  const returnTo = typeof params.returnTo === 'string' ? params.returnTo : null;
  const field = typeof params.field === 'string' ? params.field : null;
  const label =
    typeof params.label === 'string' ? params.label : 'Scan QR / Barcode';

  const [permission, requestPermission] = useCameraPermissions();
  const [scannedValue, setScannedValue] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  // Prevent double-firing scans
  const hasHandledScanRef = useRef(false);

  const handleCancel = () => {
    router.back();
  };

  const handleBarcodeScanned = useCallback(
    async (result) => {
      if (hasHandledScanRef.current) return;

      const value = result?.data ? String(result.data) : '';
      if (!value) return;

      hasHandledScanRef.current = true;
      setScannedValue(value);

      try {
        setIsSaving(true);

        const payload = {
          value,
          field, // optional: what the caller expects to populate
          type: result?.type ? String(result.type) : null,
          scannedAt: new Date().toISOString(),
          returnTo,
        };

        await AsyncStorage.setItem(LAST_SCAN_KEY, JSON.stringify(payload));

        // Small UX delay so user sees it scanned
        setTimeout(() => {
          if (returnTo) {
            router.replace(returnTo);
          } else {
            router.back();
          }
        }, 250);
      } catch (e) {
        console.log('[SCAN] Failed to store scan result', e);
        Alert.alert('Error', 'Could not save scan result on this device.');
        hasHandledScanRef.current = false;
      } finally {
        setIsSaving(false);
      }
    },
    [field, returnTo, router]
  );

  if (!permission) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{label}</Text>
        <Text style={styles.subtitle}>Preparing camera…</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{label}</Text>
        <Text style={styles.subtitle}>
          Camera permission is required to scan codes.
        </Text>

        <TouchableOpacity style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.primaryButtonText}>Allow camera</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={handleCancel}>
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.scanContainer}>
      {/* Top bar (simple, consistent feel) */}
      <View style={styles.topBar}>
        <Image
          source={require('../assets/home.png')}
          style={styles.topIcon}
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.topTitle}>{label}</Text>
          <Text style={styles.topSubtitle}>Point camera at QR / barcode</Text>
        </View>
        <TouchableOpacity onPress={handleCancel} style={styles.cancelBtn}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>

      {/* Camera */}
      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          onBarcodeScanned={handleBarcodeScanned}
        />

        {/* Overlay frame */}
        <View style={styles.overlay}>
          <View style={styles.frame} />
          {scannedValue ? (
            <View style={styles.resultPill}>
              <Text style={styles.resultText} numberOfLines={2}>
                Scanned: {scannedValue}
              </Text>
              {isSaving ? (
                <Text style={styles.resultHint}>Saving…</Text>
              ) : (
                <Text style={styles.resultHint}>Returning…</Text>
              )}
            </View>
          ) : (
            <View style={styles.hintPill}>
              <Text style={styles.hintText}>
                Align the code inside the box
              </Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 80,
    paddingHorizontal: 16,
    backgroundColor: '#fff',
    justifyContent: 'flex-start',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
    marginBottom: 16,
  },
  primaryButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: 'center',
    marginTop: 10,
  },
  secondaryButtonText: {
    color: THEME_COLOR,
    fontSize: 14,
    fontWeight: '600',
  },

  scanContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  topBar: {
    paddingTop: 50,
    paddingHorizontal: 12,
    paddingBottom: 10,
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
  },
  topIcon: {
    width: 28,
    height: 28,
    marginRight: 10,
    opacity: 0.9,
  },
  topTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  topSubtitle: {
    fontSize: 11,
    color: '#666',
    marginTop: 2,
  },
  cancelBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  cancelText: {
    color: THEME_COLOR,
    fontSize: 13,
    fontWeight: '600',
  },
  cameraWrap: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    width: '72%',
    height: '38%',
    borderWidth: 2,
    borderColor: THEME_COLOR,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.12)',
  },
  hintPill: {
    position: 'absolute',
    bottom: 36,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 18,
  },
  hintText: {
    color: '#fff',
    fontSize: 12,
  },
  resultPill: {
    position: 'absolute',
    bottom: 30,
    backgroundColor: 'rgba(34,166,179,0.85)',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    width: '86%',
  },
  resultText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  resultHint: {
    color: '#fff',
    fontSize: 11,
    marginTop: 4,
    opacity: 0.95,
  },
});
