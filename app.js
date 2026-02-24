import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getFirestore, collection, addDoc, serverTimestamp, query, where, orderBy, getDocs } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyBwHs9Or3qhpThQsSEmC2Ccb5s8FPQqEC8",
    authDomain: "odontovoice.firebaseapp.com",
    projectId: "odontovoice",
    storageBucket: "odontovoice.firebasestorage.app",
    messagingSenderId: "123401121009",
    appId: "1:123401121009:web:4d59a820d0d5c16d9fcd50",
    measurementId: "G-ED3PE24J93"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let currentUser = null;

// --- ENCRYPTION HELPERS (AES-GCM via Web Crypto API) ---
// Derives a unique AES-256 key from the doctor's UID
async function deriveKey(uid) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(uid),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: encoder.encode('odontovoice-salt-2024'),
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

// Encrypts a string → returns a base64-encoded string (iv + ciphertext)
async function encryptText(plainText, uid) {
    const key = await deriveKey(uid);
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(plainText)
    );
    // Combine IV + ciphertext into one array, then base64
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
}

// Decrypts a base64 string → returns the original plain text
async function decryptText(base64Str, uid) {
    const key = await deriveKey(uid);
    const combined = Uint8Array.from(atob(base64Str), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
    );
    return new TextDecoder().decode(decrypted);
}

