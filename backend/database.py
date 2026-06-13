import sqlite3
import os
import logging
from datetime import datetime
from typing import List, Dict, Any

logger = logging.getLogger("ai-chan-db")

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "memory", "aichan_os.db")

def get_connection():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()
    
    # Notes Table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Tasks Table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            due_date TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Calendar Table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS calendar_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            start_time TIMESTAMP NOT NULL,
            end_time TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # User Context Table (location, weather, preferences)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS user_context (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Chat History Table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            character TEXT NOT NULL DEFAULT 'ai_chan',
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            display_text TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_history(session_id, character)')

    conn.commit()
    conn.close()
    logger.info("SQLite Database initialized successfully.")

# --- Notes CRUD ---
def create_note(title: str, content: str) -> int:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO notes (title, content) VALUES (?, ?)", (title, content))
    note_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return note_id

def get_notes() -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM notes ORDER BY updated_at DESC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def update_note(note_id: int, title: str, content: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE notes SET title=?, content=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", (title, content, note_id))
    conn.commit()
    conn.close()

def delete_note(note_id: int):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM notes WHERE id=?", (note_id,))
    conn.commit()
    conn.close()

# --- Tasks CRUD ---
def create_task(content: str, due_date: str = None) -> int:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO tasks (content, due_date) VALUES (?, ?)", (content, due_date))
    task_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return task_id

def get_tasks() -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM tasks ORDER BY status ASC, created_at DESC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def update_task_status(task_id: int, status: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE tasks SET status = ? WHERE id = ?", (status, task_id))
    conn.commit()
    conn.close()

def delete_task(task_id: int):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM tasks WHERE id=?", (task_id,))
    conn.commit()
    conn.close()

# --- Calendar CRUD ---
def create_event(title: str, description: str, start_time: str, end_time: str) -> int:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO calendar_events (title, description, start_time, end_time) VALUES (?, ?, ?, ?)",
                   (title, description, start_time, end_time))
    event_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return event_id

def get_events() -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM calendar_events ORDER BY start_time ASC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def delete_event(event_id: int):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM calendar_events WHERE id=?", (event_id,))
    conn.commit()
    conn.close()

# --- User Context CRUD (location, weather, preferences) ---
def set_context(key: str, value: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO user_context (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
        (key, value)
    )
    conn.commit()
    conn.close()

def get_context(key: str) -> Dict[str, Any]:
    """Returns dict with 'value' and 'updated_at', or None if not found."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value, updated_at FROM user_context WHERE key=?", (key,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def delete_context(key: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM user_context WHERE key=?", (key,))
    conn.commit()
    conn.close()

def get_all_context() -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT key, value, updated_at FROM user_context ORDER BY key ASC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

# --- Chat History CRUD ---
def append_chat_message(session_id: str, character: str, role: str, content: str, display_text: str = None) -> int:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO chat_history (session_id, character, role, content, display_text) VALUES (?, ?, ?, ?, ?)",
        (session_id, character, role, content, display_text or content)
    )
    msg_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return msg_id

def get_chat_session(session_id: str, character: str, limit: int = 200) -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, role, content, display_text, created_at FROM chat_history "
        "WHERE session_id=? AND character=? ORDER BY id ASC LIMIT ?",
        (session_id, character, limit)
    )
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def list_chat_sessions(character: str) -> List[Dict[str, Any]]:
    """Returns each unique session with its message count and last message time."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT session_id, COUNT(*) as msg_count, MAX(created_at) as last_msg "
        "FROM chat_history WHERE character=? GROUP BY session_id ORDER BY last_msg DESC",
        (character,)
    )
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def clear_chat_session(session_id: str, character: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM chat_history WHERE session_id=? AND character=?", (session_id, character))
    conn.commit()
    conn.close()

def delete_chat_message(msg_id: int):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM chat_history WHERE id=?", (msg_id,))
    conn.commit()
    conn.close()

# Run initialization when imported
init_db()
