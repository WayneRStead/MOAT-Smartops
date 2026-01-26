// moat-smartops-mobile/app/index.jsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../firebase";

import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  Alert,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { ORG_KEY, TOKEN_KEY } from "../apiClient";
import { initDatabase } from "../database";

const THEME_COLOR = "#22a6b3";

export default function LoginScreen() {
  const router = useRouter();

  useEffect(() => {
    (async () => {
      try {
        await initDatabase();
      } catch (e) {
        console.log("[DB] initDatabase error in index.jsx", e);
      }
    })();
  }, []);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [registerVisible, setRegisterVisible] = useState(false);

  const handleLogin = async () => {
    try {
      if (!username || !password) return;

      const email = username.trim();
      const pass = password;

      const cred = await signInWithEmailAndPassword(auth, email, pass);
      const token = await cred.user.getIdToken();

      // Save token for API calls
      await AsyncStorage.setItem(TOKEN_KEY, token);

      // Clear org so user must select (prevents wrong-org issues during testing)
      await AsyncStorage.removeItem(ORG_KEY);

      // Go select org (bootstrap endpoint does not require x-org-id)
      router.replace("/org-select");
    } catch (e) {
      console.log("Login error", e);
      Alert.alert("Login failed", "Check your email/password and try again.");
    }
  };

  const handleForgotPassword = () => {
    console.log("Forgot password pressed for", username);
  };

  const handleSubmitRegistrationRequest = () => {
    setRegisterVisible(false);
  };

  return (
    <View style={styles.container}>
      <View style={styles.logoContainer}>
        <Image
          source={require("../assets/moat-logo.png")}
          style={styles.logoImage}
          resizeMode="contain"
        />
        <Text style={styles.appTitle}>Smart Operations Suite</Text>
      </View>

      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder="User name / Email"
          placeholderTextColor="#aaa"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#aaa"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        <TouchableOpacity
          onPress={handleForgotPassword}
          style={styles.forgotContainer}
        >
          <Text style={styles.forgotText}>Forgotten password?</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.primaryButton} onPress={handleLogin}>
          <Text style={styles.primaryButtonText}>Sign in</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.primaryButton, styles.secondaryButton]}
          onPress={() => setRegisterVisible(true)}
        >
          <Text style={styles.primaryButtonText}>Not yet registered</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={registerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setRegisterVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Organisation setup</Text>

            <TextInput
              style={styles.input}
              placeholder="Organisation name"
              placeholderTextColor="#aaa"
            />
            <TextInput
              style={styles.input}
              placeholder="Contact person"
              placeholderTextColor="#aaa"
            />
            <TextInput
              style={styles.input}
              placeholder="Contact email"
              placeholderTextColor="#aaa"
              autoCapitalize="none"
              keyboardType="email-address"
            />

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.primaryButton, styles.modalButton]}
                onPress={handleSubmitRegistrationRequest}
              >
                <Text style={styles.primaryButtonText}>Submit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryButton, styles.modalButton]}
                onPress={() => setRegisterVisible(false)}
              >
                <Text style={styles.primaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>

          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setRegisterVisible(false)}
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
    paddingHorizontal: 24,
    justifyContent: "center",
    paddingTop: 0,
  },
  logoContainer: {
    alignItems: "center",
    marginBottom: 40,
  },
  logoImage: {
    width: 240,
    height: 120,
    marginBottom: -20,
  },
  appTitle: {
    marginTop: 0,
    fontSize: 24,
    fontWeight: "500",
  },
  form: {
    width: "100%",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
    fontSize: 14,
  },
  forgotContainer: {
    alignItems: "flex-end",
    marginBottom: 16,
  },
  forgotText: {
    fontSize: 12,
    textDecorationLine: "underline",
    color: "#555",
  },
  primaryButton: {
    backgroundColor: THEME_COLOR,
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: "center",
    marginBottom: 12,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  secondaryButton: {
    marginTop: 8,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: "#fff",
    borderRadius: 8,
    padding: 20,
    elevation: 5,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 16,
    textAlign: "center",
  },
  modalButtonsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 16,
  },
  modalButton: {
    flex: 1,
    marginHorizontal: 4,
  },
});
