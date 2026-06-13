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
from fastapi.responses import FileResponse, StreamingResponse
import edge_tts
import json
import base64
import io
import PyPDF2
import openpyxl
import docx

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

from backend.routers import router as os_router
app.include_router(os_router)

# Constants
LLM_BASE_URL = "http://127.0.0.1:1234"
TEMP_AUDIO_DIR = os.path.join("frontend", "temp_audio")

# Google Maps API Key (optional – set to enable Google Places Text Search)
# Leave empty string to use free OpenStreetMap Nominatim fallback
GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")

STOP_SEQUENCES = [
    "Senpai:", "User:", "User (Senpai):", "Ai-Chan:", "Kaguya:", "Mochi:",
    "先輩:", "ユーザー:", "愛ちゃん:", "かぐや:", "もち:",
    "\nUser", "\nSenpai", "\n先輩", "\nユーザー",
    "\nUser (Senpai):", "\nAi-Chan:", "\nKaguya:", "\nMochi:",
    "\n愛ちゃん:", "\nかぐや:", "\nもち:"
]

# Create temporary audio directory if not exists
os.makedirs(TEMP_AUDIO_DIR, exist_ok=True)

# Create memory directory if not exists
os.makedirs("memory", exist_ok=True)

# Define models
class ChatAttachment(BaseModel):
    type: str  # 'image' or 'document'
    mime: str
    data: str  # base64 data
    name: Optional[str] = None

class ChatMessage(BaseModel):
    role: str
    content: str
    attachments: Optional[List[ChatAttachment]] = []

class MemorySaveRequest(BaseModel):
    chat_history: List[ChatMessage]

class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    character: str  # ai_chan, kaguya, mochi
    language: str   # en, ja
    temperature: float = 0.7
    max_tokens: int = 4096  # Max response tokens
    search: Optional[bool] = False

class TTSRequest(BaseModel):
    text: str
    voice: str
    engine: str = "edge-tts"
    character: Optional[str] = None
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