document.addEventListener('DOMContentLoaded', () => {
    const themeToggleBtn = document.getElementById('theme-toggle');
    const micBtn = document.getElementById('mic-btn');
    const listeningStatus = document.getElementById('listening-status');
    const transcriptToast = document.getElementById('transcript-toast');

    // View Management Elements
    const mainContent = document.getElementById('main-content');
    const reportContent = document.getElementById('report-content');
    const btnGenerateReport = document.getElementById('btn-generate-report');
    const btnBackToEdit = document.getElementById('btn-back-to-edit');
    const btnDownloadPdf = document.getElementById('btn-download-pdf');
    const micContainer = document.querySelector('.mic-container');

    // Form Elements
    const inputs = {
        name: document.getElementById('p-name'),
        age: document.getElementById('p-age'),
        sex: document.getElementById('p-sex'),
        phone: document.getElementById('p-phone'),
        pathologies: document.getElementById('p-pathologies')
    };

    const findingsList = document.getElementById('findings-list');

    // State
    let isListening = false;
    let recognition = null;
    let clinicalFindings = []; // Stores objects like { unit: 11, face: "vestibular", condition: "caries incipiente" }

    // --- 1. FIREBASE AUTH & THEME ---
    const btnLogin = document.getElementById('btn-login');
    const btnLogout = document.getElementById('btn-logout');
    const userInfo = document.getElementById('user-info');
    const userAvatar = document.getElementById('user-avatar');

    // Auth State Listener
    onAuthStateChanged(auth, (user) => {
        if (user) {
            currentUser = user;
            btnLogin.classList.add('hidden');
            userInfo.classList.remove('hidden');
            userAvatar.src = user.photoURL;
        } else {
            currentUser = null;
            btnLogin.classList.remove('hidden');
            userInfo.classList.add('hidden');
            userAvatar.src = "";
        }
    });

    btnLogin.addEventListener('click', async () => {
        try {
            await signInWithPopup(auth, provider);
        } catch (error) {
            console.error("Error al iniciar sesión:", error);
            alert("Error al iniciar sesión con Google");
        }
    });

    btnLogout.addEventListener('click', async () => {
        try {
            await signOut(auth);
        } catch (error) {
            console.error("Error al cerrar sesión", error);
        }
    });

    themeToggleBtn.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        if (currentTheme === 'dark') {
            document.documentElement.removeAttribute('data-theme');
            themeToggleBtn.innerHTML = '<i class="fa-solid fa-moon"></i>';
        } else {
            document.documentElement.setAttribute('data-theme', 'dark');
            themeToggleBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
        }
    });

    // --- 2. ODONTOGRAM GENERATION ---
    const jawData = {
        adultUpper: [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28],
        childUpper: [55, 54, 53, 52, 51, 61, 62, 63, 64, 65],
        childLower: [85, 84, 83, 82, 81, 71, 72, 73, 74, 75],
        adultLower: [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38]
    };

    function createToothSVG(number) {
        return `
            <div class="tooth-unit" id="tooth-${number}">
                <span class="tooth-number">${number}</span>
                <svg viewBox="0 0 100 100" class="tooth-svg">
                    <defs>
                        <pattern id="diagonal-hatch-red" width="10" height="10" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
                            <line x1="0" y1="0" x2="0" y2="10" style="stroke:var(--danger); stroke-width:2" />
                        </pattern>
                    </defs>
                    <!-- Vestibular (Top) -->
                    <polygon points="20,20 80,20 65,35 35,35" class="tooth-face face-top" data-face="vestibular" />
                    <!-- Right (Distal/Mesial depending on quadrant) -->
                    <polygon points="80,20 80,80 65,65 65,35" class="tooth-face face-right" data-face="derecha" />
                    <!-- Palatino/Lingual (Bottom) -->
                    <polygon points="20,80 80,80 65,65 35,65" class="tooth-face face-bottom" data-face="lingual" />
                    <!-- Left (Mesial/Distal depending on quadrant) -->
                    <polygon points="20,20 20,80 35,65 35,35" class="tooth-face face-left" data-face="izquierda" />
                    <!-- Oclusal/Incisal (Center) -->
                    <rect x="35" y="35" width="30" height="30" class="tooth-face face-center" data-face="oclusal" />
                    
                    <!-- Overlays: Endodoncia line -->
                    <line x1="50" y1="0" x2="50" y2="100" class="tooth-overlay endo-line hidden" stroke="#EF4444" stroke-width="4" />
                    
                    <!-- Overlays: Caries incipiente dots (center of each face) -->
                    <circle cx="50" cy="27" r="4" class="tooth-overlay dot-face-top hidden" fill="#EF4444" />
                    <circle cx="50" cy="73" r="4" class="tooth-overlay dot-face-bottom hidden" fill="#EF4444" />
                    <circle cx="50" cy="50" r="4" class="tooth-overlay dot-face-center hidden" fill="#EF4444" />
                    <circle cx="27" cy="50" r="4" class="tooth-overlay dot-face-left hidden" fill="#EF4444" />
                    <circle cx="73" cy="50" r="4" class="tooth-overlay dot-face-right hidden" fill="#EF4444" />

                    <!-- Overlays: Caries incipiente dots (sub-location: face + mesial/distal) -->
                    <!-- Vestibular (top) por mesial (left) / distal (right) -->
                    <circle cx="30" cy="27" r="4" class="tooth-overlay dot-face-top-left hidden" fill="#EF4444" />
                    <circle cx="70" cy="27" r="4" class="tooth-overlay dot-face-top-right hidden" fill="#EF4444" />
                    <!-- Palatino/Lingual (bottom) por mesial (left) / distal (right) -->
                    <circle cx="30" cy="73" r="4" class="tooth-overlay dot-face-bottom-left hidden" fill="#EF4444" />
                    <circle cx="70" cy="73" r="4" class="tooth-overlay dot-face-bottom-right hidden" fill="#EF4444" />

                    <!-- Overlays: Abrasión / Erosión (Línea en el cuello) -->
                    <line x1="20" y1="20" x2="80" y2="20" class="tooth-overlay abrasion-top hidden" stroke="#EF4444" stroke-width="6" />
                    <line x1="20" y1="80" x2="80" y2="80" class="tooth-overlay abrasion-bottom hidden" stroke="#EF4444" stroke-width="6" />

                    <!-- Overlays: Atricción (Línea central) -->
                    <line x1="20" y1="50" x2="80" y2="50" class="tooth-overlay atriccion-center hidden" stroke="#EF4444" stroke-width="5" />

                    <!-- Overlays: Diente en erupción (Círculo alrededor) -->
                    <circle cx="50" cy="50" r="40" class="tooth-overlay eruption-circle hidden" fill="none" stroke="#2563EB" stroke-width="4" stroke-dasharray="6,4" />

                    <!-- Overlays: Giroversion (Arrows below tooth) -->
                    <g class="tooth-overlay giro-right hidden">
                        <path d="M 20,105 Q 50,115 80,105" fill="none" stroke="#EF4444" stroke-width="4" />
                        <path d="M 80,105 L 70,95 M 80,105 L 75,115" fill="none" stroke="#EF4444" stroke-width="4" />
                    </g>
                    <g class="tooth-overlay giro-left hidden">
                        <path d="M 80,105 Q 50,115 20,105" fill="none" stroke="#EF4444" stroke-width="4" />
                        <path d="M 20,105 L 30,95 M 20,105 L 25,115" fill="none" stroke="#EF4444" stroke-width="4" />
                    </g>

                    <!-- Overlays: Diastema (Double vertical lines between teeth, drawn on the right overflow) -->
                    <g class="tooth-overlay diastema-right hidden">
                        <line x1="102" y1="20" x2="102" y2="80" stroke="#EF4444" stroke-width="4" />
                        <line x1="110" y1="20" x2="110" y2="80" stroke="#EF4444" stroke-width="4" />
                    </g>
                </svg>
            </div>
        `;
    }

    function renderOdontogram() {
        document.getElementById('odontogram-adult-upper').innerHTML = jawData.adultUpper.map(createToothSVG).join('');
        document.getElementById('odontogram-child-upper').innerHTML = jawData.childUpper.map(createToothSVG).join('');
        document.getElementById('odontogram-child-lower').innerHTML = jawData.childLower.map(createToothSVG).join('');
        document.getElementById('odontogram-adult-lower').innerHTML = jawData.adultLower.map(createToothSVG).join('');
    }

    renderOdontogram();

    // --- 3. SPEECH RECOGNITION SETUP ---
    let lastProcessedTranscript = ''; // Prevents processing the same phrase twice
    let lastProcessedTime = 0;

    function initSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            alert('El reconocimiento de voz no es compatible con este navegador. Por favor usa Chrome en Android.');
            return null;
        }

        const rec = new SpeechRecognition();
        rec.lang = 'es-ES';
        rec.continuous = true; // Stay listening continuously
        rec.interimResults = true;

        rec.onstart = () => {
            isListening = true;
            micBtn.classList.add('listening');
            listeningStatus.textContent = 'Escuchando... Di datos o hallazgos.';
        };

        rec.onresult = (event) => {
            let finalTranscript = '';
            let interimTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                } else {
                    interimTranscript += event.results[i][0].transcript;
                }
            }

            if (interimTranscript) {
                showToast(interimTranscript);
            }

            if (finalTranscript) {
                const trimmed = finalTranscript.trim().toLowerCase();
                const now = Date.now();

                // Skip if identical to the last processed transcript within 3 seconds
                if (trimmed === lastProcessedTranscript && (now - lastProcessedTime) < 3000) {
                    console.log('Duplicate transcript skipped:', trimmed);
                    return;
                }

                lastProcessedTranscript = trimmed;
                lastProcessedTime = now;

                showToast('Procesando: ' + finalTranscript);
                processTranscript(trimmed);
            }
        };

        rec.onerror = (event) => {
            console.error('Speech recognition error', event.error);
            // 'no-speech' and 'aborted' are normal on mobile - ignore them silently
            if (event.error !== 'no-speech' && event.error !== 'aborted') {
                showToast('Error: ' + event.error);
            }
        };

        rec.onend = () => {
            // Android may kill the session randomly. If we're still supposed
            // to be listening, silently restart WITHOUT touching the UI.
            if (isListening) {
                setTimeout(() => {
                    if (isListening) {
                        try { rec.start(); } catch (e) { /* already running */ }
                    }
                }, 200);
            } else {
                stopListeningIndicator();
            }
        };

        return rec;
    }

    recognition = initSpeechRecognition();

    function stopListeningIndicator() {
        isListening = false;
        micBtn.classList.remove('listening');
        listeningStatus.textContent = 'Tocá para hablar...';
        transcriptToast.classList.remove('show');
    }

    function stopListening() {
        if (recognition) {
            isListening = false;
            recognition.stop();
        }
        stopListeningIndicator();
    }

    const betaModal = document.getElementById('beta-modal');
    const btnCloseBetaModal = document.getElementById('btn-close-beta-modal');

    // Hide tooltip on click, logic for first-time use
    micBtn.addEventListener('click', () => {
        // Hide the tooltip on first interaction
        const tooltip = document.getElementById('beta-tooltip');
        if (tooltip) tooltip.style.display = 'none';

        // Check if user has accepted the beta warning
        const hasAcceptedBeta = localStorage.getItem('betaVoiceAccepted');

        if (!hasAcceptedBeta) {
            // First time use -> Show modal, don't start listening yet
            if (betaModal) betaModal.classList.remove('hidden');
            return;
        }

        // Normal listening logic
        if (isListening) {
            stopListening();
        } else {
            if (recognition) {
                try {
                    recognition.start();
                } catch (e) {
                    console.error("Could not start recognition", e);
                }
            }
        }
    });

    if (btnCloseBetaModal && betaModal) {
        btnCloseBetaModal.addEventListener('click', () => {
            localStorage.setItem('betaVoiceAccepted', 'true');
            betaModal.classList.add('hidden');
        });
    }

    function showToast(message) {
        transcriptToast.textContent = message;
        transcriptToast.classList.add('show');
    }


    // --- 4. NATURAL LANGUAGE PARSING LOGIC ---
    function processTranscript(text) {
        text = text.trim().toLowerCase();

        // Android Speech-to-Text sometimes adds punctuation like commas or periods
        // This breaks regex word boundaries. We strip them here.
        text = text.replace(/[.,!?;:]/g, '');

        // Patient Data Extraction
        extractPatientData(text);

        // Odontogram Data Extraction
        extractOdontogramData(text);
    }

    function extractPatientData(text) {
        // Improved Regex for Name
        const nameMatch = text.match(/nombre\s+(?:es\s+)?([a-zñáéíóú\s]+)(?:edad|sexo|tel|pat|celular|años|$)/i);
        if (nameMatch && nameMatch[1]) {
            let name = nameMatch[1].replace(/(?:su\s+)?(?:es\s+)?/i, '').trim();
            name = name.replace(/\s+(?:edad|sexo|teléfono|telefono|celular)$/i, '');
            if (name) inputs.name.value = name;
        }

        // Improved Regex for Age
        const ageMatch = text.match(/edad\s+(?:de\s+)?(\d+)/i) || text.match(/(\d+)\s+años/i);
        if (ageMatch && ageMatch[1]) inputs.age.value = ageMatch[1];

        // Improved Regex for Sex
        if (text.match(/masculino|hombre/i)) inputs.sex.value = "Masculino";
        else if (text.match(/femenino|mujer/i)) inputs.sex.value = "Femenino";

        // Improved Regex for Phone
        const phoneMatch = text.match(/tel[é|e]fono\s+(?:es\s+)?([\d\s]+)/i) || text.match(/celular\s+(?:es\s+)?([\d\s]+)/i);
        if (phoneMatch && phoneMatch[1]) inputs.phone.value = phoneMatch[1].trim();

        // Improved Regex for Pathologies
        const pathoMatch = text.match(/(?:patolog[i|í]a(?:s)?|enfermedad(?:es)?)[\s,]+(?:es |son |tiene |presenta )?([^.]+)/i) || text.match(/(?:sin patolog[i|í]a(?:s)?|ninguna patolog[i|í]a|no presenta patolog[i|í]a)/i);

        if (pathoMatch) {
            if (pathoMatch[0].match(/(sin|ninguna|no presenta)/i)) {
                inputs.pathologies.value = "Ninguna";
            } else if (pathoMatch[1]) {
                let pato = pathoMatch[1].trim();
                // Limpiar si capturó texto del odontodiagrama
                pato = pato.replace(/\b(caries|unidad|diente|pieza|por|en)\b.*$/i, '').trim();
                // Limpiar conectores finales
                pato = pato.replace(/\s+y\s*$/i, '');

                if (pato && pato.length > 3) {
                    // Split by spaces or " y " to separate multiple words into a list
                    // So "diabetes asma" becomes "diabetes, asma"
                    let words = pato.split(/\s+y\s+|\s+/i).filter(w => w.length > 2);
                    let formattedPato = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(", ");

                    if (inputs.pathologies.value && inputs.pathologies.value !== "Ninguna") {
                        if (!inputs.pathologies.value.toLowerCase().includes(formattedPato.toLowerCase())) {
                            inputs.pathologies.value += ", " + formattedPato;
                        }
                    } else {
                        inputs.pathologies.value = formattedPato;
                    }
                }
            }
        }
    }

    function extractOdontogramData(text) {
        // Special command: Delete last finding
        if (text.match(/(elimina|eliminar|borra|borrar).*?(hallazgo|anterior|ultimo|último)/i)) {
            if (clinicalFindings.length > 0) {
                const lastFinding = clinicalFindings[clinicalFindings.length - 1];
                removeFinding(lastFinding.id);
                showToast("Último hallazgo eliminado");
            } else {
                showToast("No hay hallazgos para eliminar");
            }
            return;
        }

        const conditions = [
            "caries incipiente", "caries moderada", "caries avanzada", "caries recidiva", "caries",
            "obturacion provisional", "obturación provisional",
            "fractura", "abrasion", "abrasión", "erosion", "erosión", "atriccion", "atricción",
            "restauracion defectuosa", "restauración defectuosa",
            "restauracion", "restauración", "sellante",
            "endodoncia", "exodoncia", "diente ausente", "ausencia",
            "corona", "puente", "protesis", "prótesis", "diastema", "giroversion", "diente en erupcion"
        ];

        const facesDict = {
            "mesial": ["mesial", "derecha", "izquierda"],
            "distal": ["distal"],
            "vestibular": ["vestibular", "arriba", "frente"],
            "palatino": ["palatino", "lingual", "abajo"],
            "lingual": ["lingual", "palatino", "abajo"],
            "oclusal": ["oclusal", "incisal", "centro"]
        };

        // Determine condition
        let foundCondition = null;
        for (const cond of conditions) {
            if (text.includes(cond)) {
                foundCondition = cond;
                break;
            }
        }

        let foundUnits = [];

        // Determine units
        if (foundCondition === "diastema") {
            const multiUnits = text.match(/\b([1-4|5-8][1-8])\s*y\s*([1-4|5-8][1-8])\b/i);
            if (multiUnits) {
                let u1 = parseInt(multiUnits[1]);
                let u2 = parseInt(multiUnits[2]);
                let idx1 = -1, idx2 = -1;
                for (const arr of [jawData.adultUpper, jawData.childUpper, jawData.childLower, jawData.adultLower]) {
                    if (arr.includes(u1)) idx1 = arr.indexOf(u1);
                    if (arr.includes(u2)) idx2 = arr.indexOf(u2);
                    if (idx1 > -1 && idx2 > -1) break;
                }
                let diastemaUnit = (idx1 > -1 && idx2 > -1) ? (idx1 < idx2 ? u1.toString() : u2.toString()) : u1.toString();
                foundUnits.push(diastemaUnit);
            }
        } else {
            // Find all teeth following "unidad(es)", "pieza(s)", "diente(s)"
            const multiUnitMatch = text.match(/(?:unidad|unidades|diente|dientes|pieza|piezas)\s+((?:\d{2}[\s,y-]*)+)/i);
            if (multiUnitMatch) {
                const numbers = multiUnitMatch[1].match(/\b([1-8][1-8])\b/g);
                if (numbers) {
                    foundUnits = numbers;
                }
            }
            // Fallback: just find any standalone 2 digit valid teeth numbers
            if (foundUnits.length === 0 && foundCondition) {
                const standaloneUnits = text.match(/\b([1-8][1-8])\b/g);
                if (standaloneUnits) foundUnits = standaloneUnits;
            }
        }

        if (foundUnits.length === 0) return;

        // Raw face canonical matches (global for all teeth in this phrase)
        let rawFaceCanonical = null;
        // Special check for giroversion direction
        let giroDirection = null;
        if (foundCondition && foundCondition.includes("giroversion")) {
            if (text.includes("izquierda")) giroDirection = "giro-left";
            else if (text.includes("derecha")) giroDirection = "giro-right";
        }

        for (const [canonical, aliases] of Object.entries(facesDict)) {
            for (const alias of aliases) {
                if (text.includes(`por ${alias}`) || text.includes(`cara ${alias}`) || text.includes(alias)) {
                    rawFaceCanonical = canonical;
                    break;
                }
            }
            if (rawFaceCanonical && !rawFaceCanonical.includes('giro')) break;
        }

        function getMesialDistalMapping(unitStr) {
            const q = parseInt(unitStr.toString()[0]);
            const rightSide = [1, 4, 5, 8].includes(q);
            return {
                mesialClass: rightSide ? 'face-right' : 'face-left',
                distalClass: rightSide ? 'face-left' : 'face-right',
                mesialSub: rightSide ? 'right' : 'left',
                distalSub: rightSide ? 'left' : 'right'
            };
        }

        function getVestLingMapping(unitStr) {
            const q = parseInt(unitStr.toString()[0]);
            const isUpper = [1, 2, 5, 6].includes(q);
            return {
                vestibularClass: isUpper ? 'face-top' : 'face-bottom',
                linguoPalatClass: isUpper ? 'face-bottom' : 'face-top'
            };
        }

        // Loop through each extracted tooth number
        foundUnits.forEach(unit => {
            let mappedFaceClass = null;
            let displayFace = rawFaceCanonical;
            let currentCondition = foundCondition;

            if (rawFaceCanonical) {
                if (rawFaceCanonical === 'vestibular') mappedFaceClass = getVestLingMapping(unit).vestibularClass;
                if (rawFaceCanonical === 'palatino' || rawFaceCanonical === 'lingual') mappedFaceClass = getVestLingMapping(unit).linguoPalatClass;
                if (rawFaceCanonical === 'oclusal') mappedFaceClass = 'face-center';
                if (rawFaceCanonical === 'mesial') mappedFaceClass = getMesialDistalMapping(unit).mesialClass;
                if (rawFaceCanonical === 'distal') mappedFaceClass = getMesialDistalMapping(unit).distalClass;
            }

            // Compound face for caries incipiente
            if (currentCondition && currentCondition.includes('incipiente')) {
                const compoundMatch = text.match(/(?:cara\s+)?(vestibular|palatino|palatina|lingual)\s+(?:por\s+)?(mesial|distal)/i);
                if (compoundMatch) {
                    const primaryFace = compoundMatch[1].toLowerCase();
                    const subPos = compoundMatch[2].toLowerCase();
                    const mdMapping = getMesialDistalMapping(unit);
                    const vlMapping = getVestLingMapping(unit);

                    let primaryClass = (primaryFace === 'vestibular') ? vlMapping.vestibularClass : vlMapping.linguoPalatClass;
                    let subClass = (subPos === 'mesial') ? mdMapping.mesialSub : mdMapping.distalSub;

                    mappedFaceClass = `${primaryClass}-${subClass}`;
                    displayFace = `${primaryFace} por ${subPos}`;
                }
            }

            if (currentCondition && currentCondition.includes("giroversion") && giroDirection) {
                mappedFaceClass = giroDirection;
                currentCondition = "giroversion " + (giroDirection === "giro-left" ? "izquierda" : "derecha");
                displayFace = giroDirection;
            }

            // Auto-correct palatino/lingual based on tooth quadrant
            if (displayFace) {
                const quadrant = parseInt(unit.toString()[0]);
                const isUpper = [1, 2, 5, 6].includes(quadrant);

                if (displayFace === 'palatino' && !isUpper) displayFace = 'lingual';
                else if (displayFace === 'lingual' && isUpper) displayFace = 'palatino';

                if (displayFace.includes(' por ')) {
                    if (displayFace.includes('palatino') && !isUpper) displayFace = displayFace.replace('palatino', 'lingual');
                    else if (displayFace.includes('lingual') && isUpper) displayFace = displayFace.replace('lingual', 'palatino');
                }
            }

            if (currentCondition) {
                addFinding(unit, currentCondition, displayFace, mappedFaceClass);
            }
        });
    }

    // Manual Entry Logic
    const btnAddManual = document.getElementById('btn-add-manual');
    if (btnAddManual) {
        btnAddManual.addEventListener('click', () => {
            const unit = document.getElementById('manual-unit').value;
            const condition = document.getElementById('manual-condition').value;
            const face = document.getElementById('manual-face').value;

            if (!unit || !condition) {
                alert('Por favor ingrese al menos la Pieza y la Condición');
                return;
            }

            let mappedFaceClass = null;
            let displayFace = face; // what we show in the UI

            if (face && unit) {
                const q = parseInt(unit.toString()[0]);
                const isUpper = [1, 2, 5, 6].includes(q);
                const rightSide = [1, 4, 5, 8].includes(q);

                // Quadrant-aware: upper vest=top, lower vest=bottom
                if (face === 'vestibular') mappedFaceClass = isUpper ? 'face-top' : 'face-bottom';
                if (face === 'palatino') mappedFaceClass = isUpper ? 'face-bottom' : 'face-top';
                if (face === 'oclusal') mappedFaceClass = 'face-center';
                if (face === 'mesial') {
                    mappedFaceClass = rightSide ? 'face-right' : 'face-left';
                }
                if (face === 'distal') {
                    mappedFaceClass = rightSide ? 'face-left' : 'face-right';
                }

                // Compound faces: vestibular-mesial, palatino-distal, etc.
                if (face.includes('-')) {
                    const parts = face.split('-');
                    const primaryFace = parts[0];
                    const subPos = parts[1];

                    // Primary face mapping (quadrant-aware)
                    let primaryClass;
                    if (primaryFace === 'vestibular') {
                        primaryClass = isUpper ? 'face-top' : 'face-bottom';
                    } else {
                        primaryClass = isUpper ? 'face-bottom' : 'face-top';
                    }

                    let subClass = (subPos === 'mesial')
                        ? (rightSide ? 'right' : 'left')
                        : (rightSide ? 'left' : 'right');

                    mappedFaceClass = `${primaryClass}-${subClass}`;

                    // Auto-correct palatino/lingual for display
                    let correctPrimary = primaryFace;
                    if (primaryFace === 'palatino' && !isUpper) correctPrimary = 'lingual';
                    if (primaryFace === 'lingual' && isUpper) correctPrimary = 'palatino';
                    displayFace = `${correctPrimary} por ${subPos}`;
                }

                // Auto-correct simple palatino/lingual
                if (face === 'palatino' || face === 'lingual') {
                    const q = parseInt(unit.toString()[0]);
                    const isUpper = [1, 2, 5, 6].includes(q);
                    displayFace = isUpper ? 'palatino' : 'lingual';
                }
            }

            addFinding(unit, condition, displayFace, mappedFaceClass);

            // Clear manual form
            document.getElementById('manual-unit').value = '';
            document.getElementById('manual-condition').value = '';
            document.getElementById('manual-face').value = '';
        });
    }

    function addFinding(unit, condition, face, mappedFaceClass) {
        // Deduplication: reject if the exact same unit+condition was added < 3 seconds ago
        const now = Date.now();
        const isDuplicate = clinicalFindings.some(f => {
            return f.unit === unit &&
                f.condition.toLowerCase() === condition.toLowerCase() &&
                (now - (f._timestamp || 0)) < 3000;
        });
        if (isDuplicate) {
            console.log('Duplicate finding rejected:', unit, condition);
            return;
        }

        const findingId = `finding-${now}`;

        // Remove empty state
        const emptyState = findingsList.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        // Capitalize condition
        const condCapital = condition.charAt(0).toUpperCase() + condition.slice(1);

        // Add to array
        clinicalFindings.push({ id: findingId, unit, condition, face, mappedFaceClass, _timestamp: now });

        // Add to UI List
        const li = document.createElement('li');
        li.className = 'finding-item';
        li.id = findingId;
        li.innerHTML = `
            <div class="finding-content">
                <span class="finding-title">${condCapital}</span>
                <span class="finding-sub">Unidad ${unit} ${face ? '- Cara ' + face : ''}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <span class="finding-badge">U-${unit}</span>
                <button class="btn-delete-finding" onclick="removeFinding('${findingId}')" style="background:none; border:none; color:var(--danger); cursor:pointer;">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;
        findingsList.appendChild(li);

        // Update SVG Odontogram
        updateSVGTooth(unit, condition, mappedFaceClass);
    }

    // Make remove finding available globally
    window.removeFinding = function (id) {
        // Find finding index
        const index = clinicalFindings.findIndex(f => f.id === id);
        if (index > -1) {
            const finding = clinicalFindings[index];

            // Remove from array
            clinicalFindings.splice(index, 1);

            // Remove from UI
            const li = document.getElementById(id);
            if (li) li.remove();

            // Regenerate all SVG shapes for that specific tooth to clear styles
            // The simplest approach is to reset the whole tooth SVG and re-apply remaining findings
            resetAndReapplyTooth(finding.unit);

            // Check empty state
            if (clinicalFindings.length === 0) {
                findingsList.innerHTML = '<li class="empty-state">No hay hallazgos registrados.</li>';
            }
        }
    };

    function resetAndReapplyTooth(unit) {
        const toothUnit = document.getElementById(`tooth-${unit}`);
        if (!toothUnit) return;

        // 1. Reset SVG entirely (replace outerHTML with fresh render)
        const newSvgHTML = createToothSVG(parseInt(unit));
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = newSvgHTML;
        toothUnit.innerHTML = tempDiv.firstElementChild.innerHTML;

        // 2. Re-apply all *remaining* findings for this specific unit
        clinicalFindings.forEach(f => {
            if (f.unit === unit) {
                updateSVGTooth(f.unit, f.condition, f.mappedFaceClass);
            }
        });
    }

    function updateSVGTooth(unit, condition, faceClass) {
        const toothUnit = document.getElementById(`tooth-${unit}`);
        if (!toothUnit) return; // Tooth doesn't exist

        const condLower = condition.toLowerCase();

        // 1. Endodoncia
        if (condLower.includes('endodoncia')) {
            const line = toothUnit.querySelector('.endo-line');
            if (line) line.classList.remove('hidden');
            return;
        }

        // 2. Diastema
        if (condLower.includes('diastema')) {
            const diastemaLines = toothUnit.querySelector('.diastema-right');
            if (diastemaLines) diastemaLines.classList.remove('hidden');
            return;
        }

        // 3. Giroversion
        if (condLower.includes('giroversion') || condLower.includes('giroversión')) {
            if (condLower.includes('izquierda') || faceClass === 'giro-left') {
                const arrow = toothUnit.querySelector('.giro-left');
                if (arrow) arrow.classList.remove('hidden');
            } else {
                const arrow = toothUnit.querySelector('.giro-right');
                if (arrow) arrow.classList.remove('hidden');
            }
            return;
        }

        // 4. Caries Incipiente (Red Dot)
        if (condLower.includes('incipiente')) {
            if (faceClass) {
                const dot = toothUnit.querySelector(`.dot-${faceClass}`);
                if (dot) dot.classList.remove('hidden');
            } else {
                const dot = toothUnit.querySelector(`.dot-face-center`);
                if (dot) dot.classList.remove('hidden');
            }

            // Also check for sub-location (e.g. "face-top-left")
            // The compound faceClass like "face-top-left" is set by the parser
            // when it detects "vestibular por mesial" etc.

            return;
        }

        // 5. Abrasión / Erosión (Línea en el cuello, vestibular o palatino)
        if (condLower.includes('abrasion') || condLower.includes('abrasión') || condLower.includes('erosion') || condLower.includes('erosión')) {
            if (faceClass === 'face-top') {
                const line = toothUnit.querySelector('.abrasion-top');
                if (line) line.classList.remove('hidden');
            } else if (faceClass === 'face-bottom') {
                const line = toothUnit.querySelector('.abrasion-bottom');
                if (line) line.classList.remove('hidden');
            } else {
                // Default to top if face not specified clearly
                const line = toothUnit.querySelector('.abrasion-top');
                if (line) line.classList.remove('hidden');
            }
            return;
        }

        // 6. Atricción (Línea central oclusal)
        if (condLower.includes('atriccion') || condLower.includes('atricción')) {
            const line = toothUnit.querySelector('.atriccion-center');
            if (line) line.classList.remove('hidden');
            return;
        }

        // 7. Diente en Erupción
        if (condLower.includes('erupcion') || condLower.includes('erupción')) {
            const circle = toothUnit.querySelector('.eruption-circle');
            if (circle) circle.classList.remove('hidden');
            return;
        }

        // 8. Other solid fills/strokes
        let applyClass = '';
        let isDefectuosa = false;

        if (condLower.includes('caries')) applyClass = 'face-caries';
        if (condLower.includes('restauracion') || condLower.includes('restauración')) {
            applyClass = 'face-restoration';
            if (condLower.includes('defectuosa') || condLower.includes('recidiva')) {
                isDefectuosa = true;
            }
        }
        if (condLower.includes('sellante')) applyClass = 'face-sealant';
        if (condLower.includes('fractura')) applyClass = 'face-fracture';
        if (condLower.includes('exodoncia') || condLower.includes('ausencia') || condLower.includes('ausente')) {
            applyClass = 'face-fracture';

            const isBlueCross = condLower.includes('ausencia') || condLower.includes('ausente');
            const crossColor = isBlueCross ? "#3B82F6" : "#EF4444"; // #3B82F6 = blue (restoration), #EF4444 = red (caries)

            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", "0");
            line.setAttribute("y1", "0");
            line.setAttribute("x2", "100");
            line.setAttribute("y2", "100");
            line.setAttribute("stroke", crossColor);
            line.setAttribute("stroke-width", "4");
            line.setAttribute("class", "tooth-overlay");

            const line2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line2.setAttribute("x1", "0");
            line2.setAttribute("y1", "100");
            line2.setAttribute("x2", "100");
            line2.setAttribute("y2", "0");
            line2.setAttribute("stroke", crossColor);
            line2.setAttribute("stroke-width", "4");
            line2.setAttribute("class", "tooth-overlay");

            const svgGroup = toothUnit.querySelector('.tooth-svg');
            if (svgGroup) {
                // If the red hatch pattern was added by face-fracture class, we handle the X lines
                svgGroup.appendChild(line);
                svgGroup.appendChild(line2);
            }
            return;
        }

        if (applyClass) {
            if (faceClass) {
                const polygon = toothUnit.querySelector(`.${faceClass}`);
                if (polygon) {
                    polygon.classList.add(applyClass);
                    if (isDefectuosa) {
                        polygon.style.stroke = "var(--caries)";
                        polygon.style.strokeWidth = "4px";
                    }
                }
            } else {
                // Apply to whole tooth
                const polys = toothUnit.querySelectorAll('.tooth-face');
                polys.forEach(p => {
                    p.classList.add(applyClass);
                    if (isDefectuosa) {
                        p.style.stroke = "var(--caries)";
                        p.style.strokeWidth = "4px";
                    }
                });
            }
        }
    }


    // --- 5. REPORT GENERATION & PDF ---
    btnGenerateReport.addEventListener('click', () => {
        // Hide Main, Show Report
        mainContent.classList.add('hidden');
        micContainer.classList.add('hidden');
        btnGenerateReport.classList.add('hidden');
        reportContent.classList.remove('hidden');

        // Stop listening if active
        stopListening();

        generateReportContent();
    });

    btnBackToEdit.addEventListener('click', () => {
        mainContent.classList.remove('hidden');
        micContainer.classList.remove('hidden');
        btnGenerateReport.classList.remove('hidden');
        reportContent.classList.add('hidden');
    });

    function generateReportContent() {
        const d = new Date();
        document.getElementById('report-date').textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;

        const reportBody = document.getElementById('editable-report');

        // Build HTML string
        let htmlSnippet = `
            <h3>Datos del Paciente</h3>
            <p><strong>Nombre:</strong> ${inputs.name.value || 'No especificado'}</p>
            <p><strong>Edad:</strong> ${inputs.age.value || 'No especificada'}</p>
            <p><strong>Sexo:</strong> ${inputs.sex.value || 'No especificado'}</p>
            <p><strong>Teléfono:</strong> ${inputs.phone.value || 'No especificado'}</p>
            <p><strong>Patologías:</strong> ${inputs.pathologies.value || 'Ninguna registrada'}</p>
            
            <h3>Hallazgos Odontológicos Registrados</h3>
            <ul>
        `;

        if (clinicalFindings.length === 0) {
            htmlSnippet += `<li>Sin hallazgos dictados.</li>`;
        } else {
            clinicalFindings.forEach(f => {
                htmlSnippet += `<li><strong>Pieza ${f.unit}:</strong> ${f.condition} ${f.face ? '(Cara: ' + f.face + ')' : ''}</li>`;
            });
        }

        htmlSnippet += `</ul>`;

        // Notes section editable
        htmlSnippet += `
            <h3>Observaciones del Especialista</h3>
            <p><em>(Escriba notas adicionales aquí si es necesario...)</em></p>
        `;

        reportBody.innerHTML = htmlSnippet;

        // Clone Odontogram for PDF
        const mount = document.getElementById('report-odontogram-mount');
        mount.innerHTML = ''; // clear
        const originalOdontogram = document.getElementById('odontogram-container');
        const clone = originalOdontogram.cloneNode(true);
        clone.id = 'cloned-odontogram';
        mount.appendChild(clone);
    }

    // --- SHARED PDF GENERATOR (jsPDF text + html2canvas odontogram) ---
    async function generateOdontogramPDF(patientInfo, findingsArr, odontogramEl) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
        const pageW = 210, margin = 15, contentW = pageW - margin * 2;
        let y = 0;

        // --- HEADER ---
        doc.setFillColor(79, 70, 229);
        doc.rect(0, 0, pageW, 28, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(18);
        doc.setFont('helvetica', 'bold');
        doc.text('Informe Odontológico', margin, 14);
        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        const now = new Date();
        doc.text(`Fecha: ${now.toLocaleDateString()} — ${now.toLocaleTimeString()}`, margin, 22);
        y = 36;

        // --- PATIENT DATA ---
        doc.setTextColor(79, 70, 229);
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.text('DATOS DEL PACIENTE', margin, y);
        y += 2;
        doc.setDrawColor(79, 70, 229);
        doc.setLineWidth(0.5);
        doc.line(margin, y, margin + contentW, y);
        y += 6;

        doc.setTextColor(30, 30, 30);
        doc.setFontSize(10);

        const fields = [
            ['Nombre', patientInfo.name || '—'],
            ['Edad', patientInfo.age ? patientInfo.age + ' años' : '—'],
            ['Sexo', patientInfo.sex || '—'],
            ['Teléfono', patientInfo.phone || '—'],
            ['Patologías', patientInfo.pathologies || 'Ninguna']
        ];
        fields.forEach(([label, value]) => {
            doc.setFont('helvetica', 'bold');
            doc.text(label + ':', margin, y);
            doc.setFont('helvetica', 'normal');
            const lines = doc.splitTextToSize(value, contentW - 30);
            doc.text(lines, margin + 30, y);
            y += lines.length * 5;
        });
        y += 4;

        // --- ODONTOGRAM IMAGE ---
        if (odontogramEl) {
            doc.setTextColor(79, 70, 229);
            doc.setFontSize(12);
            doc.setFont('helvetica', 'bold');
            doc.text('ODONTODIAGRAMA', margin, y);
            y += 2;
            doc.setDrawColor(79, 70, 229);
            doc.line(margin, y, margin + contentW, y);
            y += 4;

            try {
                // Ensure element is visible for html2canvas
                const wasHidden = odontogramEl.offsetParent === null;
                const origDisplay = odontogramEl.style.display;
                const origVisibility = odontogramEl.style.visibility;
                const origPosition = odontogramEl.style.position;
                if (wasHidden) {
                    odontogramEl.style.display = 'block';
                    odontogramEl.style.visibility = 'visible';
                    odontogramEl.style.position = 'absolute';
                    odontogramEl.style.left = '-9999px';
                }

                // Force white background for capture
                const origBg = odontogramEl.style.backgroundColor;
                odontogramEl.style.backgroundColor = '#FFFFFF';
                odontogramEl.querySelectorAll('.tooth-number').forEach(el => el.style.color = '#111827');
                odontogramEl.querySelectorAll('.tooth-face').forEach(el => {
                    if (!el.classList.contains('face-caries') &&
                        !el.classList.contains('face-restoration') &&
                        !el.classList.contains('face-sealant') &&
                        !el.classList.contains('face-fracture')) {
                        el.style.fill = '#FFFFFF';
                    }
                    el.style.stroke = '#333';
                });

                const canvas = await html2canvas(odontogramEl, {
                    scale: 2, backgroundColor: '#FFFFFF', useCORS: true, windowWidth: 1024
                });

                // Restore
                odontogramEl.style.backgroundColor = origBg;
                odontogramEl.querySelectorAll('.tooth-number').forEach(el => el.style.color = '');
                odontogramEl.querySelectorAll('.tooth-face').forEach(el => { el.style.stroke = ''; el.style.fill = ''; });
                if (wasHidden) {
                    odontogramEl.style.display = origDisplay;
                    odontogramEl.style.visibility = origVisibility;
                    odontogramEl.style.position = origPosition;
                    odontogramEl.style.left = '';
                }

                const imgData = canvas.toDataURL('image/png');
                const imgW = contentW;
                const imgH = (canvas.height / canvas.width) * imgW;

                if (y + imgH > 280) { doc.addPage(); y = margin; }
                doc.addImage(imgData, 'PNG', margin, y, imgW, imgH);
                y += imgH + 6;
            } catch (e) {
                console.warn('Odontogram capture failed:', e);
                doc.setTextColor(150, 150, 150);
                doc.setFontSize(9);
                doc.text('(No se pudo capturar el odontodiagrama)', margin, y);
                y += 8;
            }
        }

        // --- FINDINGS ---
        if (y > 240) { doc.addPage(); y = margin; }

        doc.setTextColor(79, 70, 229);
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.text('HALLAZGOS CLÍNICOS', margin, y);
        y += 2;
        doc.setDrawColor(79, 70, 229);
        doc.line(margin, y, margin + contentW, y);
        y += 6;

        doc.setTextColor(30, 30, 30);
        doc.setFontSize(9);

        if (findingsArr && findingsArr.length > 0) {
            findingsArr.forEach((f, i) => {
                if (y > 275) { doc.addPage(); y = margin; }
                doc.setFont('helvetica', 'bold');
                doc.text(`${i + 1}.`, margin, y);
                doc.setFont('helvetica', 'normal');
                const txt = `${f.condition || '—'} — Unidad ${f.unit || '—'}${f.face ? ' · Cara ' + f.face : ''}`;
                doc.text(txt, margin + 7, y);
                y += 5;
            });
        } else {
            doc.setFont('helvetica', 'italic');
            doc.setTextColor(150, 150, 150);
            doc.text('Sin hallazgos registrados', margin, y);
        }

        // --- FOOTER ---
        doc.setDrawColor(200, 200, 200);
        doc.setLineWidth(0.3);
        doc.line(margin, 288, margin + contentW, 288);
        doc.setFontSize(7);
        doc.setTextColor(150, 150, 150);
        doc.setFont('helvetica', 'normal');
        doc.text('Generado por OdontoVoice · Documento confidencial', margin, 292);

        return doc;
    }

    // --- MAIN PDF BUTTON (from report view) ---
    btnDownloadPdf.addEventListener('click', async () => {
        btnDownloadPdf.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generando...';
        btnDownloadPdf.disabled = true;

        try {
            const pInfo = {
                name: inputs.name.value,
                age: inputs.age.value,
                sex: inputs.sex.value,
                phone: inputs.phone.value,
                pathologies: inputs.pathologies.value
            };
            // Use the cloned odontogram in the report view (the original is hidden)
            const odontogramEl = document.getElementById('cloned-odontogram') || document.getElementById('odontogram-container');
            const doc = await generateOdontogramPDF(pInfo, clinicalFindings, odontogramEl);
            doc.save(`Odontograma_${pInfo.name.replace(/\s+/g, '_') || 'Paciente'}.pdf`);

            // Encrypt and save to Firestore in background
            if (currentUser && inputs.name.value) {
                try {
                    const uid = currentUser.uid;
                    const encName = await encryptText(inputs.name.value, uid);
                    const encPhone = await encryptText(inputs.phone.value || '', uid);
                    const encPathologies = await encryptText(inputs.pathologies.value || '', uid);
                    const encFindings = await encryptText(JSON.stringify(clinicalFindings), uid);
                    await addDoc(collection(db, "patients"), {
                        doctorId: uid, doctorEmail: currentUser.email,
                        patientName: encName, patientAge: inputs.age.value, patientSex: inputs.sex.value,
                        patientPhone: encPhone, pathologies: encPathologies,
                        findings: encFindings, encrypted: true, timestamp: serverTimestamp()
                    });
                    console.log("Paciente guardado en la nube (encriptado)");
                } catch (e) { console.error("Error al guardar en la nube:", e); }
            }
        } catch (e) {
            console.error('Error generando PDF:', e);
            alert('Error al generar el PDF.');
        }

        btnDownloadPdf.innerHTML = '<i class="fa-solid fa-file-pdf"></i> Guardar PDF';
        btnDownloadPdf.disabled = false;
    });

    // --- 6. FEEDBACK MODAL ---
    const btnOpenFeedback = document.getElementById('btn-open-feedback');
    const btnCloseFeedback = document.getElementById('btn-close-feedback');
    const btnSendFeedback = document.getElementById('btn-send-feedback');
    const feedbackModal = document.getElementById('feedback-modal');
    const feedbackText = document.getElementById('feedback-text');

    btnOpenFeedback.addEventListener('click', () => {
        feedbackModal.classList.remove('hidden');
    });

    btnCloseFeedback.addEventListener('click', () => {
        feedbackModal.classList.add('hidden');
    });

    btnSendFeedback.addEventListener('click', async () => {
        const text = feedbackText.value.trim();
        if (!text) {
            alert('Por favor escribe un mensaje primero.');
            return;
        }

        btnSendFeedback.disabled = true;
        btnSendFeedback.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enviando...';

        const feedbackData = {
            text: text,
            timestamp: serverTimestamp(),
            userId: currentUser ? currentUser.uid : 'anonymous',
            userEmail: currentUser ? currentUser.email : 'unknown'
        };

        try {
            await addDoc(collection(db, "feedback"), feedbackData);
            alert("¡Gracias por tu sugerencia! La hemos recibido correctamente.");
            feedbackText.value = '';
            feedbackModal.classList.add('hidden');
        } catch (e) {
            console.error("Error al enviar feedback", e);
            alert("Hubo un error al enviar el feedback. Intenta más tarde.");
        } finally {
            btnSendFeedback.disabled = false;
            btnSendFeedback.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Enviar';
        }
    });

    // --- 7. PATIENT HISTORY ---
    const historyContent = document.getElementById('history-content');
    const historyDetail = document.getElementById('history-detail');
    const historyList = document.getElementById('history-list');
    const historySearchInput = document.getElementById('history-search-input');
    const btnHistory = document.getElementById('btn-history');
    const btnBackFromHistory = document.getElementById('btn-back-from-history');
    const btnBackFromDetail = document.getElementById('btn-back-from-detail');

    let cachedPatients = []; // Cache decrypted patients

    // Show history view
    btnHistory.addEventListener('click', () => {
        mainContent.classList.add('hidden');
        micContainer.classList.add('hidden');
        btnGenerateReport.classList.add('hidden');
        reportContent.classList.add('hidden');
        historyDetail.classList.add('hidden');
        historyContent.classList.remove('hidden');
        stopListening();
        fetchPatients();
    });

    // Back to main from history
    btnBackFromHistory.addEventListener('click', () => {
        historyContent.classList.add('hidden');
        mainContent.classList.remove('hidden');
        micContainer.classList.remove('hidden');
        btnGenerateReport.classList.remove('hidden');
    });

    // Back to history from detail
    btnBackFromDetail.addEventListener('click', () => {
        historyDetail.classList.add('hidden');
        historyContent.classList.remove('hidden');
    });

    // Search filter
    historySearchInput.addEventListener('input', () => {
        const search = historySearchInput.value.toLowerCase();
        const filtered = cachedPatients.filter(p =>
            p.name.toLowerCase().includes(search)
        );
        renderHistoryList(filtered);
    });

    // Fetch patients from Firestore
    async function fetchPatients() {
        if (!currentUser) {
            historyList.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding:2rem;">Inicia sesión para ver tu historial.</p>';
            return;
        }

        historyList.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding:2rem;"><i class="fa-solid fa-spinner fa-spin"></i> Cargando pacientes...</p>';

        try {
            const q = query(
                collection(db, "patients"),
                where("doctorId", "==", currentUser.uid),
                orderBy("timestamp", "desc")
            );
            const snapshot = await getDocs(q);

            cachedPatients = [];

            for (const doc of snapshot.docs) {
                const data = doc.data();
                let name = data.patientName || '';
                let phone = data.patientPhone || '';
                let pathologies = data.pathologies || '';
                let findings = data.findings || '[]';

                // Decrypt if encrypted
                if (data.encrypted) {
                    try {
                        name = await decryptText(name, currentUser.uid);
                        phone = await decryptText(phone, currentUser.uid);
                        pathologies = await decryptText(pathologies, currentUser.uid);
                        findings = await decryptText(findings, currentUser.uid);
                    } catch (e) {
                        console.warn('Could not decrypt record:', doc.id, e);
                        name = '🔒 (No se pudo descifrar)';
                    }
                }

                let findingsArr = [];
                try { findingsArr = JSON.parse(findings); } catch (e) { findingsArr = findings; }

                const timestamp = data.timestamp?.toDate ? data.timestamp.toDate() : new Date();

                cachedPatients.push({
                    id: doc.id,
                    name,
                    age: data.patientAge || '',
                    sex: data.patientSex || '',
                    phone,
                    pathologies,
                    findings: findingsArr,
                    date: timestamp
                });
            }

            if (cachedPatients.length === 0) {
                historyList.innerHTML = '<p style="text-align:center; color:var(--text-muted); padding:2rem;"><i class="fa-solid fa-folder-open" style="font-size:2rem; display:block; margin-bottom:0.5rem;"></i> No hay pacientes guardados aún.</p>';
            } else {
                renderHistoryList(cachedPatients);
            }
        } catch (e) {
            console.error('Error fetching patients:', e);
            historyList.innerHTML = `<p style="text-align:center; color:var(--danger); padding:2rem;">Error al cargar pacientes. Verifica que las reglas de Firestore estén configuradas correctamente.</p>`;
        }
    }

    // Render the patient list
    function renderHistoryList(patients) {
        historyList.innerHTML = patients.map((p, i) => `
            <div class="history-item" data-index="${i}" style="
                display: flex; justify-content: space-between; align-items: center;
                padding: 0.75rem 1rem; border-radius: var(--radius-md);
                border: 1px solid var(--border); cursor: pointer;
                transition: background 0.2s; background: var(--surface);
            ">
                <div style="flex: 1; min-width: 0;">
                    <strong style="display: block; font-size: 1rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.name}</strong>
                    <span style="font-size: 0.8rem; color: var(--text-muted);">
                        ${p.date.toLocaleDateString()} · ${p.age ? p.age + ' años' : ''} ${p.sex ? '· ' + p.sex : ''}
                    </span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="background: var(--primary); color: white; font-size: 0.7rem; padding: 2px 8px; border-radius: 12px;">
                        ${Array.isArray(p.findings) ? p.findings.length : 0} hallazgos
                    </span>
                    <i class="fa-solid fa-chevron-right" style="color: var(--text-muted); font-size: 0.8rem;"></i>
                </div>
            </div>
        `).join('');

        // Click handlers
        historyList.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', () => {
                const idx = parseInt(item.dataset.index);
                showPatientDetail(patients[idx]);
            });
        });
    }

    // Show patient detail view
    let currentDetailPatient = null;

    function showPatientDetail(patient) {
        currentDetailPatient = patient;
        historyContent.classList.add('hidden');
        historyDetail.classList.remove('hidden');

        document.getElementById('detail-patient-name').textContent = patient.name;

        const detail = document.getElementById('detail-content');

        let findingsHtml = '';
        if (Array.isArray(patient.findings) && patient.findings.length > 0) {
            findingsHtml = patient.findings.map(f => `
                <li style="padding: 0.5rem 0; border-bottom: 1px solid var(--border);">
                    <strong>${f.condition}</strong> — Unidad ${f.unit}${f.face ? ' · Cara ' + f.face : ''}
                </li>
            `).join('');
        } else {
            findingsHtml = '<li style="color: var(--text-muted); padding: 0.5rem 0;">Sin hallazgos registrados</li>';
        }

        detail.innerHTML = `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 1.5rem;">
                <div>
                    <label style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">Nombre</label>
                    <p style="font-weight: 600; margin-top: 2px;">${patient.name}</p>
                </div>
                <div>
                    <label style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">Edad</label>
                    <p style="font-weight: 600; margin-top: 2px;">${patient.age || '—'}</p>
                </div>
                <div>
                    <label style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">Sexo</label>
                    <p style="font-weight: 600; margin-top: 2px;">${patient.sex || '—'}</p>
                </div>
                <div>
                    <label style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">Teléfono</label>
                    <p style="font-weight: 600; margin-top: 2px;">${patient.phone || '—'}</p>
                </div>
            </div>

            <div style="margin-bottom: 1.5rem;">
                <label style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">Patologías</label>
                <p style="margin-top: 2px;">${patient.pathologies || 'Ninguna reportada'}</p>
            </div>

            <div>
                <label style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; display: block; margin-bottom: 0.5rem;">Hallazgos Clínicos (${Array.isArray(patient.findings) ? patient.findings.length : 0})</label>
                <ul style="list-style: none; padding: 0; margin: 0;">
                    ${findingsHtml}
                </ul>
            </div>

            <p style="text-align: right; font-size: 0.8rem; color: var(--text-muted); margin-top: 1.5rem;">
                <i class="fa-solid fa-calendar"></i> Guardado el ${patient.date.toLocaleDateString()} a las ${patient.date.toLocaleTimeString()}
            </p>
        `;
    }

    // PDF from history detail — build a temporary odontogram from saved findings
    const btnDetailPdf = document.getElementById('btn-detail-pdf');
    btnDetailPdf.addEventListener('click', async () => {
        if (!currentDetailPatient) return;

        btnDetailPdf.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ...';
        btnDetailPdf.disabled = true;

        try {
            const pInfo = {
                name: currentDetailPatient.name,
                age: currentDetailPatient.age,
                sex: currentDetailPatient.sex,
                phone: currentDetailPatient.phone,
                pathologies: currentDetailPatient.pathologies
            };

            // Build a temporary offscreen odontogram to capture for the PDF
            let tempOdontogram = null;
            if (Array.isArray(currentDetailPatient.findings) && currentDetailPatient.findings.length > 0) {
                tempOdontogram = document.createElement('div');
                tempOdontogram.className = 'odontogram-container';
                tempOdontogram.style.cssText = 'position:absolute; left:-9999px; top:0; background:#FFFFFF; padding:10px;';

                // Build jaw rows
                const rows = [
                    { id: 'odontogram-adult-upper', teeth: jawData.adultUpper, cls: 'jaw-row' },
                    { id: 'odontogram-child-upper', teeth: jawData.childUpper, cls: 'jaw-row child-jaw' },
                    { id: 'midline', teeth: null, cls: 'midline-divider' },
                    { id: 'odontogram-child-lower', teeth: jawData.childLower, cls: 'jaw-row child-jaw' },
                    { id: 'odontogram-adult-lower', teeth: jawData.adultLower, cls: 'jaw-row' }
                ];
                rows.forEach(r => {
                    const div = document.createElement('div');
                    div.className = r.cls;
                    if (r.teeth) {
                        r.teeth.forEach(num => {
                            div.innerHTML += createToothSVG(num);
                        });
                    }
                    tempOdontogram.appendChild(div);
                });

                document.body.appendChild(tempOdontogram);

                // Apply each finding to the temporary odontogram
                currentDetailPatient.findings.forEach(f => {
                    // updateSVGTooth works on the DOM by ID, so we need temp IDs
                    // The createToothSVG already creates elements with id="tooth-{num}"
                    // but they might conflict with existing ones. We'll use a scoped approach.
                    const toothUnit = tempOdontogram.querySelector(`#tooth-${f.unit}`);
                    if (!toothUnit) return;

                    const condLower = (f.condition || '').toLowerCase();
                    const faceClass = f.mappedFaceClass || null;

                    // Endodoncia
                    if (condLower.includes('endodoncia')) {
                        const line = toothUnit.querySelector('.endo-line');
                        if (line) line.classList.remove('hidden');
                        return;
                    }
                    // Diastema
                    if (condLower.includes('diastema')) {
                        const d = toothUnit.querySelector('.diastema-right');
                        if (d) d.classList.remove('hidden');
                        return;
                    }
                    // Giroversion
                    if (condLower.includes('giroversion') || condLower.includes('giroversión')) {
                        if (condLower.includes('izquierda') || faceClass === 'giro-left') {
                            const arrow = toothUnit.querySelector('.giro-left');
                            if (arrow) arrow.classList.remove('hidden');
                        } else {
                            const arrow = toothUnit.querySelector('.giro-right');
                            if (arrow) arrow.classList.remove('hidden');
                        }
                        return;
                    }
                    // Caries Incipiente
                    if (condLower.includes('incipiente')) {
                        if (faceClass) {
                            const dot = toothUnit.querySelector(`.dot-${faceClass}`);
                            if (dot) dot.classList.remove('hidden');
                        } else {
                            const dot = toothUnit.querySelector(`.dot-face-center`);
                            if (dot) dot.classList.remove('hidden');
                        }
                        return;
                    }
                    // Abrasion / Erosion
                    if (condLower.includes('abrasion') || condLower.includes('abrasión') || condLower.includes('erosion') || condLower.includes('erosión')) {
                        if (faceClass === 'face-top') {
                            const l = toothUnit.querySelector('.abrasion-top');
                            if (l) l.classList.remove('hidden');
                        } else {
                            const l = toothUnit.querySelector('.abrasion-bottom') || toothUnit.querySelector('.abrasion-top');
                            if (l) l.classList.remove('hidden');
                        }
                        return;
                    }
                    // Atriccion
                    if (condLower.includes('atriccion') || condLower.includes('atricción')) {
                        const l = toothUnit.querySelector('.atriccion-center');
                        if (l) l.classList.remove('hidden');
                        return;
                    }
                    // Erupcion
                    if (condLower.includes('erupcion') || condLower.includes('erupción')) {
                        const c = toothUnit.querySelector('.eruption-circle');
                        if (c) c.classList.remove('hidden');
                        return;
                    }
                    // Solid fills
                    let applyClass = '';
                    let isDefectuosa = false;
                    if (condLower.includes('caries')) applyClass = 'face-caries';
                    if (condLower.includes('restauracion') || condLower.includes('restauración')) {
                        applyClass = 'face-restoration';
                        if (condLower.includes('defectuosa') || condLower.includes('recidiva')) isDefectuosa = true;
                    }
                    if (condLower.includes('sellante')) applyClass = 'face-sealant';
                    if (condLower.includes('fractura')) applyClass = 'face-fracture';
                    if (condLower.includes('exodoncia') || condLower.includes('ausencia') || condLower.includes('ausente')) {
                        const isBlueCross = condLower.includes('ausencia') || condLower.includes('ausente');
                        const crossColor = isBlueCross ? '#3B82F6' : '#EF4444';
                        const svgGroup = toothUnit.querySelector('.tooth-svg');
                        if (svgGroup) {
                            const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                            l1.setAttribute('x1', '0'); l1.setAttribute('y1', '0');
                            l1.setAttribute('x2', '100'); l1.setAttribute('y2', '100');
                            l1.setAttribute('stroke', crossColor); l1.setAttribute('stroke-width', '4');
                            l1.setAttribute('class', 'tooth-overlay');
                            const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                            l2.setAttribute('x1', '0'); l2.setAttribute('y1', '100');
                            l2.setAttribute('x2', '100'); l2.setAttribute('y2', '0');
                            l2.setAttribute('stroke', crossColor); l2.setAttribute('stroke-width', '4');
                            l2.setAttribute('class', 'tooth-overlay');
                            svgGroup.appendChild(l1); svgGroup.appendChild(l2);
                        }
                        return;
                    }
                    if (applyClass) {
                        if (faceClass) {
                            const polygon = toothUnit.querySelector(`.${faceClass}`);
                            if (polygon) {
                                polygon.classList.add(applyClass);
                                if (isDefectuosa) { polygon.style.stroke = 'var(--caries)'; polygon.style.strokeWidth = '4px'; }
                            }
                        } else {
                            toothUnit.querySelectorAll('.tooth-face').forEach(p => {
                                p.classList.add(applyClass);
                                if (isDefectuosa) { p.style.stroke = 'var(--caries)'; p.style.strokeWidth = '4px'; }
                            });
                        }
                    }
                });

                // Force light-mode colors for PDF capture
                tempOdontogram.querySelectorAll('.tooth-number').forEach(el => el.style.color = '#111827');
                tempOdontogram.querySelectorAll('.tooth-face').forEach(el => {
                    if (!el.classList.contains('face-caries') &&
                        !el.classList.contains('face-restoration') &&
                        !el.classList.contains('face-sealant') &&
                        !el.classList.contains('face-fracture')) {
                        el.style.fill = '#FFFFFF';
                    }
                    el.style.stroke = '#333';
                });
            }

            const doc = await generateOdontogramPDF(pInfo, currentDetailPatient.findings, tempOdontogram);
            doc.save(`Odontograma_${pInfo.name.replace(/\s+/g, '_') || 'Paciente'}.pdf`);

            // Cleanup temporary odontogram
            if (tempOdontogram && tempOdontogram.parentNode) {
                tempOdontogram.parentNode.removeChild(tempOdontogram);
            }
        } catch (e) {
            console.error('Error generando PDF desde historial:', e);
            alert('Error al generar el PDF.');
        }

        btnDetailPdf.innerHTML = '<i class="fa-solid fa-file-pdf"></i> PDF';
        btnDetailPdf.disabled = false;
    });

});
