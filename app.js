document.addEventListener('DOMContentLoaded', () => {
    // UI Elements
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

    // --- 1. THEME TOGGLE ---
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
                    
                    <!-- Overlays: Caries incipiente dots -->
                    <circle cx="50" cy="27" r="4" class="tooth-overlay dot-face-top hidden" fill="#EF4444" />
                    <circle cx="50" cy="73" r="4" class="tooth-overlay dot-face-bottom hidden" fill="#EF4444" />
                    <circle cx="50" cy="50" r="4" class="tooth-overlay dot-face-center hidden" fill="#EF4444" />
                    <circle cx="27" cy="50" r="4" class="tooth-overlay dot-face-left hidden" fill="#EF4444" />
                    <circle cx="73" cy="50" r="4" class="tooth-overlay dot-face-right hidden" fill="#EF4444" />

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
    function initSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            alert('El reconocimiento de voz no es compatible con este navegador. Por favor usa Chrome en Android.');
            return null;
        }

        const rec = new SpeechRecognition();
        rec.lang = 'es-ES'; // Spanish
        rec.continuous = true; // Keep listening
        rec.interimResults = true; // Show live transcript

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
                showToast('Procesando: ' + finalTranscript);
                processTranscript(finalTranscript.toLowerCase());
            }
        };

        rec.onerror = (event) => {
            console.error('Speech recognition error', event.error);
            showToast('Error: ' + event.error);
            stopListening();
        };

        rec.onend = () => {
            if (isListening) {
                // Auto-restart if it stopped but shouldn't have
                rec.start();
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
        text = text.trim();
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

        // Special check for giroversion direction
        if (foundCondition && foundCondition.includes("giroversion")) {
            if (text.includes("izquierda")) foundFace = "giro-left";
            else if (text.includes("derecha")) foundFace = "giro-right";
        }

        for (const [canonical, aliases] of Object.entries(facesDict)) {
            for (const alias of aliases) {
                if (text.includes(`por ${alias}`) || text.includes(`cara ${alias}`) || text.includes(alias)) {
                    foundFace = canonical;
                    // Map to SVG class
                    if (canonical === 'vestibular') mappedFaceClass = 'face-top';
                    if (canonical === 'palatino' || canonical === 'lingual') mappedFaceClass = 'face-bottom';
                    if (canonical === 'oclusal') mappedFaceClass = 'face-center';
                    if (canonical === 'mesial') mappedFaceClass = 'face-left'; // Approximation
                    if (canonical === 'distal') mappedFaceClass = 'face-right'; // Approximation
                    break;
                }
            }
            if (foundFace && !foundFace.includes('giro')) break;
        }

        if (foundCondition && foundCondition.includes("giroversion") && foundFace) {
            mappedFaceClass = foundFace;
            foundCondition = "giroversion " + (foundFace === "giro-left" ? "izquierda" : "derecha");
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
            if (face) {
                if (face === 'vestibular') mappedFaceClass = 'face-top';
                if (face === 'palatino') mappedFaceClass = 'face-bottom';
                if (face === 'oclusal') mappedFaceClass = 'face-center';
                if (face === 'mesial') mappedFaceClass = 'face-left';
                if (face === 'distal') mappedFaceClass = 'face-right';
            }

            addFinding(unit, condition, face, mappedFaceClass);

            // Clear manual form
            document.getElementById('manual-unit').value = '';
            document.getElementById('manual-condition').value = '';
            document.getElementById('manual-face').value = '';
        });
    }

    function addFinding(unit, condition, face, mappedFaceClass) {
        const findingId = `finding-${Date.now()}`;

        // Remove empty state
        const emptyState = findingsList.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        // Capitalize condition
        const condCapital = condition.charAt(0).toUpperCase() + condition.slice(1);

        // Add to array
        clinicalFindings.push({ id: findingId, unit, condition, face, mappedFaceClass });

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
                // If no face specified, dot in center
                const dot = toothUnit.querySelector(`.dot-face-center`);
                if (dot) dot.classList.remove('hidden');
            }
            return;
        }

        // 3. Other solid fills/strokes
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

    btnDownloadPdf.addEventListener('click', () => {
        const element = document.getElementById('pdf-export-area');

        // Options for html2pdf
        const opt = {
            margin: 10,
            filename: `Odontograma_${inputs.name.value.replace(/\s+/g, '_') || 'Paciente'}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };

        // Temporarily adjust styles for PDF
        btnDownloadPdf.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generando...';
        btnDownloadPdf.disabled = true;

        html2pdf().set(opt).from(element).save().then(() => {
            btnDownloadPdf.innerHTML = '<i class="fa-solid fa-file-pdf"></i> Guardar PDF';
            btnDownloadPdf.disabled = false;
        });
    });

});