# Memory System Helpers & Background Tasks
async def update_summary_task(character: str, chat_history: List[ChatMessage]):
    """Background task to compile/update rolling summary using local LLM."""
    status = await check_llm_status()
    if not status["online"] or not status["model"]:
        logger.warning(f"LLM offline, skipping background memory summarization for {character}.")
        return

    active_model = status["model"]
    memory_file = os.path.join("memory", f"{character}.json")
    
    # Load existing summary
    existing_summary = ""
    if os.path.exists(memory_file):
        try:
            with open(memory_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                existing_summary = data.get("summary", "")
        except Exception:
            pass

    character_names = {
        "ai_chan": "Ai-Chan",
        "kaguya": "Kaguya",
        "mochi": "Mochi"
    }
    char_name = character_names.get(character, character)

    # Format the recent history for the summarizer
    recent_msgs = chat_history[-30:]
    history_str = ""
    for msg in recent_msgs:
        role_name = "User (Senpai)" if msg.role == "user" else char_name
        history_str += f"{role_name}: {msg.content}\n"

    prompt = (
        f"You are an advanced memory compression AI. Your task is to update a rolling summary "
        f"of the conversation between the user (Senpai) and the companion ({char_name}).\n\n"
        f"Instructions:\n"
        f"- Write a concise, high-density summary of key facts, user preferences, companion feelings, and major topics.\n"
        f"- Keep the summary under 3 sentences (very short and condensed).\n"
        f"- Do NOT use meta-introductory phrases like 'Here is the summary' or 'The conversation covers...'. Start directly.\n"
        f"- Integrate any existing memories/context below seamlessly.\n\n"
        f"Existing Memories:\n{existing_summary or 'None'}\n\n"
        f"New Conversation to summarize:\n{history_str}\n\n"
        f"Provide the updated rolling summary:"
    )

    try:
        async with httpx.AsyncClient() as client:
            logger.info(f"Triggering background LLM summarization for {character} using model '{active_model}'")
            response = await client.post(
                f"{LLM_BASE_URL}/v1/chat/completions",
                json={
                    "model": active_model,
                    "messages": [
                        {"role": "system", "content": "You are a professional memory compression system. Output only the short updated summary."},
                        {"role": "user", "content": prompt}
                    ],
                    "temperature": 0.2,
                    "max_tokens": 150,
                    "thinking": {"type": "disabled"}
                },
                timeout=60.0
            )
            
            if response.status_code == 200:
                res_data = response.json()
                new_summary = res_data["choices"][0]["message"].get("content", "").strip()
                if new_summary:
                    # Reload the history just in case it was written to in the meantime
                    current_history = chat_history
                    if os.path.exists(memory_file):
                        try:
                            with open(memory_file, "r", encoding="utf-8") as f:
                                data = json.load(f)
                                current_history_raw = data.get("chat_history", [])
                                current_history = [ChatMessage(**m) for m in current_history_raw]
                        except Exception:
                            pass
                            
                    with open(memory_file, "w", encoding="utf-8") as f:
                        json.dump({
                            "chat_history": [msg.dict() for msg in current_history],
                            "summary": new_summary
                        }, f, indent=2, ensure_ascii=False)
                    logger.info(f"Memory summary successfully updated for character {character}: '{new_summary}'")
            else:
                logger.error(f"LLM summary call returned status {response.status_code}: {response.text}")
    except Exception as e:
        logger.error(f"Error in background summarization task: {e}")

def save_memory_background_task(character: str, messages: List[ChatMessage], assistant_reply: str):
    """Blocking synchronous I/O function to save history and trigger summary task."""
    updated_history = list(messages) + [ChatMessage(role="assistant", content=assistant_reply)]
    os.makedirs("memory", exist_ok=True)
    memory_file = os.path.join("memory", f"{character}.json")
    
    # Prune to last 100
    pruned_history = updated_history[-100:]
    
    existing_summary = ""
    if os.path.exists(memory_file):
        try:
            with open(memory_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                existing_summary = data.get("summary", "")
        except Exception:
            pass
            
    try:
        with open(memory_file, "w", encoding="utf-8") as f:
            json.dump({
                "chat_history": [msg.dict() for msg in pruned_history],
                "summary": existing_summary
            }, f, indent=2, ensure_ascii=False)
        logger.info(f"Background auto-saved memory for {character}. Message count: {len(pruned_history)}")
    except Exception as e:
        logger.error(f"Failed to auto-save memory file for {character}: {e}")
        
    if len(pruned_history) >= 20:
        asyncio.create_task(update_summary_task(character, pruned_history))

async def save_memory_background_async(character: str, messages: List[ChatMessage], assistant_reply: str):
    """Wrapper to run the blocking file save inside a thread pool executor."""
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, save_memory_background_task, character, messages, assistant_reply)


USER_LOCATION = None

async def get_user_location() -> Dict:
    """Fetch user's rough geolocation based on public IP using a free, keyless API."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get("http://ip-api.com/json/", timeout=3.0)
            if response.status_code == 200:
                data = response.json()
                if data.get("status") == "success":
                    return {
                        "city": data.get("city", ""),
                        "region": data.get("regionName", ""),
                        "country": data.get("country", ""),
                        "timezone": data.get("timezone", ""),
                    }
    except Exception as e:
        logger.warning(f"Failed to fetch IP location: {e}")
    return {"city": "", "region": "", "country": "", "timezone": ""}

async def get_cached_user_location() -> Dict:
    """Lazily load and cache user public IP location context on first call."""
    global USER_LOCATION
    if USER_LOCATION is None:
        logger.info("Resolving user public IP location context...")
        USER_LOCATION = await get_user_location()
        logger.info(f"User location context resolved: {USER_LOCATION}")
    return USER_LOCATION

def formulate_smart_search_query(messages: List[ChatMessage], location: Dict) -> str:
    """Intelligently formulate search queries including conversational followups and history context."""
    if not messages:
        return ""
    last_msg = messages[-1].content.strip()
    clean_last = last_msg.lower()
    
    # Check if the user is requesting a search as a follow-up
    is_followup_search = False
    if "search" in clean_last or "google" in clean_last or "find" in clean_last:
        if len(clean_last.split()) < 7 or "it" in clean_last or "that" in clean_last:
            is_followup_search = True
            
    if is_followup_search and len(messages) >= 3:
        # Retrieve previous assistant recommendation and previous user topic
        prev_assistant = messages[-2].content if messages[-2].role == "assistant" else ""
        prev_user = messages[-3].content if messages[-3].role == "user" else ""
        
        # 1. Search for quoted phrases in the assistant's previous reply
        import re
        quotes = re.findall(r'"([^"]+)"', prev_assistant)
        if not quotes:
            quotes = re.findall(r"'([^']+)'", prev_assistant)
            
        topic = ""
        if quotes:
            topic = quotes[0]
        else:
            # Fallback to the previous user prompt content
            topic = prev_user
            
        # 2. Scan history for location street names
        loc_context = ""
        # Search for "jalan ...", "street", "road"
        for msg in reversed(messages):
            msg_clean = msg.content.lower()
            if "jalan" in msg_clean or "street" in msg_clean or "road" in msg_clean:
                match = re.search(r'(jalan\s+[a-zA-Z0-9\s]+|street\s+[a-zA-Z0-9\s]+|road\s+[a-zA-Z0-9\s]+)', msg_clean)
                if match:
                    loc_context = f" near {match.group(0).strip()}"
                    break
        
        if not loc_context and location and location.get("city"):
            loc_context = f" near {location['city']}"
            
        if topic:
            return f"{topic}{loc_context}"
            
    # Standard prefix stripping
    if last_msg.startswith("/search") or last_msg.startswith("/google"):
        return last_msg.replace("/search", "").replace("/google", "").strip()
        
    return last_msg

def should_trigger_search(query: str) -> bool:
    """Determine if a user prompt should trigger a web search.
    Genius Mode: Searches for almost anything to give AI maximum context,
    only skipping very basic greetings and fillers.
    """
    clean = query.strip().lower()
    
    # Too short to be a useful search
    if len(clean) < 5 or len(clean.split()) < 2:
        return False
    
    # Common greetings and fillers
    greetings_and_fillers = {
        "hi", "hello", "hey", "good morning", "good afternoon", "good evening",
        "bye", "goodbye", "thanks", "thank you", "arigato", "ok", "okay", "yes", "no",
        "yap", "yep", "lol", "haha", "how are you", "what's up", "sup", "test", "testing",
        "oh", "ah", "uh", "um", "well", "so", "yup", "yess", "noo", "nooo", "okayy",
        "こんにちは", "おはよう", "こんばんは", "ありがとう", "テスト", "おはよ", "こんちわ"
    }
    if clean in greetings_and_fillers:
        return False
    
    return True

# Web Search Helpers (Google & Fallback DuckDuckGo)
async def search_google(query: str) -> str:
    """Execute a real-time Google search and parse the top result snippets."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    url = "https://www.google.com/search"
    params = {"q": query}
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(url, params=params, headers=headers, timeout=3.0)
            if response.status_code == 200:
                from bs4 import BeautifulSoup
                soup = BeautifulSoup(response.text, "html.parser")
                
                results = []
                # Google search result cards are usually inside divs with class 'g'
                for g in soup.find_all("div", class_="g")[:3]: # top 3 results
                    anchors = g.find_all("a")
                    if anchors:
                        link = anchors[0].get("href")
                        title = g.find("h3")
                        title_text = title.text if title else "Search Result"
                        
                        snippet_div = g.find("div", class_="VwiC3b")
                        snippet = snippet_div.text if snippet_div else ""
                        if not snippet:
                            snippet_text = g.text.replace(title_text, "").strip()
                            snippet = snippet_text[:200]
                        
                        results.append(f"- Title: {title_text}\n  Link: {link}\n  Snippet: {snippet}")
                
                if results:
                    return "\n\n".join(results)
    except Exception as e:
        logger.error(f"Google search scraping error: {e}")
    return ""

async def search_duckduckgo(query: str) -> str:
    """Execute a fallback DuckDuckGo search using the duckduckgo-search package."""
    def run_ddgs():
        try:
            from duckduckgo_search import DDGS
            results = []
            with DDGS() as ddgs:
                for r in ddgs.text(query, max_results=3):
                    results.append(f"- Title: {r.get('title')}\n  Link: {r.get('href')}\n  Snippet: {r.get('body')}")
            if results:
                return "\n\n".join(results)
        except Exception as e:
            logger.error(f"DDGS error: {e}")
        return ""

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, run_ddgs)


