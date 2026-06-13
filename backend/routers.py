from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Optional
import asyncio
import json
from . import database
from . import research_agent

router = APIRouter()

# --- Schemas ---
class NoteCreate(BaseModel):
    title: str
    content: str

class NoteUpdate(BaseModel):
    title: str
    content: str

class TaskCreate(BaseModel):
    content: str
    due_date: Optional[str] = None

class TaskUpdate(BaseModel):
    status: str

class EventCreate(BaseModel):
    title: str
    description: str
    start_time: str
    end_time: str

class ResearchRequest(BaseModel):
    query: str
    llm_base_url: str = "http://127.0.0.1:1234"
    model: str = "sao10k/Fimbulvetr-11B-v2-GGUF"

# --- Notes Endpoints ---
@router.get("/api/notes")
def get_notes():
    return {"notes": database.get_notes()}

@router.post("/api/notes")
def create_note(note: NoteCreate):
    note_id = database.create_note(note.title, note.content)
    return {"id": note_id, "message": "Note created"}

@router.put("/api/notes/{note_id}")
def update_note(note_id: int, note: NoteUpdate):
    database.update_note(note_id, note.title, note.content)
    return {"message": "Note updated"}

@router.delete("/api/notes/{note_id}")
def delete_note(note_id: int):
    database.delete_note(note_id)
    return {"message": "Note deleted"}

# --- Tasks Endpoints ---
@router.get("/api/tasks")
def get_tasks():
    return {"tasks": database.get_tasks()}

@router.post("/api/tasks")
def create_task(task: TaskCreate):
    task_id = database.create_task(task.content, task.due_date)
    return {"id": task_id, "message": "Task created"}

@router.put("/api/tasks/{task_id}")
def update_task(task_id: int, task_update: TaskUpdate):
    database.update_task_status(task_id, task_update.status)
    return {"message": "Task updated"}

@router.delete("/api/tasks/{task_id}")
def delete_task(task_id: int):
    database.delete_task(task_id)
    return {"message": "Task deleted"}

# --- Calendar Endpoints ---
@router.get("/api/calendar")
def get_events():
    return {"events": database.get_events()}

@router.post("/api/calendar")
def create_event(event: EventCreate):
    event_id = database.create_event(event.title, event.description, event.start_time, event.end_time)
    return {"id": event_id, "message": "Event created"}

@router.delete("/api/calendar/{event_id}")
def delete_event(event_id: int):
    database.delete_event(event_id)
    return {"message": "Event deleted"}

# --- Deep Research Streaming Endpoint ---
@router.post("/api/research/stream")
async def research_stream(req: ResearchRequest):
    async def event_generator():
        progress_messages = []

        async def on_progress(msg: str):
            progress_messages.append(msg)
            payload = json.dumps({"type": "progress", "message": msg})
            yield f"data: {payload}\n\n"

        # We need to iterate as the agent progresses
        queue = asyncio.Queue()

        async def on_progress_queue(msg: str):
            await queue.put({"type": "progress", "message": msg})

        async def run_agent():
            report = await research_agent.search_and_summarize(
                req.query, req.llm_base_url, req.model, on_progress=on_progress_queue
            )
            await queue.put({"type": "report", "content": report})
            await queue.put(None)  # sentinel

        task = asyncio.create_task(run_agent())

        while True:
            item = await queue.get()
            if item is None:
                break
            yield f"data: {json.dumps(item)}\n\n"

        await task

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# --- User Context Endpoints (location, weather, preferences) ---
class ContextSet(BaseModel):
    value: str

@router.get("/api/context")
def get_all_context():
    return {"context": database.get_all_context()}

@router.get("/api/context/{key}")
def get_context(key: str):
    row = database.get_context(key)
    if not row:
        raise HTTPException(status_code=404, detail="Context key not found")
    return row

@router.put("/api/context/{key}")
def set_context(key: str, body: ContextSet):
    database.set_context(key, body.value)
    return {"message": "Context saved", "key": key}

@router.delete("/api/context/{key}")
def delete_context(key: str):
    database.delete_context(key)
    return {"message": "Context deleted", "key": key}

# --- Chat History Endpoints ---
class ChatMessageAppend(BaseModel):
    session_id: str
    character: str
    role: str
    content: str
    display_text: Optional[str] = None

@router.post("/api/chat_history")
def append_chat_message(msg: ChatMessageAppend):
    msg_id = database.append_chat_message(
        msg.session_id, msg.character, msg.role, msg.content, msg.display_text
    )
    return {"id": msg_id}

@router.get("/api/chat_history/{character}/{session_id}")
def get_chat_session(character: str, session_id: str, limit: int = 200):
    messages = database.get_chat_session(session_id, character, limit)
    return {"messages": messages}

@router.get("/api/chat_history/{character}")
def list_chat_sessions(character: str):
    sessions = database.list_chat_sessions(character)
    return {"sessions": sessions}

@router.delete("/api/chat_history/{character}/{session_id}")
def clear_chat_session(character: str, session_id: str):
    database.clear_chat_session(session_id, character)
    return {"message": "Session cleared"}
