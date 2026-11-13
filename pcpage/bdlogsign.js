// =============================================
// Firebase Imports
// =============================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-analytics.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, sendEmailVerification, deleteUser } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

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
const analytics = getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);

// =============================================
// Cloudinary Config
// =============================================
const CLOUDINARY_CLOUD_NAME = 'ddizbxtdd';
const CLOUDINARY_UPLOAD_PRESET = 'barangaydocs_preset'; // ← replace with your preset name

async function uploadToCloudinary(file, folder = 'barangaydocs/valid_ids') {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    formData.append('folder', folder);

    const res = await fetch(
        `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
        { method: 'POST', body: formData }
    );

    if (!res.ok) throw new Error('Cloudinary upload failed');
    const data = await res.json();
    return {
        url: data.secure_url,
        publicId: data.public_id
    };
}

// =============================================
// Helper — safely get element
// =============================================
const el = (id) => document.getElementById(id);

// =============================================
// PAGE DETECTION
// =============================================
const isLoginPage    = !!el('login-btn');
const isRegisterPage = !!el('step1-next');

// =============================================
// =============================================
// LOGIN PAGE LOGIC
// =============================================
// =============================================
if (isLoginPage) {

    // Toggle password visibility
    el('toggle-login-pw')?.addEventListener('click', () => {
        const pw = el('login-pw');
        pw.type = pw.type === 'password' ? 'text' : 'password';
    });

    // Sign In button
    el('login-btn').addEventListener('click', async () => {
        const email    = el('login-email').value.trim();
        const password = el('login-pw').value;

        if (!email)    return alert('Please enter your Email Address.');
        if (!password) return alert('Please enter your Password.');

        try {
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            // Check account status in Firestore
            const userDoc = await getDoc(doc(db, 'residents', user.uid));

            if (!userDoc.exists()) {
                alert('Account not found. Please register first.');
                await signOut(auth);
                return;
            }

            const userData = userDoc.data();

            if (userData.status === 'pending') {
                alert('Your account is still pending admin approval. Please wait for activation.');
                await signOut(auth);
                return;
            }

            if (userData.status === 'rejected') {
                alert('Your account registration was rejected. Please contact the barangay office.');
                await signOut(auth);
                return;
            }

            // Approved — redirect based on role
            if (userData.role === 'admin') {
                window.location.href = 'barangaydocs_admin.html';
            } else {
                window.location.href = 'barangaydocs_home.html';
            }

        } catch (error) {
            console.error('Login error:', error.code, error.message);

            if (
                error.code === 'auth/invalid-credential' ||
                error.code === 'auth/user-not-found' ||
                error.code === 'auth/wrong-password'
            ) {
                alert('Incorrect email or password. Please try again.');
            } else if (error.code === 'auth/invalid-email') {
                alert('Please enter a valid email address.');
            } else if (error.code === 'auth/too-many-requests') {
                alert('Too many failed attempts. Your account is temporarily locked. Please try again later.');
            } else if (error.code === 'auth/network-request-failed') {
                alert('Network error. Please check your internet connection and try again.');
            } else {
                alert('Sign in failed: ' + error.message);
            }
        }
    });
}

// =============================================
// =============================================
// REGISTER PAGE LOGIC
// =============================================
// =============================================
if (isRegisterPage) {

    // ------------------------------------------
    // Step Navigation
    // ------------------------------------------
    let currentStep = 1;

    function nextStep(step) {
        el('panel' + currentStep).classList.remove('active');
        el('panel' + step).classList.add('active');

        [1, 2, 3].forEach(s => {
            const dot   = el('vdot' + s);
            const vstep = el('vstep' + s);
            dot.classList.remove('active', 'done');
            vstep.classList.remove('active-step', 'done-step');

            if (s < step) {
                dot.classList.add('done');
                dot.textContent = '✓';
                vstep.classList.add('done-step');
            } else if (s === step) {
                dot.classList.add('active');
                dot.textContent = s;
                vstep.classList.add('active-step');
            } else {
                dot.textContent = s;
            }
        });

        currentStep = step;
    }

    function showSuccess() {
        [1, 2, 3, 4].forEach(s => {
            const panel = el('panel' + s);
            if (panel) panel.classList.remove('active');
        });
        el('panel4').classList.add('active');
        [1, 2, 3].forEach(s => {
            const dot = el('vdot' + s);
            el('vstep' + s).classList.remove('active-step');
            el('vstep' + s).classList.add('done-step');
            dot.classList.remove('active');
            dot.classList.add('done');
            dot.textContent = '✓';
        });
    }

    // ------------------------------------------
    // Password Strength
    // ------------------------------------------
    function checkStrength(val) {
        const b1  = el('bar1');
        const b2  = el('bar2');
        const b3  = el('bar3');
        const lbl = el('pw-label');

        b1.className = 'pw-bar';
        b2.className = 'pw-bar';
        b3.className = 'pw-bar';

        if (val.length === 0) { lbl.textContent = 'Enter a password'; return; }
        if (val.length < 6)   { b1.classList.add('weak');   lbl.textContent = 'Weak'; }
        else if (val.length < 10) { b1.classList.add('medium'); b2.classList.add('medium'); lbl.textContent = 'Medium'; }
        else { b1.classList.add('strong'); b2.classList.add('strong'); b3.classList.add('strong'); lbl.textContent = 'Strong'; }
    }

    // ------------------------------------------
    // Toggle Password Visibility
    // ------------------------------------------
    el('toggle-pw1').addEventListener('click', () => {
        const pw = el('reg-pw');
        pw.type = pw.type === 'password' ? 'text' : 'password';
    });

    el('toggle-pw2').addEventListener('click', () => {
        const pw = el('reg-pw2');
        pw.type = pw.type === 'password' ? 'text' : 'password';
    });

    el('reg-pw').addEventListener('input', (e) => checkStrength(e.target.value));

    // ------------------------------------------
    // Step 1 — Personal Info
    // ------------------------------------------
    el('step1-next').addEventListener('click', () => {
        const firstName   = el('first-name').value.trim();
        const lastName    = el('last-name').value.trim();
        const birthday    = el('birthday').value;
        const sex         = el('sex').value;
        const civilStatus = el('civil-status').value;

        if (!firstName)   return alert('Please enter your First Name.');
        if (!lastName)    return alert('Please enter your Last Name.');
        if (!birthday)    return alert('Please enter your Date of Birth.');
        if (!sex)         return alert('Please select your Sex.');
        if (!civilStatus) return alert('Please select your Civil Status.');

        nextStep(2);
    });

    // ------------------------------------------
    // Step 2 — Valid ID Upload (Preview & Remove)
    // ------------------------------------------
    const validIdInput   = el('valid-id');
    const uploadBox      = el('id-upload-box');
    const previewArea    = el('id-preview-area');
    const previewImg     = el('id-preview-img');
    const fileNameLabel  = el('id-file-name');
    const removeBtn      = el('id-remove-btn');

    validIdInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Show image preview
        previewImg.src = URL.createObjectURL(file);
        fileNameLabel.textContent = file.name;
        previewArea.style.display = 'block';
        uploadBox.classList.add('has-file');
    });

    removeBtn.addEventListener('click', () => {
        validIdInput.value = '';
        previewImg.src = '';
        fileNameLabel.textContent = '';
        previewArea.style.display = 'none';
        uploadBox.classList.remove('has-file');
    });

    // ------------------------------------------
    // Step 2 - Face Photo (Camera or Upload)
    // ------------------------------------------
    const MAX_FACE_BYTES = 5 * 1024 * 1024;
    let faceFile = null;          // File object used at submit time
    let camStream = null;

    const faceBox        = el('face-box');
    const facePreviewBox = el('face-preview-area');
    const facePreviewImg = el('face-preview-img');
    const faceNameLabel  = el('face-file-name');
    const faceFileInput  = el('face-file');
    const camModal       = el('modal-camera');
    const camVideo       = el('cam-video');
    const camMsg         = el('cam-msg');
    const camCaptureBtn  = el('cam-capture');

    function setFace(file) {
        if (facePreviewImg.src.startsWith('blob:')) URL.revokeObjectURL(facePreviewImg.src);
        faceFile = file;
        facePreviewImg.src = URL.createObjectURL(file);
        faceNameLabel.textContent = file.name;
        facePreviewBox.style.display = 'block';
        faceBox.classList.add('has-file');
    }

    function clearFace() {
        if (facePreviewImg.src.startsWith('blob:')) URL.revokeObjectURL(facePreviewImg.src);
        faceFile = null;
        faceFileInput.value = '';
        facePreviewImg.src = '';
        faceNameLabel.textContent = '';
        facePreviewBox.style.display = 'none';
        faceBox.classList.remove('has-file');
    }

    // Upload a picture
    el('face-upload-btn').addEventListener('click', () => faceFileInput.click());

    faceFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            faceFileInput.value = '';
            return alert('Please choose an image file (JPG, PNG, or WEBP).');
        }
        if (file.size > MAX_FACE_BYTES) {
            faceFileInput.value = '';
            return alert('Face photo is too large. Maximum size is 5MB.');
        }
        setFace(file);
    });

    el('face-remove-btn').addEventListener('click', clearFace);

    // Live camera
    function stopCamera() {
        if (camStream) {
            camStream.getTracks().forEach(t => t.stop());
            camStream = null;
        }
        camVideo.srcObject = null;
        camCaptureBtn.disabled = true;
    }

    function closeCamera() {
        stopCamera();
        camModal.classList.remove('open');
    }

    async function openCamera() {
        camMsg.className = 'cam-msg';
        camMsg.textContent = 'Allow camera access, then center your face inside the outline.';
        camCaptureBtn.disabled = true;

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('Camera is not available in this browser or connection. Please use the Upload Photo option instead. (Camera needs HTTPS or localhost.)');
            return;
        }

        camModal.classList.add('open');

        try {
            camStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
                audio: false
            });
            camVideo.srcObject = camStream;
            await camVideo.play();
            camCaptureBtn.disabled = false;
        } catch (err) {
            console.error('Camera error:', err);
            camMsg.className = 'cam-msg error';
            if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
                camMsg.textContent = 'Camera permission was denied. Allow camera access in your browser settings, or close this and use Upload Photo.';
            } else if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
                camMsg.textContent = 'No camera was found on this device. Please use Upload Photo instead.';
            } else {
                camMsg.textContent = 'Could not start the camera. Please use Upload Photo instead.';
            }
        }
    }

    function captureFrame() {
        if (!camStream || !camVideo.videoWidth) return;

        const canvas = document.createElement('canvas');
        canvas.width  = camVideo.videoWidth;
        canvas.height = camVideo.videoHeight;
        // Save the un-mirrored frame so the admin sees a true photo
        canvas.getContext('2d').drawImage(camVideo, 0, 0, canvas.width, canvas.height);

        canvas.toBlob((blob) => {
            if (!blob) return alert('Could not capture the photo. Please try again.');
            const file = new File([blob], `face-${Date.now()}.jpg`, { type: 'image/jpeg' });
            setFace(file);
            closeCamera();
        }, 'image/jpeg', 0.9);
    }

    el('face-camera-btn').addEventListener('click', openCamera);
    el('close-camera').addEventListener('click', closeCamera);
    el('cam-cancel').addEventListener('click', closeCamera);
    camCaptureBtn.addEventListener('click', captureFrame);
    camModal.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeCamera(); });
    window.addEventListener('pagehide', stopCamera);

    // ------------------------------------------
    // Step 2 — Next Button
    // ------------------------------------------
    el('step2-back').addEventListener('click', () => nextStep(1));

    el('step2-next').addEventListener('click', () => {
        const houseNumber    = el('house-number').value.trim();
        const yearsResidency = el('years-residency').value.trim();
        const validIdFile    = el('valid-id').files[0];

        if (!houseNumber)    return alert('Please enter your House No. / Street.');
        if (!yearsResidency) return alert('Please enter your Years of Residency.');
        if (!validIdFile)    return alert('Please upload a valid ID before proceeding.');
        if (!faceFile)       return alert('Please take or upload a face photo before proceeding.');

        nextStep(3);
    });

    // ------------------------------------------
    // Email Verification LINK (Firebase)
    // ------------------------------------------
    const VC_RESEND_SECS = 60;
    let vcPoll  = null;
    let vcTimer = null;

    const vcModal  = el('modal-verify');
    const vcMsg    = el('vc-msg');
    const vcResend = el('vc-resend');
    const vcVerify = el('vc-verify');

    function vcSetMsg(text, ok = false) {
        vcMsg.textContent = text;
        vcMsg.classList.toggle('ok', ok);
    }

    function startResendCooldown() {
        clearInterval(vcTimer);
        let left = VC_RESEND_SECS;
        vcResend.disabled = true;
        vcResend.textContent = `Resend in ${left}s`;
        vcTimer = setInterval(() => {
            left--;
            if (left <= 0) {
                clearInterval(vcTimer);
                vcResend.disabled = false;
                vcResend.textContent = 'Resend link';
            } else {
                vcResend.textContent = `Resend in ${left}s`;
            }
        }, 1000);
    }

    async function isEmailVerified(user) {
        await user.reload();
        return user.emailVerified;
    }

    // Sends the link, then waits until the user clicks it (or cancels)
    async function verifyEmailByLink(user, email) {
        try {
            await sendEmailVerification(user);
        } catch (err) {
            try { await deleteUser(user); } catch (e) { console.error(e); }
            throw err;
        }

        el('vc-email').textContent = email;
        vcSetMsg('');
        vcModal.classList.add('open');
        startResendCooldown();

        return new Promise((resolve, reject) => {
            const finish = (ok) => {
                clearInterval(vcPoll);
                clearInterval(vcTimer);
                vcModal.classList.remove('open');
                ok ? resolve() : reject(new Error('verification-cancelled'));
            };

            // Auto-check every 3 seconds
            vcPoll = setInterval(async () => {
                try { if (await isEmailVerified(user)) finish(true); } catch (e) { /* retry next tick */ }
            }, 3000);

            vcVerify.onclick = async () => {
                vcVerify.disabled = true;
                try {
                    if (await isEmailVerified(user)) return finish(true);
                    vcSetMsg('Not verified yet. Click the link in your email first.');
                } catch (e) {
                    vcSetMsg('Could not check right now. Please try again.');
                }
                vcVerify.disabled = false;
            };

            vcResend.onclick = async () => {
                vcResend.disabled = true;
                vcResend.textContent = 'Sending...';
                try {
                    await sendEmailVerification(user);
                    vcSetMsg('A new link was sent.', true);
                    startResendCooldown();
                } catch (e) {
                    console.error('Resend error:', e);
                    vcSetMsg(e.code === 'auth/too-many-requests'
                        ? 'Too many requests. Please wait a while and try again.'
                        : 'Could not resend the link. Please try again.');
                    vcResend.disabled = false;
                    vcResend.textContent = 'Resend link';
                }
            };

            const cancel = async () => {
                // remove the unverified account so the email can be used again
                try { await deleteUser(user); } catch (e) { console.error(e); }
                finish(false);
            };
            el('vc-cancel').onclick = cancel;
            el('close-verify').onclick = cancel;
        });
    }

    // ------------------------------------------
    // Step 3 — Account Setup + Firebase + Cloudinary
    // ------------------------------------------
    el('step3-back').addEventListener('click', () => nextStep(2));

    el('step3-submit').addEventListener('click', async () => {
        const email           = el('signup-email').value.trim();
        const contactNumber   = el('contact-number').value.trim();
        const password        = el('reg-pw').value;
        const confirmPassword = el('reg-pw2').value;
        const termsChecked    = el('terms').checked;
        const validIdFile     = el('valid-id').files[0];

        if (!email)           return alert('Please enter your Email Address.');
        if (!contactNumber)   return alert('Please enter your Contact Number.');
        if (!password)        return alert('Please enter your Password.');
        if (!confirmPassword) return alert('Please confirm your Password.');
        if (password !== confirmPassword) return alert('Passwords do not match.');
        if (!termsChecked)    return alert('Please accept the Terms and Conditions.');

        // Safety check — valid ID should always be present at this point
        if (!validIdFile) {
            alert('Valid ID is missing. Please go back to Step 2 and upload your ID.');
            return nextStep(2);
        }

        if (!faceFile) {
            alert('Face photo is missing. Please go back to Step 2 and add your face photo.');
            return nextStep(2);
        }

        // Collect all fields from previous steps
        const firstName      = el('first-name').value.trim();
        const lastName       = el('last-name').value.trim();
        const middleName     = el('middle-name').value.trim();
        const birthday       = el('birthday').value;
        const sex            = el('sex').value;
        const civilStatus    = el('civil-status').value;
        const houseNumber    = el('house-number').value.trim();
        const yearsResidency = el('years-residency').value.trim();

        // Disable button + show loading state
        const submitBtn = el('step3-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = '» Uploading ID...';

        try {
            // Step 1: Upload Valid ID to Cloudinary
            const { url: validIdUrl, publicId: validIdPublicId } = await uploadToCloudinary(validIdFile);

            submitBtn.textContent = '» Uploading face photo...';

            // Step 1b: Upload face photo to Cloudinary
            const { url: faceUrl, publicId: facePublicId } = await uploadToCloudinary(faceFile, 'barangaydocs/face_photos');

            submitBtn.textContent = '» Creating account...';

            // Step 2: Create Firebase Auth account
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            // Email must be verified by clicking the link sent to the inbox
            submitBtn.textContent = '» Waiting for email verification...';
            await verifyEmailByLink(user, email);
            submitBtn.textContent = '» Saving account...';

            // Step 3: Save all data + ID URL to Firestore
            await setDoc(doc(db, 'residents', user.uid), {
                uid:             user.uid,
                firstName,
                lastName,
                middleName:      middleName || '',
                birthday,
                sex,
                civilStatus,
                houseNumber,
                barangay:        'Barangay Banicain',
                city:            'Olongapo City',
                province:        'Zambales',
                yearsResidency,
                email,
                contactNumber,
                validIdUrl,        // ← Cloudinary image URL (viewable by admin)
                validIdPublicId,   // ← Cloudinary public ID (for future management)
                faceUrl,           // ← Cloudinary face photo URL (admin compares with ID)
                facePublicId,      // ← Cloudinary public ID of the face photo
                status:          'pending',
                role:            'resident',
                createdAt:       new Date().toISOString()
            });

            // Sign out — account needs admin approval
            await signOut(auth);

            showSuccess();

        } catch (error) {
            console.error('Registration error:', error);

            // Reset button
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Account';

            if (error.message === 'verification-cancelled') {
                return;
            } else if (error.message === 'Cloudinary upload failed') {
                alert('Failed to upload your ID or face photo. Please check your internet connection and try again.');
            } else if (error.code === 'auth/email-already-in-use') {
                alert('This email is already registered. Please sign in instead.');
            } else if (error.code === 'auth/weak-password') {
                alert('Password is too weak. Please use at least 6 characters.');
            } else if (error.code === 'auth/invalid-email') {
                alert('Please enter a valid email address.');
            } else {
                alert('Registration failed: ' + error.message);
            }
        }
    });

    // ------------------------------------------
    // Success — Go to Login
    // ------------------------------------------
    el('go-to-login').addEventListener('click', () => {
        window.location.href = 'barangaydocs_login.html';
    });

    // ------------------------------------------
    // Terms & Privacy Modals
    // ------------------------------------------
    function openModal(id)  { el(id).classList.add('open'); }
    function closeModal(id) { el(id).classList.remove('open'); }

    el('open-terms').addEventListener('click',   (e) => { e.preventDefault(); openModal('modal-terms'); });
    el('open-privacy').addEventListener('click', (e) => { e.preventDefault(); openModal('modal-privacy'); });

    el('close-terms').addEventListener('click',       () => closeModal('modal-terms'));
    el('close-privacy').addEventListener('click',     () => closeModal('modal-privacy'));
    el('close-terms-btn').addEventListener('click',   () => closeModal('modal-terms'));
    el('close-privacy-btn').addEventListener('click', () => closeModal('modal-privacy'));

    el('modal-terms').addEventListener('click',   (e) => { if (e.target === e.currentTarget) closeModal('modal-terms'); });
    el('modal-privacy').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal('modal-privacy'); });
}