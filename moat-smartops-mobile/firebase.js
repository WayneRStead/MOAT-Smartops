import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCaitvnrRAqK9lcGXbu-FtGy8iVLkvQ9N0",
  authDomain: "moat-smartops-3f523.firebaseapp.com",
  projectId: "moat-smartops-3f523",
  storageBucket: "moat-smartops-3f523.firebasestorage.app",
  messagingSenderId: "445643585024",
  appId: "1:445643585024:web:fcb4b6f5bffd812428cae5",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