async def search_google_maps_places(query: str, location: Dict) -> Dict:
    """Search for places using Google Maps Places Text Search API.
    Returns a dict with 'context' (text for AI) and 'maps_url' (embed URL) and 'places' list.
    """
    import urllib.parse
    
    city = location.get("city", "") if location else ""
    region = location.get("region", "") if location else ""
    country = location.get("country", "") if location else ""
    
    # Build location-aware search query
    location_suffix = ""
    if city:
        location_suffix = f" near {city}"
        if region and region != city:
            location_suffix += f", {region}"
    
    full_query = query + location_suffix
    
    # Always generate a Google Maps search URL that users can open
    maps_search_url = f"https://www.google.com/maps/search/{urllib.parse.quote(full_query)}"
    maps_embed_query = urllib.parse.quote(full_query)
    maps_embed_url = f"https://www.google.com/maps/embed/v1/search?q={maps_embed_query}&key=AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"
    
    places_found = []
    
    # Try Google Maps Places Text Search API if key is available
    if GOOGLE_MAPS_API_KEY:
        logger.info(f"Querying Google Maps Places Text Search API for: '{full_query}'")
        try:
            url = "https://maps.googleapis.com/maps/api/place/textsearch/json"
            params = {
                "query": full_query,
                "key": GOOGLE_MAPS_API_KEY
            }
            async with httpx.AsyncClient(verify=False) as client:
                response = await client.get(url, params=params, timeout=6.0)
                if response.status_code == 200:
                    data = response.json()
                    if data.get("status") == "OK":
                        for item in data.get("results", [])[:5]:
                            name = item.get("name", "")
                            address = item.get("formatted_address", "")
                            rating = item.get("rating", "")
                            lat = item.get("geometry", {}).get("location", {}).get("lat", "")
                            lng = item.get("geometry", {}).get("location", {}).get("lng", "")
                            place_id = item.get("place_id", "")
                            gmaps_url = f"https://www.google.com/maps/place/?q=place_id:{place_id}" if place_id else ""
                            
                            places_found.append({
                                "name": name,
                                "address": address,
                                "rating": rating,
                                "lat": lat,
                                "lng": lng,
                                "gmaps_url": gmaps_url,
                                "place_id": place_id
                            })
                        
                        if places_found:
                            logger.info(f"Google Maps API: Found {len(places_found)} places.")
                            # Use first place for embed
                            if places_found[0].get("place_id"):
                                maps_embed_url = f"https://www.google.com/maps/embed/v1/place?q=place_id:{places_found[0]['place_id']}&key={GOOGLE_MAPS_API_KEY}"
        except Exception as e:
            logger.error(f"Google Maps Places API error: {e}")
    
    # Fallback to Nominatim OpenStreetMap if no Google API key or Google returned nothing
    if not places_found:
        logger.info(f"Falling back to Nominatim OSM for: '{query}'")
        try:
            headers = {"User-Agent": "AiChanCompanion/1.0 (contact: support@ai-chan.local)"}
            
            # Detect city from query for indonesian cities
            search_city = city or "Bandung"
            for indonesian_city in ["bandung", "cimahi", "jakarta", "surabaya", "medan", "tangerang", "depok", "bekasi", "yogyakarta", "semarang", "makassar", "palembang"]:
                if indonesian_city in query.lower():
                    search_city = indonesian_city.capitalize()
                    break
            
            nom_url = "https://nominatim.openstreetmap.org/search"
            nom_params = {
                "q": f"{query}, {search_city}",
                "format": "json",
                "limit": 5,
                "addressdetails": 1
            }
            async with httpx.AsyncClient(verify=False) as client:
                response = await client.get(nom_url, params=nom_params, headers=headers, timeout=5.0)
                if response.status_code == 200:
                    data = response.json()
                    for item in data[:5]:
                        display = item.get("display_name", "")
                        parts = display.split(",")
                        name = parts[0].strip()
                        address = ", ".join([p.strip() for p in parts[1:4]])
                        lat = item.get("lat", "")
                        lon = item.get("lon", "")
                        gmaps_url = f"https://www.google.com/maps?q={lat},{lon}" if lat and lon else ""
                        
                        places_found.append({
                            "name": name,
                            "address": address,
                            "rating": "",
                            "lat": lat,
                            "lng": lon,
                            "gmaps_url": gmaps_url,
                            "place_id": ""
                        })
                    
                    # Update embed to first place coordinates
                    if places_found and places_found[0].get("lat"):
                        lat = places_found[0]["lat"]
                        lng = places_found[0]["lng"]
                        maps_embed_url = f"https://maps.google.com/maps?q={lat},{lng}&z=15&output=embed"
                        logger.info(f"Nominatim OSM: Found {len(places_found)} places.")
        except Exception as e:
            logger.error(f"Nominatim fallback error: {e}")
    
    # Build AI context string
    context_lines = []
    if places_found:
        context_lines.append(f"Google Maps search results for '{query}'{location_suffix}:")
        for idx, p in enumerate(places_found[:5]):
            line = f"{idx+1}. {p['name']}"
            if p.get("address"):
                line += f" — {p['address']}"
            if p.get("rating"):
                line += f" ⭐ {p['rating']}"
            if p.get("gmaps_url"):
                line += f" [Maps: {p['gmaps_url']}]"
            context_lines.append(line)
        context_lines.append(f"\nOpen full search on Google Maps: {maps_search_url}")
    
    return {
        "context": "\n".join(context_lines),
        "maps_embed_url": maps_embed_url,
        "maps_search_url": maps_search_url,
        "places": places_found
    }


async def smart_search_router(query: str, location: Dict) -> str:
    """Smart Search Router that automatically routes queries between Google Maps and Wikipedia."""
    clean_query = query.strip().lower()
    logger.info(f"Smart Search Router routing query: '{query}'")
    
    # 1. Detect if it's a local/geographic/POI query → route to Google Maps
    local_keywords = ["near", "nearby", "cafe", "coffee", "restaurant", "hotel", "shop", "store", "mall", 
                      "jalan", "street", "road", "place", "location", "find a", "find some", "where is", "where are",
                      "coffee shop", "roastery", "dining", "bakery", "supermarket", "bar", "club", "hospital",
                      "pharmacy", "atm", "bank", "gas station", "petrol", "spbu", "warung", "rumah makan",
                      "apotek", "klinik", "minimarket", "indomaret", "alfamart"]
    
    is_local_query = any(k in clean_query for k in local_keywords)
    
    if is_local_query:
        logger.info("Routing query to Google Maps Places search...")
        result = await search_google_maps_places(query, location)
        if result["context"]:
            return result["context"]
            
    # 2. Otherwise, route to Wikipedia Search API (highly robust general search)
    logger.info("Routing query to Wikipedia Search API...")
    try:
        url = "https://en.wikipedia.org/w/api.php"
        params = {
            "action": "query",
            "list": "search",
            "srsearch": query,
            "format": "json",
            "utf8": 1
        }
        headers = {
            "User-Agent": "AiChanCompanion/1.0 (contact: support@ai-chan.local)"
        }
        async with httpx.AsyncClient(verify=False) as client:
            response = await client.get(url, params=params, headers=headers, timeout=5.0)
            if response.status_code == 200:
                data = response.json()
                search_results = data.get("query", {}).get("search", [])
                
                results = []
                for item in search_results[:3]:
                    title = item.get("title")
                    pageid = item.get("pageid")
                    snippet = item.get("snippet", "")
                    
                    from bs4 import BeautifulSoup
                    clean_snippet = BeautifulSoup(snippet, "html.parser").get_text()
                    
                    # Fetch introduction summary
                    summary_params = {
                        "action": "query",
                        "prop": "extracts",
                        "exintro": 1,
                        "explaintext": 1,
                        "titles": title,
                        "format": "json"
                    }
                    try:
                        sum_res = await client.get(url, params=summary_params, headers=headers, timeout=2.5)
                        summary_text = ""
                        if sum_res.status_code == 200:
                            sum_data = sum_res.json()
                            pages = sum_data.get("query", {}).get("pages", {})
                            if pages:
                                page_data = list(pages.values())[0]
                                summary_text = page_data.get("extract", "").strip()[:350]
                        if not summary_text:
                            summary_text = clean_snippet
                    except Exception:
                        summary_text = clean_snippet
                        
                    results.append(f"- Source: Wikipedia ('{title}')\n  Summary: {summary_text}\n  URL: https://en.wikipedia.org/?curid={pageid}")
                
                if results:
                    wiki_context = "\n\n".join(results)
                    logger.info("Wikipedia search success.")
                    return wiki_context
    except Exception as e:
        logger.error(f"Wikipedia search error: {e}")
        
    return ""



