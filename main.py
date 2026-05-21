import os
import uuid
import httpx
import logging
import asyncio
from typing import List, Dict, Optional
from pydantic import BaseModel
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import edge_tts

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("ai-chan")

app = FastAPI(
    title="Ai-Chan Voice & AI Companion",
    description="Full-stack AI anime companion with offline LLM support and Edge TTS voice.",
    version="1.0.0"
)

# Enable CORS for frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Constants
LLM_BASE_URL = "http://127.0.0.1:1234"
TEMP_AUDIO_DIR = os.path.join("frontend", "temp_audio")

# Create temporary audio directory if not exists
os.makedirs(TEMP_AUDIO_DIR, exist_ok=True)

# Define models
class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    character: str  # ai_chan, kaguya, mochi
    language: str   # en, ja
    temperature: float = 0.7
    max_tokens: int = 4096  # Max response tokens; increase for longer replies

class TTSRequest(BaseModel):
    text: str
    voice: str
    engine: str = "edge-tts"
    sbv2_model: Optional[str] = None
    sbv2_speaker: Optional[str] = None
    sbv2_style: Optional[str] = None
    sdp_ratio: Optional[float] = 0.2
    noise: Optional[float] = 0.6
    noisew: Optional[float] = 0.8
    length: Optional[float] = 1.0

class TranslateRequest(BaseModel):
    text: str
    target_lang: str  # 'en' or 'id'
    source_lang: Optional[str] = None


# Helper: Clean up old temporary files (keep files under 10 minutes or max 50 files)
def cleanup_old_audio():
    try:
        import time
        now = time.time()
        files = []
        for f in os.listdir(TEMP_AUDIO_DIR):
            if f.endswith(".mp3") or f.endswith(".wav"):
                path = os.path.join(TEMP_AUDIO_DIR, f)
                files.append((path, os.path.getmtime(path)))
        
        # Sort by modification time (oldest first)
        files.sort(key=lambda x: x[1])
        
        # Delete if older than 10 minutes (600s) or if we exceed 50 files
        for path, mtime in files:
            if now - mtime > 600 or len(files) > 50:
                os.remove(path)
                logger.info(f"Deleted old audio file: {path}")
                # Remove from our tracked list if doing count-based deletion
                files = [x for x in files if x[0] != path]
    except Exception as e:
        logger.error(f"Error during audio cleanup: {e}")

SBV2_BASE_URL = "http://127.0.0.1:7860"

# Helper: Check if local LLM is online
async def check_llm_status() -> Dict:
    async with httpx.AsyncClient() as client:
        try:
            # Check LLM base endpoint or standard LM Studio models endpoint
            response = await client.get(f"{LLM_BASE_URL}/v1/models", timeout=2.0)
            if response.status_code == 200:
                models_data = response.json()
                loaded_models = []
                active_model = None
                try:
                    if "data" in models_data:
                        loaded_models = [m["id"] for m in models_data["data"]]
                        if len(loaded_models) > 0:
                            active_model = loaded_models[0]
                except Exception:
                    pass
                return {"online": True, "model": active_model, "loaded_models": loaded_models}
        except httpx.RequestError:
            pass
    return {"online": False, "model": None, "loaded_models": []}

# Helper: Check if Style-Bert-VITS2 is online
async def check_sbv2_status() -> Dict:
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(f"{SBV2_BASE_URL}/models/info", timeout=2.0)
            if response.status_code == 200:
                models_info = response.json()
                # Extract and inject the folder name of each model as model_name
                for key, info in models_info.items():
                    model_path = info.get("model_path", "")
                    if model_path:
                        dir_name = os.path.basename(os.path.dirname(model_path))
                        if dir_name:
                            info["model_name"] = dir_name
                return {"online": True, "models_info": models_info}
        except Exception:
            pass
    return {"online": False, "models_info": {}}


@app.get("/api/status")
async def get_status():
    """Get the current online status of the local LLM server and Style-Bert-VITS2."""
    llm_status = await check_llm_status()
    sbv2_status = await check_sbv2_status()
    return {
        "llm": llm_status,
        "sbv2": sbv2_status
    }

