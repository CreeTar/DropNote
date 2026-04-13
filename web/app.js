let token = localStorage.getItem('dropnote_token') || '';
const API_BASE = '__ADMIN_API_BASE__';

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

window.onTelegramAuth = async function onTelegramAuth(user) {
  const resp = await fetch(`${API_BASE}/auth/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user)
  });

  if (!resp.ok) {
    setStatus('Login fehlgeschlagen');
    return;
  }

  const data = await resp.json();
  token = data.token;
  localStorage.setItem('dropnote_token', token);
  setStatus(`Eingeloggt als @${data.username || data.userId}`);
  await loadEntries();
};

document.getElementById('loadBtn').addEventListener('click', () => loadEntries());
document.getElementById('exportBtn').addEventListener('click', () => exportCsv());

async function loadEntries() {
  if (!token) {
    setStatus('Bitte zuerst mit Telegram einloggen.');
    return;
  }

  const resp = await fetch(`${API_BASE}/entries`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!resp.ok) {
    setStatus('Fehler beim Laden');
    return;
  }

  const data = await resp.json();
  const tbody = document.querySelector('#table tbody');
  tbody.innerHTML = '';

  for (const entry of data.entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${entry.eventAt}</td>
      <td><input value="${entry.category || ''}" data-id="${entry.id}" data-field="category" /></td>
      <td><textarea data-id="${entry.id}" data-field="note">${entry.note}</textarea></td>
      <td>
        <button data-action="save" data-id="${entry.id}">Speichern</button>
        <button data-action="delete" data-id="${entry.id}">Löschen</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-action="save"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const note = tbody.querySelector(`textarea[data-id="${id}"][data-field="note"]`).value;
      const category = tbody.querySelector(`input[data-id="${id}"][data-field="category"]`).value || null;
      await fetch(`${API_BASE}/entries/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ note, category })
      });
      setStatus('Eintrag gespeichert');
    });
  });

  tbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      await fetch(`${API_BASE}/entries/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      await loadEntries();
    });
  });

  document.getElementById('table').classList.remove('hidden');
  setStatus(`${data.entries.length} Einträge geladen`);
}

async function exportCsv() {
  if (!token) return;
  const resp = await fetch(`${API_BASE}/entries/export.csv`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dropnote_export.csv';
  a.click();
  URL.revokeObjectURL(url);
}
