// ==========================================================================
// Ai-Chan OS — Notes, Tasks, Calendar, Research, Location
// Appended to app.js
// ==========================================================================

// ---- OS API Base (reuse window.API_BASE set by app.js init) ----
function osApi() { return (window.location.protocol === 'file:' || window.location.port !== '8000') ? 'http://127.0.0.1:8000' : ''; }

// ============================================================
// LOCATION SHARING
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const locationBtn = document.getElementById('location-btn');
    const chatInput = document.getElementById('chat-input');

    if (locationBtn) {
        locationBtn.addEventListener('click', async () => {
            if (!navigator.geolocation) {
                alert('[ SYSTEM ] Geolocation API not supported in this browser.');
                return;
            }
            locationBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            locationBtn.disabled = true;

            navigator.geolocation.getCurrentPosition(async (pos) => {
                const { latitude, longitude } = pos.coords;
                try {
                    const res = await fetch(
                        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`,
                        { headers: { 'User-Agent': 'AiChan-OS/1.0' } }
                    );
                    const data = await res.json();
                    const address = data.display_name || `${latitude}, ${longitude}`;
                    chatInput.value = `📍 My current location is: ${address}`;
                    chatInput.style.height = '24px';
                    chatInput.style.height = chatInput.scrollHeight + 'px';
                } catch (e) {
                    chatInput.value = `📍 My current location: ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
                }
                locationBtn.innerHTML = '<i class="fa-solid fa-location-dot"></i>';
                locationBtn.disabled = false;
                chatInput.focus();
            }, (err) => {
                alert('[ SYSTEM ] Location access denied or unavailable.');
                locationBtn.innerHTML = '<i class="fa-solid fa-location-dot"></i>';
                locationBtn.disabled = false;
            }, { timeout: 10000 });
        });
    }
});

// ============================================================
// VIEW SWITCHING (override previous stub)
// ============================================================
window.switchView = function(viewId) {
    document.querySelectorAll('.view-panel').forEach(el => {
        el.style.display = 'none';
    });
    const target = document.getElementById('view-' + viewId);
    if (target) {
        // chat uses flex-row (chat-wrapper + visualizer), OS panels use flex-column
        target.style.display = 'flex';
        target.style.flexDirection = viewId === 'chat' ? 'row' : 'column';
    }
    document.querySelectorAll('.nav-btn').forEach(btn => {
        const isActive = btn.getAttribute('onclick').includes(`'${viewId}'`);
        btn.style.background = isActive ? 'rgba(0,200,255,0.1)' : 'transparent';
        btn.style.border = isActive ? '1px solid var(--color-primary)' : '1px solid transparent';
        btn.style.color = isActive ? 'white' : 'rgba(255,255,255,0.6)';
    });

    if (viewId === 'notes') { loadNotes(); loadTasks(); }
    if (viewId === 'calendar') { renderCalendar(); loadEvents(); }
};

// ============================================================
// MODAL HELPERS
// ============================================================
let _activeNoteId = null;

window.openNoteModal = function(noteId, title, content) {
    _activeNoteId = noteId || null;
    document.getElementById('note-modal-title').textContent = noteId ? 'Edit Note' : 'New Note';
    document.getElementById('note-title-input').value = title || '';
    document.getElementById('note-content-input').value = content || '';
    document.getElementById('modal-overlay').style.display = 'block';
    document.getElementById('modal-note').style.display = 'flex';
    document.getElementById('modal-note').style.flexDirection = 'column';
};

window.openTaskModal = function() {
    document.getElementById('task-content-input').value = '';
    document.getElementById('task-due-input').value = '';
    document.getElementById('modal-overlay').style.display = 'block';
    document.getElementById('modal-task').style.display = 'flex';
    document.getElementById('modal-task').style.flexDirection = 'column';
};

window.openEventModal = function() {
    document.getElementById('event-title-input').value = '';
    document.getElementById('event-desc-input').value = '';
    document.getElementById('event-start-input').value = '';
    document.getElementById('event-end-input').value = '';
    document.getElementById('modal-overlay').style.display = 'block';
    document.getElementById('modal-event').style.display = 'flex';
    document.getElementById('modal-event').style.flexDirection = 'column';
};

window.closeModal = function() {
    document.getElementById('modal-overlay').style.display = 'none';
    ['modal-note', 'modal-task', 'modal-event'].forEach(id => {
        document.getElementById(id).style.display = 'none';
    });
    _activeNoteId = null;
};