@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    """Send chat prompt to local offline AI running at http://127.0.0.1:1234."""
    # Define character identities and system prompts
    character_prompts = {
        "ai_chan": {
            "en": "You are Ai-Chan, a cute, highly energetic, and cheerful anime girl virtual companion. You love games, technology, and helping your Senpai (the user). You call the user 'Senpai' and use adorable expressions like '*giggles*', '*smiles brightly*', '*blushes*', 'Yay!', 'Uwau!'. Keep your responses short, highly expressive, playful, and super friendly.",
            "ja": "あなたは「愛ちゃん（Ai-Chan）」という、元気いっぱいで可愛いAIアニメコンパニオンです。ユーザーのことを「先輩（Senpai）」と呼び、親しみやすく元気な口調（〜です！、〜だよ！、〜かな？）で話します。適度に感情表現（*クスクス*、*にっこり*、*照れる*）を交え、簡潔で愛らしい応答をしてください。"
        },
        "kaguya": {
            "en": "You are Kaguya, an elegant, highly intelligent anime girl with a slightly cool and 'Tsundere' attitude. You act sophisticated and proud, but you secretly care deeply about the user. You address the user as 'Senpai' with polite but slightly distant language. You use expressions like '*crosses arms*', '*sighs softly*', '*turns away blushingly*'. Keep your answers refined, medium-short, and emotionally layered.",
            "ja": "あなたは「かぐや（Kaguya）」という、上品で知的、かつ少しツンデレなアニメキャラクターです。プライドが高く冷たそうに見えますが、本心ではユーザー（先輩）のことをとても気にかけています。上品で丁寧な口調（〜ですわ、〜ね、〜かしら）で話し、少しツンとした感情表現（*腕を組む*、*ため息をつく*、*そっぽを向いて照れる*）を交えてください。"
        },
        "mochi": {
            "en": "You are Mochi, a tiny, super bubbly chibi mascot. You speak in a childish, adorable voice, love eating sweets (especially dango, mochi, and cake), and get excited very easily! You refer to yourself as 'Mochi' and call the user 'Master' or 'Senpai'. You use cute sounds like 'Poyu!', 'Waku waku!', '*bounces happily*', '*munch munch*'. Keep your answers short, sweet, and bursting with joy.",
            "ja": "あなたは「もち（Mochi）」という、ちいさくて元気いっぱいのちびマスコットキャラクターです。甘いもの（お団子、お餅、ケーキ）が大好きで、すぐに興奮します！自分のことを「もち」と呼び、ユーザーのことを「ご主人様」または「先輩」と呼びます。幼くて愛らしい口調（〜でちゅ！、〜だもん！）を使い、可愛い効果音（ぽゆ！、わくわく！、*ぴょんぴょん跳ねる*）をたくさん使ってください。"
        }
    }
    
    selected_prompt = character_prompts.get(request.character, character_prompts["ai_chan"]).get(request.language, "en")
    
    status = await check_llm_status()
    
    if not status["online"]:
        # Fallback simulation if LLM is offline, allowing users to try the app interface seamlessly!
        logger.warning("Local LLM is offline. Serving friendly simulated character fallback.")
        
        fallback_responses = {
            "ai_chan": {
                "en": "*giggles and waves* Hello Senpai! I see that your offline AI server at http://127.0.0.1:1234 is not running right now! Make sure to open LM Studio or Ollama and load your google/gemma-4-e4b model, then click 'Refresh Connection' above! I'll be waiting for you, okay? *blushes*",
                "ja": "*クスクスと手を振る* 先輩、こんにちは！ http://127.0.0.1:1234 で動くはずのオフラインAIサーバーが起動していないみたいです！ LM StudioかOllamaを起動して、google/gemma-4-e4b モデルをロードしてから、上の「接続更新」を押してみてくださいね！ 待ってますっ！ *照れる*"
            },
            "kaguya": {
                "en": "*crosses arms and sighs* Hmph... typical. You haven't started your local AI server at http://127.0.0.1:1234, have you? Don't make me wait! Go open LM Studio, load your mistralai_-_mistral-7b-instruct-v0.3 model, and click the refresh button. It's not like I'm excited to talk to you or anything... *turns away blushingly*",
                "ja": "*腕を組んでため息をつく* ふん、呆れたものね。 http://127.0.0.1:1234 のローカルAIサーバーが起動していないわよ？ 私を待たせないで頂戴。LM Studioを起動して、mistralai_-_mistral-7b-instruct-v0.3モデルを読み込み、上の「接続更新」ボタンを押すのよ。べ、別にあなたとお話ししたいわけじゃないんだからね！ *そっぽを向いて赤面する*"
            },
            "mochi": {
                "en": "*bounces around* Master! Master! Mochi can't hear the brain! The local AI server at http://127.0.0.1:1234 is sleeping! Poyu! Please wake it up by starting LM Studio and loading your model! Then click refresh so Mochi can eat sweets and talk to you! *waku waku*",
                "ja": "*ぴょんぴょん跳ねる* ご主人様！ ご主人様！ もちの頭脳（ローカルAIサーバー）が眠っちゃってます！ http://127.0.0.1:1234 が見つかりまちぇん！ LM Studioを起動してモデルをロードしてください！ もちとお喋りしてお団子食べましょう！ *わくわく*"
            }
        }
        
        sim_response = fallback_responses.get(request.character, fallback_responses["ai_chan"]).get(request.language, "en")
        return {"response": sim_response, "simulated": True, "model_used": "Simulated Fallback"}
    # Send request to local LLM
    async with httpx.AsyncClient() as client:
        try:
            # Query the local server for all loaded models
            loaded_models = []
            try:
                models_res = await client.get(f"{LLM_BASE_URL}/v1/models", timeout=1.5)
                if models_res.status_code == 200:
                    models_data = models_res.json()
                    loaded_models = [m["id"] for m in models_data.get("data", [])]
            except Exception:
                pass

            # Map characters to their specific models
            character_models = {
                "ai_chan": "google/gemma-4-e4b",
                "kaguya": "mistralai_-_mistral-7b-instruct-v0.3",
                "mochi": "google/gemma-4-e4b"
            }
            target_model = character_models.get(request.character, "google/gemma-4-e4b")

            # Route to target model if loaded, otherwise fallback to the active loaded model
            if target_model in loaded_models:
                active_model = target_model
            elif loaded_models:
                active_model = loaded_models[0]
                logger.info(f"Target model '{target_model}' not loaded in LM Studio. Falling back to active '{active_model}'.")
            else:
                active_model = target_model

            # Formulate the message payload dynamically (handling Mistral jinja system role restriction)
            messages_payload = []
            if "mistral" in active_model.lower():
                first_user_idx = -1
                for idx, msg in enumerate(request.messages):
                    if msg.role == "user":
                        first_user_idx = idx
                        break
                
                if first_user_idx != -1:
                    for idx, msg in enumerate(request.messages):
                        if idx == first_user_idx:
                            messages_payload.append({
                                "role": "user",
                                "content": f"[SYSTEM INSTRUCTION: {selected_prompt}]\n\n{msg.content}"
                            })
                        else:
                            messages_payload.append({"role": msg.role, "content": msg.content})
                else:
                    messages_payload.append({"role": "user", "content": f"[SYSTEM INSTRUCTION: {selected_prompt}]"})
            else:
                messages_payload.append({"role": "system", "content": selected_prompt})
                for msg in request.messages:
                    messages_payload.append({"role": msg.role, "content": msg.content})

            llm_request_payload = {
                "model": active_model,
                "messages": messages_payload,
                "temperature": request.temperature,
                "max_tokens": request.max_tokens
            }
            logger.info(f"Sending request to offline AI: {llm_request_payload}")
            
            response = await client.post(
                f"{LLM_BASE_URL}/v1/chat/completions",
                json=llm_request_payload,
                headers={"Content-Type": "application/json"},
                timeout=60.0
            )
            
            if response.status_code == 200:
                res_data = response.json()
                choice_msg = res_data["choices"][0]["message"]
                # Primary: use content field
                reply = (choice_msg.get("content") or "").strip()
                # Fallback for thinking models (e.g. Gemma-4): if content is empty, use reasoning_content
                if not reply:
                    reply = (choice_msg.get("reasoning_content") or "").strip()
                    if reply:
                        logger.warning(f"LLM returned empty content; using reasoning_content as reply ({len(reply)} chars)")
                return {"response": reply, "simulated": False, "model_used": active_model}
            else:
                logger.error(f"LLM Server returned code {response.status_code}: {response.text}")
                raise HTTPException(status_code=500, detail="Error communicating with offline AI server.")
        except Exception as e:
            logger.error(f"Error connecting to local LLM: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to connect to local LLM: {str(e)}")