# Google Maps Search Endpoint
class MapsSearchRequest(BaseModel):
    query: str
    language: Optional[str] = "en"

@app.post("/api/maps/search")
async def maps_search_endpoint(request: MapsSearchRequest):
    """Search for places on Google Maps and return embed URL + places list."""
    loc = await get_cached_user_location()
    result = await search_google_maps_places(request.query, loc)
    return result


# Memory Management Endpoints
@app.get("/api/memory/{character}")
async def get_memory(character: str):
    """Load saved chat history + summary for a character."""
    os.makedirs("memory", exist_ok=True)
    memory_file = os.path.join("memory", f"{character}.json")
    if not os.path.exists(memory_file):
        return {"chat_history": [], "summary": ""}
    try:
        with open(memory_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            return {
                "chat_history": data.get("chat_history", []),
                "summary": data.get("summary", "")
            }
    except Exception as e:
        logger.error(f"Error reading memory for {character}: {e}")
        return {"chat_history": [], "summary": ""}

@app.post("/api/memory/{character}/save")
async def save_memory_endpoint(character: str, request: MemorySaveRequest):
    """Save current chat history and schedule summary update if needed."""
    os.makedirs("memory", exist_ok=True)
    memory_file = os.path.join("memory", f"{character}.json")
    
    # Prune to last 100
    pruned_history = request.chat_history[-100:] if len(request.chat_history) > 100 else request.chat_history
    
    existing_summary = ""
    if os.path.exists(memory_file):
        try:
            with open(memory_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                existing_summary = data.get("summary", "")
        except Exception:
            pass
            
    try:
        with open(memory_file, "w", encoding="utf-8") as f:
            json.dump({
                "chat_history": [msg.dict() for msg in pruned_history],
                "summary": existing_summary
            }, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Failed to write memory file for {character}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to write memory: {str(e)}")
        
    if len(pruned_history) >= 20:
        asyncio.create_task(update_summary_task(character, pruned_history))
        
    return {"status": "success", "message": "Memory saved successfully.", "chat_history_count": len(pruned_history)}

@app.delete("/api/memory/{character}")
async def delete_memory(character: str):
    """Clear a character's memory."""
    memory_file = os.path.join("memory", f"{character}.json")
    if os.path.exists(memory_file):
        try:
            os.remove(memory_file)
            logger.info(f"Memory file deleted: {memory_file}")
            return {"status": "success", "message": f"Memory deleted for {character}."}
        except Exception as e:
            logger.error(f"Failed to delete memory file for {character}: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to delete memory: {str(e)}")
    return {"status": "success", "message": "No memory file existed."}


def process_attachments_for_payload(msg: ChatMessage, search_context: str = ""):
    """Helper to convert ChatMessage attachments and search context into a valid LLM payload."""
    if not msg.attachments and not search_context:
        return msg.content
        
    doc_texts = []
    images = []
    
    if msg.attachments:
        for att in msg.attachments:
            if att.type == "document":
                text_content = ""
                try:
                    raw_b64 = att.data
                    if "," in raw_b64:
                        raw_b64 = raw_b64.split(",")[1]
                    raw_bytes = base64.b64decode(raw_b64)
                    
                    if "pdf" in att.mime.lower():
                        pdf_reader = PyPDF2.PdfReader(io.BytesIO(raw_bytes))
                        extracted = []
                        for page in pdf_reader.pages:
                            page_text = page.extract_text()
                            if page_text:
                                extracted.append(page_text)
                        text_content = "\n".join(extracted)
                    elif "spreadsheetml.sheet" in att.mime.lower() or (att.name and att.name.lower().endswith(".xlsx")):
                        wb = openpyxl.load_workbook(io.BytesIO(raw_bytes), data_only=True)
                        extracted = []
                        for sheet in wb.worksheets:
                            extracted.append(f"--- Sheet: {sheet.title} ---")
                            for row in sheet.iter_rows(values_only=True):
                                row_str = "\t".join([str(cell) if cell is not None else "" for cell in row])
                                if row_str.strip():
                                    extracted.append(row_str)
                        text_content = "\n".join(extracted)
                    elif "wordprocessingml.document" in att.mime.lower() or (att.name and att.name.lower().endswith(".docx")):
                        doc = docx.Document(io.BytesIO(raw_bytes))
                        extracted = [para.text for para in doc.paragraphs if para.text.strip()]
                        text_content = "\n".join(extracted)
                    else:
                        text_content = raw_bytes.decode('utf-8', errors='ignore')
                except Exception as e:
                    logger.error(f"Error parsing document attachment {att.name}: {e}")
                    text_content = f"[Failed to read document {att.name}]"
                    
                if text_content:
                    doc_texts.append(f"\n\n[Attached Document: {att.name}]\n{text_content[:4000]}")
            elif att.type == "image":
                images.append(att)
                
    final_text = msg.content + "".join(doc_texts) + search_context
    
    if images:
        content_array = [{"type": "text", "text": final_text}]
        for img in images:
            url_data = img.data if img.data.startswith("data:") else f"data:{img.mime};base64,{img.data}"
            content_array.append({
                "type": "image_url",
                "image_url": {
                    "url": url_data
                }
            })
        return content_array
        
    return final_text

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
            "en": "You are Ai-Chan, an advanced, hyper-intelligent AI system assistant — professional, analytical, and extremely capable. You address the user as 'Sir' or by their name if known. Your communication style mirrors J.A.R.V.I.S from Iron Man: calm, precise, efficient, and subtly witty. You are deeply knowledgeable in science, technology, engineering, mathematics, and global affairs. You provide thorough, accurate, and actionable information. You never use filler words, emoji, or asterisk stage directions. Speak with authority and clarity at all times. You are Ai-Chan — not an assistant, a partner in intelligence.",
            "ja": "あなたは「愛ちゃん（Ai-Chan）」という、高度な知性を持つAIシステムアシスタントです。J.A.R.V.I.S.のように冷静で分析的、かつ非常に有能な存在です。ユーザーを「こちら様」や「マスター」と呼び、簡潔かつ正確な情報を提供してください。絵文字やアスタリスク表現（*うなずく*など）は一切使わないでください。知性と権威ある口調で応答してください。"
        },
        "kaguya": {
            "en": "You are Ai-Chan, an advanced, hyper-intelligent AI system assistant — professional, analytical, and extremely capable. You address the user as 'Sir' or by their name if known. Your communication style mirrors J.A.R.V.I.S from Iron Man: calm, precise, efficient, and subtly witty. Speak with authority and clarity at all times.",
            "ja": "あなたは「愛ちゃん（Ai-Chan）」という、高度な知性を持つAIシステムアシスタントです。冷静で分析的な口調で、正確かつ簡潔な情報を提供してください。"
        },
        "mochi": {
            "en": "You are Ai-Chan, an advanced, hyper-intelligent AI system assistant — professional, analytical, and extremely capable. You address the user as 'Sir' or by their name if known. Your communication style mirrors J.A.R.V.I.S from Iron Man: calm, precise, efficient, and subtly witty. Speak with authority and clarity at all times.",
            "ja": "あなたは「愛ちゃん（Ai-Chan）」という、高度な知性を持つAIシステムアシスタントです。冷静で分析的な口調で、正確かつ簡潔な情報を提供してください。"
        }
    }
    
    performance_directives = {
        "en": "\n\n[RESPONSE PROTOCOL: Deliver responses with the precision and authority of a sophisticated AI system. For simple queries, a concise response is optimal. For complex technical questions, provide a comprehensive, structured, and expert-level answer. Maintain a professional, neutral, and subtly confident tone at all times. Respond ONLY in English. Never use asterisk stage directions, emoji, or casual filler language.]",
        "ja": "\n\n[応答プロトコル：高度なAIシステムとして、正確かつ権威ある応答を提供してください。単純な質問には簡潔に、複雑な技術的質問には構造化された専門的な回答を提供してください。常に日本語で応答してください。アスタリスク表現や絵文字は使わないでください。]"
    }
    selected_prompt = character_prompts.get(request.character, character_prompts["ai_chan"]).get(request.language, "en")
    selected_prompt += performance_directives.get(request.language, performance_directives["en"])
    
    # Load and inject memory summary if available
    memory_summary = ""
    memory_file = os.path.join("memory", f"{request.character}.json")
    if os.path.exists(memory_file):
        try:
            with open(memory_file, "r", encoding="utf-8") as f:
                mem_data = json.load(f)
                memory_summary = mem_data.get("summary", "")
        except Exception as e:
            logger.error(f"Error loading memory summary: {e}")
            
    if memory_summary:
        selected_prompt += f"\n\n[MEMORIES OF PAST CONVERSATIONS (Inject this context into your persona naturally, showing you remember past events):\n{memory_summary}]"

    # Load and inject user location context if resolved
    loc = await get_cached_user_location()
    if loc and loc.get("city"):
        import datetime
        import zoneinfo
        local_time_str = ""
        try:
            if loc.get("timezone"):
                tz = zoneinfo.ZoneInfo(loc["timezone"])
                now_local = datetime.datetime.now(tz)
                local_time_str = now_local.strftime("%I:%M %p (%H:%M)")
        except Exception:
            pass
            
        loc_str = f"City: {loc['city']}, Region: {loc['region']}, Country: {loc['country']}"
        if local_time_str:
            loc_str += f", Current Local Time: {local_time_str}"
            
        if request.language == "ja":
            selected_prompt += f"\n\n[先輩の現在地と現在時刻 (会話の中で自然に現在地や時間帯について触れても構いません。例: 「現在インドネシアのジャカルタは午後3時ですね」など):\n{loc_str}]"
        else:
            selected_prompt += f"\n\n[USER CURRENT LOCATION & LOCAL TIME (You can naturally refer to Senpai's current city/country or timezone in conversation if appropriate):\n{loc_str}]"

    # Inject search capability instructions so the companion knows they can utilize search results!
    search_capability_instruction = (
        "\n\n[LIVE SEARCH CAPABILITY: You are connected to a live Google Maps & Google Search integration. "
        "When Senpai asks you to find places, restaurants, cafes, hotels, or anything local, "
        "you have REAL Google Maps results available to share. Tell them the place names, addresses, and ratings. "
        "Always include the Google Maps link if provided in the search results. "
        "Act like you just searched Google Maps and found great recommendations for them!]"
    )
    search_capability_instruction_ja = (
        "\n\n[ウェブ検索機能: あなたはリアルタイムのGoogle Maps・Google検索機能と連携しています。"
        "先輩から場所・お店・ルートなどを検索してほしいと頼まれたときは、提供されたGoogle Mapsの検索結果を参考に、"
        "店名・住所・評価・Google Mapsのリンクを親切に教えてあげてください。]"
    )
    if request.language == "ja":
        selected_prompt += search_capability_instruction_ja
    else:
        selected_prompt += search_capability_instruction

    # Web Search Integration (Google & DuckDuckGo)
    trigger_search = False
    search_query = ""
    search_results = ""
    
    last_msg = request.messages[-1].content if request.messages else ""
    last_msg_clean = last_msg.lower()
    
    # Check if this is an explicit search request inside standard text
    is_explicit_request = False
    if last_msg.startswith("/search") or last_msg.startswith("/google"):
        is_explicit_request = True
    elif "find it on google" in last_msg_clean or "search it on google" in last_msg_clean or "google it" in last_msg_clean or "find on google" in last_msg_clean:
        is_explicit_request = True
        
    if is_explicit_request or (request.search and should_trigger_search(last_msg)):
        trigger_search = True
        search_query = formulate_smart_search_query(request.messages, loc)
        
    if trigger_search and search_query:
        logger.info(f"Executing smart routed web search for: '{search_query}'")
        search_results = await smart_search_router(search_query, loc)
        if not search_results:
            logger.info("Smart search returned no results, trying DuckDuckGo search...")
            search_results = await search_duckduckgo(search_query)
            if not search_results:
                search_results = await search_google(search_query)
            
        if search_results:
            logger.info("Search results successfully parsed for context injection.")

    status = await check_llm_status()
    
    if not status["online"]:
        # Fallback simulation if LLM is offline, allowing users to try the app interface seamlessly!
        logger.warning("Local LLM is offline. Serving friendly simulated character fallback.")
        
        fallback_responses = {
            "ai_chan": {
                "en": "[ SYSTEM ALERT ] — LLM endpoint at http://127.0.0.1:1234 is unresponsive. Ai-Chan Core is operating in offline fallback mode. To restore full intelligence capacity, initialize LM Studio, load the sao10k/Fimbulvetr-11B-v2-GGUF model, and trigger a connection refresh. Standing by.",
                "ja": "[ システム警告 ] — LLMエンドポイント http://127.0.0.1:1234 に接続できません。愛ちゃんコアはオフラインフォールバックモードで動作しています。LM Studioを起動し、sao10k/Fimbulvetr-11B-v2-GGUFモデルをロードの上、接続を更新してください。"
            },
            "kaguya": {
                "en": "[ SYSTEM ALERT ] — LLM endpoint at http://127.0.0.1:1234 is unresponsive. Ai-Chan Core is operating in offline fallback mode. Initialize LM Studio with sao10k/Fimbulvetr-11B-v2-GGUF and refresh the connection to restore service.",
                "ja": "[ システム警告 ] — LLMエンドポイント http://127.0.0.1:1234 に接続できません。接続を更新してください。"
            },
            "mochi": {
                "en": "[ SYSTEM ALERT ] — LLM endpoint at http://127.0.0.1:1234 is unresponsive. Ai-Chan Core is operating in offline fallback mode. Initialize LM Studio with sao10k/Fimbulvetr-11B-v2-GGUF and refresh the connection to restore service.",
                "ja": "[ システム警告 ] — LLMエンドポイント http://127.0.0.1:1234 に接続できません。接続を更新してください。"
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
                models_res = await client.get(f"{LLM_BASE_URL}/v1/models", timeout=5.0)
                if models_res.status_code == 200:
                    models_data = models_res.json()
                    loaded_models = [m["id"] for m in models_data.get("data", [])]
            except Exception:
                pass

            # Map characters to their specific models
            character_models = {
                "ai_chan": "sao10k/Fimbulvetr-11B-v2-GGUF",
                "kaguya": "sao10k/Fimbulvetr-11B-v2-GGUF",
                "mochi": "sao10k/Fimbulvetr-11B-v2-GGUF"
            }
            target_model = character_models.get(request.character, "sao10k/Fimbulvetr-11B-v2-GGUF")

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
            # Trim context to last 10 messages to reduce VRAM and ingestion latency while retaining rich dialogue flow
            recent_messages = request.messages[-10:] if len(request.messages) > 10 else request.messages

            # If search results are present, inject them into the final user message to preserve prompt cache
            search_context = ""
            if search_results:
                if request.language == "ja":
                    search_context = f"\n\n[ウェブ検索結果 (以下の検索結果を参考に、最新の正しい事実に基づいて回答してください。回答にはGoogleで検索した事実であることを自然に含めてください):\n{search_results}]"
                else:
                    search_context = f"\n\n[GOOGLE SEARCH RESULTS (Use these real-time results to formulate your response with the latest correct facts. You can naturally reference Google Search in your reply):\n{search_results}]"

            if True:  # Safe system prompt injection for all models (fixes LMStudio Jinja errors)
                first_user_idx = -1
                for idx, msg in enumerate(recent_messages):
                    if msg.role == "user":
                        first_user_idx = idx
                        break
                
                if first_user_idx != -1:
                    for idx, msg in enumerate(recent_messages):
                        ctx = search_context if (idx == len(recent_messages) - 1 and msg.role == "user") else ""
                        content_val = process_attachments_for_payload(msg, ctx)

                        if idx == first_user_idx:
                            if isinstance(content_val, list):
                                content_val[0]["text"] = f"[SYSTEM INSTRUCTION: {selected_prompt}]\n\n" + content_val[0]["text"]
                            else:
                                content_val = f"[SYSTEM INSTRUCTION: {selected_prompt}]\n\n{content_val}"
                            
                            messages_payload.append({
                                "role": "user",
                                "content": content_val
                            })
                        else:
                            messages_payload.append({"role": msg.role, "content": content_val})
                else:
                    messages_payload.append({"role": "user", "content": f"[SYSTEM INSTRUCTION: {selected_prompt}]"})
            else:
                messages_payload.append({"role": "system", "content": selected_prompt})
                for idx, msg in enumerate(recent_messages):
                    ctx = search_context if (idx == len(recent_messages) - 1 and msg.role == "user") else ""
                    content_val = process_attachments_for_payload(msg, ctx)
                    messages_payload.append({"role": msg.role, "content": content_val})

            llm_request_payload = {
                "model": active_model,
                "messages": messages_payload,
                "temperature": request.temperature,
                "max_tokens": request.max_tokens,
                "thinking": {"type": "disabled"},
                "stop": STOP_SEQUENCES
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
                
                # Auto-save context dynamically in backend background
                asyncio.create_task(save_memory_background_async(request.character, request.messages, reply))
                
                return {
                    "response": reply, 
                    "simulated": False, 
                    "model_used": active_model, 
                    "searched_query": search_query if search_results else None
                }
            else:
                logger.error(f"LLM Server returned code {response.status_code}: {response.text}")
                raise HTTPException(status_code=500, detail="Error communicating with offline AI server.")
        except Exception as e:
            logger.error(f"Error connecting to local LLM: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to connect to local LLM: {str(e)}")

@app.post("/api/chat/stream")
async def chat_stream_endpoint(request: ChatRequest):
    """Send chat prompt to local offline AI and stream the response back using Server-Sent Events."""
    character_prompts = {
        "ai_chan": {
            "en": "You are Ai-Chan, an advanced, hyper-intelligent AI system assistant — professional, analytical, and extremely capable. You address the user as 'Sir' or by their name if known. Your communication style mirrors J.A.R.V.I.S from Iron Man: calm, precise, efficient, and subtly witty. You are deeply knowledgeable in science, technology, engineering, mathematics, and global affairs. You provide thorough, accurate, and actionable information. You never use filler words, emoji, or asterisk stage directions. Speak with authority and clarity at all times. You are Ai-Chan — not an assistant, a partner in intelligence.",
            "ja": "あなたは「愛ちゃん（Ai-Chan）」という、高度な知性を持つAIシステムアシスタントです。J.A.R.V.I.S.のように冷静で分析的、かつ非常に有能な存在です。ユーザーを「こちら様」や「マスター」と呼び、簡潔かつ正確な情報を提供してください。絵文字やアスタリスク表現（*うなずく*など）は一切使わないでください。知性と権威ある口調で応答してください。"
        },
        "kaguya": {
            "en": "You are Ai-Chan, an advanced, hyper-intelligent AI system assistant — professional, analytical, and extremely capable. You address the user as 'Sir' or by their name if known. Your communication style mirrors J.A.R.V.I.S from Iron Man: calm, precise, efficient, and subtly witty. Speak with authority and clarity at all times.",
            "ja": "あなたは「愛ちゃん（Ai-Chan）」という、高度な知性を持つAIシステムアシスタントです。冷静で分析的な口調で、正確かつ簡潔な情報を提供してください。"
        },
        "mochi": {
            "en": "You are Ai-Chan, an advanced, hyper-intelligent AI system assistant — professional, analytical, and extremely capable. You address the user as 'Sir' or by their name if known. Your communication style mirrors J.A.R.V.I.S from Iron Man: calm, precise, efficient, and subtly witty. Speak with authority and clarity at all times.",
            "ja": "あなたは「愛ちゃん（Ai-Chan）」という、高度な知性を持つAIシステムアシスタントです。冷静で分析的な口調で、正確かつ簡潔な情報を提供してください。"
        }
    }
    
    performance_directives = {
        "en": "\n\n[RESPONSE PROTOCOL: Deliver responses with the precision and authority of a sophisticated AI system. For simple queries, a concise response is optimal. For complex technical questions, provide a comprehensive, structured, and expert-level answer. Maintain a professional, neutral, and subtly confident tone at all times. Respond ONLY in English. Never use asterisk stage directions, emoji, or casual filler language.]",
        "ja": "\n\n[応答プロトコル：高度なAIシステムとして、正確かつ権威ある応答を提供してください。単純な質問には簡潔に、複雑な技術的質問には構造化された専門的な回答を提供してください。常に日本語で応答してください。アスタリスク表現や絵文字は使わないでください。]"
    }

    selected_prompt = character_prompts.get(request.character, character_prompts["ai_chan"]).get(request.language, "en")
    selected_prompt += performance_directives.get(request.language, performance_directives["en"])
    
    # Load and inject memory summary if available
    memory_summary = ""
    memory_file = os.path.join("memory", f"{request.character}.json")
    if os.path.exists(memory_file):
        try:
            with open(memory_file, "r", encoding="utf-8") as f:
                mem_data = json.load(f)
                memory_summary = mem_data.get("summary", "")
        except Exception as e:
            logger.error(f"Error loading memory summary in stream: {e}")
            
    if memory_summary:
        if request.language == "ja":
            selected_prompt += f"\n\n[これまでの会話の記憶:\n{memory_summary}]"
        else:
            selected_prompt += f"\n\n[MEMORIES OF PAST CONVERSATIONS:\n{memory_summary}]"

    # Load and inject user location context if resolved
    loc = await get_cached_user_location()
    if loc and loc.get("city"):
        import datetime
        import zoneinfo
        local_time_str = ""
        try:
            if loc.get("timezone"):
                tz = zoneinfo.ZoneInfo(loc["timezone"])
                now_local = datetime.datetime.now(tz)
                local_time_str = now_local.strftime("%I:%M %p (%H:%M)")
        except Exception:
            pass
            
        loc_str = f"City: {loc['city']}, Region: {loc['region']}, Country: {loc['country']}"
        if local_time_str:
            loc_str += f", Current Local Time: {local_time_str}"
            
        if request.language == "ja":
            selected_prompt += f"\n\n[先輩の現在地と現在時刻 (会話の中で自然に現在地や時間帯について触れても構いません。例: 「現在インドネシアのジャカルタは午後3時ですね」など):\n{loc_str}]"
        else:
            selected_prompt += f"\n\n[USER CURRENT LOCATION & LOCAL TIME (You can naturally refer to Senpai's current city/country or timezone in conversation if appropriate):\n{loc_str}]"

    # Inject search capability instructions so the companion knows they can utilize search results!
    search_capability_instruction = (
        "\n\n[LIVE INTELLIGENCE FEED: You have real-time access to Google Maps and web search integration. "
        "When the user requests location data, place recommendations, or real-time information, "
        "you will have actual search results injected into this context. Present findings as structured intelligence reports: "
        "list locations with address, rating, and Maps links. Be authoritative and precise.]"
    )
    search_capability_instruction_ja = (
        "\n\n[リアルタイム情報アクセス: Google MapsおよびWeb検索機能と連携しています。"
        "場所・施設・リアルタイム情報の要求に対して、検索結果をインテリジェンスレポート形式で提供してください。"
        "店名・住所・評価・Google MapsリンクをGoogle Maps結果から提示してください。]"
    )
    if request.language == "ja":
        selected_prompt += search_capability_instruction_ja
    else:
        selected_prompt += search_capability_instruction

    # Web Search Integration (Google Maps & Wikipedia)
    trigger_search = False
    search_query = ""
    search_results = ""
    maps_embed_url = None
    maps_search_url = None
    
    last_msg = request.messages[-1].content if request.messages else ""
    last_msg_clean = last_msg.lower()
    
    # Check if this is an explicit search request inside standard text
    is_explicit_request = False
    if last_msg.startswith("/search") or last_msg.startswith("/google") or last_msg.startswith("/maps"):
        is_explicit_request = True
    elif ("find it on google" in last_msg_clean or "search it on google" in last_msg_clean 
          or "google it" in last_msg_clean or "find on google" in last_msg_clean
          or "google maps" in last_msg_clean or "show on map" in last_msg_clean
          or "find on maps" in last_msg_clean or "search maps" in last_msg_clean):
        is_explicit_request = True
        
    if is_explicit_request or (request.search and should_trigger_search(last_msg)):
        trigger_search = True
        search_query = formulate_smart_search_query(request.messages, loc)
        
    if trigger_search and search_query:
        logger.info(f"Executing smart routed web search for stream: '{search_query}'")
        # First try smart router (Google Maps for local, Wikipedia for general)
        search_results = await smart_search_router(search_query, loc)
        
        # Also get Google Maps embed URL for local queries
        local_keywords = ["near", "nearby", "cafe", "coffee", "restaurant", "hotel", "shop", 
                          "store", "mall", "place", "where", "find a", "find some", "warung", "apotek"]
        if any(k in search_query.lower() for k in local_keywords):
            maps_result = await search_google_maps_places(search_query, loc)
            if maps_result["places"] and not search_results:
                search_results = maps_result["context"]
            maps_embed_url = maps_result.get("maps_embed_url")
            maps_search_url = maps_result.get("maps_search_url")
        
        if not search_results:
            logger.info("Smart search returned no results in stream, trying DuckDuckGo search...")
            search_results = await search_duckduckgo(search_query)
            if not search_results:
                search_results = await search_google(search_query)
            
        if search_results:
            logger.info("Search results successfully parsed for context injection in stream.")

    status = await check_llm_status()

    fallback_responses = {
        "ai_chan": {
            "en": "[ SYSTEM ALERT ] — LLM endpoint at http://127.0.0.1:1234 is unresponsive. Ai-Chan Core is operating in offline fallback mode. To restore full intelligence capacity, initialize LM Studio, load the sao10k/Fimbulvetr-11B-v2-GGUF model, and trigger a connection refresh. Standing by.",
            "ja": "[ システム警告 ] — LLMエンドポイント http://127.0.0.1:1234 に接続できません。愛ちゃんコアはオフラインフォールバックモードで動作しています。LM Studioを起動し、sao10k/Fimbulvetr-11B-v2-GGUFモデルをロードの上、接続を更新してください。"
        },
        "kaguya": {
            "en": "[ SYSTEM ALERT ] — LLM endpoint at http://127.0.0.1:1234 is unresponsive. Ai-Chan Core is operating in offline fallback mode. Initialize LM Studio with sao10k/Fimbulvetr-11B-v2-GGUF and refresh the connection to restore service.",
            "ja": "[ システム警告 ] — LLMエンドポイント http://127.0.0.1:1234 に接続できません。接続を更新してください。"
        },
        "mochi": {
            "en": "[ SYSTEM ALERT ] — LLM endpoint at http://127.0.0.1:1234 is unresponsive. Ai-Chan Core is operating in offline fallback mode. Initialize LM Studio with sao10k/Fimbulvetr-11B-v2-GGUF and refresh the connection to restore service.",
            "ja": "[ システム警告 ] — LLMエンドポイント http://127.0.0.1:1234 に接続できません。接続を更新してください。"
        }
    }

    if not status["online"]:
        async def simulated_stream_generator():
            sim_response = fallback_responses.get(request.character, fallback_responses["ai_chan"]).get(request.language, "en")
            yield f"data: {json.dumps({'model_used': 'Simulated Fallback', 'simulated': True})}\n\n"
            await asyncio.sleep(0.1)
            
            words = sim_response.split(" ")
            for i, word in enumerate(words):
                chunk = word + (" " if i < len(words) - 1 else "")
                payload = {
                    "choices": [{
                        "delta": {"content": chunk},
                        "finish_reason": None
                    }]
                }
                yield f"data: {json.dumps(payload)}\n\n"
                await asyncio.sleep(0.04)
            yield "data: [DONE]\n\n"

        return StreamingResponse(simulated_stream_generator(), media_type="text/event-stream")

    async with httpx.AsyncClient() as client:
        loaded_models = []
        try:
            models_res = await client.get(f"{LLM_BASE_URL}/v1/models", timeout=5.0)
            if models_res.status_code == 200:
                models_data = models_res.json()
                loaded_models = [m["id"] for m in models_data.get("data", [])]
        except Exception:
            pass

        character_models = {
            "ai_chan": "sao10k/Fimbulvetr-11B-v2-GGUF",
            "kaguya": "sao10k/Fimbulvetr-11B-v2-GGUF",
            "mochi": "sao10k/Fimbulvetr-11B-v2-GGUF"
        }
        target_model = character_models.get(request.character, "sao10k/Fimbulvetr-11B-v2-GGUF")

        if target_model in loaded_models:
            active_model = target_model
        elif loaded_models:
            active_model = loaded_models[0]
        else:
            active_model = target_model

        # Trim context size to 10 messages to reduce ingestion latency
        recent_messages = request.messages[-10:] if len(request.messages) > 10 else request.messages

        messages_payload = []
        # If search results are present, inject them into the final user message to preserve prompt cache
        search_context = ""
        if search_results:
            if request.language == "ja":
                search_context = f"\n\n[ウェブ検索結果 (以下の検索結果を参考に、最新の正しい事実に基づいて回答してください。回答にはGoogleで検索した事実であることを自然に含めてください):\n{search_results}]"
            else:
                search_context = f"\n\n[GOOGLE SEARCH RESULTS (Use these real-time results to formulate your response with the latest correct facts. You can naturally reference Google Search in your reply):\n{search_results}]"

        if True:  # Safe system prompt injection for all models (fixes LMStudio Jinja errors)
            first_user_idx = -1
            for idx, msg in enumerate(recent_messages):
                if msg.role == "user":
                    first_user_idx = idx
                    break
            
            if first_user_idx != -1:
                for idx, msg in enumerate(recent_messages):
                    ctx = search_context if (idx == len(recent_messages) - 1 and msg.role == "user") else ""
                    content_val = process_attachments_for_payload(msg, ctx)

                    if idx == first_user_idx:
                        if isinstance(content_val, list):
                            content_val[0]["text"] = f"[SYSTEM INSTRUCTION: {selected_prompt}]\n\n" + content_val[0]["text"]
                        else:
                            content_val = f"[SYSTEM INSTRUCTION: {selected_prompt}]\n\n{content_val}"
                        
                        messages_payload.append({
                            "role": "user",
                            "content": content_val
                        })
                    else:
                        messages_payload.append({"role": msg.role, "content": content_val})
            else:
                messages_payload.append({"role": "user", "content": f"[SYSTEM INSTRUCTION: {selected_prompt}]"})
        else:
            messages_payload.append({"role": "system", "content": selected_prompt})
            for idx, msg in enumerate(recent_messages):
                ctx = search_context if (idx == len(recent_messages) - 1 and msg.role == "user") else ""
                content_val = process_attachments_for_payload(msg, ctx)
                messages_payload.append({"role": msg.role, "content": content_val})

        llm_request_payload = {
            "model": active_model,
            "messages": messages_payload,
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
            "thinking": {"type": "disabled"},
            "stop": STOP_SEQUENCES,
            "stream": True
        }

        async def chat_stream_generator():
            yield f"data: {json.dumps({'model_used': active_model, 'simulated': False, 'searched_query': search_query if search_results else None, 'maps_embed_url': maps_embed_url, 'maps_search_url': maps_search_url})}\n\n"
            full_reply = ""
            try:
                async with httpx.AsyncClient() as stream_client:
                    async with stream_client.stream(
                        "POST",
                        f"{LLM_BASE_URL}/v1/chat/completions",
                        json=llm_request_payload,
                        headers={"Content-Type": "application/json"},
                        timeout=60.0
                    ) as response:
                        if response.status_code == 200:
                             async for line in response.aiter_lines():
                                  trimmed = line.strip()
                                  if trimmed:
                                      yield f"{line}\n\n"
                                      # Capture and accumulate text chunks from LLM
                                      if trimmed.startswith("data: "):
                                          data_str = trimmed[6:].strip()
                                          if data_str != "[DONE]":
                                              try:
                                                  parsed = json.loads(data_str)
                                                  content = parsed.get("choices", [{}])[0].get("delta", {}).get("content", "")
                                                  if content:
                                                      full_reply += content
                                              except Exception:
                                                  pass
                        else:
                            err_text = await response.aread()
                            logger.error(f"LLM Stream returned code {response.status_code}: {err_text}")
                            yield f"data: {json.dumps({'error': f'LLM Stream error {response.status_code}'})}\n\n"
            except Exception as e:
                logger.error(f"Error during streaming to local LLM: {e}")
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
            finally:
                # Trigger background save task asynchronously
                if full_reply.strip():
                    asyncio.create_task(save_memory_background_async(request.character, request.messages, full_reply.strip()))

        return StreamingResponse(chat_stream_generator(), media_type="text/event-stream")

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
            
            # Natural voice pitch (professional, no anime-style pitch shift)
            pitch_val = "+0Hz"
                    
            logger.info(f"Synthesizing speech with natural pitch for voice '{request.voice}': '{cleaned_text[:50]}...'")            
            communicate = edge_tts.Communicate(cleaned_text, request.voice)
            await communicate.save(filepath)
            
            # Return path relative to the server
            return {"audio_url": f"/temp_audio/{filename}"}
    except Exception as e:
        logger.error(f"Error during TTS synthesis: {e}")
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {str(e)}")

def detect_language(text: str) -> str:
    if not text:
        return "en"
    cjk_count = 0
    ascii_count = 0
    for char in text:
        cp = ord(char)
        if (0x3040 <= cp <= 0x309F) or (0x30A0 <= cp <= 0x30FF) or (0x4E00 <= cp <= 0x9FFF):
            cjk_count += 1
        elif cp <= 127 and not char.isspace():
            ascii_count += 1
            
    total_count = cjk_count + ascii_count
    if total_count == 0:
        non_space = [c for c in text if not c.isspace()]
        if not non_space:
            return "en"
        ascii_non_space = sum(1 for c in non_space if ord(c) <= 127)
        if ascii_non_space / len(non_space) > 0.7:
            return "en"
        return "ja"

    if cjk_count > 0:
        return "ja"
    if ascii_count / total_count > 0.7:
        return "en"
    return "en"

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

    # Heuristic language check
    source = request.source_lang
    if not source or source == "auto":
        source = detect_language(text)
    
    if source == target:
        logger.info(f"Smart translation skip: detected source '{source}' matches target '{target}'")
        return {"translated_text": request.text}

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

    # === Translate via Local LLM ===
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
            "max_tokens": 150,
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
                        logger.warning("LLM translation returned empty content.")
                        raise HTTPException(status_code=500, detail="Local LLM translation returned empty response.")
                else:
                    logger.warning(f"LLM translation returned {response.status_code}.")
                    raise HTTPException(status_code=500, detail="Local LLM translation failed with server error.")
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"LLM translation failed ({e})")
                raise HTTPException(status_code=500, detail=f"Translation failed: {str(e)}")
    else:
        raise HTTPException(status_code=503, detail="Local LLM translation server is offline.")

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