// ============================================================
// NOTES
// ============================================================
async function loadNotes() {
    const list = document.getElementById('notes-list');
    list.innerHTML = '<div class="os-empty-state"><i class="fa-solid fa-spinner fa-spin"></i><span>Loading notes...</span></div>';
    const res = await fetch(`${osApi()}/api/notes`);
    const data = await res.json();
    if (!data.notes.length) {
        list.innerHTML = '<div class="os-empty-state"><i class="fa-solid fa-note-sticky"></i><span>No notes yet. Click + to create one.</span></div>';
        return;
    }
    list.innerHTML = data.notes.map(n => `
        <div class="os-card">
            <div class="os-card-title">
                <span>${escHtml(n.title)}</span>
                <div class="os-card-actions">
                    <button title="Edit" onclick="openNoteModal(${n.id}, ${JSON.stringify(n.title)}, ${JSON.stringify(n.content)})"><i class="fa-solid fa-pen"></i></button>
                    <button class="danger" title="Delete" onclick="deleteNote(${n.id})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            <div class="os-card-body">${escHtml(n.content.substring(0, 200))}${n.content.length > 200 ? '...' : ''}</div>
            <div class="os-card-meta">${new Date(n.updated_at).toLocaleString()}</div>
        </div>
    `).join('');
}

window.saveNote = async function() {
    const title = document.getElementById('note-title-input').value.trim();
    const content = document.getElementById('note-content-input').value.trim();
    if (!title || !content) return alert('[ SYSTEM ] Title and content required.');
    const method = _activeNoteId ? 'PUT' : 'POST';
    const url = _activeNoteId ? `${osApi()}/api/notes/${_activeNoteId}` : `${osApi()}/api/notes`;
    await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify({title, content}) });
    closeModal();
    loadNotes();
};

window.deleteNote = async function(id) {
    if (!confirm('[ SYSTEM ] Delete this note permanently?')) return;
    await fetch(`${osApi()}/api/notes/${id}`, { method: 'DELETE' });
    loadNotes();
};

// ============================================================
// TASKS
// ============================================================
async function loadTasks() {
    const list = document.getElementById('tasks-list');
    list.innerHTML = '<div class="os-empty-state"><i class="fa-solid fa-spinner fa-spin"></i><span>Loading tasks...</span></div>';
    const res = await fetch(`${osApi()}/api/tasks`);
    const data = await res.json();
    if (!data.tasks.length) {
        list.innerHTML = '<div class="os-empty-state"><i class="fa-solid fa-list-check"></i><span>No tasks. Click + to add one.</span></div>';
        return;
    }
    const pending = data.tasks.filter(t => t.status !== 'done');
    const done = data.tasks.filter(t => t.status === 'done');
    const renderTask = t => `
        <div class="os-card task-card ${t.status === 'done' ? 'done' : ''}">
            <div class="os-card-title">
                <span>${escHtml(t.content)}</span>
                <div class="os-card-actions">
                    <button title="${t.status === 'done' ? 'Mark Pending' : 'Mark Done'}"
                        onclick="toggleTask(${t.id}, '${t.status === 'done' ? 'pending' : 'done'}')">
                        <i class="fa-solid ${t.status === 'done' ? 'fa-rotate-left' : 'fa-check'}"></i>
                    </button>
                    <button class="danger" title="Delete" onclick="deleteTask(${t.id})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            ${t.due_date ? `<div class="os-card-meta"><i class="fa-solid fa-clock"></i> Due: ${new Date(t.due_date).toLocaleString()}</div>` : ''}
            <div style="margin-top:8px;"><span class="task-badge ${t.status}">${t.status.toUpperCase()}</span></div>
        </div>
    `;
    list.innerHTML = [...pending, ...done].map(renderTask).join('');
}

window.saveTask = async function() {
    const content = document.getElementById('task-content-input').value.trim();
    const due_date = document.getElementById('task-due-input').value || null;
    if (!content) return alert('[ SYSTEM ] Task content required.');
    await fetch(`${osApi()}/api/tasks`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({content, due_date}) });
    closeModal();
    loadTasks();
};

