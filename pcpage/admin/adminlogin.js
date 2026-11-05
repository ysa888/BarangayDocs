// =============================================
// Firebase Imports
// =============================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

// =============================================
// Firebase Config & Init
// =============================================
const firebaseConfig = {
    apiKey: "AIzaSyDqRAX7DEFl2r6JbDpdsEOkip3jblgRTag",
    authDomain: "barangaydocs-df957.firebaseapp.com",
    projectId: "barangaydocs-df957",
    storageBucket: "barangaydocs-df957.firebasestorage.app",
    messagingSenderId: "1006488581565",
    appId: "1:1006488581565:web:b1269001298ff935838ed4",
    measurementId: "G-YG0Y575BRD"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// =============================================
// Toggle Password Visibility
// =============================================
document.getElementById('toggle-admin-pw').addEventListener('click', () => {
    const pw = document.getElementById('admin-pw');
    pw.type = pw.type === 'password' ? 'text' : 'password';
});

// =============================================
// Admin Sign In
// =============================================
document.getElementById('admin-login-btn').addEventListener('click', async () => {
    const email    = document.getElementById('admin-email').value.trim();
    const password = document.getElementById('admin-pw').value;

    if (!email)    return alert('Please enter your Admin Email.');
    if (!password) return alert('Please enter your Password.');

    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        // Check admins collection only
        const adminDoc = await getDoc(doc(db, 'admins', user.uid));

        if (!adminDoc.exists()) {
            alert('Access denied. This account is not registered as an admin.');
            await signOut(auth);
            return;
        }

        if (adminDoc.data().role !== 'admin') {
            alert('Access denied. Insufficient permissions.');
            await signOut(auth);
            return;
        }

        // Verified admin — redirect to admin panel
        window.location.href = 'admin_pending_users.html';

    } catch (error) {
        console.error('Admin login error:', error.code, error.message);

        if (
            error.code === 'auth/invalid-credential' ||
            error.code === 'auth/user-not-found' ||
            error.code === 'auth/wrong-password'
        ) {
            alert('Incorrect email or password. Please try again.');
        } else if (error.code === 'auth/invalid-email') {
            alert('Please enter a valid email address.');
        } else if (error.code === 'auth/too-many-requests') {
            alert('Too many failed attempts. Please try again later.');
        } else if (error.code === 'auth/network-request-failed') {
            alert('Network error. Please check your connection.');
        } else {
            alert('Sign in failed: ' + error.message);
        }
    }
});