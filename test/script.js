// Import Firebase
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-analytics.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword } 
from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";

// Your config (already provided)
const firebaseConfig = {
    apiKey: "AIzaSyAEWVTiNaeMCvfO--52vKSgaAbXPGAhCUk",
    authDomain: "barangaydocstest.firebaseapp.com",
    projectId: "barangaydocstest",
    storageBucket: "barangaydocstest.firebasestorage.app",
    messagingSenderId: "573531295849",
    appId: "1:573531295849:web:0775f0b026bd53a19092f8",
    measurementId: "G-SK522EWX52"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);

// UI elements
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const message = document.getElementById("message");

const showRegister = document.getElementById("show-register");
const showLogin = document.getElementById("show-login");

// Switch forms
showRegister.onclick = () => {
    loginForm.classList.add("hidden");
    registerForm.classList.remove("hidden");
};

showLogin.onclick = () => {
    registerForm.classList.add("hidden");
    loginForm.classList.remove("hidden");
};

// REGISTER
registerForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const email = document.getElementById("register-email").value;
    const password = document.getElementById("register-password").value;

    createUserWithEmailAndPassword(auth, email, password)
        .then(() => {
            message.textContent = "Registered successfully!";
        })
        .catch((error) => {
            message.textContent = error.message;
        });
});

// LOGIN
loginForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const email = document.getElementById("login-email").value;
    const password = document.getElementById("login-password").value;

    signInWithEmailAndPassword(auth, email, password)
        .then(() => {
            message.textContent = "Login successful!";
        })
        .catch((error) => {
            message.textContent = error.message;
        });
});