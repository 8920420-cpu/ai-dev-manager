// Логика экрана настройки БД оркестратора.
const $ = (id) => document.getElementById(id);
const FIELDS = ['host', 'port', 'database', 'adminDatabase', 'user', 'password'];

function collect() {
  const s = {};
  for (const f of FIELDS) s[f] = $(f).value;
  s.port = Number(s.port) || 5432;
  const url = $('url').value.trim();
  if (url) s.url = url;
  return s;
}

function fill(s) {
  for (const f of FIELDS) if (s[f] !== undefined) $(f).value = s[f];
  // Пароль сервер не отдаёт (см. redactSettings). Если он сохранён — показываем
  // это плейсхолдером; пустое поле при сохранении не затрёт существующий пароль.
  if (s.hasPassword !== undefined) {
    $('password').value = '';
    $('password').placeholder = s.hasPassword ? 'сохранён — оставьте пустым' : '••••••';
  }
}

function show(obj, ok) {
  const out = $('out');
  out.hidden = false;
  out.className = 'out ' + (ok ? 'ok' : 'err');
  out.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function busy(btn, fn) {
  const all = document.querySelectorAll('button');
  all.forEach((b) => (b.disabled = true));
  const old = btn.textContent;
  btn.textContent = '…';
  try {
    await fn();
  } catch (e) {
    show(String(e.message || e), false);
  } finally {
    all.forEach((b) => (b.disabled = false));
    btn.textContent = old;
  }
}

async function loadSettings() {
  const { data } = await api('/api/settings');
  fill(data);
}

async function refreshStatus() {
  const el = $('status');
  el.textContent = '…';
  const { data } = await api('/api/db/status');
  if (!data.connected) {
    el.innerHTML = `<span class="pill err">нет подключения</span><div style="margin-top:8px;color:var(--muted)">${
      data.error || ''
    }</div>`;
    return;
  }
  const rc = data.rowCounts || {};
  el.innerHTML = `
    <span class="pill ok">подключено</span>
    <table>
      <tr><td>База</td><td>${data.database}</td></tr>
      <tr><td>Таблиц</td><td>${data.tables}</td></tr>
      <tr><td>Применённые миграции</td><td>${(data.migrations || []).join(', ') || '—'}</td></tr>
      <tr><td>projects / services / roles</td><td>${rc.projects ?? '—'} / ${rc.services ?? '—'} / ${rc.roles ?? '—'}</td></tr>
      <tr><td>agents / tasks</td><td>${rc.agents ?? '—'} / ${rc.tasks ?? '—'}</td></tr>
    </table>`;
}

// Автоподстановка из строки подключения
$('url').addEventListener('change', () => {
  const url = $('url').value.trim();
  if (!url) return;
  try {
    const u = new URL(url);
    $('host').value = u.hostname || '';
    $('port').value = u.port || 5432;
    $('user').value = decodeURIComponent(u.username || '');
    $('password').value = decodeURIComponent(u.password || '');
    $('database').value = u.pathname.replace(/^\//, '') || '';
  } catch {
    /* игнорируем некорректный ввод */
  }
});

$('btnTest').onclick = (e) =>
  busy(e.target, async () => {
    const { ok, data } = await api('/api/db/test', 'POST', collect());
    show(data, ok && data.ok);
  });

$('btnSave').onclick = (e) =>
  busy(e.target, async () => {
    const { ok, data } = await api('/api/settings', 'POST', collect());
    if (ok) fill(data);
    show(ok ? { saved: true, ...data } : data, ok);
    refreshStatus();
  });

$('btnInit').onclick = (e) =>
  busy(e.target, async () => {
    await api('/api/settings', 'POST', collect()); // сохраняем перед инициализацией
    const { ok, data } = await api('/api/db/init', 'POST', collect());
    show(ok ? { ...data, message: data.created ? 'База создана' : 'База уже была' } : data, ok);
    refreshStatus();
  });

$('btnSeed').onclick = (e) =>
  busy(e.target, async () => {
    const { ok, data } = await api('/api/db/seed', 'POST', collect());
    show(data, ok);
    refreshStatus();
  });

$('btnRefresh').onclick = (e) => busy(e.target, refreshStatus);

loadSettings().then(refreshStatus);
