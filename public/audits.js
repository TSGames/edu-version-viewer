// Patch-audit rounds ("Patch-Runden") — admin-only UI. Vanilla JS, loaded after
// app.js and sharing its globals (escapeHtml, hostOf, lastEndpoints, isAdmin,
// renderEndpoints, versionKey, compareVersion, REPO_TYPE_SHORT).
//
// Routing via location.hash: '' = Instanzen, #audits = overview,
// #audits/new, #audits/<id>, #audits/<id>/edit.

const auditEls = {
  tabs: document.getElementById('tabs'),
  tabCount: document.getElementById('tab-audit-count'),
  instancesView: document.getElementById('view-instances'),
  auditsView: document.getElementById('view-audits'),
  auditFilter: document.getElementById('audit-filter'),
  modal: document.getElementById('modal'),
};

const AUDIT_STATUS = {
  open: { label: 'offen', icon: '⛔', cls: 'p-open' },
  patched: { label: 'gepatcht', icon: '✅', cls: 'p-ok' },
  accepted: { label: 'akzeptiert', icon: '☑️', cls: 'p-acc' },
  'not-affected': { label: 'nicht (mehr) betroffen', icon: '➖', cls: 'p-na' },
};
const AUDIT_STATUS_RANK = { open: 0, accepted: 1, patched: 2, 'not-affected': 3 };

// Summaries from GET /api/audits (header + counts + statusById).
let audits = [];
// '' | '<id>:open' | '<id>:all' — narrows the instance list to a round.
let auditFilter = localStorage.getItem('auditFilter') || '';
let auditListFilter = 'all'; // overview: all | open | closed

// ---------- helpers ----------

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return d.toLocaleDateString('de-DE');
}

function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function daysBetween(fromIso, to = new Date()) {
  const a = new Date(fromIso.length === 10 ? fromIso + 'T00:00:00' : fromIso);
  return Math.round((to - a) / 86400000);
}

function affectedLabel(a) {
  return (a.affected || [])
    .map((v) => (v === 'unknown' ? 'unbekannt' : v))
    .map((v) => `<b>${escapeHtml(v)}</b>`)
    .join(', ');
}

function scopeLabel(a) {
  if (!a.repoTypes || !a.repoTypes.length) return '';
  return ' · nur ' + a.repoTypes.map((t) => REPO_TYPE_SHORT[t] || t).join(', ');
}

// "Ziel: 15.11.2026 (in 11 Tagen)" / overdue / no date + how long it's open.
function dueLabel(a) {
  if (a.status !== 'open') {
    return `${fmtDate(a.createdAt)}–${fmtDate(a.closedAt)} · geschlossen von ${escapeHtml(a.closedBy || '?')}`;
  }
  const openFor = daysBetween(a.createdAt);
  if (!a.dueDate) {
    return `kein Zieldatum · <span class="audit-age">seit ${openFor} Tagen offen</span>`;
  }
  const left = -daysBetween(a.dueDate);
  if (left < 0) {
    return `Ziel: ${fmtDate(a.dueDate)} · <span class="audit-overdue">überfällig seit ${-left} Tagen</span>`;
  }
  return `Ziel: ${fmtDate(a.dueDate)} (${left === 0 ? 'heute' : 'in ' + left + ' Tagen'})`;
}

function pill(status) {
  const s = AUDIT_STATUS[status] || { label: status, cls: '' };
  return `<span class="pill ${s.cls}">${escapeHtml(s.label)}</span>`;
}

function roundPill(a) {
  return a.status === 'open'
    ? '<span class="pill p-run">offen</span>'
    : '<span class="pill p-closed">abgeschlossen</span>';
}

function progressHtml(c) {
  const total = c.total || 0;
  const pct = (n) => (total ? (n / total) * 100 : 0);
  const parts = [];
  if (c.patched) parts.push(`${c.patched} gepatcht`);
  if (c.accepted) parts.push(`${c.accepted} akzeptiert`);
  if (c['not-affected']) parts.push(`${c['not-affected']} nicht mehr betroffen`);
  if (c.open) parts.push(`${c.open} offen`);
  return `
    <div class="bar">
      <span class="b-ok" style="width:${pct(c.patched)}%"></span>
      <span class="b-acc" style="width:${pct(c.accepted)}%"></span>
      <span class="b-na" style="width:${pct(c['not-affected'])}%"></span>
      <span class="b-open" style="width:${pct(c.open)}%"></span>
    </div>
    <div class="legend">${parts.length ? parts.join(' · ') : 'keine Instanzen'} (von ${total})</div>`;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Nicht angemeldet');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Fehler ' + res.status);
  return data;
}

