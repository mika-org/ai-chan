// ==========================================================================
// Ai-Chan Web Client Application Logic
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
    // Auto-redirect from 127.0.0.1 to localhost for secure context (enabling SpeechRecognition & getUserMedia)
    if (window.location.hostname === '127.0.0.1') {
        window.location.hostname = 'localhost';
        return;
    }

    // Dynamic Base API URL to allow opening page via file://, other ports, or dev servers
    const API_BASE = (window.location.protocol === 'file:' || window.location.port !== '8000')
        ? 'http://127.0.0.1:8000'
        : '';

    // Application State
    const state = {
        character: 'ai_chan',
        language: 'ja',
        voice: 'ja-JP-NanamiNeural',
        autoplay: true,
        speed: 1.0,
        messages: [],
        lastResponseText: '',
        lastVoiceUrl: '',
        llmOnline: false,
        recognition: null,
        isListening: false,
        voiceEngine: 'edge-tts', // 'edge-tts' or 'sbv2'
        sbv2Online: false,
        sbv2ModelsInfo: {}, // Store models info dict
        sbv2SelectedModel: '',
        sbv2SelectedSpeaker: '',
        sbv2SelectedStyle: '',
        sbv2SdpRatio: 0.2,
        sbv2Noise: 0.6,
        sbv2NoiseW: 0.8,
        maxTokens: 4096   // Max response length tokens
    };

    // Character Profiles
    const characters = {
        ai_chan: {
            name: 'Ai-Chan',
            jpName: '愛ちゃん',
            tagline: '"Senpai! Let\'s build something awesome today!"',
            avatar: 'assets/ai_chan.png',
            defaultVoice: {
                ja: 'ja-JP-NanamiNeural',
                en: 'en-US-AriaNeural'
            },
            targetModel: 'google/gemma-4-e4b'
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
            targetModel: 'mistralai_-_mistral-7b-instruct-v0.3'
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
            targetModel: 'google/gemma-4-e4b'
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
        // 1. Check Offline AI server status
        checkServerStatus();
        
        // 2. Populate voices dropdown based on active language
        populateVoices();
        
        // 3. Set up event listeners
        setupEventListeners();
        
        // 4. Initialize web speech recognition (Speech-to-text)
        setupSpeechRecognition();
        
        // 5. Append first welcome system prompt helper
        addSystemMessage("Connecting to offline AI at <strong>http://127.0.0.1:1234</strong> and voice synthesis at <strong>http://127.0.0.1:7860</strong>. Set target models & speak to your companion!");
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
    function selectCompanion(charId) {
        if (!characters[charId] || state.character === charId) return;
        
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
        const targetModel = char.targetModel || 'google/gemma-4-e4b';
        if (infoTargetModel) infoTargetModel.textContent = targetModel;
        if (guidelineTargetModel) guidelineTargetModel.textContent = targetModel;
        if (footerModelInfo) footerModelInfo.textContent = `Target Model: ${targetModel}`;

        // Repopulate voice choice to match standard
        populateVoices();
        
        // Stop current audio if playing
        stopVoicePlayback();
        
        // Visual indicator in chat that character has switched
        addSystemMessage(`Companion switched to <strong>${char.name}</strong>`);
        
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
        const targetModel = activeChar.targetModel || 'google/gemma-4-e4b';

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
                engine: state.voiceEngine
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
    // Chat & Messaging Operations
    // ==========================================================================

    async function sendMessage() {
        const text = chatInput.value.trim();
        if (!text) return;
        
        // Clear input box
        chatInput.value = '';
        adjustTextareaHeight(chatInput);
        
        // Stop audio if playing
        stopVoicePlayback();
        
        // 1. Add user message to UI and history state
        addMessageBubble('user', text);
        state.messages.push({ role: 'user', content: text });
        
        // Limit context size to keep it responsive (max last 20 messages)
        if (state.messages.length > 20) {
            state.messages.shift();
        }
        
        // 2. Set Avatar to thinking (blue aura, pulsing)
        setAvatarState('thinking');
        showTypingIndicator(true);
        
        try {
            // 3. Query local AI endpoint
            const res = await fetch(`${API_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: state.messages,
                    character: state.character,
                    language: state.language,
                    temperature: 0.7,
                    max_tokens: state.maxTokens
                })
            });
            
            if (!res.ok) throw new Error("Server returned API error");
            
            const data = await res.json();
            const reply = data.response;
            const modelUsed = data.model_used || '';
            state.lastResponseText = reply;
            
            // Add to model context
            state.messages.push({ role: 'assistant', content: reply });
            
            // 4. Render AI response in UI
            showTypingIndicator(false);
            addMessageBubble('companion', reply, modelUsed);
            
            // 5. Autoplay voice if toggled
            if (state.autoplay) {
                speakText(reply);
            } else {
                setAvatarState('idle');
            }
        } catch (err) {
            console.error("Error sending chat:", err);
            showTypingIndicator(false);
            addMessageBubble('companion', "*giggles* Whoops! Senpai, something went wrong when speaking to my neural core! Please verify your settings and make sure LM Studio is running. *blushes*", "error");
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
            const playBtn = msgDiv.querySelector('.audio-play-btn');
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
                            // puter.ai.chat returns a string or a message object
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

            // Auto-translate to English if companion language is not English
            if (state.language !== 'en' && text && text.trim().length > 2) {
                const enBtn = Array.from(translateBtns).find(btn => btn.dataset.lang === 'en');
                if (enBtn) {
                    enBtn.click();
                }
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

    function clearChat() {
        chatHistory.innerHTML = '';
        state.messages = [];
        state.lastResponseText = '';
        state.lastVoiceUrl = '';
        stopVoicePlayback();
        replayVoiceBtn.disabled = true;
        
        addSystemMessage("Chat memory has been cleared. Senpai, what shall we speak about now?");
    }

    // ==========================================================================
    // Event Listeners Bindings
    // ==========================================================================

    function setupEventListeners() {
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
            state.language = e.target.value;
            
            // Visual alert
            addSystemMessage(`Language model format set to: <strong>${state.language === 'ja' ? 'Japanese (日本語)' : 'English (English)'}</strong>`);
            
            // Re-populate options
            populateVoices();
            
            // Reset speech recognition language
            if (state.recognition) {
                state.recognition.lang = state.language === 'ja' ? 'ja-JP' : 'en-US';
            }
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
    }

    // Start App
    init();
});