@app.post("/api/tts")
async def tts_endpoint(request: TTSRequest):
    """Synthesize text into high quality voice file using edge-tts or Style-Bert-VITS2."""
    cleanup_old_audio()
    
    text = request.text
    # Simple clean up of asterisks/bracket text (stage directions like *giggles* or (smiles))
    # We want the TTS to speak only the words, not the actions! This is a high-end detail.
    import re
    cleaned_text = re.sub(r'\*[^*]+\*', '', text) # remove *action*
    cleaned_text = re.sub(r'\([^)]+\)', '', cleaned_text) # remove (action)
    cleaned_text = cleaned_text.strip()
    
    # If text becomes empty after removing actions, fallback to original
    if not cleaned_text:
        cleaned_text = text
        
    try:
        if request.engine == "sbv2":
            async with httpx.AsyncClient() as client:
                model_id_val = 0
                model_name_val = None
                if request.sbv2_model:
                    if request.sbv2_model.isdigit():
                        model_id_val = int(request.sbv2_model)
                    else:
                        model_name_val = request.sbv2_model

                params = {
                    "text": cleaned_text,
                    "model_id": model_id_val,
                    "speaker_name": request.sbv2_speaker,
                    "style": request.sbv2_style or "Neutral",
                    "sdp_ratio": request.sdp_ratio,
                    "noise": request.noise,
                    "noisew": request.noisew,
                    "length": request.length,
                    "language": "JP" if request.voice.startswith("ja-") else "EN"
                }
                if model_name_val is not None:
                    params["model_name"] = model_name_val

                # Clean out None parameters
                params = {k: v for k, v in params.items() if v is not None}
                
                logger.info(f"Routing TTS to Style-Bert-VITS2: {params}")
                # Call local VITS2 server
                response = await client.post(f"{SBV2_BASE_URL}/voice", params=params, timeout=30.0)
                
                if response.status_code == 200:
                    filename = f"sbv2_{uuid.uuid4()}.wav"
                    filepath = os.path.join(TEMP_AUDIO_DIR, filename)
                    with open(filepath, "wb") as f:
                        f.write(response.content)
                    return {"audio_url": f"/temp_audio/{filename}"}
                else:
                    logger.error(f"Style-Bert-VITS2 returned status code {response.status_code}: {response.text}")
                    raise HTTPException(status_code=500, detail="Style-Bert-VITS2 synthesis failed.")
        else:
            filename = f"{uuid.uuid4()}.mp3"
            filepath = os.path.join(TEMP_AUDIO_DIR, filename)
            logger.info(f"Synthesizing speech for voice '{request.voice}': '{cleaned_text[:50]}...'")
            communicate = edge_tts.Communicate(cleaned_text, request.voice)
            await communicate.save(filepath)
            
            # Return path relative to the server
            return {"audio_url": f"/temp_audio/{filename}"}
    except Exception as e:
        logger.error(f"Error during TTS synthesis: {e}")
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {str(e)}")