// ---------- integration with the instance view ----------

// Badges on cards / list rows: one per open round the instance is part of.
function auditBadgesHtml(e) {
  if (!isAdmin()) return '';
  let out = '';
  for (const a of audits) {
    if (a.status !== 'open') continue;
    const st = a.statusById && a.statusById[e.id];
    if (!st || st === 'not-affected') continue;
    const cls = st === 'open' ? 'audit-open' : st === 'patched' ? 'audit-ok' : 'audit-acc';
    out += `<a class="badge ${cls}" href="#audits/${escapeHtml(a.id)}" title="Patch-Runde: ${escapeHtml(
      a.title
    )}">🔒 ${escapeHtml(a.title)}: ${escapeHtml(AUDIT_STATUS[st].label)}</a>`;
  }
  return out;
}

function matchesAuditFilter(e) {
  if (!auditFilter || !isAdmin()) return true;
  const [id, mode] = auditFilter.split(':');
  const a = audits.find((x) => x.id === id);
  if (!a) return true; // round vanished -> don't hide everything
  const st = a.statusById && a.statusById[e.id];
  if (!st) return false;
  return mode === 'open' ? st === 'open' : st !== 'not-affected';
}

function updateAuditFilterOptions() {
  const sel = auditEls.auditFilter;
  sel.classList.toggle('hidden', !isAdmin() || audits.length === 0);
  const opts = [['', 'Patch-Runde: alle Instanzen']];
  for (const a of audits) {
    if (a.status !== 'open') continue;
    opts.push([`${a.id}:open`, `${a.title} – nur offene`]);
    opts.push([`${a.id}:all`, `${a.title} – alle betroffenen`]);
  }
  if (auditFilter && !opts.some(([v]) => v === auditFilter)) {
    auditFilter = '';
    localStorage.setItem('auditFilter', '');
  }
  sel.innerHTML = opts
    .map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`)
    .join('');
  sel.value = auditFilter;
}

async function loadAudits() {
  if (!isAdmin()) {
    audits = [];
    updateAuditChrome();
    return;
  }
  try {
    audits = (await api('GET', '/api/audits')).audits || [];
  } catch {
    return;
  }
  updateAuditChrome();
  renderEndpoints(); // badges / filter depend on rounds
  if (currentRoute().mode === 'list') renderAuditsView();
}

function updateAuditChrome() {
  auditEls.tabs.classList.toggle('hidden', !isAdmin());
  const open = audits.filter((a) => a.status === 'open').length;
  auditEls.tabCount.textContent = open ? `${open} offen` : '';
  auditEls.tabCount.classList.toggle('hidden', !open);
  updateAuditFilterOptions();
}

function resetAudits() {
  audits = [];
  auditEls.tabs.classList.add('hidden');
  auditEls.auditFilter.classList.add('hidden');
  closeModal();
  if (location.hash) history.replaceState(null, '', location.pathname);
  applyRoute();
}

// ---------- routing ----------

function currentRoute() {
  const h = location.hash.replace(/^#/, '');
  if (!h.startsWith('audits') || !isAdmin()) return { tab: 'instances' };
  const parts = h.split('/');
  if (parts.length === 1 || !parts[1]) return { tab: 'audits', mode: 'list' };
  if (parts[1] === 'new') return { tab: 'audits', mode: 'new' };
  if (parts[2] === 'edit') return { tab: 'audits', mode: 'edit', id: parts[1] };
  return { tab: 'audits', mode: 'detail', id: parts[1] };
}

function applyRoute() {
  const r = currentRoute();
  auditEls.instancesView.classList.toggle('hidden', r.tab !== 'instances');
  auditEls.auditsView.classList.toggle('hidden', r.tab !== 'audits');
  for (const b of auditEls.tabs.querySelectorAll('[data-tab]')) {
    b.classList.toggle('active', b.dataset.tab === r.tab);
  }
  if (r.tab === 'audits') renderAuditsView();
}

window.addEventListener('hashchange', () => {
  closeModal();
  applyRoute();
});

// True while the audits view holds unsaved input (skip auto-refresh re-render).
function auditViewBusy() {
  const m = currentRoute().mode;
  return m === 'new' || m === 'edit' || !auditEls.modal.classList.contains('hidden');
}

// ---------- views ----------

async function renderAuditsView() {
  const r = currentRoute();
  const root = auditEls.auditsView;
  if (r.mode === 'list') return renderAuditList(root);
  if (r.mode === 'new') return renderAuditForm(root, null);
  try {
    const { audit } = await api('GET', '/api/audits/' + encodeURIComponent(r.id));
    if (currentRoute().id !== r.id) return; // navigated away meanwhile
    if (r.mode === 'edit') {
      if (audit.status !== 'open') {
        location.hash = '#audits/' + audit.id;
        return;
      }
      return renderAuditForm(root, audit);
    }
    return renderAuditDetail(root, audit);
  } catch (e) {
    root.innerHTML = `<div class="audit-wrap"><p class="error-text">${escapeHtml(
      e.message
    )}</p><a href="#audits">← zurück zur Übersicht</a></div>`;
  }
}

function renderAuditList(root) {
  const shown = audits.filter((a) =>
    auditListFilter === 'all' ? true : auditListFilter === 'open' ? a.status === 'open' : a.status !== 'open'
  );
  root.innerHTML = `
    <div class="audit-wrap">
      <div class="audit-head">
        <h2>Patch-Runden</h2>
        <div class="row-inline">
          <select id="audit-list-filter" aria-label="Runden filtern">
            <option value="all">Offene + abgeschlossene</option>
            <option value="open">Nur offene</option>
            <option value="closed">Nur abgeschlossene</option>
          </select>
          <a class="button" href="#audits/new">+ Neue Runde</a>
        </div>
      </div>
      <div class="rounds">
        ${
          shown.length
            ? shown
                .map(
                  (a) => `
          <div class="round ${a.status === 'open' ? '' : 'round-closed'}">
            <div>
              <h3><a href="#audits/${escapeHtml(a.id)}">${escapeHtml(a.title)}</a> ${roundPill(a)}</h3>
              <div class="sm">Betroffen: ${affectedLabel(a)}${escapeHtml(scopeLabel(a))} · eröffnet ${fmtDate(
                    a.createdAt
                  )} von ${escapeHtml(a.createdBy || '?')} · ${dueLabel(a)}</div>
            </div>
            <div>${progressHtml(a.counts)}</div>
            <div class="round-actions">
              <a class="button secondary" href="#audits/${escapeHtml(a.id)}">${
                    a.status === 'open' ? 'Öffnen' : 'Ansehen'
                  }</a>
              <a class="button secondary" href="/api/audits/${escapeHtml(a.id)}/export.csv">CSV</a>
            </div>
          </div>`
                )
                .join('')
            : '<p class="muted">Noch keine Patch-Runden. Lege mit „+ Neue Runde“ eine an.</p>'
        }
      </div>
    </div>`;
  const sel = root.querySelector('#audit-list-filter');
  sel.value = auditListFilter;
  sel.addEventListener('change', () => {
    auditListFilter = sel.value;
    renderAuditList(root);
  });
}

// Base versions present in the instance list, with counts (+ unknown).
function presentBaseVersions() {
  const counts = new Map();
  for (const e of lastEndpoints) {
    const k = versionKey(e.version);
    const v = k ? `${k[0]}.${k[1] || 0}` : 'unknown';
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

function renderAuditForm(root, audit) {
  const isEdit = !!audit;
  const counts = presentBaseVersions();
  const selected = new Set(audit ? audit.affected : []);
  const extra = new Set([...selected].filter((v) => !counts.has(v)));
  const repoTypes = new Set(audit ? audit.repoTypes : []);

  root.innerHTML = `
    <div class="audit-wrap">
      <form class="audit-form" autocomplete="off">
        <h2>${isEdit ? 'Patch-Runde bearbeiten' : 'Neue Patch-Runde'}</h2>
        <div class="grid2">
          <label class="fld">Titel<input name="title" required maxlength="300"></label>
          <label class="fld">Advisory / Ticket-Link<input name="link" placeholder="https://…"></label>
          <label class="fld span2">Beschreibung<textarea name="description" rows="2"></textarea></label>
          <label class="fld">Zieldatum <span class="muted">(optional – Runde bleibt auch danach offen)</span><input name="dueDate" type="date"></label>
          <div class="fld">Umfang <span class="muted">(nichts gewählt = alle Typen)</span>
            <div class="scope-checks">
              ${['dev', 'staging', 'prod']
                .map(
                  (t) =>
                    `<label><input type="checkbox" name="repoType" value="${t}" ${
                      repoTypes.has(t) ? 'checked' : ''
                    }> ${escapeHtml(REPO_TYPE_SHORT[t])}</label>`
                )
                .join('')}
            </div>
          </div>
        </div>
        <div class="fld vers-label">Betroffene Basisversionen
          <span class="muted">– Patch-Stand ist über _about nicht abrufbar, daher nur Major.Minor; Status pro Instanz wird manuell gepflegt</span></div>
        <div class="vers"></div>
        <div class="vers-add">
          <input class="vers-add-input" placeholder="weitere Version, z. B. 8.1" aria-label="Weitere Version">
          <button type="button" class="secondary vers-add-btn">+ hinzufügen</button>
        </div>
        <div class="hint"></div>
        <div class="error-text form-msg"></div>
        <div class="foot">
          <a class="button secondary" href="${isEdit ? '#audits/' + escapeHtml(audit.id) : '#audits'}">Abbrechen</a>
          <button type="submit">${isEdit ? 'Speichern' : 'Runde anlegen'}</button>
        </div>
      </form>
    </div>`;

  const form = root.querySelector('form');
  form.title.value = audit ? audit.title : '';
  form.link.value = audit ? audit.link : '';
  form.description.value = audit ? audit.description : '';
  form.dueDate.value = audit ? audit.dueDate : '';
  const vers = form.querySelector('.vers');
  const hint = form.querySelector('.hint');
  const msg = form.querySelector('.form-msg');

  function renderTiles() {
    const all = [...counts.keys(), ...extra].filter((v, i, arr) => arr.indexOf(v) === i);
    all.sort((a, b) => (a === 'unknown' ? 1 : b === 'unknown' ? -1 : compareVersion(b, a)));
    vers.innerHTML = all
      .map((v) => {
        const n = counts.get(v) || 0;
        const on = selected.has(v);
        return `<button type="button" class="ver ${on ? 'on' : ''}" data-v="${escapeHtml(v)}" aria-pressed="${on}">
          <span class="cb">${on ? '✓' : ''}</span>${escapeHtml(v === 'unknown' ? 'unbekannt' : v)}
          <small>${n} ${n === 1 ? 'Instanz' : 'Instanzen'}</small></button>`;
      })
      .join('');
    updateHint();
  }

  function scopedCount() {
    const types = [...form.querySelectorAll('input[name=repoType]:checked')].map((i) => i.value);
    return lastEndpoints.filter((e) => {
      if (types.length && !types.includes(e.repoType)) return false;
      const k = versionKey(e.version);
      return selected.has(k ? `${k[0]}.${k[1] || 0}` : 'unknown');
    }).length;
  }

  function updateHint() {
    if (!selected.size) {
      hint.innerHTML = 'Mindestens eine betroffene Basisversion auswählen.';
      return;
    }
    const n = scopedCount();
    hint.innerHTML = isEdit
      ? `→ aktuell <b>${n} Instanzen</b> im Umfang. Neu hinzukommende werden als ${pill(
          'open'
        )} ergänzt; bestehende Einträge und ihr Status bleiben erhalten.`
      : `→ <b>${n} Instanzen</b> werden in die Runde aufgenommen, alle mit Status ${pill(
          'open'
        )}. Instanzen, die später hinzukommen oder auf eine betroffene Version wechseln, werden automatisch ergänzt.`;
  }

  vers.addEventListener('click', (ev) => {
    const b = ev.target.closest('.ver');
    if (!b) return;
    const v = b.dataset.v;
    if (selected.has(v)) selected.delete(v);
    else selected.add(v);
    renderTiles();
  });
  form.addEventListener('change', (ev) => {
    if (ev.target.name === 'repoType') updateHint();
  });
  const addInput = form.querySelector('.vers-add-input');
  const addVersion = () => {
    const k = versionKey(addInput.value.trim());
    if (!k || !/^\d+(\.\d+)*$/.test(addInput.value.trim())) {
      msg.textContent = 'Ungültige Version (Format: 10.0)';
      return;
    }
    msg.textContent = '';
    const v = `${k[0]}.${k[1] || 0}`;
    if (!counts.has(v)) extra.add(v);
    selected.add(v);
    addInput.value = '';
    renderTiles();
  };
  form.querySelector('.vers-add-btn').addEventListener('click', addVersion);
  addInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      addVersion();
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.textContent = '';
    const body = {
      title: form.title.value,
      link: form.link.value,
      description: form.description.value,
      dueDate: form.dueDate.value,
      repoTypes: [...form.querySelectorAll('input[name=repoType]:checked')].map((i) => i.value),
      affected: [...selected],
    };
    try {
      const { audit: saved } = isEdit
        ? await api('PATCH', '/api/audits/' + encodeURIComponent(audit.id), body)
        : await api('POST', '/api/audits', body);
      await loadAudits();
      location.hash = '#audits/' + saved.id;
    } catch (e) {
      msg.textContent = e.message;
    }
  });

  renderTiles();
  form.title.focus();
}

function renderAuditDetail(root, a) {
  const open = a.status === 'open';
  const c = a.counts;
  const entries = Object.entries(a.entries || {}).sort(
    ([, x], [, y]) =>
      (x.removed ? 1 : 0) - (y.removed ? 1 : 0) ||
      AUDIT_STATUS_RANK[x.status] - AUDIT_STATUS_RANK[y.status] ||
      String(x.label).localeCompare(String(y.label))
  );

  const statusCell = (id, e) => {
    if (!open || e.removed) {
      return pill(e.status) + (e.openAtClose ? ' <span class="sm">(offen bei Abschluss)</span>' : '');
    }
    return `<select class="entry-status" data-id="${escapeHtml(id)}" aria-label="Status">
      ${Object.entries(AUDIT_STATUS)
        .map(
          ([k, s]) => `<option value="${k}" ${k === e.status ? 'selected' : ''}>${s.icon} ${escapeHtml(s.label)}</option>`
        )
        .join('')}
    </select>`;
  };
  const commentCell = (id, e) =>
    !open || e.removed
      ? `<span class="sm">${escapeHtml(e.comment || '')}</span>`
      : `<input class="entry-comment" data-id="${escapeHtml(id)}" placeholder="Kommentar…" maxlength="2000">`;
  const logTitle = (e) =>
    (e.log || [])
      .map((l) => `${fmtDateTime(l.at)} ${l.by}: ${AUDIT_STATUS[l.status] ? AUDIT_STATUS[l.status].label : l.status}${l.comment ? ' – ' + l.comment : ''}`)
      .join('\n');

  root.innerHTML = `
    <div class="audit-wrap">
      <div class="audit-head">
        <div>
          <div class="sm"><a href="#audits">← Patch-Runden</a></div>
          <h2>${escapeHtml(a.title)} ${roundPill(a)}</h2>
          <div class="sm">Betroffen: ${affectedLabel(a)}${escapeHtml(scopeLabel(a))} · eröffnet ${fmtDate(
            a.createdAt
          )} von ${escapeHtml(a.createdBy || '?')} · ${dueLabel(a)}${
            a.link
              ? ` · <a href="${escapeHtml(a.link)}" target="_blank" rel="noopener noreferrer">Advisory / Ticket</a>`
              : ''
          }</div>
        </div>
        <div class="row-inline">
          ${open ? `<a class="button secondary" href="#audits/${escapeHtml(a.id)}/edit">Bearbeiten</a>` : ''}
          <a class="button secondary" href="/api/audits/${escapeHtml(a.id)}/export.csv">CSV-Export</a>
          ${
            open
              ? '<button type="button" class="danger close-btn">Runde abschließen…</button>'
              : '<button type="button" class="reopen-btn">Wieder öffnen</button>'
          }
        </div>
      </div>
      ${a.description ? `<div class="notes">${escapeHtml(a.description)}</div>` : ''}
      ${
        !open && a.closeNote
          ? `<div class="notes">Abschlussnotiz (${escapeHtml(a.closedBy || '')}, ${fmtDateTime(a.closedAt)}): ${escapeHtml(
              a.closeNote
            )}</div>`
          : ''
      }
      <div class="kpis">
        <div class="kpi"><b class="k-open">${c.open}</b>offen</div>
        <div class="kpi"><b class="k-ok">${c.patched}</b>gepatcht</div>
        <div class="kpi"><b>${c.accepted}</b>akzeptiert</div>
        <div class="kpi"><b class="k-na">${c['not-affected']}</b>nicht mehr betroffen</div>
      </div>
      <span class="sm save-msg" aria-live="polite"></span>
      <div class="list-wrap">
      <table class="audit-table">
        <thead><tr><th>Instanz</th><th>Version</th><th>Typ</th><th>Status</th><th>Kommentar</th><th>Zuletzt geändert</th></tr></thead>
        <tbody>
          ${
            entries.length
              ? entries
                  .map(
                    ([id, e]) => `
            <tr class="${e.removed ? 'removed' : e.status === 'not-affected' ? 'na' : ''}">
              <td><b>${escapeHtml(e.label || hostOf(e.url))}</b>${e.removed ? ' <span class="sm">(Instanz gelöscht)</span>' : ''}
                <div class="sm">${escapeHtml(hostOf(e.url))}</div></td>
              <td><span class="badge version">${escapeHtml(e.version || 'unbekannt')}</span></td>
              <td>${
                e.repoType ? `<span class="badge repo repo-${escapeHtml(e.repoType)}">${escapeHtml(REPO_TYPE_SHORT[e.repoType] || e.repoType)}</span>` : ''
              }</td>
              <td>${statusCell(id, e)}</td>
              <td>${commentCell(id, e)}</td>
              <td class="sm" title="${escapeHtml(logTitle(e))}">${
                e.updatedAt ? `${escapeHtml(e.updatedBy || '')} · ${fmtDateTime(e.updatedAt)}` : '—'
              }</td>
            </tr>`
                  )
                  .join('')
              : '<tr><td colspan="6" class="muted">Keine Instanzen mit den betroffenen Versionen.</td></tr>'
          }
        </tbody>
      </table>
      </div>
      <details class="audit-history">
        <summary>Verlauf der Runde</summary>
        <ul>${(a.history || [])
          .map(
            (h) =>
              `<li>${fmtDateTime(h.at)} · ${escapeHtml(h.by || '')} · ${escapeHtml(
                { created: 'angelegt', edited: 'bearbeitet', closed: 'abgeschlossen', reopened: 'wieder geöffnet' }[h.action] ||
                  h.action
              )}${h.note ? ' – ' + escapeHtml(h.note) : ''}</li>`
          )
          .join('')}</ul>
      </details>
    </div>`;

  // Comment inputs get their value via the DOM (no HTML-attribute escaping pitfalls).
  for (const input of root.querySelectorAll('.entry-comment')) {
    input.value = a.entries[input.dataset.id].comment || '';
  }

  const saveMsg = root.querySelector('.save-msg');
  async function saveEntry(id, patch) {
    saveMsg.textContent = 'speichere…';
    saveMsg.className = 'sm save-msg';
    try {
      const { audit } = await api(
        'PATCH',
        `/api/audits/${encodeURIComponent(a.id)}/entries/${encodeURIComponent(id)}`,
        patch
      );
      renderAuditDetail(root, audit);
      root.querySelector('.save-msg').textContent = 'gespeichert';
      loadAudits();
    } catch (e) {
      saveMsg.textContent = e.message;
      saveMsg.className = 'error-text save-msg';
    }
  }
  root.querySelectorAll('.entry-status').forEach((sel) =>
    sel.addEventListener('change', () => {
      const comment = root.querySelector(`.entry-comment[data-id="${CSS.escape(sel.dataset.id)}"]`);
      saveEntry(sel.dataset.id, { status: sel.value, comment: comment ? comment.value : undefined });
    })
  );
  root.querySelectorAll('.entry-comment').forEach((input) => {
    input.addEventListener('change', () => saveEntry(input.dataset.id, { comment: input.value }));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
    });
  });

  const closeBtn = root.querySelector('.close-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => openCloseDialog(a, entries));
  const reopenBtn = root.querySelector('.reopen-btn');
  if (reopenBtn) {
    reopenBtn.addEventListener('click', async () => {
      try {
        const { audit } = await api('POST', `/api/audits/${encodeURIComponent(a.id)}/reopen`);
        renderAuditDetail(root, audit);
        loadAudits();
      } catch (e) {
        alert(e.message);
      }
    });
  }
}

// ---------- close dialog (two-step confirmation) ----------

function closeModal() {
  auditEls.modal.classList.add('hidden');
  auditEls.modal.innerHTML = '';
}

function openCloseDialog(a, entries) {
  const stillOpen = entries.filter(([, e]) => !e.removed && e.status === 'open').map(([, e]) => e.label || hostOf(e.url));
  let note = '';
  const m = auditEls.modal;

  function step1() {
    m.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="close-title">
        <div class="step">Schritt 1 von 2</div>
        <h3 id="close-title">Runde „${escapeHtml(a.title)}“ abschließen?</h3>
        ${
          stillOpen.length
            ? `<div class="warn">⚠️ Noch <b>${stillOpen.length} ${stillOpen.length === 1 ? 'Instanz' : 'Instanzen'} offen</b>: ${escapeHtml(
                stillOpen.join(', ')
              )}</div>`
            : '<div class="ok-note">Alle Instanzen sind erledigt.</div>'
        }
        <p class="sm">Nach dem Abschluss ist die Runde schreibgeschützt (nur Ansicht + Export) und kann bei Bedarf wieder geöffnet werden. Offene Instanzen bleiben als „offen bei Abschluss“ dokumentiert.</p>
        <label class="fld">Abschlussnotiz <span class="muted">(optional)</span><textarea rows="2" class="close-note"></textarea></label>
        <div class="foot">
          <button type="button" class="secondary m-cancel">Abbrechen</button>
          <button type="button" class="danger m-next">Weiter</button>
        </div>
      </div>`;
    const ta = m.querySelector('.close-note');
    ta.value = note;
    m.querySelector('.m-cancel').addEventListener('click', closeModal);
    m.querySelector('.m-next').addEventListener('click', () => {
      note = ta.value;
      step2();
    });
    m.querySelector('.m-next').focus();
  }

  function step2() {
    m.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="close-title2">
        <div class="step">Schritt 2 von 2</div>
        <h3 id="close-title2">Endgültig abschließen</h3>
        <p>Zur Bestätigung den Titel der Runde eintippen:</p>
        <p><code>${escapeHtml(a.title)}</code></p>
        <input class="confirm-title" aria-label="Titel zur Bestätigung" autocomplete="off">
        <p class="sm confirm-msg"></p>
        <div class="foot">
          <button type="button" class="secondary m-back">Zurück</button>
          <button type="button" class="danger m-close" disabled>Endgültig abschließen</button>
        </div>
      </div>`;
    const input = m.querySelector('.confirm-title');
    const btn = m.querySelector('.m-close');
    const cmsg = m.querySelector('.confirm-msg');
    input.addEventListener('input', () => {
      const ok = input.value.trim() === a.title;
      btn.disabled = !ok;
      cmsg.textContent = ok || !input.value ? '' : 'Titel stimmt noch nicht überein.';
      cmsg.className = ok ? 'sm confirm-msg' : 'error-text confirm-msg';
    });
    m.querySelector('.m-back').addEventListener('click', step1);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const { audit } = await api('POST', `/api/audits/${encodeURIComponent(a.id)}/close`, {
          confirmTitle: input.value.trim(),
          note,
        });
        closeModal();
        renderAuditDetail(auditEls.auditsView, audit);
        loadAudits();
      } catch (e) {
        cmsg.textContent = e.message;
        cmsg.className = 'error-text confirm-msg';
        btn.disabled = false;
      }
    });
    input.focus();
  }

  m.classList.remove('hidden');
  step1();
}

auditEls.modal.addEventListener('click', (ev) => {
  if (ev.target === auditEls.modal) closeModal();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !auditEls.modal.classList.contains('hidden')) closeModal();
});

auditEls.auditFilter.addEventListener('change', () => {
  auditFilter = auditEls.auditFilter.value;
  localStorage.setItem('auditFilter', auditFilter);
  renderEndpoints();
});
