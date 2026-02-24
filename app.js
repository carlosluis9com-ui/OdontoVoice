import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getFirestore, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";

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

    micBtn.addEventListener('click', () => {
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
        // Catch variations: "elimina el hallazgo", "eliminar", "borrar el anterior", "borra el ultimo"
        if (text.match(/(elimina|eliminar|borra|borrar).*?(hallazgo|anterior|ultimo|último)/i)) {
            if (clinicalFindings.length > 0) {
                const lastFinding = clinicalFindings[clinicalFindings.length - 1];
                removeFinding(lastFinding.id);
                showToast("Último hallazgo eliminado");
            } else {
                showToast("No hay hallazgos para eliminar");
            }
            return; // Skip normal parsing
        }

        // Look for pattern: "[Category] en [unidad/diente] [number] (en la cara / por) [face]"

        const conditions = [
            "caries incipiente", "caries moderada", "caries avanzada", "caries recidiva", "caries",
            "obturacion provisional", "obturación provisional",
            "fractura", "abrasion", "abrasión", "erosion", "erosión", "atriccion", "atricción",
            "restauracion defectuosa", "restauración defectuosa",
            "restauracion", "restauración", "sellante",
            "endodoncia", "exodoncia", "diente ausente",
            "corona", "puente", "protesis", "prótesis", "diastema", "giroversion", "diente en erupcion"
        ];

        const facesDict = {
            "mesial": ["mesial", "derecha", "izquierda"], // Will map logically later based on quad
            "distal": ["distal"],
            "vestibular": ["vestibular", "arriba", "frente"],
            "palatino": ["palatino", "lingual", "abajo"],
            "lingual": ["lingual", "palatino", "abajo"],
            "oclusal": ["oclusal", "incisal", "centro"]
        };

        // Attempt a basic parse
        // Loop over text to find combinations
        let foundCondition = null;
        for (const cond of conditions) {
            if (text.includes(cond)) {
                foundCondition = cond;
                break; // Found the most prominent condition
            }
        }

        // Find unit number
        const unitMatch = text.match(/(?:unidad|diente|pieza(?:s)?)\s+(\d{2})/i);
        let foundUnit = unitMatch ? unitMatch[1] : null;

        // Special check for diastema to catch "entre 11 y 12"
        if (foundCondition === "diastema") {
            const multiUnits = text.match(/\b([1-4|5-8][1-8])\s*y\s*([1-4|5-8][1-8])\b/i);
            if (multiUnits) {
                let u1 = parseInt(multiUnits[1]);
                let u2 = parseInt(multiUnits[2]);
                // Determine which one is "first" visually based on array order
                let idx1 = -1, idx2 = -1;
                for (const arr of [jawData.adultUpper, jawData.childUpper, jawData.childLower, jawData.adultLower]) {
                    if (arr.includes(u1)) idx1 = arr.indexOf(u1);
                    if (arr.includes(u2)) idx2 = arr.indexOf(u2);
                    if (idx1 > -1 && idx2 > -1) break;
                }
                if (idx1 > -1 && idx2 > -1) {
                    foundUnit = idx1 < idx2 ? u1.toString() : u2.toString();
                } else {
                    foundUnit = u1.toString();
                }
            }
        }

        if (!foundUnit && foundCondition) {
            const standaloneUnit = text.match(/\b([1-4|5-8][1-8])\b/);
            if (standaloneUnit) foundUnit = standaloneUnit[1];
        }

        // Find face
        let foundFace = null;
        let mappedFaceClass = null;

        // Helper: determine mesial/distal → SVG left/right based on quadrant
        // Mesial = toward midline, Distal = away from midline
        // Quadrants 1,4,5,8 (right side of mouth): mesial is toward center = RIGHT in SVG
        // Quadrants 2,3,6,7 (left side of mouth): mesial is toward center = LEFT in SVG
        function getMesialDistalMapping(unitStr) {
            const q = parseInt(unitStr.toString()[0]);
            const rightSide = [1, 4, 5, 8].includes(q); // right side of mouth
            return {
                mesialClass: rightSide ? 'face-right' : 'face-left',
                distalClass: rightSide ? 'face-left' : 'face-right',
                mesialSub: rightSide ? 'right' : 'left',
                distalSub: rightSide ? 'left' : 'right'
            };
        }

        // Helper: determine vestibular/lingual/palatino → SVG top/bottom based on quadrant
        // UPPER teeth (Q 1,2,5,6): vestibular = TOP, palatino = BOTTOM
        // LOWER teeth (Q 3,4,7,8): lingual = TOP, vestibular = BOTTOM
        function getVestLingMapping(unitStr) {
            const q = parseInt(unitStr.toString()[0]);
            const isUpper = [1, 2, 5, 6].includes(q);
            return {
                vestibularClass: isUpper ? 'face-top' : 'face-bottom',
                linguoPalatClass: isUpper ? 'face-bottom' : 'face-top'
            };
        }

        // Special check for giroversion direction
        if (foundCondition && foundCondition.includes("giroversion")) {
            if (text.includes("izquierda")) foundFace = "giro-left";
            else if (text.includes("derecha")) foundFace = "giro-right";
        }

        for (const [canonical, aliases] of Object.entries(facesDict)) {
            for (const alias of aliases) {
                if (text.includes(`por ${alias}`) || text.includes(`cara ${alias}`) || text.includes(alias)) {
                    foundFace = canonical;
                    // Map to SVG class using quadrant-aware helpers
                    if (canonical === 'vestibular' && foundUnit) {
                        mappedFaceClass = getVestLingMapping(foundUnit).vestibularClass;
                    } else if (canonical === 'vestibular') {
                        mappedFaceClass = 'face-top'; // fallback
                    }
                    if (canonical === 'palatino' || canonical === 'lingual') {
                        if (foundUnit) {
                            mappedFaceClass = getVestLingMapping(foundUnit).linguoPalatClass;
                        } else {
                            mappedFaceClass = 'face-bottom'; // fallback
                        }
                    }
                    if (canonical === 'oclusal') mappedFaceClass = 'face-center';
                    if (canonical === 'mesial' && foundUnit) {
                        mappedFaceClass = getMesialDistalMapping(foundUnit).mesialClass;
                    }
                    if (canonical === 'distal' && foundUnit) {
                        mappedFaceClass = getMesialDistalMapping(foundUnit).distalClass;
                    }
                    break;
                }
            }
            if (foundFace && !foundFace.includes('giro')) break;
        }

        // Compound face for caries incipiente: "vestibular por mesial", "lingual por distal", etc.
        if (foundCondition && foundCondition.includes('incipiente') && foundUnit) {
            const compoundMatch = text.match(/(?:cara\s+)?(vestibular|palatino|palatina|lingual)\s+(?:por\s+)?(mesial|distal)/i);
            if (compoundMatch) {
                const primaryFace = compoundMatch[1].toLowerCase();
                const subPos = compoundMatch[2].toLowerCase();
                const mdMapping = getMesialDistalMapping(foundUnit);
                const vlMapping = getVestLingMapping(foundUnit);

                // Map primary face to top/bottom using quadrant
                let primaryClass;
                if (primaryFace === 'vestibular') {
                    primaryClass = vlMapping.vestibularClass;
                } else {
                    primaryClass = vlMapping.linguoPalatClass;
                }

                // Map mesial/distal to correct SVG side based on quadrant
                let subClass = (subPos === 'mesial') ? mdMapping.mesialSub : mdMapping.distalSub;

                mappedFaceClass = `${primaryClass}-${subClass}`;
                foundFace = `${primaryFace} por ${subPos}`;
            }
        }

        if (foundCondition && foundCondition.includes("giroversion") && foundFace) {
            mappedFaceClass = foundFace;
            foundCondition = "giroversion " + (foundFace === "giro-left" ? "izquierda" : "derecha");
        }

        // Auto-correct palatino/lingual based on tooth quadrant
        if (foundUnit && foundFace) {
            const quadrant = parseInt(foundUnit.toString()[0]);
            const isUpper = [1, 2, 5, 6].includes(quadrant);

            if (foundFace === 'palatino' && !isUpper) {
                foundFace = 'lingual';
            } else if (foundFace === 'lingual' && isUpper) {
                foundFace = 'palatino';
            }

            if (typeof foundFace === 'string' && foundFace.includes(' por ')) {
                if (foundFace.includes('palatino') && !isUpper) {
                    foundFace = foundFace.replace('palatino', 'lingual');
                } else if (foundFace.includes('lingual') && isUpper) {
                    foundFace = foundFace.replace('lingual', 'palatino');
                }
            }
        }

        if (foundCondition && foundUnit) {
            addFinding(foundUnit, foundCondition, foundFace, mappedFaceClass);
        }
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
            const crossColor = isBlueCross ? "var(--restoration)" : "var(--caries)"; // var(--restoration) = blue

            line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", "0");
            line.setAttribute("y1", "0");
            line.setAttribute("x2", "100");
            line.setAttribute("y2", "100");
            line.setAttribute("stroke", crossColor);
            line.setAttribute("stroke-width", "4");

            line2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line2.setAttribute("x1", "0");
            line2.setAttribute("y1", "100");
            line2.setAttribute("x2", "100");
            line2.setAttribute("y2", "0");
            line2.setAttribute("stroke", crossColor);
            line2.setAttribute("stroke-width", "4");

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

    btnDownloadPdf.addEventListener('click', async () => {
        const element = document.getElementById('pdf-export-area');

        // Options for html2pdf
        const pdfFilename = `Odontograma_${inputs.name.value.replace(/\s+/g, '_') || 'Paciente'}.pdf`;
        const opt = {
            margin: 10,
            filename: pdfFilename,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, windowWidth: 1024 },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };

        // 1. Generate and download PDF FIRST (using plain text data)
        btnDownloadPdf.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generando...';
        btnDownloadPdf.disabled = true;

        try {
            // Generate PDF as blob for sharing + also save it
            const pdfBlob = await html2pdf().set(opt).from(element).outputPdf('blob');

            // Download the PDF
            const url = URL.createObjectURL(pdfBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = pdfFilename;
            a.click();
            URL.revokeObjectURL(url);

            // Offer to share via native share (WhatsApp, Gmail, etc.)
            if (navigator.share && navigator.canShare) {
                const file = new File([pdfBlob], pdfFilename, { type: 'application/pdf' });
                if (navigator.canShare({ files: [file] })) {
                    try {
                        await navigator.share({
                            title: 'Odontograma - ' + (inputs.name.value || 'Paciente'),
                            text: 'Reporte de odontograma',
                            files: [file]
                        });
                    } catch (shareErr) {
                        // User cancelled share - that's fine
                        console.log('Share cancelled or failed:', shareErr);
                    }
                }
            }
        } catch (pdfErr) {
            console.error('Error generando PDF:', pdfErr);
            alert('Error al generar el PDF.');
        }

        btnDownloadPdf.innerHTML = '<i class="fa-solid fa-file-pdf"></i> Guardar PDF';
        btnDownloadPdf.disabled = false;

        // 2. THEN save encrypted data to Firestore in the background
        if (currentUser && inputs.name.value) {
            try {
                const uid = currentUser.uid;

                const encName = await encryptText(inputs.name.value, uid);
                const encPhone = await encryptText(inputs.phone.value || '', uid);
                const encPathologies = await encryptText(inputs.pathologies.value || '', uid);
                const encFindings = await encryptText(JSON.stringify(clinicalFindings), uid);

                const patientData = {
                    doctorId: uid,
                    doctorEmail: currentUser.email,
                    patientName: encName,
                    patientAge: inputs.age.value,
                    patientSex: inputs.sex.value,
                    patientPhone: encPhone,
                    pathologies: encPathologies,
                    findings: encFindings,
                    encrypted: true,
                    timestamp: serverTimestamp()
                };

                await addDoc(collection(db, "patients"), patientData);
                console.log("Paciente guardado en la nube (encriptado)");
            } catch (e) {
                console.error("Error al guardar paciente:", e);
            }
        }
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

});
