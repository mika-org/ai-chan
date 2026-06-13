// ==========================================================================
// Ai-Chan Web Client Application Logic
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
    // Auto-redirect from 127.0.0.1 to localhost for secure context (enabling SpeechRecognition & getUserMedia)
    if (window.location.hostname === '127.0.0.1') {
        window.location.hostname = 'localhost';
        return;
    }

    
    // ==========================================================================
    // Neural Network Visualizer
    // ==========================================================================
    class NeuralNetworkVisualizer {
        constructor(canvasId) {
            this.canvas = document.getElementById(canvasId);
            if (!this.canvas) return;
            this.ctx = this.canvas.getContext('2d');
            this.particles = [];
            this.numParticles = 40;
            this.maxDistance = 80;
            this.baseSpeed = 0.5;
            this.speedMultiplier = 1.0;
            
            this.resize();
            window.addEventListener('resize', () => this.resize());
            
            for (let i = 0; i < this.numParticles; i++) {
                this.particles.push({
                    x: Math.random() * this.canvas.width,
                    y: Math.random() * this.canvas.height,
                    vx: (Math.random() - 0.5) * this.baseSpeed,
                    vy: (Math.random() - 0.5) * this.baseSpeed,
                    radius: Math.random() * 2 + 1
                });
            }
            
            this.animate = this.animate.bind(this);
            requestAnimationFrame(this.animate);
        }

        resize() {
            const rect = this.canvas.parentElement.getBoundingClientRect();
            this.canvas.width = rect.width;
            this.canvas.height = rect.height;
        }

        setMode(mode) {
            if (mode === 'thinking' || mode === 'talking') {
                this.speedMultiplier = 3.0;
                this.maxDistance = 120;
            } else {
                this.speedMultiplier = 1.0;
                this.maxDistance = 80;
            }
        }

        animate() {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            
            for (let i = 0; i < this.numParticles; i++) {
                let p = this.particles[i];
                p.x += p.vx * this.speedMultiplier;
                p.y += p.vy * this.speedMultiplier;
                
                if (p.x < 0 || p.x > this.canvas.width) p.vx *= -1;
                if (p.y < 0 || p.y > this.canvas.height) p.vy *= -1;
                
                this.ctx.beginPath();
                this.ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                this.ctx.fillStyle = 'rgba(0, 200, 255, 0.6)';
                this.ctx.fill();
                
                for (let j = i + 1; j < this.numParticles; j++) {
                    let p2 = this.particles[j];
                    let dx = p.x - p2.x;
                    let dy = p.y - p2.y;
                    let dist = Math.sqrt(dx*dx + dy*dy);
                    
                    if (dist < this.maxDistance) {
                        this.ctx.beginPath();
                        this.ctx.moveTo(p.x, p.y);
                        this.ctx.lineTo(p2.x, p2.y);
                        this.ctx.strokeStyle = `rgba(0, 200, 255, ${1 - dist/this.maxDistance})`;
                        this.ctx.lineWidth = 1;
                        this.ctx.stroke();
                    }
                }
            }
            requestAnimationFrame(this.animate);
        }
    }

    // ==========================================================================
    // TTS Queue
    // ==========================================================================
    class TTSQueue {
        constructor() {
            this.queue = [];
            this.isPlaying = false;
        }

        async enqueue(text, appState) {
            if (!text.trim()) return;
            const cleaned = text.replace(/\*([^\*]+)\*/g, '').replace(/\(([^)]+)\)/g, '').trim();
            if (!cleaned) return;

            try {
                let payload = { text: cleaned, voice: appState.voice, engine: appState.voiceEngine, character: appState.character };
                if (appState.voiceEngine === 'sbv2') {
                    payload.sbv2_model = appState.sbv2SelectedModel;
                    payload.sbv2_speaker = appState.sbv2SelectedSpeaker;
                    payload.sbv2_style = appState.sbv2SelectedStyle;
                    payload.sdp_ratio = appState.sbv2SdpRatio;
                    payload.noise = appState.sbv2Noise;
                    payload.noisew = appState.sbv2NoiseW;
                    payload.length = parseFloat((1.0 / appState.speed).toFixed(2));
                }

                const res = await fetch(`${API_BASE}/api/tts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (res.ok) {
                    const data = await res.json();
                    this.queue.push(data.audio_url);
                    this.playNext();
                }
            } catch (e) {
                console.error("TTS enqueue error", e);
            }
        }

        playNext() {
            if (this.isPlaying || this.queue.length === 0) return;
            this.isPlaying = true;
            
            const url = this.queue.shift();
            companionAudio.src = url;
            setAvatarState('talking');
            audioStatus.textContent = 'Playing voice...';
            
            companionAudio.onended = () => {
                this.isPlaying = false;
                if (this.queue.length === 0) {
                    setAvatarState('idle');
                    audioStatus.textContent = 'Idle';
                } else {
                    this.playNext();
                }
            };
            
            companionAudio.play().catch(e => {
                console.error("Audio playback error", e);
                this.isPlaying = false;
                this.playNext();
            });
        }
        
        clear() {
            this.queue = [];
            this.isPlaying = false;
        }
    }
    const ttsQueue = new TTSQueue();
    let visualizer = null;

    // Dynamic Base API URL to allow opening page via file://, other ports, or dev servers
    const API_BASE = (window.location.protocol === 'file:' || window.location.port !== '8000')
        ? 'http://127.0.0.1:8000'
        : '';

    // Application State
    const state = {
        character: 'ai_chan',
        language: 'ja',
        voice: 'en-US-AriaNeural',
        autoplay: true,
        autoTranslate: false,
        webSearch: true,
        speed: 1.0,
        messages: [],
        lastResponseText: '',
        lastVoiceUrl: '',
        llmOnline: false,
        recognition: null,
        isListening: false,
        voiceEngine: 'sbv2', // 'edge-tts' or 'sbv2'
        sbv2Online: false,
        sbv2ModelsInfo: {}, // Store models info dict
        sbv2SelectedModel: '',
        sbv2SelectedSpeaker: '',
        sbv2SelectedStyle: '',
        sbv2SdpRatio: 0.2,
        sbv2Noise: 0.6,
        sbv2NoiseW: 0.8,
        maxTokens: 4096,   // Max response length tokens
        pendingAttachments: [],  // Array of {type, mime, data, name} objects
        sessionId: localStorage.getItem('ai_chan_session_id') || (() => {
            const id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            localStorage.setItem('ai_chan_session_id', id);
            return id;
        })()
    };

    // Character Profiles
    const characters = {
        ai_chan: {
            name: 'Ai-Chan',
            jpName: '愛ちゃん',
            tagline: '"All systems nominal. Ready for your query, Sir."',
            avatar: 'assets/ai_chan.png',
            defaultVoice: {
                ja: 'ja-JP-NanamiNeural',
                en: 'en-US-EmmaNeural'
            },
            targetModel: 'sao10k/Fimbulvetr-11B-v2-GGUF'
        },
        kaguya: {
            name: 'Kaguya',
            jpName: 'かぐや',
            tagline: '"Hmph, you need my help again? Fine, I suppose..."',
            avatar: 'assets/kaguya.png',
            defaultVoice: {
                ja: 'ja-JP-NanamiNeural',
                en: 'en-US-EmmaNeural'
            },
            targetModel: 'sao10k/Fimbulvetr-11B-v2-GGUF'
        },
        mochi: {
            name: 'Mochi',
            jpName: 'もち',
            tagline: '"Poyu! Mochi wants to eat sweets with you!"',
            avatar: 'assets/mochi.png',
            defaultVoice: {
                ja: 'ja-JP-NanamiNeural',
                en: 'en-US-AnaNeural'
            },
            targetModel: 'sao10k/Fimbulvetr-11B-v2-GGUF'
        }
    };

    // Edge TTS Voice Mapping based on language selection
    const voicesByLanguage = {
        ja: [
            { id: 'ja-JP-NanamiNeural', name: 'Ai-Chan & Kaguya / Nanami (Female - 女性)' },
            { id: 'ja-JP-KeitaNeural', name: 'Keita (Friendly Male - 男性)' }
        ],
        en: [
            { id: 'en-US-AnaNeural', name: 'Mochi / Ana (Cute Chibi/Child Female)' },
            { id: 'en-US-EmmaNeural', name: 'Kaguya / Emma (Warm/Elegant Female)' },
            { id: 'en-US-AriaNeural', name: 'Ai-Chan / Aria (Expressive Female)' },
            { id: 'en-US-JennyNeural', name: 'Jenny (Default Modern Female)' },
            { id: 'en-US-GuyNeural', name: 'Guy (Natural Male)' }
        ]
    };

    // DOM Elements
    const chatHistory = document.getElementById('chat-history');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const voiceInputBtn = document.getElementById('voice-input-btn');
    const clearChatBtn = document.getElementById('clear-chat');

    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const statusDetails = document.getElementById('status-details');
    const refreshStatusBtn = document.getElementById('refresh-status');
    const statusExtraInfo = document.getElementById('status-extra-info');
    const infoLatency = document.getElementById('info-latency');
    const infoModel = document.getElementById('info-model');

    const characterOptions = document.querySelectorAll('.character-option');
    const languageSelect = document.getElementById('language-select');
    const voiceSelect = document.getElementById('voice-select');
    const autoplayVoiceCheckbox = document.getElementById('autoplay-voice');
    const autotranslateToggle = document.getElementById('autotranslate-toggle');
    const webSearchToggle = document.getElementById('websearch-toggle');
    const targetModelSelect = document.getElementById('target-model-select');
    const voiceSpeedSlider = document.getElementById('voice-speed');
    const speedValDisplay = document.getElementById('speed-val');

    const headerAvatar = document.getElementById('header-avatar');
    const headerName = document.getElementById('header-name');
    const headerStatus = document.getElementById('header-status');

    const mainAvatar = document.getElementById('main-avatar');
    const avatarGlow = document.getElementById('avatar-glow');
    const avatarWrapper = document.querySelector('.avatar-wrapper');
    const displayName = document.getElementById('display-name');
    const displayJp = document.getElementById('display-jp');
    const displayTagline = document.getElementById('display-tagline');

    const speechWave = document.getElementById('speech-wave');
    const audioStatus = document.getElementById('audio-status');
    const companionAudio = document.getElementById('companion-audio');
    const replayVoiceBtn = document.getElementById('replay-voice');
    const stopVoiceBtn = document.getElementById('stop-voice');
    const typingIndicator = document.getElementById('typing-indicator');
    const typingText = document.getElementById('typing-text');

    // File Attachment Elements
    const attachFileBtn = document.getElementById('attach-file-btn');
    const fileUploadInput = document.getElementById('file-upload');
    const attachmentPreviewContainer = document.getElementById('attachment-preview-container');

    // Voice Engine and Local VITS2 Settings DOM Elements
    const engineTabs = document.querySelectorAll('.engine-tab');
    const edgeTtsSettings = document.getElementById('edge-tts-settings');
    const sbv2Settings = document.getElementById('sbv2-settings');
    const sbv2ModelSelect = document.getElementById('sbv2-model-select');
    const sbv2SpeakerSelect = document.getElementById('sbv2-speaker-select');
    const sbv2StyleSelect = document.getElementById('sbv2-style-select');
    const sbv2SdpRatioSlider = document.getElementById('sbv2-sdp-ratio');
    const sbv2SdpVal = document.getElementById('sbv2-sdp-val');
    const sbv2NoiseSlider = document.getElementById('sbv2-noise');
    const sbv2NoiseVal = document.getElementById('sbv2-noise-val');
    const sbv2NoiseWSlider = document.getElementById('sbv2-noisew');
    const sbv2NoiseWVal = document.getElementById('sbv2-noisew-val');
    const sbv2OfflineBanner = document.getElementById('sbv2-offline-banner');

    // Model target indicators
    const infoTargetModel = document.getElementById('info-target-model');
    const footerModelInfo = document.getElementById('footer-model-info');
    const guidelineTargetModel = document.getElementById('guideline-target-model');

    // ==========================================================================
    // Initialization & Setup
    // ==========================================================================

    function init() {
        visualizer = new NeuralNetworkVisualizer("neural-canvas");
        // 1. Check Offline AI server status
        checkServerStatus();

        // 2. Populate voices dropdown based on active language
        populateVoices();

        // 3. Set up event listeners
        setupEventListeners();

        // 4. Initialize web speech recognition (Speech-to-text)
        setupSpeechRecognition();

        // 5. System boot sequence message
        addSystemMessage("<i class='fa-solid fa-microchip'></i> <strong>[ AI-CHAN CORE BOOT SEQUENCE ]</strong> &mdash; Establishing neural link to <strong>http://127.0.0.1:1234</strong> &amp; voice synthesis at <strong>http://127.0.0.1:7860</strong>. Select target model and initialize communication.");

        // 6. Load saved character memory dynamically from server
        loadCharacterMemory(state.character);

        // 7. Initialize Google Search toggle checked state
        if (webSearchToggle) {
            webSearchToggle.checked = state.webSearch;
        }

        // 8. Initialize Target Model dropdown select value
        if (targetModelSelect && characters[state.character]) {
            targetModelSelect.value = characters[state.character].targetModel;
        }
    }

    // Load character chat history from SQLite
    async function loadCharacterMemory(charId) {
        const indicator = document.getElementById('memory-indicator');
        const countEl = document.getElementById('memory-count');
        try {
            const res = await fetch(`${API_BASE}/api/chat_history/${charId}/${state.sessionId}?limit=200`);
            if (!res.ok) throw new Error('Failed to load chat history from SQLite');
            const data = await res.json();

            // Rebuild state.messages using the stored content (which may have SYSTEM CONTEXT injected)
            state.messages = (data.messages || []).map(m => ({ role: m.role, content: m.content }));

            // Clear and rebuild DOM chat view
            chatHistory.innerHTML = '';
            const welcomeDiv = document.createElement('div');
            welcomeDiv.className = 'message system-message';
            welcomeDiv.innerHTML = `
                <div class="message-content">
                    <i class="fa-solid fa-microchip"></i> <strong>SYSTEM CORE INITIALIZING...</strong> ESTABLISH NEURAL LINK AT <strong>http://127.0.0.1:1234</strong> to ACTIVATE FULL PROTOCOLS.
                </div>
            `;
            chatHistory.appendChild(welcomeDiv);

            if (data.messages && data.messages.length > 0) {
                data.messages.forEach(m => {
                    // Use display_text (the clean version without SYSTEM CONTEXT prefix)
                    const displayContent = m.display_text || m.content;
                    addMessageBubble(m.role === 'user' ? 'user' : 'companion', displayContent, characters[charId].targetModel);
                });
                if (indicator && countEl) {
                    indicator.style.display = 'inline-flex';
                    countEl.textContent = data.messages.length;
                }
                addSystemMessage(`Restored <strong>${data.messages.length}</strong> messages from SQLite memory for <strong>${characters[charId].name}</strong>.`);
            } else {
                if (indicator) indicator.style.display = 'none';
            }

            scrollToBottom();
        } catch (err) {
            console.error('Error loading chat history:', err);
            if (indicator) indicator.style.display = 'none';
        }
    }

    // Save a single chat message to SQLite (fire-and-forget)
    function saveChatMessage(role, content, displayText) {
        fetch(`${API_BASE}/api/chat_history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: state.sessionId,
                character: state.character,
                role,
                content,          // full content (may include SYSTEM CONTEXT prefix)
                display_text: displayText || content  // clean version shown in UI
            })
        }).catch(e => console.warn('SQLite save failed:', e.message));
    }

    // Legacy: keep saveCharacterMemory for JSON-file-based memory summary (no-op for chat; SQLite handles it)
    async function saveCharacterMemory(charId, messages) {
        if (!messages || messages.length === 0) return;
        try {
            await fetch(`${API_BASE}/api/memory/${charId}/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_history: messages })
            });
        } catch (err) {
            console.error('Error saving character memory:', err);
        }
    }

    // Populate voices select element based on selected language
    function populateVoices() {
        const lang = state.language;
        const availableVoices = voicesByLanguage[lang] || [];

        voiceSelect.innerHTML = '';
        availableVoices.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.textContent = v.name;
            voiceSelect.appendChild(opt);
        });

        // Set default voice for active character in selected language
        const charDefault = characters[state.character].defaultVoice[lang];
        if (charDefault) {
            state.voice = charDefault;
            voiceSelect.value = charDefault;
        } else {
            state.voice = voiceSelect.value;
        }
    }

    // Set companion character profile
    async function selectCompanion(charId) {
        if (!characters[charId] || state.character === charId) return;

        const prevChar = state.character;
        // Save current character's memory before switching
        if (state.messages && state.messages.length > 0) {
            await saveCharacterMemory(prevChar, state.messages);
        }

        state.character = charId;
        const char = characters[charId];

        // Update character sidebar visual active state
        characterOptions.forEach(opt => {
            if (opt.dataset.character === charId) {
                opt.classList.add('active');
            } else {
                opt.classList.remove('active');
            }
        });

        // Update main showcase card
        mainAvatar.src = char.avatar;
        headerAvatar.src = char.avatar;
        headerName.textContent = char.name;
        displayName.innerHTML = `${char.name} <span id="display-jp" class="jp-accent">${char.jpName}</span>`;
        displayTagline.textContent = char.tagline;

        // Update target model UI elements immediately
        const targetModel = char.targetModel || 'sao10k/Fimbulvetr-11B-v2-GGUF';
        if (infoTargetModel) infoTargetModel.textContent = targetModel;
        if (guidelineTargetModel) guidelineTargetModel.textContent = targetModel;
        if (footerModelInfo) footerModelInfo.textContent = `Target Model: ${targetModel}`;

        // Update target model select option in dropdown
        if (targetModelSelect) {
            targetModelSelect.value = targetModel;
        }

        // Repopulate voice choice to match standard
        populateVoices();

        // Stop current audio if playing
        stopVoicePlayback();

        // Load the new companion's memory
        await loadCharacterMemory(charId);

        // Immediately run status verification to check if the target model matches
        checkServerStatus();
    }

    // Check server statuses (both LLM and Style-Bert-VITS2)
    async function checkServerStatus() {
        statusDot.className = 'dot offline';
        statusText.textContent = 'Checking Status...';
        statusDetails.textContent = 'Connecting to http://127.0.0.1:8000...';
        statusExtraInfo.style.display = 'none';

        const startTime = performance.now();
        const activeChar = characters[state.character];
        const targetModel = activeChar.targetModel || 'sao10k/Fimbulvetr-11B-v2-GGUF';

        // Update target model UI elements immediately
        if (infoTargetModel) infoTargetModel.textContent = targetModel;
        if (guidelineTargetModel) guidelineTargetModel.textContent = targetModel;
        if (footerModelInfo) footerModelInfo.textContent = `Target Model: ${targetModel}`;

        try {
            const res = await fetch(`${API_BASE}/api/status`);
            if (!res.ok) throw new Error("API status check failed");
            const data = await res.json();

            const latency = Math.round(performance.now() - startTime);
            infoLatency.textContent = `${latency}ms`;

            // 1. Handle LLM Server Status
            const llm = data.llm || { online: false, model: null, loaded_models: [] };
            if (llm.online) {
                state.llmOnline = true;

                // Compare model loaded vs companion target model
                const isTargetLoaded = llm.loaded_models.includes(targetModel) || llm.model === targetModel;

                if (!llm.model) {
                    // Online but NO model loaded!
                    statusDot.className = 'dot warning';
                    statusText.textContent = 'Connected (No Model)';
                    statusDetails.textContent = 'LM Studio has no loaded model!';
                    infoModel.textContent = 'None - Load model first!';
                    infoModel.className = 'info-val-highlight';
                    infoModel.style.color = 'var(--color-warning)';
                    headerStatus.innerHTML = `<span class="pulse-icon" style="background-color: var(--color-warning); box-shadow: 0 0 6px var(--color-warning)"></span>Server Idle (No Model)`;
                    headerStatus.style.color = 'var(--color-warning)';
                } else if (isTargetLoaded) {
                    // Model loaded and MATCHES target!
                    statusDot.className = 'dot online';
                    statusText.textContent = 'Connected (Ready)';
                    statusDetails.textContent = 'LM Studio is ready and running the target model!';
                    infoModel.textContent = llm.model;
                    infoModel.className = 'info-val-highlight';
                    infoModel.style.color = 'var(--color-secondary)';
                    headerStatus.innerHTML = `<span class="pulse-icon"></span>Online & Ready to Talk`;
                    headerStatus.style.color = 'var(--color-success)';
                } else {
                    // Connected but model MISMATCH!
                    statusDot.className = 'dot warning';
                    statusText.textContent = 'Connected (Mismatch)';
                    statusDetails.textContent = `Running '${llm.model}' instead of '${targetModel}'`;
                    infoModel.textContent = llm.model;
                    infoModel.className = 'info-val-highlight';
                    infoModel.style.color = 'var(--color-warning)';
                    headerStatus.innerHTML = `<span class="pulse-icon" style="background-color: var(--color-warning); box-shadow: 0 0 6px var(--color-warning)"></span>Model Mismatch Warning`;
                    headerStatus.style.color = 'var(--color-warning)';
                }

                statusExtraInfo.style.display = 'block';
            } else {
                state.llmOnline = false;
                statusDot.className = 'dot offline';
                statusText.textContent = 'Offline (Server Inactive)';
                statusDetails.textContent = 'Start LM Studio on http://127.0.0.1:1234';
                statusExtraInfo.style.display = 'none';
                headerStatus.innerHTML = `<span class="pulse-icon" style="background-color: var(--color-danger); box-shadow: 0 0 6px var(--color-danger)"></span>Offline Fallback Active`;
                headerStatus.style.color = 'var(--color-danger)';
            }

            // 2. Handle Style-Bert-VITS2 Status
            const sbv2 = data.sbv2 || { online: false, models_info: {} };
            if (sbv2.online) {
                state.sbv2Online = true;
                state.sbv2ModelsInfo = sbv2.models_info;
                sbv2OfflineBanner.style.display = 'none';

                // Enable SBV2 engine tab visually
                const sbv2Tab = document.querySelector('.engine-tab[data-engine="sbv2"]');
                if (sbv2Tab) {
                    sbv2Tab.removeAttribute('disabled');
                    sbv2Tab.style.opacity = '1';
                    sbv2Tab.style.pointerEvents = 'auto';
                }

                // Populate dropdowns
                populateSbv2Models(sbv2.models_info);
            } else {
                state.sbv2Online = false;
                state.sbv2ModelsInfo = {};

                // Disable SBV2 engine tab visually
                const sbv2Tab = document.querySelector('.engine-tab[data-engine="sbv2"]');
                if (sbv2Tab) {
                    sbv2Tab.style.opacity = '0.5';
                }

                // If currently using sbv2 and it went offline, trigger immediate fallback
                if (state.voiceEngine === 'sbv2') {
                    sbv2OfflineBanner.style.display = 'block';
                    switchVoiceEngine('edge-tts');
                    addSystemMessage("<span style='color: var(--color-danger);'><i class='fa-solid fa-triangle-exclamation'></i> Style-Bert-VITS2 went offline! Automatic fallback to Edge-TTS cloud voice activated.</span>");
                }
            }
        } catch (err) {
            console.error("Error checking server status:", err);
            state.llmOnline = false;
            statusDot.className = 'dot offline';
            statusText.textContent = 'Offline Connection Error';
            statusDetails.textContent = 'FastAPI server connection failed.';
            statusExtraInfo.style.display = 'none';
            headerStatus.innerHTML = `<span class="pulse-icon" style="background-color: var(--color-danger); box-shadow: 0 0 6px var(--color-danger)"></span>Offline Fallback Active`;
            headerStatus.style.color = 'var(--color-danger)';
        }
    }

    // Voice Engine Toggling Panel Display Helper
    function switchVoiceEngine(engine) {
        state.voiceEngine = engine;

        // Update active class on tabs
        engineTabs.forEach(tab => {
            if (tab.dataset.engine === engine) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });

        // Show/hide settings groups
        if (engine === 'sbv2') {
            edgeTtsSettings.style.display = 'none';
            sbv2Settings.style.display = 'block';

            // Check if VITS2 is actually online
            if (!state.sbv2Online) {
                sbv2OfflineBanner.style.display = 'block';
            } else {
                sbv2OfflineBanner.style.display = 'none';
            }

            addSystemMessage("Voice synthesis engine switched to <strong>Style-Bert-VITS2 (Local Offline)</strong>");
        } else {
            edgeTtsSettings.style.display = 'block';
            sbv2Settings.style.display = 'none';
            sbv2OfflineBanner.style.display = 'none';
            addSystemMessage("Voice synthesis engine switched to <strong>Edge-TTS (Cloud)</strong>");
        }
    }

    // Dynamic Select Populate Helpers for Style-Bert-VITS2
    function populateSbv2Models(modelsInfo) {
        if (!modelsInfo || Object.keys(modelsInfo).length === 0) {
            sbv2ModelSelect.innerHTML = '<option value="">No models available</option>';
            sbv2SpeakerSelect.innerHTML = '<option value="">No speakers available</option>';
            sbv2StyleSelect.innerHTML = '<option value="">No styles available</option>';
            return;
        }

        const previousModel = state.sbv2SelectedModel;
        sbv2ModelSelect.innerHTML = '';

        const keys = Object.keys(modelsInfo);
        keys.forEach(key => {
            const item = modelsInfo[key];
            const name = item.model_name || key;
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = name;
            sbv2ModelSelect.appendChild(opt);
        });

        // Set selected model
        if (previousModel && modelsInfo[previousModel]) {
            sbv2ModelSelect.value = previousModel;
            state.sbv2SelectedModel = previousModel;
        } else {
            state.sbv2SelectedModel = keys[0];
            sbv2ModelSelect.value = keys[0];
        }

        populateSbv2Speakers(state.sbv2SelectedModel, modelsInfo);
    }

    function populateSbv2Speakers(modelKey, modelsInfo) {
        const modelData = modelsInfo[modelKey];
        if (!modelData || !modelData.spk2id) {
            sbv2SpeakerSelect.innerHTML = '<option value="">No speakers available</option>';
            sbv2StyleSelect.innerHTML = '<option value="">No styles available</option>';
            return;
        }

        const previousSpeaker = state.sbv2SelectedSpeaker;
        sbv2SpeakerSelect.innerHTML = '';

        const speakers = Object.keys(modelData.spk2id);
        speakers.forEach(spk => {
            const opt = document.createElement('option');
            opt.value = spk;
            opt.textContent = spk;
            sbv2SpeakerSelect.appendChild(opt);
        });

        if (previousSpeaker && modelData.spk2id[previousSpeaker] !== undefined) {
            sbv2SpeakerSelect.value = previousSpeaker;
            state.sbv2SelectedSpeaker = previousSpeaker;
        } else {
            state.sbv2SelectedSpeaker = speakers[0];
            sbv2SpeakerSelect.value = speakers[0];
        }

        populateSbv2Styles(modelKey, modelsInfo);
    }

    function populateSbv2Styles(modelKey, modelsInfo) {
        const modelData = modelsInfo[modelKey];
        if (!modelData) {
            sbv2StyleSelect.innerHTML = '<option value="">No styles available</option>';
            return;
        }

        // Support both style2id or styles array if returned differently
        let styles = [];
        if (modelData.style2id) {
            styles = Object.keys(modelData.style2id);
        } else if (modelData.styles) {
            styles = modelData.styles;
        }

        const previousStyle = state.sbv2SelectedStyle;
        sbv2StyleSelect.innerHTML = '';

        // Add a default/Neutral style if styles list is empty
        if (styles.length === 0) {
            styles = ['Neutral'];
        }

        styles.forEach(style => {
            const opt = document.createElement('option');
            opt.value = style;
            opt.textContent = style;
            sbv2StyleSelect.appendChild(opt);
        });

        if (previousStyle && styles.includes(previousStyle)) {
            sbv2StyleSelect.value = previousStyle;
            state.sbv2SelectedStyle = previousStyle;
        } else {
            // Default to "Neutral" if available, else first style
            if (styles.includes('Neutral')) {
                state.sbv2SelectedStyle = 'Neutral';
                sbv2StyleSelect.value = 'Neutral';
            } else {
                state.sbv2SelectedStyle = styles[0];
                sbv2StyleSelect.value = styles[0];
            }
        }
    }

    // ==========================================================================
    // Speech Recognition (Speech-to-Text)
    // ==========================================================================

    function setupSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.warn("Speech Recognition not supported in this browser.");
            voiceInputBtn.style.display = 'none';
            return;
        }

        let networkRetryCount = 0;

        state.recognition = new SpeechRecognition();
        state.recognition.continuous = false;
        state.recognition.interimResults = false;

        // Set listening language matching selection
        state.recognition.lang = state.language === 'ja' ? 'ja-JP' : 'en-US';

        state.recognition.onstart = () => {
            state.isListening = true;
            networkRetryCount = 0; // Reset retry counter on successful start
            voiceInputBtn.classList.add('listening');
            voiceInputBtn.querySelector('i').className = 'fa-solid fa-microphone-lines';
            chatInput.placeholder = "Listening... Speak now, Senpai!";
        };

        state.recognition.onend = () => {
            state.isListening = false;
            voiceInputBtn.classList.remove('listening');
            voiceInputBtn.querySelector('i').className = 'fa-solid fa-microphone';
            chatInput.placeholder = "Type your message here, Senpai...";
        };

        state.recognition.onerror = (e) => {
            console.error("Speech recognition error:", e);
            state.isListening = false;
            voiceInputBtn.classList.remove('listening');
            voiceInputBtn.querySelector('i').className = 'fa-solid fa-microphone';
            chatInput.placeholder = "Type your message here, Senpai...";

            let errMsg = "";
            if (e.error === 'not-allowed') {
                errMsg = "Microphone permission was denied, Senpai! Please click the microphone lock icon in your browser URL bar and grant microphone access to this page.";
            } else if (e.error === 'no-speech') {
                errMsg = "I couldn't hear anything, Senpai! Please speak clearly into your microphone.";
            } else if (e.error === 'network') {
                // Auto-retry up to 2 times for temporary network sockets
                if (networkRetryCount < 2) {
                    networkRetryCount++;
                    console.log(`Speech recognition network failure. Auto-retrying attempt ${networkRetryCount} in 800ms...`);
                    setTimeout(() => {
                        try {
                            if (!state.isListening) {
                                state.recognition.start();
                            }
                        } catch (retryErr) {
                            console.error("Failed to auto-restart speech recognition:", retryErr);
                        }
                    }, 800);
                    return; // Silent bypass for the initial retries
                }

                errMsg = "A speech recognition network error occurred, Senpai!<br><br>" +
                    "<strong>Common Solutions:</strong><br>" +
                    "1. 🌐 <strong>Internet Connection Needed</strong>: Chrome/Edge's built-in voice transcription sends audio to Google/Microsoft servers. Make sure your internet is working.<br>" +
                    "2. 🔗 <strong>Use Localhost</strong>: Try opening the app at <strong><a href='http://localhost:8000' style='color: var(--color-accent); font-weight: bold; text-decoration: underline;'>http://localhost:8000</a></strong> instead of 127.0.0.1. Browsers isolate microphone socket connections on numeric IP addresses.<br>" +
                    "3. 🎙️ <strong>Windows Privacy Settings</strong>: Go to <em>Windows Settings > Privacy > Microphone</em> and ensure <em>'Allow desktop apps to access your microphone'</em> is turned ON.";
                networkRetryCount = 0; // Reset counter after ultimate failure
            } else if (e.error === 'audio-capture') {
                errMsg = "No microphone was found or audio capture failed, Senpai. Make sure your microphone is plugged in and active.";
            } else if (e.error !== 'aborted') {
                errMsg = `Speech recognition error occurred (${e.error}). Please try again.`;
            }

            if (errMsg) {
                addSystemMessage(`<span style="color: var(--color-danger); line-height: 1.5;"><i class="fa-solid fa-microphone-slash"></i> ${errMsg}</span>`);
            }
        };

        state.recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            chatInput.value = transcript;
            // Auto resize text area
            adjustTextareaHeight(chatInput);

            // Auto send after speaking
            sendMessage();
        };

        // Notify user about local file scheme microphone restriction
        if (window.location.protocol === 'file:') {
            console.warn("Speech Recognition will not work on file:// protocol due to browser security restrictions.");
            setTimeout(() => {
                addSystemMessage(`<span style="color: var(--color-warning);"><i class="fa-solid fa-triangle-exclamation"></i> <strong>Senpai, you opened the app via a local file (file://)!</strong> Browser security restricts microphone access for local files. Please open <strong>http://localhost:8000</strong> in your browser to use voice input features!</span>`);
            }, 1000);
        }
    }

    async function toggleListening() {
        if (!state.recognition) return;

        if (state.isListening) {
            try {
                state.recognition.stop();
            } catch (err) {
                console.error("Error stopping recognition:", err);
            }
        } else {
            // Check microphone permission status if supported
            let needsPrompt = true;
            try {
                if (navigator.permissions && navigator.permissions.query) {
                    const result = await navigator.permissions.query({ name: 'microphone' });
                    if (result.state === 'granted') {
                        needsPrompt = false;
                    }
                }
            } catch (pErr) {
                console.warn("Permissions API check failed:", pErr);
            }

            // Only request/verify media stream if permission is not already granted
            if (needsPrompt) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    // Release the stream immediately so SpeechRecognition can take over the microphone exclusively
                    stream.getTracks().forEach(track => track.stop());
                    // Wait a tiny bit (200ms) for the hardware to fully release
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (mediaErr) {
                    console.error("Microphone hardware access error:", mediaErr);
                    addSystemMessage("<span style='color: var(--color-danger);'><i class='fa-solid fa-microphone-slash'></i> <strong>Microphone Access Failed!</strong> Senpai, I couldn't access your microphone. Please make sure your hardware is plugged in and active, and that you have granted microphone access to this page in browser settings!</span>");
                    return;
                }
            }

            // Update speech recognition language just in case it changed
            state.recognition.lang = state.language === 'ja' ? 'ja-JP' : 'en-US';
            try {
                state.recognition.start();
            } catch (err) {
                console.error("Error starting recognition:", err);
            }
        }
    }

    // ==========================================================================
    // Audio / Voice Synthesis (Text-to-Speech)
    // ==========================================================================

    async function speakText(text) {
        if (!text) return;

        // Update visual state to talking (spinning halo, wave bar dancing)
        setAvatarState('talking');
        audioStatus.textContent = 'Synthesizing voice...';

        try {
            let payload = {
                text: text,
                voice: state.voice,
                engine: state.voiceEngine,
                character: state.character
            };

            if (state.voiceEngine === 'sbv2') {
                // Map speed parameter to speed inverse length for VITS2
                const vitsLength = parseFloat((1.0 / state.speed).toFixed(2));

                payload.sbv2_model = state.sbv2SelectedModel;
                payload.sbv2_speaker = state.sbv2SelectedSpeaker;
                payload.sbv2_style = state.sbv2SelectedStyle;
                payload.sdp_ratio = state.sbv2SdpRatio;
                payload.noise = state.sbv2Noise;
                payload.noisew = state.sbv2NoiseW;
                payload.length = vitsLength;
            }

            const res = await fetch(`${API_BASE}/api/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) throw new Error("TTS endpoint failed");

            const data = await res.json();
            const audioUrl = data.audio_url;

            state.lastVoiceUrl = audioUrl;
            playAudio(audioUrl);
        } catch (err) {
            console.error("Error synthesizing speech:", err);
            audioStatus.textContent = 'Voice Synthesis Failed';
            setAvatarState('idle');

            // Give specific feedback on SBV2 failure
            if (state.voiceEngine === 'sbv2') {
                addSystemMessage("<span style='color: var(--color-danger);'><i class='fa-solid fa-circle-exclamation'></i> Local voice synthesis failed. Check if Style-Bert-VITS2 has loaded the active model, or switch to Edge-TTS (Cloud).</span>");
            }
        }
    }

    function playAudio(url) {
        // Resolve URL with API_BASE if it is a relative path starting with /
        const resolvedUrl = url.startsWith('/') ? `${API_BASE}${url}` : url;
        companionAudio.src = resolvedUrl;
        companionAudio.playbackRate = state.speed; // set playback rate (speed)

        companionAudio.play()
            .then(() => {
                audioStatus.textContent = 'Speaking...';
                setAvatarState('talking');

                // Enable audio buttons
                stopVoiceBtn.disabled = false;
                replayVoiceBtn.disabled = false;
            })
            .catch(err => {
                console.error("Audio playback error:", err);
                audioStatus.textContent = 'Audio Playback Blocked';
                setAvatarState('idle');
            });
    }

    function stopVoicePlayback() {
        if (!companionAudio.paused) {
            companionAudio.pause();
            companionAudio.currentTime = 0;
            audioStatus.textContent = 'Stopped';
            setAvatarState('idle');
            stopVoiceBtn.disabled = true;
        }
    }

    function replayVoice() {
        if (state.lastVoiceUrl) {
            playAudio(state.lastVoiceUrl);
        }
    }

    // Sync HTML5 audio events with UI
    companionAudio.onended = () => {
        audioStatus.textContent = 'Idle';
        setAvatarState('idle');
        stopVoiceBtn.disabled = true;
    };

    companionAudio.onerror = () => {
        audioStatus.textContent = 'Playback error';
        setAvatarState('idle');
        stopVoiceBtn.disabled = true;
    };

    // Update avatar styles depending on current action
    function setAvatarState(mode) {
        // Reset classes
        mainAvatar.className = '';
        avatarGlow.className = 'avatar-glow-ring';
        avatarWrapper.className = 'avatar-wrapper';
        speechWave.classList.remove('active');

        if (mode === 'idle') {
            mainAvatar.classList.add('idle');
            avatarGlow.classList.add('idle');
        } else if (mode === 'thinking') {
            mainAvatar.classList.add('thinking');
            avatarGlow.classList.add('thinking');
            avatarWrapper.classList.add('thinking');
        } else if (mode === 'talking') {
            mainAvatar.classList.add('talking');
            avatarGlow.classList.add('talking');
            avatarWrapper.classList.add('talking');
            speechWave.classList.add('active');
        }
    }

    // ==========================================================================
    // File Attachment Handling
    // ==========================================================================

    function handleFileSelection(files) {
        if (!files || files.length === 0) return;

        for (const file of files) {
            const reader = new FileReader();
            const isImage = file.type.startsWith('image/');

            reader.onload = (e) => {
                const base64Data = e.target.result; // data:mime;base64,...
                const attachment = {
                    type: isImage ? 'image' : 'document',
                    mime: file.type || 'application/octet-stream',
                    data: base64Data,
                    name: file.name
                };
                state.pendingAttachments.push(attachment);
                renderAttachmentPreviews();
            };

            reader.onerror = () => {
                console.error(`Error reading file: ${file.name}`);
                addSystemMessage(`<span style="color: var(--color-danger);"><i class="fa-solid fa-triangle-exclamation"></i> Failed to read file: ${file.name}</span>`);
            };

            reader.readAsDataURL(file);
        }
    }

    function renderAttachmentPreviews() {
        if (!attachmentPreviewContainer) return;

        if (state.pendingAttachments.length === 0) {
            attachmentPreviewContainer.style.display = 'none';
            attachmentPreviewContainer.innerHTML = '';
            return;
        }

        attachmentPreviewContainer.style.display = 'flex';
        attachmentPreviewContainer.innerHTML = '';

        state.pendingAttachments.forEach((att, index) => {
            const item = document.createElement('div');
            item.className = 'attachment-item';

            if (att.type === 'image') {
                const img = document.createElement('img');
                img.src = att.data;
                img.alt = att.name;
                item.appendChild(img);
            } else {
                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-file-lines doc-icon';
                item.appendChild(icon);
                const nameEl = document.createElement('span');
                nameEl.className = 'doc-name';
                nameEl.textContent = att.name;
                nameEl.title = att.name;
                item.appendChild(nameEl);
            }

            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            removeBtn.title = 'Remove';
            removeBtn.addEventListener('click', () => {
                state.pendingAttachments.splice(index, 1);
                renderAttachmentPreviews();
            });
            item.appendChild(removeBtn);

            attachmentPreviewContainer.appendChild(item);
        });
    }

    function clearAttachments() {
        state.pendingAttachments = [];
        renderAttachmentPreviews();
        if (fileUploadInput) fileUploadInput.value = '';
    }

    // ==========================================================================
    // Chat & Messaging Operations
    // ==========================================================================

    // Perform Deep Search using Server-Sent Events from backend
    async function performDeepSearch(query, displayText) {
        // Clear input box
        chatInput.value = '';
        adjustTextareaHeight(chatInput);
        stopVoicePlayback();

        // 1. Add user message
        addMessageBubble('user', displayText || `/research ${query}`);
        const userMsg = { role: 'user', content: `/research ${query}` };
        state.messages.push(userMsg);
        saveChatMessage('user', userMsg.content, displayText || `/research ${query}`);

        setAvatarState('thinking');
        showTypingIndicator(true);

        try {
            const res = await fetch(`${API_BASE}/api/research/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: query,
                    llm_base_url: "http://127.0.0.1:1234",
                    model: characters[state.character].targetModel
                })
            });

            if (!res.ok) throw new Error("Research API failed");

            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let finalReport = "";
            let companionBubbleCreated = false;
            let bubbleTextElement = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data: ")) continue;
                    
                    const dataStr = trimmed.slice(6).trim();
                    if (dataStr === "[DONE]") break;

                    try {
                        const parsed = JSON.parse(dataStr);
                        if (parsed.step) {
                            addSystemMessage(parsed.step);
                            scrollToBottom();
                        } else if (parsed.report) {
                            finalReport = parsed.report;
                            if (!companionBubbleCreated) {
                                showTypingIndicator(false);
                                setAvatarState('talking');
                                const bubbleElement = document.createElement('div');
                                bubbleElement.className = 'message companion';
                                bubbleElement.innerHTML = `
                                    <img class="message-avatar" src="${characters[state.character].avatar}" alt="companion">
                                    <div class="message-bubble">
                                        <div class="bubble-text"></div>
                                    </div>
                                `;
                                chatHistory.appendChild(bubbleElement);
                                bubbleTextElement = bubbleElement.querySelector('.bubble-text');
                                companionBubbleCreated = true;
                            }
                            bubbleTextElement.innerHTML = formatSpeechEmotes(finalReport);
                            scrollToBottom();
                        }
                    } catch(e) { console.error("Parse error:", e); }
                }
            }

            if (finalReport) {
                state.messages.push({ role: 'assistant', content: finalReport });
                saveChatMessage('assistant', finalReport, finalReport);
            }
            setAvatarState('idle');

        } catch(err) {
            console.error("Deep search error:", err);
            addSystemMessage("❌ Deep Search failed: " + err.message);
            showTypingIndicator(false);
            setAvatarState('idle');
        }
    }

    // Handle sending message
    async function sendMessage(text = chatInput.value.trim()) {
        const hasAttachments = state.pendingAttachments.length > 0;
        if (!text && !hasAttachments) return;

        // Snapshot and clear attachments before async work
        const attachmentsToSend = [...state.pendingAttachments];
        clearAttachments();

        // Clear input box
        chatInput.value = '';
        adjustTextareaHeight(chatInput);

        // Stop audio if playing
        stopVoicePlayback();

        // Build display text for the user bubble
        let displayText = text;
        if (attachmentsToSend.length > 0) {
            const fileNames = attachmentsToSend.map(a => a.name).join(', ');
            displayText = text ? `${text}\n📎 ${fileNames}` : `📎 ${fileNames}`;
        }

        // --- Deep Search Check ---
        const researchMatch = text.match(/^\s*(?:\/research|deep search)\s+(.+)$/i);
        if (researchMatch) {
            const query = researchMatch[1].trim();
            await performDeepSearch(query, text);
            return;
        }

        // --- Auto-inject geolocation, weather, and DB context (SQLite-backed memory) ---
        let finalText = text;
        const locationKeywords = /\b(where am i|my location|current location|my position|locate me|where i am|nearby|near me|directions to|around me|my area|what city|what country|my address|my coordinates)\b/i;
        const weatherKeywords = /\b(weather|temperature|temp|forecast|rain|raining|sunny|cloudy|humidity|wind|hot|cold|how (hot|cold|warm)|climate|storm|snow|snowing|celsius|fahrenheit)\b/i;
        const dbKeywords = /\b(note|notes|memo|memos|task|tasks|todo|calendar|event|events|schedule|agenda|remind)\b/i;

        const needsLocation = locationKeywords.test(text);
        const needsWeather  = weatherKeywords.test(text);
        const needsDb       = dbKeywords.test(text);

        const contextParts = [];

        if (needsLocation || needsWeather || needsDb) {
            // Helper: check if a cached SQLite row is still fresh (within maxAgeMs)
            const isFresh = (row, maxAgeMs) => {
                if (!row || !row.updated_at) return false;
                const age = Date.now() - new Date(row.updated_at + ' UTC').getTime();
                return age < maxAgeMs;
            };

            try {
                // ── 1. LOCATION (cache TTL: 1 hour) ──────────────────────────────────
                let locationStr = null;
                let lat = null, lon = null;

                const cachedLoc = await fetch(`${API_BASE}/api/context/user_location`)
                    .then(r => r.ok ? r.json() : null).catch(() => null);

                if (isFresh(cachedLoc, 60 * 60 * 1000)) {
                    // Use memory — no GPS needed
                    const saved = JSON.parse(cachedLoc.value);
                    locationStr = saved.address;
                    lat = saved.lat;
                    lon = saved.lon;
                    console.log('[Context] Using cached location:', locationStr);
                } else if (navigator.geolocation) {
                    // Fetch fresh from browser GPS
                    try {
                        const coords = await new Promise((res, rej) =>
                            navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 })
                        );
                        lat = coords.coords.latitude;
                        lon = coords.coords.longitude;
                        locationStr = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

                        // Reverse geocode
                        try {
                            const geoRes = await fetch(
                                `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
                                { headers: { 'User-Agent': 'AiChan-OS/1.0' } }
                            );
                            const geoData = await geoRes.json();
                            if (geoData.display_name) locationStr = geoData.display_name;
                        } catch (_) {}

                        // Persist to SQLite memory
                        fetch(`${API_BASE}/api/context/user_location`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ value: JSON.stringify({ address: locationStr, lat, lon }) })
                        }).catch(() => {});
                    } catch (geoErr) {
                        console.warn('[Context] Geolocation unavailable:', geoErr.message);
                    }
                }

                if (locationStr) {
                    contextParts.push(`User's current location: ${locationStr}${lat ? ` (lat: ${lat.toFixed(5)}, lon: ${lon.toFixed(5)})` : ''}`);
                }

                // ── 2. WEATHER (cache TTL: 30 minutes) ───────────────────────────────
                if (needsWeather && lat !== null && lon !== null) {
                    let weatherStr = null;

                    const cachedWx = await fetch(`${API_BASE}/api/context/user_weather`)
                        .then(r => r.ok ? r.json() : null).catch(() => null);

                    if (isFresh(cachedWx, 30 * 60 * 1000)) {
                        weatherStr = JSON.parse(cachedWx.value).summary;
                        console.log('[Context] Using cached weather:', weatherStr);
                    } else {
                        // Fetch fresh from Open-Meteo (free, no API key)
                        try {
                            const wxRes = await fetch(
                                `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
                                `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m` +
                                `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=1`
                            );
                            const wxData = await wxRes.json();
                            const c = wxData.current;
                            const d = wxData.daily;

                            const weatherCodeMap = {
                                0:'Clear sky', 1:'Mainly clear', 2:'Partly cloudy', 3:'Overcast',
                                45:'Fog', 48:'Icy fog', 51:'Light drizzle', 53:'Moderate drizzle', 55:'Dense drizzle',
                                61:'Slight rain', 63:'Moderate rain', 65:'Heavy rain',
                                71:'Slight snow', 73:'Moderate snow', 75:'Heavy snow',
                                80:'Slight showers', 81:'Moderate showers', 82:'Violent showers',
                                95:'Thunderstorm', 96:'Thunderstorm with hail', 99:'Thunderstorm with heavy hail'
                            };
                            const condition = weatherCodeMap[c.weather_code] || `Code ${c.weather_code}`;
                            const tempC = c.temperature_2m;
                            const tempF = ((tempC * 9/5) + 32).toFixed(1);
                            const feelsC = c.apparent_temperature;
                            const feelsF = ((feelsC * 9/5) + 32).toFixed(1);

                            weatherStr =
                                `${condition}, ${tempC}°C / ${tempF}°F (feels like ${feelsC}°C / ${feelsF}°F), ` +
                                `Humidity: ${c.relative_humidity_2m}%, Wind: ${c.wind_speed_10m} km/h, ` +
                                `Precipitation: ${c.precipitation} mm. ` +
                                `Today's high: ${d.temperature_2m_max[0]}°C, low: ${d.temperature_2m_min[0]}°C.`;

                            // Persist to SQLite memory
                            fetch(`${API_BASE}/api/context/user_weather`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ value: JSON.stringify({ summary: weatherStr, lat, lon }) })
                            }).catch(() => {});
                        } catch (wxErr) {
                            console.warn('[Context] Weather fetch failed:', wxErr.message);
                        }
                    }

                    if (weatherStr) contextParts.push(`Current weather: ${weatherStr}`);
                }

                // ── 3. DATABASE KNOWLEDGE ───────────────────────────────
                if (needsDb) {
                    const [notesRes, tasksRes, calRes] = await Promise.all([
                        fetch(`${API_BASE}/api/notes`).then(r => r.ok ? r.json() : {notes: []}),
                        fetch(`${API_BASE}/api/tasks`).then(r => r.ok ? r.json() : {tasks: []}),
                        fetch(`${API_BASE}/api/calendar`).then(r => r.ok ? r.json() : {events: []})
                    ]);
                    
                    if (notesRes.notes && notesRes.notes.length > 0) {
                        const notesStr = notesRes.notes.map(n => `[ID:${n.id}] ${n.title} (Content: ${n.content})`).join(' | ');
                        contextParts.push(`Saved Notes: ${notesStr}`);
                    } else {
                        contextParts.push(`Saved Notes: None`);
                    }

                    if (tasksRes.tasks && tasksRes.tasks.length > 0) {
                        const tasksStr = tasksRes.tasks.map(t => `[ID:${t.id}][${t.status}] ${t.content}`).join(' | ');
                        contextParts.push(`Current Tasks: ${tasksStr}`);
                    } else {
                        contextParts.push(`Current Tasks: None`);
                    }

                    if (calRes.events && calRes.events.length > 0) {
                        const eventsStr = calRes.events.map(e => `[ID:${e.id}] ${e.title} (${e.start_time} to ${e.end_time})`).join(' | ');
                        contextParts.push(`Calendar Events: ${eventsStr}`);
                    } else {
                        contextParts.push(`Calendar Events: None`);
                    }
                }

            } catch (ctxErr) {
                console.warn('[Context] Context inject error:', ctxErr.message);
            }

            if (contextParts.length > 0) {
                finalText = `[SYSTEM CONTEXT: ${contextParts.join(' || ')}]\n\n${text}`;
            }
        }

        // 1. Add user message to UI and history state
        addMessageBubble('user', displayText);
        const messageObj = { role: 'user', content: finalText || '(see attached files)' };
        if (attachmentsToSend.length > 0) {
            messageObj.attachments = attachmentsToSend;
        }
        state.messages.push(messageObj);
        saveChatMessage('user', messageObj.content, displayText);

        // Sync memory indicator count in header dynamically
        const indicator = document.getElementById('memory-indicator');
        const countEl = document.getElementById('memory-count');
        if (indicator && countEl) {
            indicator.style.display = 'inline-flex';
            countEl.textContent = state.messages.length;
        }

        // 2. Set Avatar to thinking (blue aura, pulsing)
        setAvatarState('thinking');
        showTypingIndicator(true);


        try {
            // 3. Query local AI streaming endpoint
            const res = await fetch(`${API_BASE}/api/chat/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: state.messages,
                    character: state.character,
                    language: state.language,
                    temperature: 0.7,
                    max_tokens: state.maxTokens,
                    search: state.webSearch
                })
            });

            if (!res.ok) throw new Error("Server returned API error");

            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let companionBubbleCreated = false;
            let bubbleTextElement = null;
            let bubbleElement = null;
            let fullText = "";
            let modelUsed = "Unknown Model";
            let simulated = false;

            let currentSentenceBuffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n\n');
                // Keep the last partial line in the buffer
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    if (!trimmed.startsWith("data: ")) continue;

                    const dataStr = trimmed.slice(6).trim();
                    if (dataStr === "[DONE]") {
                        break;
                    }

                    try {
                        const parsed = JSON.parse(dataStr);
                        if (parsed.error) {
                            throw new Error(parsed.error);
                        }

                        // Check if it's the metadata chunk
                        if (parsed.model_used !== undefined) {
                            modelUsed = parsed.model_used;
                            simulated = !!parsed.simulated;
                            if (parsed.searched_query) {
                                // Store maps embed URL for after stream
                                window._pendingMapsEmbed = {
                                    url: parsed.maps_embed_url || null,
                                    searchUrl: parsed.maps_search_url || null,
                                    query: parsed.searched_query
                                };
                                addSystemMessage(`<i class="fa-solid fa-map-location-dot" style="color: #4ade80;"></i> Searched for: <strong>"${parsed.searched_query}"</strong>`);
                            } else {
                                window._pendingMapsEmbed = null;
                            }
                            continue;
                        }

                        // Otherwise it's a standard token chunk
                        const content = parsed.choices?.[0]?.delta?.content || "";
                        if (content) {
                            if (!companionBubbleCreated) {
                                // First token arrived: hide typing indicator and transition avatar
                                showTypingIndicator(false);
                                setAvatarState('talking');

                                // Create the message bubble container
                                bubbleElement = document.createElement('div');
                                bubbleElement.className = 'message companion';
                                const avatarUrl = characters[state.character].avatar;

                                bubbleElement.innerHTML = `
                                    <img class="message-avatar" src="${avatarUrl}" alt="companion">
                                    <div class="message-bubble">
                                        <div class="bubble-text"></div>
                                    </div>
                                `;
                                chatHistory.appendChild(bubbleElement);
                                bubbleTextElement = bubbleElement.querySelector('.bubble-text');
                                companionBubbleCreated = true;
                            }

                            fullText += content;
                            currentSentenceBuffer += content;
                            
                            // Detect sentence boundary
                            if (/[.!?。！？\n]/.test(content)) {
                                if (state.autoplay && currentSentenceBuffer.trim()) {
                                    ttsQueue.enqueue(currentSentenceBuffer, state);
                                }
                                currentSentenceBuffer = '';
                            }

                            bubbleTextElement.innerHTML = formatSpeechEmotes(fullText);
                            scrollToBottom();
                        }
                    } catch (e) {
                        console.error("Error parsing stream chunk:", e);
                    }
                }
            }

            // Once the stream completes, add actions to the bubble and finalize
            if (companionBubbleCreated && bubbleElement) {
                if (currentSentenceBuffer.trim() && state.autoplay) {
                    ttsQueue.enqueue(currentSentenceBuffer, state);
                }
                currentSentenceBuffer = '';
                state.lastResponseText = fullText;

                // Add to model context
                state.messages.push({ role: 'assistant', content: fullText });
                saveChatMessage('assistant', fullText, fullText);

                // Sync memory indicator count in header dynamically
                if (indicator && countEl) {
                    indicator.style.display = 'inline-flex';
                    countEl.textContent = state.messages.length;
                }

                const badgeClass = getModelBadgeClass(modelUsed);
                const badgeText = modelUsed;
                const badgeHTML = modelUsed ? `<span class="action-badge model-badge ${badgeClass}" title="Generating Model"><i class="fa-solid fa-cube"></i> ${badgeText}</span>` : '';

                const actionsHTML = `
                    <div class="bubble-actions">
                        ${badgeHTML}
                        <span class="action-badge audio-play-btn" data-text="${encodeURIComponent(fullText)}" title="Listen to voice">
                            <i class="fa-solid fa-volume-high"></i> Speak
                        </span>
                        <span class="action-badge translate-btn" data-lang="en" title="Translate to English">
                            <i class="fa-solid fa-language"></i> EN
                        </span>
                        <span class="action-badge translate-btn" data-lang="id" title="Translate to Indonesian">
                            <i class="fa-solid fa-language"></i> ID
                        </span>
                    </div>
                    <div class="translation-container" style="display: none;">
                        <div class="translation-header">
                            <span class="translation-label"><i class="fa-solid fa-globe"></i> Translation</span>
                            <span class="translation-close"><i class="fa-solid fa-xmark"></i></span>
                        </div>
                        <div class="translation-text"></div>
                    </div>
                `;

                const messageBubble = bubbleElement.querySelector('.message-bubble');
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = actionsHTML;
                while (tempDiv.firstChild) {
                    messageBubble.appendChild(tempDiv.firstChild);
                }

                // Wire up actions for the stream-created bubble
                setupBubbleActions(bubbleElement, fullText);

                // 5a. Inject Google Maps panel if location search was done
                if (window._pendingMapsEmbed && window._pendingMapsEmbed.url) {
                    const mapsPanel = createMapsEmbedPanel(
                        window._pendingMapsEmbed.url,
                        window._pendingMapsEmbed.searchUrl,
                        window._pendingMapsEmbed.query
                    );
                    chatHistory.appendChild(mapsPanel);
                    window._pendingMapsEmbed = null;
                    scrollToBottom();
                }

                // 5b. Queue empty fallback
                if (!state.autoplay || ttsQueue.queue.length === 0 && !ttsQueue.isPlaying) {
                    setAvatarState('idle');
                }
            } else {
                // If stream completed but no content was received
                showTypingIndicator(false);
                setAvatarState('idle');
            }
        } catch (err) {
            console.error("Error sending chat:", err);
            showTypingIndicator(false);
            addMessageBubble('companion', "Whoops! Senpai, something went wrong when speaking to my neural core! Please verify your settings and make sure LM Studio is running.", "error");
            setAvatarState('idle');
        }
    }

    function getModelBadgeClass(modelName) {
        if (!modelName) return '';
        const lower = modelName.toLowerCase();
        if (lower.includes('gemma')) return 'gemma';
        if (lower.includes('mistral')) return 'mistral';
        if (lower.includes('fallback')) return 'fallback';
        if (lower.includes('error')) return 'error';
        return 'fallback';
    }

    // Render message bubbles in the chat frame
    function addMessageBubble(sender, text, modelUsed) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${sender}`;

        // Retrieve character avatar or default user icon
        const avatarUrl = sender === 'user' ? 'https://api.dicebear.com/7.x/pixel-art/svg?seed=senpai' : characters[state.character].avatar;

        // Parse brackets *giggles* or (blushes) stage actions and style them beautifully
        const parsedContent = formatSpeechEmotes(text);

        let actionsHTML = '';
        if (sender === 'companion') {
            const badgeClass = getModelBadgeClass(modelUsed);
            const badgeText = modelUsed || 'Unknown Model';
            const badgeHTML = modelUsed ? `<span class="action-badge model-badge ${badgeClass}" title="Generating Model"><i class="fa-solid fa-cube"></i> ${badgeText}</span>` : '';

            actionsHTML = `
                <div class="bubble-actions">
                    ${badgeHTML}
                    <span class="action-badge audio-play-btn" data-text="${encodeURIComponent(text)}" title="Listen to voice">
                        <i class="fa-solid fa-volume-high"></i> Speak
                    </span>
                    <span class="action-badge translate-btn" data-lang="en" title="Translate to English">
                        <i class="fa-solid fa-language"></i> EN
                    </span>
                    <span class="action-badge translate-btn" data-lang="id" title="Translate to Indonesian">
                        <i class="fa-solid fa-language"></i> ID
                    </span>
                </div>
                <div class="translation-container" style="display: none;">
                    <div class="translation-header">
                        <span class="translation-label"><i class="fa-solid fa-globe"></i> Translation</span>
                        <span class="translation-close"><i class="fa-solid fa-xmark"></i></span>
                    </div>
                    <div class="translation-text"></div>
                </div>
            `;
        }

        msgDiv.innerHTML = `
            <img class="message-avatar" src="${avatarUrl}" alt="${sender}">
            <div class="message-bubble">
                <div class="bubble-text">${parsedContent}</div>
                ${actionsHTML}
            </div>
        `;

        chatHistory.appendChild(msgDiv);
        scrollToBottom();

        // Wire up action listeners
        if (sender === 'companion') {
            setupBubbleActions(msgDiv, text);
        }
    }

    function setupBubbleActions(msgDiv, text) {
        const playBtn = msgDiv.querySelector('.audio-play-btn');
        if (!playBtn) return;

        playBtn.addEventListener('click', () => {
            stopVoicePlayback();
            speakText(decodeURIComponent(playBtn.dataset.text));
        });

        const translateBtns = msgDiv.querySelectorAll('.translate-btn');
        const transContainer = msgDiv.querySelector('.translation-container');
        const transText = msgDiv.querySelector('.translation-text');
        const transClose = msgDiv.querySelector('.translation-close');

        transContainer.dataset.translations = JSON.stringify({});

        translateBtns.forEach(btn => {
            btn.addEventListener('click', async () => {
                const targetLang = btn.dataset.lang;
                const cached = JSON.parse(transContainer.dataset.translations);

                if (cached[targetLang]) {
                    if (transContainer.style.display === 'block' && transContainer.dataset.activeLang === targetLang) {
                        transContainer.style.display = 'none';
                    } else {
                        transText.innerHTML = formatSpeechEmotes(cached[targetLang]);
                        transContainer.style.display = 'block';
                        transContainer.dataset.activeLang = targetLang;
                        scrollToBottom();
                    }
                    return;
                }

                // Show loader icon
                btn.classList.add('loading');
                const originalText = text;

                const langNames = {
                    en: 'English', id: 'Indonesian', ja: 'Japanese',
                    zh: 'Chinese (Simplified)', ko: 'Korean', fr: 'French', de: 'German', es: 'Spanish'
                };
                const targetLangName = langNames[targetLang] || targetLang.toUpperCase();

                let translated = '';
                let engine = '';

                try {
                    // === Primary: Puter.js (free GPT-4o, unlimited, runs in browser) ===
                    if (typeof puter !== 'undefined' && puter.ai) {
                        const puterResp = await puter.ai.chat([
                            { role: 'system', content: `You are a professional translator. Output ONLY the translated text — no explanations, no notes, no quotes. Just the clean ${targetLangName} translation.` },
                            { role: 'user', content: `Translate this to ${targetLangName}:\n${originalText}` }
                        ], { model: 'gpt-4o-mini' });
                        translated = (typeof puterResp === 'string' ? puterResp : puterResp?.message?.content || puterResp?.content || '').trim();
                        engine = 'GPT-4o';
                    }

                    // === Fallback: Backend /api/translate (local LLM or MyMemory) ===
                    if (!translated) {
                        const res = await fetch(`${API_BASE}/api/translate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ text: originalText, target_lang: targetLang, source_lang: state.language })
                        });
                        if (!res.ok) throw new Error('Translation request failed');
                        const data = await res.json();
                        translated = data.translated_text || '';
                        engine = 'Local LLM';
                    }

                    if (!translated) throw new Error('Empty translation result');

                    cached[targetLang] = translated;
                    transContainer.dataset.translations = JSON.stringify(cached);

                    transText.innerHTML = `${formatSpeechEmotes(translated)}<span style="display:block;margin-top:6px;font-size:0.7em;opacity:0.45;"><i class="fa-solid fa-wand-magic-sparkles"></i> Translated by ${engine}</span>`;
                    transContainer.style.display = 'block';
                    transContainer.dataset.activeLang = targetLang;
                    scrollToBottom();
                } catch (err) {
                    console.error('Translation error:', err);
                    transText.innerHTML = `<span style="color: var(--color-danger);"><i class="fa-solid fa-triangle-exclamation"></i> Translation failed. Please try again, Senpai.</span>`;
                    transContainer.style.display = 'block';
                } finally {
                    btn.classList.remove('loading');
                }
            });
        });

        transClose.addEventListener('click', () => {
            transContainer.style.display = 'none';
        });

        // Auto-translate to English if companion language is not English and autoTranslate is enabled
        if (state.autoTranslate && state.language !== 'en' && text && text.trim().length > 2) {
            const enBtn = Array.from(translateBtns).find(btn => btn.dataset.lang === 'en');
            if (enBtn) {
                enBtn.click();
            }
        }
    }

    function addSystemMessage(text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message system-message';
        msgDiv.innerHTML = `
            <div class="message-content">
                <i class="fa-solid fa-info-circle"></i> ${text}
            </div>
        `;
        chatHistory.appendChild(msgDiv);
        scrollToBottom();
    }

    // Replaces asterisks like *giggles* or *smiles* with custom styled nodes
    function formatSpeechEmotes(text) {
        // Replace *action* with stylized italicized pink node
        let formatted = text.replace(/\*([^*]+)\*/g, '<em class="stage-action">* $1 *</em>');

        // Replace (action) with similar styled nodes
        formatted = formatted.replace(/\(([^)]+)\)/g, '<em class="stage-action">($1)</em>');

        // Replace line breaks with HTML tags
        return formatted.replace(/\n/g, '<br>');
    }

    function showTypingIndicator(show) {
        if (show) {
            typingText.textContent = `${characters[state.character].name} is processing...`;
            typingIndicator.style.display = 'flex';
            scrollToBottom();
        } else {
            typingIndicator.style.display = 'none';
        }
    }

    function scrollToBottom() {
        setTimeout(() => {
            chatHistory.scrollTop = chatHistory.scrollHeight;
        }, 50);
    }

    function adjustTextareaHeight(el) {
        el.style.height = '24px';
        el.style.height = (el.scrollHeight - 4) + 'px';
    }

    async function clearChat() {
        chatHistory.innerHTML = '';
        state.messages = [];
        state.lastResponseText = '';
        state.lastVoiceUrl = '';
        stopVoicePlayback();
        if (replayVoiceBtn) replayVoiceBtn.disabled = true;

        // Hide and reset memory indicator count
        const indicator = document.getElementById('memory-indicator');
        const countEl = document.getElementById('memory-count');
        if (indicator) indicator.style.display = 'none';
        if (countEl) countEl.textContent = '0';

        try {
            await fetch(`${API_BASE}/api/memory/${state.character}`, {
                method: 'DELETE'
            });
        } catch (err) {
            console.error("Error clearing backend chat memory:", err);
        }

        addSystemMessage("Chat memory has been cleared. Senpai, what shall we speak about now?");
    }

    // Central helper to switch companion dialogue language formats (JP/EN)
    function changeLanguage(lang) {
        if (state.language === lang) return;
        state.language = lang;

        // 1. Sync dropdown selection in sidebar
        if (languageSelect) languageSelect.value = lang;

        // 2. Sync active visual states on header quick buttons
        const jaBtn = document.getElementById('lang-btn-ja');
        const enBtn = document.getElementById('lang-btn-en');
        if (lang === 'ja') {
            if (jaBtn) jaBtn.classList.add('active');
            if (enBtn) enBtn.classList.remove('active');
        } else {
            if (enBtn) enBtn.classList.add('active');
            if (jaBtn) jaBtn.classList.remove('active');
        }

        // 3. Output cyber alert system prompt notification
        addSystemMessage(`Language format set to: <strong>${lang === 'ja' ? 'Japanese (日本語)' : 'English (English)'}</strong>`);

        // 4. Re-populate matching voice profiles
        populateVoices();

        // 5. Reset listening web speech transcription socket locale
        if (state.recognition) {
            state.recognition.lang = lang === 'ja' ? 'ja-JP' : 'en-US';
        }
    }

    // ==========================================================================
    // Event Listeners Bindings
    // ==========================================================================

    function setupEventListeners() {
        // Header Language Buttons
        const jaBtn = document.getElementById('lang-btn-ja');
        const enBtn = document.getElementById('lang-btn-en');
        if (jaBtn) {
            jaBtn.addEventListener('click', () => changeLanguage('ja'));
        }
        if (enBtn) {
            enBtn.addEventListener('click', () => changeLanguage('en'));
        }

        // Text Input Key Listener
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        chatInput.addEventListener('input', () => {
            adjustTextareaHeight(chatInput);
        });

        // Send Button Click
        sendBtn.addEventListener('click', sendMessage);

        // Voice Input Click
        voiceInputBtn.addEventListener('click', toggleListening);

        // Clear Chat Click
        clearChatBtn.addEventListener('click', clearChat);

        // Refresh Status click
        refreshStatusBtn.addEventListener('click', () => {
            checkServerStatus();
            addSystemMessage("Re-checking offline LLM server status...");
        });

        // Companion Sidebar Toggle Click
        characterOptions.forEach(opt => {
            opt.addEventListener('click', () => {
                selectCompanion(opt.dataset.character);
            });
        });

        // Language Select Trigger
        languageSelect.addEventListener('change', (e) => {
            changeLanguage(e.target.value);
        });

        // Voice model select Trigger
        voiceSelect.addEventListener('change', (e) => {
            state.voice = e.target.value;
            addSystemMessage(`Voice model updated to: <strong>${state.voice}</strong>`);
        });

        // Autoplay toggle
        autoplayVoiceCheckbox.addEventListener('change', (e) => {
            state.autoplay = e.target.checked;
        });

        // Auto-translate toggle
        if (autotranslateToggle) {
            autotranslateToggle.addEventListener('change', (e) => {
                state.autoTranslate = e.target.checked;
            });
        }

        // Web Search toggle
        if (webSearchToggle) {
            webSearchToggle.addEventListener('change', (e) => {
                state.webSearch = e.target.checked;
                if (state.webSearch) {
                    addSystemMessage("Google Search integration enabled.");
                } else {
                    addSystemMessage("Google Search integration disabled.");
                }
            });
        }

        // Voice Speed slider trigger
        voiceSpeedSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value).toFixed(2);
            state.speed = parseFloat(val);
            speedValDisplay.textContent = `${val}x`;

            // Set running rate if playing
            companionAudio.playbackRate = state.speed;
        });

        // Max Tokens slider trigger
        const maxTokensSlider = document.getElementById('max-tokens-slider');
        const maxTokensVal = document.getElementById('max-tokens-val');
        if (maxTokensSlider) {
            maxTokensSlider.addEventListener('input', (e) => {
                state.maxTokens = parseInt(e.target.value);
                maxTokensVal.textContent = `${state.maxTokens} tokens`;
            });
        }

        // Target Model dropdown select trigger
        if (targetModelSelect) {
            targetModelSelect.addEventListener('change', (e) => {
                const newModel = e.target.value;
                characters[state.character].targetModel = newModel;

                // Update target model UI elements immediately
                if (infoTargetModel) infoTargetModel.textContent = newModel;
                if (guidelineTargetModel) guidelineTargetModel.textContent = newModel;
                if (footerModelInfo) footerModelInfo.textContent = `Target Model: ${newModel}`;

                addSystemMessage(`Target Model for ${characters[state.character].name} updated to: <strong>${newModel}</strong>`);

                // Re-run status check to see if it matches LM Studio
                checkServerStatus();
            });
        }
        // Right panel audio buttons
        replayVoiceBtn.addEventListener('click', replayVoice);
        stopVoiceBtn.addEventListener('click', stopVoicePlayback);

        // Voice Engine Tabs Trigger
        engineTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const engine = tab.dataset.engine;
                if (engine === 'sbv2' && !state.sbv2Online) {
                    addSystemMessage("<span style='color: var(--color-danger);'><i class='fa-solid fa-triangle-exclamation'></i> Style-Bert-VITS2 is offline! Please start the SBV2 server on port 7860 first.</span>");
                }
                switchVoiceEngine(engine);
            });
        });

        // Style-Bert-VITS2 dropdown selects
        sbv2ModelSelect.addEventListener('change', (e) => {
            state.sbv2SelectedModel = e.target.value;
            populateSbv2Speakers(state.sbv2SelectedModel, state.sbv2ModelsInfo);
            addSystemMessage(`VITS2 Model changed to: <strong>${state.sbv2SelectedModel}</strong>`);
        });

        sbv2SpeakerSelect.addEventListener('change', (e) => {
            state.sbv2SelectedSpeaker = e.target.value;
            populateSbv2Styles(state.sbv2SelectedModel, state.sbv2ModelsInfo);
            addSystemMessage(`VITS2 Speaker changed to: <strong>${state.sbv2SelectedSpeaker}</strong>`);
        });

        sbv2StyleSelect.addEventListener('change', (e) => {
            state.sbv2SelectedStyle = e.target.value;
            addSystemMessage(`VITS2 Style changed to: <strong>${state.sbv2SelectedStyle}</strong>`);
        });

        // Style-Bert-VITS2 sliders
        sbv2SdpRatioSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value).toFixed(2);
            state.sbv2SdpRatio = parseFloat(val);
            sbv2SdpVal.textContent = val;
        });

        sbv2NoiseSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value).toFixed(2);
            state.sbv2Noise = parseFloat(val);
            sbv2NoiseVal.textContent = val;
        });

        sbv2NoiseWSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value).toFixed(2);
            state.sbv2NoiseW = parseFloat(val);
            sbv2NoiseWVal.textContent = val;
        });

        // File Attachment button and input
        if (attachFileBtn && fileUploadInput) {
            attachFileBtn.addEventListener('click', () => {
                fileUploadInput.click();
            });

            fileUploadInput.addEventListener('change', (e) => {
                handleFileSelection(e.target.files);
                fileUploadInput.value = ''; // Reset so same file can be re-selected
            });
        }

        // Drag and drop on chat history
        if (chatHistory) {
            chatHistory.addEventListener('dragover', (e) => {
                e.preventDefault();
                chatHistory.style.outline = '2px dashed var(--color-secondary)';
                chatHistory.style.outlineOffset = '-4px';
            });
            chatHistory.addEventListener('dragleave', (e) => {
                e.preventDefault();
                chatHistory.style.outline = 'none';
            });
            chatHistory.addEventListener('drop', (e) => {
                e.preventDefault();
                chatHistory.style.outline = 'none';
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    handleFileSelection(e.dataTransfer.files);
                }
            });
        }
    }

    // ==========================================================================
    // Google Maps Panel
    // ==========================================================================

    function injectMapsStyles() {
        if (document.getElementById('maps-panel-styles')) return;
        const style = document.createElement('style');
        style.id = 'maps-panel-styles';
        style.textContent = `
            .maps-embed-card {
                margin: 10px 16px 10px 52px;
                background: linear-gradient(135deg, rgba(15, 25, 50, 0.95), rgba(8, 18, 40, 0.98));
                border: 1px solid rgba(66, 220, 163, 0.25);
                border-radius: 16px;
                overflow: hidden;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(66, 220, 163, 0.08);
                animation: mapsSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            }
            @keyframes mapsSlideIn {
                from { opacity: 0; transform: translateY(12px) scale(0.98); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            .maps-card-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px;
                background: linear-gradient(90deg, rgba(66, 220, 163, 0.12), rgba(74, 144, 226, 0.08));
                border-bottom: 1px solid rgba(66, 220, 163, 0.15);
                cursor: pointer;
                user-select: none;
                transition: background 0.2s;
            }
            .maps-card-header:hover {
                background: linear-gradient(90deg, rgba(66, 220, 163, 0.18), rgba(74, 144, 226, 0.12));
            }
            .maps-card-title {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 0.82rem;
                font-weight: 600;
                color: rgba(66, 220, 163, 0.95);
                letter-spacing: 0.02em;
            }
            .maps-card-title i {
                font-size: 0.9rem;
            }
            .maps-card-actions {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .maps-open-btn {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                background: rgba(66, 220, 163, 0.15);
                border: 1px solid rgba(66, 220, 163, 0.3);
                color: rgba(66, 220, 163, 0.9);
                font-size: 0.72rem;
                font-weight: 600;
                padding: 4px 10px;
                border-radius: 6px;
                text-decoration: none;
                cursor: pointer;
                transition: all 0.2s;
                letter-spacing: 0.03em;
            }
            .maps-open-btn:hover {
                background: rgba(66, 220, 163, 0.25);
                border-color: rgba(66, 220, 163, 0.5);
                color: #42dca3;
            }
            .maps-toggle-btn {
                width: 22px;
                height: 22px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 5px;
                color: rgba(255, 255, 255, 0.5);
                font-size: 0.7rem;
                cursor: pointer;
                transition: all 0.2s;
            }
            .maps-toggle-btn:hover {
                background: rgba(255, 255, 255, 0.1);
                color: rgba(255, 255, 255, 0.8);
            }
            .maps-iframe-wrapper {
                width: 100%;
                height: 280px;
                position: relative;
                overflow: hidden;
                transition: height 0.35s cubic-bezier(0.16, 1, 0.3, 1);
            }
            .maps-iframe-wrapper.collapsed {
                height: 0;
            }
            .maps-iframe-wrapper iframe {
                width: 100%;
                height: 100%;
                border: none;
                display: block;
            }
            .maps-loading-overlay {
                position: absolute;
                inset: 0;
                background: rgba(8, 18, 40, 0.85);
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 10px;
                font-size: 0.8rem;
                color: rgba(255,255,255,0.5);
            }
            .maps-spinner {
                width: 28px;
                height: 28px;
                border: 2px solid rgba(66, 220, 163, 0.2);
                border-top-color: rgba(66, 220, 163, 0.8);
                border-radius: 50%;
                animation: spin 0.8s linear infinite;
            }
            @keyframes spin { to { transform: rotate(360deg); } }
            .maps-card-footer {
                padding: 7px 14px;
                font-size: 0.7rem;
                color: rgba(255,255,255,0.3);
                background: rgba(0,0,0,0.2);
                display: flex;
                align-items: center;
                gap: 6px;
            }
        `;
        document.head.appendChild(style);
    }

    function createMapsEmbedPanel(embedUrl, searchUrl, query) {
        injectMapsStyles();

        const card = document.createElement('div');
        card.className = 'maps-embed-card';

        const queryDisplay = query.length > 50 ? query.slice(0, 47) + '...' : query;
        const openUrl = searchUrl || `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

        card.innerHTML = `
            <div class="maps-card-header" id="maps-header-${Date.now()}">
                <div class="maps-card-title">
                    <i class="fa-solid fa-map-location-dot"></i>
                    Google Maps &mdash; <em style="font-weight:400; color: rgba(255,255,255,0.6); font-style:normal;">${queryDisplay}</em>
                </div>
                <div class="maps-card-actions">
                    <a href="${openUrl}" target="_blank" rel="noopener" class="maps-open-btn">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> Open Maps
                    </a>
                    <span class="maps-toggle-btn" title="Toggle map">
                        <i class="fa-solid fa-chevron-up"></i>
                    </span>
                </div>
            </div>
            <div class="maps-iframe-wrapper">
                <div class="maps-loading-overlay">
                    <div class="maps-spinner"></div>
                    <span>Loading Google Maps...</span>
                </div>
                <iframe
                    src="${embedUrl}"
                    allowfullscreen=""
                    loading="lazy"
                    referrerpolicy="no-referrer-when-downgrade"
                    title="Google Maps Search"
                ></iframe>
            </div>
            <div class="maps-card-footer">
                <i class="fa-solid fa-circle-info"></i>
                Powered by Google Maps &bull; Tap <strong>Open Maps</strong> to view full results
            </div>
        `;

        // Wire up toggle collapse
        const header = card.querySelector('.maps-card-header');
        const iframeWrapper = card.querySelector('.maps-iframe-wrapper');
        const toggleBtn = card.querySelector('.maps-toggle-btn');
        const iframe = card.querySelector('iframe');
        const loadingOverlay = card.querySelector('.maps-loading-overlay');

        // Hide loading overlay when iframe loads
        iframe.onload = () => {
            if (loadingOverlay) loadingOverlay.style.display = 'none';
        };

        header.addEventListener('click', (e) => {
            if (e.target.closest('.maps-open-btn')) return; // Don't toggle when clicking link
            const isCollapsed = iframeWrapper.classList.toggle('collapsed');
            const icon = toggleBtn.querySelector('i');
            icon.className = isCollapsed ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
        });

        return card;
    }

    // Start App
    init();
});