window.toggleTask = async function(id, newStatus) {
    await fetch(`${osApi()}/api/tasks/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({status: newStatus}) });
    loadTasks();
};

window.deleteTask = async function(id) {
    if (!confirm('[ SYSTEM ] Delete this task permanently?')) return;
    await fetch(`${osApi()}/api/tasks/${id}`, { method: 'DELETE' });
    loadTasks();
};

// ============================================================
// CALENDAR
// ============================================================
let _calYear = new Date().getFullYear();
let _calMonth = new Date().getMonth();
let _calEvents = [];

window.calNav = function(dir) {
    _calMonth += dir;
    if (_calMonth > 11) { _calMonth = 0; _calYear++; }
    if (_calMonth < 0) { _calMonth = 11; _calYear--; }
    renderCalendar();
};

async function loadEvents() {
    const res = await fetch(`${osApi()}/api/calendar`);
    const data = await res.json();
    _calEvents = data.events || [];
    renderEventsList();
    renderCalendar();
}

function renderCalendar() {
    const grid = document.getElementById('calendar-grid');
    const label = document.getElementById('cal-month-label');
    if (!grid || !label) return;

    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    label.textContent = `${months[_calMonth]} ${_calYear}`;

    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const today = new Date();
    const firstDay = new Date(_calYear, _calMonth, 1).getDay();
    const daysInMonth = new Date(_calYear, _calMonth + 1, 0).getDate();

    const eventDays = new Set(_calEvents.map(e => {
        const d = new Date(e.start_time);
        return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    }));

    let html = days.map(d => `<div class="cal-day-header">${d}</div>`).join('');
    for (let i = 0; i < firstDay; i++) html += `<div class="cal-day empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
        const isToday = d === today.getDate() && _calMonth === today.getMonth() && _calYear === today.getFullYear();
        const hasEvent = eventDays.has(`${_calYear}-${_calMonth}-${d}`);
        html += `<div class="cal-day${isToday ? ' today' : ''}">
            <span class="cal-day-num">${d}</span>
            ${hasEvent ? '<div class="cal-dot"></div>' : ''}
        </div>`;
    }
    grid.innerHTML = html;
}

function renderEventsList() {
    const list = document.getElementById('events-list');
    if (!list) return;
    if (!_calEvents.length) {
        list.innerHTML = '<div class="os-empty-state"><i class="fa-solid fa-calendar-xmark"></i><span>No events scheduled.</span></div>';
        return;
    }
    list.innerHTML = _calEvents.map(e => `
        <div class="os-card event-card">
            <div class="os-card-title">
                <span>${escHtml(e.title)}</span>
                <div class="os-card-actions">
                    <button class="danger" title="Delete" onclick="deleteEvent(${e.id})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            ${e.description ? `<div class="os-card-body">${escHtml(e.description)}</div>` : ''}
            <div class="os-card-meta">
                <i class="fa-solid fa-play"></i> ${new Date(e.start_time).toLocaleString()} &nbsp;→&nbsp;
                <i class="fa-solid fa-stop"></i> ${new Date(e.end_time).toLocaleString()}
            </div>
        </div>
    `).join('');
}

window.saveEvent = async function() {
    const title = document.getElementById('event-title-input').value.trim();
    const description = document.getElementById('event-desc-input').value.trim();
    const start_time = document.getElementById('event-start-input').value;
    const end_time = document.getElementById('event-end-input').value;
    if (!title || !start_time || !end_time) return alert('[ SYSTEM ] Title, start time, and end time are required.');
    await fetch(`${osApi()}/api/calendar`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({title, description, start_time, end_time}) });
    closeModal();
    loadEvents();
};

window.deleteEvent = async function(id) {
    if (!confirm('[ SYSTEM ] Delete this event permanently?')) return;
    await fetch(`${osApi()}/api/calendar/${id}`, { method: 'DELETE' });
    loadEvents();
};

// ============================================================
// DEEP RESEARCH
// ============================================================
window.runDeepResearch = async function() {
    const query = document.getElementById('research-query').value.trim();
    if (!query) return alert('[ SYSTEM ] Please enter a research query.');

    const btn = document.getElementById('research-run-btn');
    const progressBox = document.getElementById('research-progress');
    const reportBox = document.getElementById('research-report');

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running...';
    progressBox.style.display = 'block';
    progressBox.textContent = '';
    reportBox.style.display = 'none';
    reportBox.textContent = '';

    // Determine active model from page state
    const modelSelect = document.getElementById('target-model-select');
    const model = modelSelect ? modelSelect.value : 'sao10k/Fimbulvetr-11B-v2-GGUF';

    try {
        const res = await fetch(`${osApi()}/api/research/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, llm_base_url: 'http://127.0.0.1:1234', model })
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) continue;
                try {
                    const parsed = JSON.parse(trimmed.slice(6));
                    if (parsed.type === 'progress') {
                        progressBox.textContent += parsed.message + '\n';
                        progressBox.scrollTop = progressBox.scrollHeight;
                    } else if (parsed.type === 'report') {
                        reportBox.style.display = 'block';
                        reportBox.textContent = parsed.content;
                    }
                } catch (e) {}
            }
        }
    } catch (err) {
        progressBox.textContent += `\n❌ Connection error: ${err.message}`;
    }

    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-rocket"></i> Launch Research';
};

// ============================================================
// UTILS
// ============================================================
function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