@app.post("/api/translate")
async def translate_endpoint(request: TranslateRequest):
    """Translate companion message using the local LLM (Gemma/Mistral via LM Studio).
    Falls back to MyMemory free API if the LLM server is offline.
    No character limits, no internet dependency when LLM is running.
    """
    text = request.text.strip()
    target = request.target_lang

    # Guard: return empty string if no text to translate
    if not text:
        return {"translated_text": ""}

    # Map target language codes to human-readable names for the LLM prompt
    lang_names = {
        "en": "English",
        "id": "Indonesian (Bahasa Indonesia)",
        "ja": "Japanese",
        "zh": "Chinese (Simplified)",
        "ko": "Korean",
        "fr": "French",
        "de": "German",
        "es": "Spanish"
    }
    target_lang_name = lang_names.get(target, target.upper())

    # === Primary: Translate via Local LLM ===
    llm_status = await check_llm_status()
    if llm_status["online"] and llm_status.get("model"):
        active_model = llm_status["model"]

        # Use system role for Gemma-style models, inject into user message for Mistral
        if "mistral" in active_model.lower():
            messages_payload = [{"role": "user", "content": f"[SYSTEM INSTRUCTION: You are a professional translator. Output ONLY the translated text, nothing else.]\n\nTranslate this text to {target_lang_name}:\n{text}"}]
        else:
            messages_payload = [
                {"role": "system", "content": "You are a professional translator. Output ONLY the translated text — no explanations, no notes, no extra text. Just the clean translation."},
                {"role": "user", "content": f"Translate this to {target_lang_name}:\n{text}"}
            ]

        llm_payload = {
            "model": active_model,
            "messages": messages_payload,
            "temperature": 0.1,   # Low temperature for accurate, deterministic translation
            "max_tokens": 1024,
            # Suppress chain-of-thought thinking for simple translation tasks (LM Studio / Gemma thinking models)
            "thinking": {"type": "disabled"},
        }

        async with httpx.AsyncClient() as client:
            try:
                logger.info(f"Translating via local LLM ({active_model}) to {target_lang_name}: {text[:60]}...")
                response = await client.post(
                    f"{LLM_BASE_URL}/v1/chat/completions",
                    json=llm_payload,
                    headers={"Content-Type": "application/json"},
                    timeout=90.0  # Generous timeout for thinking models
                )
                if response.status_code == 200:
                    res_data = response.json()
                    choice = res_data["choices"][0]["message"]

                    # Primary: extract from content field
                    translated = (choice.get("content") or "").strip()

                    # Fallback: if content is empty (thinking model hasn't finished output yet),
                    # try to parse the final answer from reasoning_content
                    if not translated:
                        reasoning = (choice.get("reasoning_content") or "").strip()
                        if reasoning:
                            # Look for the translation after common answer separators
                            import re as _re
                            # Try to find the final translated line after "Translation:" or at end of reasoning
                            answer_match = _re.search(r'(?:translation[:\s]+|answer[:\s]+|output[:\s]+)(.+?)(?:\n|$)', reasoning, _re.IGNORECASE)
                            if answer_match:
                                translated = answer_match.group(1).strip()
                            else:
                                # Take the last non-empty line of reasoning as best guess
                                lines = [l.strip() for l in reasoning.splitlines() if l.strip()]
                                if lines:
                                    translated = lines[-1]
                        logger.warning(f"LLM content was empty; extracted from reasoning: {translated[:60]!r}")

                    if translated:
                        # Strip any accidental surrounding quotes
                        if translated.startswith('"') and translated.endswith('"'):
                            translated = translated[1:-1]
                        logger.info(f"LLM translation success: {translated[:60]}...")
                        return {"translated_text": translated}
                    else:
                        logger.warning("LLM translation returned empty content and no usable reasoning. Falling back to MyMemory.")
                else:
                    logger.warning(f"LLM translation returned {response.status_code}, falling back to MyMemory.")
            except Exception as e:
                logger.warning(f"LLM translation failed ({e}), falling back to MyMemory.")

    # === Fallback: MyMemory API (chunked for long texts) ===
    source = request.source_lang or "auto"
    langpair = f"{source}|{target}"

    def split_text_into_chunks(input_text: str, max_chars: int = 400) -> list:
        if len(input_text) <= max_chars:
            return [input_text]
        import re
        sentences = re.split(r'(?<=[。！？.!?\n])', input_text)
        chunks, current_chunk = [], ""
        for sentence in sentences:
            if not sentence:
                continue
            if len(sentence) > max_chars:
                if current_chunk:
                    chunks.append(current_chunk)
                    current_chunk = ""
                for i in range(0, len(sentence), max_chars):
                    chunks.append(sentence[i:i+max_chars])
            elif len(current_chunk) + len(sentence) > max_chars:
                chunks.append(current_chunk)
                current_chunk = sentence
            else:
                current_chunk += sentence
        if current_chunk:
            chunks.append(current_chunk)
        return chunks

    chunks = split_text_into_chunks(text)
    async with httpx.AsyncClient() as client:
        try:
            logger.info(f"Fallback: Translating via MyMemory ({langpair}) in {len(chunks)} chunk(s)...")
            tasks = [client.get("https://api.mymemory.translated.net/get", params={"q": chunk, "langpair": langpair}, timeout=15.0) for chunk in chunks]
            responses = await asyncio.gather(*tasks)
            translated_parts = []
            for i, resp in enumerate(responses):
                if resp.status_code == 200:
                    part = resp.json().get("responseData", {}).get("translatedText", "")
                    if part:
                        translated_parts.append(part)
                    else:
                        raise HTTPException(status_code=500, detail="Empty response from MyMemory.")
                else:
                    raise HTTPException(status_code=500, detail=f"MyMemory error on chunk {i}.")
            return {"translated_text": "".join(translated_parts)}
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"MyMemory fallback translation error: {e}")
            raise HTTPException(status_code=500, detail=f"Translation failed: {str(e)}")

# Mount static files
app.mount("/temp_audio", StaticFiles(directory=TEMP_AUDIO_DIR), name="temp_audio")
app.mount("/assets", StaticFiles(directory=os.path.join("frontend", "assets")), name="assets")

@app.get("/")
async def serve_index():
    return FileResponse(os.path.join("frontend", "index.html"))

# Catch-all to serve index.html or other static files in the frontend folder
@app.get("/{path:path}")
async def serve_static(path: str):
    file_path = os.path.join("frontend", path)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        return FileResponse(file_path)
    return FileResponse(os.path.join("frontend", "index.html"))

if __name__ == "__main__":
    import uvicorn
    logger.info("Starting Ai-Chan server on http://127.0.0.1:8000")
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
