/* ═══════════════════════════════════════
   TC CREATOR — renderer.js
═══════════════════════════════════════ */

/* ══════════════════════════════════════
   STAV APLIKACE
══════════════════════════════════════ */
let state = {
  filePath:           null,
  project:            null,
  expandedId:         null,
  versionTargetId:    null,
  adminMode:          false,
  hardDeleteTargetId: null
};

/* ══════════════════════════════════════
   HELPERS
══════════════════════════════════════ */
/* ══════════════════════════════════════
   MIGRACE STARŠÍHO FORMÁTU DAT
   (steps: string[] → steps: {step, expected}[], expected_result zůstává samostatně)
══════════════════════════════════════ */
function migrateTc(tc) {
  if (!Array.isArray(tc.steps)) {
    tc.steps = [];
  } else {
    tc.steps = tc.steps.map(s => {
      if (typeof s === 'string') return { step: s, expected: '', test_data: '' };
      const out = { step: s.step || '', expected: s.expected || '', test_data: s.test_data || '' };
      if (s.insert_after !== undefined && s.insert_after !== null) out.insert_after = s.insert_after;
      return out;
    });
  }

  if (!Array.isArray(tc.expected_result) || tc.expected_result.length === 0) {
    tc.expected_result = [''];
  }

  if (typeof tc.notes !== 'string') tc.notes = '';
  if (!Array.isArray(tc.tags)) tc.tags = [];

  if (tc.inherited_overrides) {
    const migrated = {};
    Object.keys(tc.inherited_overrides).forEach(k => {
      const v = tc.inherited_overrides[k];
      migrated[k] = (typeof v === 'string') ? { step: v } : v;
    });
    tc.inherited_overrides = migrated;
  }
}

function migrateProject(project) {
  if (!project || !Array.isArray(project.testCases)) return;
  if (!Array.isArray(project.scratchpad)) project.scratchpad = [];
  project.testCases.forEach(migrateTc);
}

function generateUid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function nextTcNumber(testCases, renumber) {
  if (renumber) {
    const active = testCases.filter(tc => !tc.deleted);
    return active.length + 1;
  }
  let max = 0;
  testCases.forEach(tc => {
    const m = tc.id.match(/-?(\d+)(?:-V\d+)?$/);
    if (m) max = Math.max(max, parseInt(m[1]));
  });
  return max + 1;
}

function formatTcId(prefix, num, version) {
  const padded = String(num).padStart(3, '0');
  return version > 1 ? `${prefix}${padded}-V${version}` : `${prefix}${padded}`;
}

function getActiveTcs() {
  if (!state.project) return [];
  return state.project.testCases.filter(tc => !tc.deleted);
}

function getTcByUid(uid) {
  if (!state.project) return null;
  return state.project.testCases.find(tc => tc._uid === uid) || null;
}

/* ══════════════════════════════════════
   SCHRÁNKA — postranní panel s opakovaně používaným textem
   (uloženo v projektu jako project.scratchpad = [{ id, label, text }])
══════════════════════════════════════ */
function toggleScratchpad() {
  if (!state.project) return;
  const panel = document.getElementById('scratchpad-panel');
  const willOpen = !panel.classList.contains('open');
  panel.classList.toggle('open', willOpen);
  document.getElementById('btn-scratchpad').classList.toggle('scratchpad-btn-active', willOpen);
  if (willOpen) renderScratchpad();
}

function renderScratchpad() {
  const list = document.getElementById('scratchpad-list');
  if (!list || !state.project) return;
  if (!Array.isArray(state.project.scratchpad)) state.project.scratchpad = [];

  list.innerHTML = '';
  state.project.scratchpad.forEach(entry => {
    list.appendChild(buildScratchpadItem(entry));
  });
}

function buildScratchpadItem(entry) {
  const item = document.createElement('div');
  item.className = 'scratchpad-item';

  const row = document.createElement('div');
  row.className = 'scratchpad-item-row';

  const labelInp = document.createElement('input');
  labelInp.type        = 'text';
  labelInp.className   = 'scratchpad-item-label';
  labelInp.value        = entry.label || '';
  labelInp.placeholder = t('scratchpad_label_placeholder');
  labelInp.addEventListener('input', () => {
    entry.label = labelInp.value;
    scheduleSave();
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'step-del';
  delBtn.innerHTML  = '×';
  delBtn.title      = t('scratchpad_delete_title');
  delBtn.addEventListener('click', () => {
    state.project.scratchpad = state.project.scratchpad.filter(e => e.id !== entry.id);
    renderScratchpad();
    scheduleSave();
  });

  row.appendChild(labelInp);
  addFieldCopyButton(row, () => ta.value);
  row.appendChild(delBtn);

  const ta = document.createElement('textarea');
  ta.rows        = 2;
  ta.value       = entry.text || '';
  ta.placeholder = t('scratchpad_text_placeholder');
  ta.addEventListener('input', () => {
    entry.text = ta.value;
    scheduleSave();
  });

  item.appendChild(row);
  item.appendChild(ta);
  return item;
}

function addScratchpadEntry() {
  if (!state.project) return;
  if (!Array.isArray(state.project.scratchpad)) state.project.scratchpad = [];

  const entry = { id: generateUid(), label: '', text: '' };
  state.project.scratchpad.push(entry);
  renderScratchpad();
  scheduleSave();

  setTimeout(() => {
    const list = document.getElementById('scratchpad-list');
    const textareas = list ? list.querySelectorAll('textarea') : [];
    if (textareas.length) textareas[textareas.length - 1].focus();
  }, 30);
}

/* Sestaví kompletní, správně proložené pořadí zobrazení kroků — zděděné
   i vlastní, včetně vlastních kroků vložených doprostřed zděděných (přes
   pole insert_after: 'start' | <globalIndex zděděné položky> | chybí = konec).
   Vrací pole položek:
     { type: 'inherited', item: <z getInheritedStepsForEdit> }
     { type: 'own', s: <objekt kroku>, i: <index v tc.steps> } */
function buildStepRenderOrder(tc, visited) {
  const inheritedItems = getInheritedStepsForEdit(tc, visited);

  const bySlot = {};
  tc.steps.forEach((s, i) => {
    const key = (s.insert_after === undefined || s.insert_after === null) ? 'end' : s.insert_after;
    if (!bySlot[key]) bySlot[key] = [];
    bySlot[key].push({ type: 'own', s, i });
  });

  const order = [];
  (bySlot['start'] || []).forEach(o => order.push(o));

  inheritedItems.forEach(item => {
    order.push({ type: 'inherited', item });
    (bySlot[item.globalIndex] || []).forEach(o => order.push(o));
  });

  (bySlot['end'] || []).forEach(o => order.push(o));

  return order;
}

/* Plný, výsledný seznam kroků daného TC ve správném pořadí (zděděné —
   s jeho vlastními přepisy/smazáními a s doprostřed vloženými vlastními
   kroky — + vlastní kroky). Používá se jako základ pro další úroveň
   dědění, aby se úpravy provedené na mezilehlé úrovni správně propsaly
   i o úroveň níž (rodiče samotné to neovlivní). */
function getEffectiveSteps(tc, visited) {
  return buildStepRenderOrder(tc, visited)
    .filter(entry => entry.type === 'own' || !entry.item.deleted)
    .map(entry => entry.type === 'own'
      ? { step: entry.s.step || '', expected: entry.s.expected || '', test_data: entry.s.test_data || '' }
      : { step: entry.item.step, expected: entry.item.expected, test_data: entry.item.test_data }
    );
}

/* Zděděné předpoklady z celého řetězce rodičů — bere plně vyřešené (zděděné
   s přepisem + vlastní) předpoklady přímého rodiče, ne jeho syrový vlastní text,
   aby se přepis provedený na mezilehlé úrovni propsal i dál */
function getInheritedPreconditionsChain(tc, visited) {
  if (!tc.parent_id) return '';
  visited = visited || new Set([tc._uid]);
  if (visited.has(tc.parent_id)) return ''; // ochrana proti cyklu v řetězci rodičů

  const parent = getTcByUid(tc.parent_id);
  if (!parent) return '';

  const nextVisited = new Set(visited);
  nextVisited.add(parent._uid);

  return getFullPreconditions(parent, nextVisited);
}

/* Zděděné předpoklady s aplikovaným lokálním přepisem (pro export/kopírování) */
function getInheritedPreconditions(tc, visited) {
  const original = getInheritedPreconditionsChain(tc, visited);
  if (!original) return '';
  return tc.inherited_preconditions_override !== undefined
    ? tc.inherited_preconditions_override
    : original;
}

/* Zděděné + vlastní předpoklady spojené (pro export, kopírování i další úroveň dědění) */
function getFullPreconditions(tc, visited) {
  const inherited = getInheritedPreconditions(tc, visited);
  return [inherited, tc.preconditions].filter(Boolean).join('\n');
}

/* Samostatná testovací data + testovací data u jednotlivých kroků,
   spojené do jednoho textu — každý krok označen "(krok N.)" */
function getFullTestData(tc) {
  const allSteps = getEffectiveSteps(tc);
  const perStep = allSteps
    .map((s, i) => (s.test_data ? `(${t('step_label_short')} ${i + 1}.) ${s.test_data}` : null))
    .filter(Boolean);
  return [tc.test_data, ...perStep].filter(Boolean).join('\n');
}

/* Vrátí zděděné kroky jako objekty { step, expected, originalStep, originalExpected,
   stepOverridden, expectedOverridden, deleted, globalIndex }
   pro zobrazení ve formuláři s možností editace. Krok a očekávaný výsledek se
   dědí a přepisují nezávisle, stejnou logikou jako samotné kroky.
   Vychází z PLNĚ VYŘEŠENÝCH kroků přímého rodiče (getEffectiveSteps) — tedy
   včetně jeho vlastních přepisů/smazání zděděných položek — takže úprava
   provedená na mezilehlé úrovni řetězce se správně propíše i o úroveň níž. */
function getInheritedStepsForEdit(tc, visited) {
  if (!tc.parent_id) return [];
  visited = visited || new Set([tc._uid]);
  if (visited.has(tc.parent_id)) return []; // ochrana proti cyklu v řetězci rodičů

  const parent = getTcByUid(tc.parent_id);
  if (!parent) return [];

  const nextVisited = new Set(visited);
  nextVisited.add(parent._uid);

  const raw = getEffectiveSteps(parent, nextVisited); // pole { step, expected, test_data }
  const overrides = tc.inherited_overrides || {};
  const deleted   = new Set(tc.inherited_deleted || []);

  return raw.map((s, i) => {
    const ov = overrides[i] || {};
    return {
      globalIndex:          i,
      originalStep:         s.step || '',
      originalExpected:     s.expected || '',
      originalTestData:     s.test_data || '',
      step:                 ov.step      !== undefined ? ov.step      : (s.step || ''),
      expected:             ov.expected  !== undefined ? ov.expected  : (s.expected || ''),
      test_data:            ov.test_data !== undefined ? ov.test_data : (s.test_data || ''),
      stepOverridden:       ov.step      !== undefined,
      expectedOverridden:   ov.expected  !== undefined,
      testDataOverridden:   ov.test_data !== undefined,
      deleted:              deleted.has(i)
    };
  });
}

/* Smaže prázdný override záznam (pokud u dané položky už nezbyl žádný přepis) */
function cleanupOverrideEntry(tc, idx) {
  if (tc.inherited_overrides && tc.inherited_overrides[idx] && Object.keys(tc.inherited_overrides[idx]).length === 0) {
    delete tc.inherited_overrides[idx];
  }
}

function resetIconSvg() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
}

function notesIconSvg() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>`;
}

function priorityLabel(p) {
  return { high: t('priority_high'), medium: t('priority_medium'), low: t('priority_low') }[p] || p;
}

function statusLabel(s) {
  return { draft: t('status_draft'), ready: t('status_ready'), deprecated: t('status_deprecated') }[s] || s;
}

function isDuplicateId(id) {
  if (!state.project) return false;
  const count = state.project.testCases.filter(t => t.id === id).length;
  return count > 1;
}

/* ══════════════════════════════════════
   THEME
══════════════════════════════════════ */
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next   = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('tc_theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const btn = document.getElementById('theme-btn');
  if (theme === 'light') {
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
  } else {
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>`;
  }
}

/* ══════════════════════════════════════
   ADMIN MÓD
══════════════════════════════════════ */
function toggleAdminMode() {
  state.adminMode = !state.adminMode;
  document.getElementById('admin-btn').classList.toggle('admin-active', state.adminMode);

  const nameInp      = document.getElementById('proj-name');
  const prefixInp     = document.getElementById('proj-prefix');
  const applyBtn      = document.getElementById('proj-prefix-apply');
  const renumberBtn   = document.getElementById('btn-renumber-order');

  nameInp.readOnly   = !state.adminMode;
  prefixInp.readOnly = !state.adminMode;
  applyBtn.classList.toggle('hidden', !state.adminMode);
  renumberBtn.classList.toggle('hidden', !state.adminMode);

  if (state.project) renderTcList(); // přerenderuj — zobraz/skryj admin zónu i tlačítka nahoru/dolů
}

/* ══════════════════════════════════════
   PŘEKLAD (i18n)
══════════════════════════════════════ */
function applyTranslations() {
  document.documentElement.lang = currentLang;
  document.getElementById('lang-label').textContent = currentLang.toUpperCase();

  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });

  // Dynamicky generovaný obsah (seznam TC, formuláře) — přerenderuj
  if (state.project) {
    renderTcList();
  }
}

function toggleLang() {
  setLang(currentLang === 'cs' ? 'en' : 'cs');
  applyTranslations();
}


/* ══════════════════════════════════════
   AUTOSAVE
══════════════════════════════════════ */
let _saveTimer = null;

let dirtySinceLastBackup = false;

function scheduleSave() {
  dirtySinceLastBackup = true;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => saveProject(), 800);
}

async function saveProject(forcePath) {
  if (!state.project) return;
  syncProjectBarToState();
  syncTagColorsIntoProject(state.project);
  const result = await window.api.saveFile(forcePath || state.filePath, state.project);
  if (result && result.success) {
    if (result.filePath) {
      state.filePath = result.filePath;
      localStorage.setItem('tc_last_file', state.filePath);
      document.getElementById('proj-filepath').textContent = state.filePath;
    }
    showAutosaveIndicator();
  }
}

function showAutosaveIndicator() {
  const el = document.getElementById('autosave-ind');
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 1800);
}

function syncProjectBarToState() {
  if (!state.project) return;
  state.project.project  = document.getElementById('proj-name').value.trim();
  state.project.renumber = document.getElementById('proj-renumber').checked;
  // prefix se NEčte z proj-prefix inputu přímo — měnitelný pouze tlačítkem "Použít prefix" v admin módu
  document.getElementById('proj-prefix').value = state.project.prefix || '';
}

/* ══════════════════════════════════════
   PROJEKT
══════════════════════════════════════ */
function openModalNew() {
  document.getElementById('mn-name').value       = '';
  document.getElementById('mn-prefix').value     = '';
  document.getElementById('mn-renumber').checked = false;
  document.getElementById('modal-new-ov').classList.add('open');
  setTimeout(() => document.getElementById('mn-name').focus(), 80);
}

function closeModalNew() {
  document.getElementById('modal-new-ov').classList.remove('open');
}

function confirmNewProject() {
  const name   = document.getElementById('mn-name').value.trim();
  const prefix = document.getElementById('mn-prefix').value.trim().toUpperCase();
  if (!name)   { document.getElementById('mn-name').focus();   return; }
  if (!prefix) { document.getElementById('mn-prefix').focus(); return; }

  state.project = {
    project:    name,
    prefix:     prefix,
    renumber:   document.getElementById('mn-renumber').checked,
    created:    new Date().toISOString().slice(0, 10),
    scratchpad: [],
    testCases:  []
  };
  state.filePath   = null;
  state.expandedId = null;

  closeModalNew();
  activateProject();
  saveProject();
}

async function openProject() {
  const result = await window.api.openFile();
  if (!result) return;
  if (result.error) { alert(result.error); return; }
  state.project    = result.data;
  state.filePath   = result.filePath;
  state.expandedId = null;
  localStorage.setItem('tc_last_file', state.filePath);
  activateProject();
}

async function loadLastProject() {
  const lastPath = localStorage.getItem('tc_last_file');
  if (!lastPath) return;
  const result = await window.api.loadLastFile(lastPath);
  if (!result) return;
  state.project    = result.data;
  state.filePath   = result.filePath;
  state.expandedId = null;
  activateProject();
}

function activateProject() {
  migrateProject(state.project);
  document.getElementById('project-bar').style.display      = 'flex';
  document.getElementById('proj-name').value                = state.project.project  || '';
  document.getElementById('proj-prefix').value              = state.project.prefix   || '';
  document.getElementById('proj-renumber').checked          = state.project.renumber || false;
  document.getElementById('proj-filepath').textContent      = state.filePath         || '';
  document.getElementById('btn-export').disabled             = false;
  document.getElementById('btn-export-json').disabled       = false;
  document.getElementById('btn-find-replace').disabled      = false;
  document.getElementById('btn-scratchpad').disabled        = false;
  document.getElementById('empty-state').style.display      = 'none';
  document.getElementById('tc-list-header').style.display   = 'flex';
  document.getElementById('tc-list').style.display          = 'flex';
  document.getElementById('add-tc-btn').style.display       = 'flex';
  renderTcList();
  initSortable();
  renderScratchpad();
}

/* ══════════════════════════════════════
   TC — PŘIDAT
══════════════════════════════════════ */
function addTc() {
  if (!state.project) return;
  const { prefix, renumber, testCases } = state.project;
  const num   = nextTcNumber(testCases, renumber);
  const newId = formatTcId(prefix, num, 1);

  // Název se často řadí za předchozí TC (stejný prefix názvu) —
  // předvyplní se název posledního TC v seznamu jako výchozí bod k úpravě.
  const prevTc = testCases[testCases.length - 1];
  const prefillName = prevTc ? prevTc.name : '';

  const tc = {
    _uid:            generateUid(),
    id:              newId,
    version:         1,
    name:            prefillName,
    goal:            '',
    preconditions:   '',
    test_data:       '',
    parent_id:       null,
    steps:           [],
    expected_result: [''],
    notes:           '',
    tags:            [],
    priority:        'medium',
    status:          'draft',
    deleted:         false,
    locked:          false
  };

  state.project.testCases.push(tc);
  state.expandedId = tc._uid;
  renderTcList();
  scheduleSave();

  setTimeout(() => {
    const el = document.querySelector(`[data-uid="${tc._uid}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const nameInput = document.querySelector(`[data-uid="${tc._uid}"] .tc-name-input`);
    if (nameInput) { nameInput.focus(); nameInput.select(); }
  }, 80);
}

/* ══════════════════════════════════════
   RENDER — celý seznam
══════════════════════════════════════ */
function renderTcList() {
  const list = document.getElementById('tc-list');
  list.innerHTML = '';
  if (!state.project || !state.project.testCases.length) return;
  state.project.testCases.forEach(tc => list.appendChild(buildTcRow(tc)));
  initSortable();
}

/* ══════════════════════════════════════
   RENDER — jeden řádek (hlavička)
   Přerenderuje jen hlavičku, formulář nechá být
══════════════════════════════════════ */
function refreshTcRowHead(uid) {
  const row = document.querySelector(`[data-uid="${uid}"]`);
  if (!row) return;
  const tc = getTcByUid(uid);
  if (!tc) return;

  const isDup = isDuplicateId(tc.id);

  // Aktualizuj classy řádku
  row.className = 'tc-row' +
    (state.expandedId === uid ? ' expanded' : '') +
    (tc.deleted ? ' deleted' : '') +
    (isDup ? ' dup-warning' : '') +
    (!tc.locked ? ' tc-row-unlocked' : '');

  // Aktualizuj jen textové prvky v hlavičce
  const idEl   = row.querySelector('.tc-id');
  const nameEl = row.querySelector('.tc-name');
  if (idEl) {
    idEl.className = 'tc-id' + (isDup ? ' dup-warning' : '');
    idEl.title     = isDup ? t('dup_warning_title') : '';
  }
  const badges = row.querySelectorAll('.tc-badge');

  if (idEl)   idEl.textContent   = tc.id;
  if (nameEl) nameEl.textContent = tc.name || t('tc_no_name');

  // Ikona poznámky — přidat/odebrat/aktualizovat podle aktuálního obsahu
  let notesIcon = row.querySelector('.tc-notes-icon');
  if (tc.notes) {
    if (!notesIcon) {
      notesIcon = document.createElement('span');
      notesIcon.className = 'tc-notes-icon';
      notesIcon.innerHTML = notesIconSvg();
      if (nameEl) nameEl.insertAdjacentElement('afterend', notesIcon);
    }
    notesIcon.title = tc.notes;
  } else if (notesIcon) {
    notesIcon.remove();
  }

  if (badges[0]) {
    badges[0].className   = `tc-badge priority-${tc.priority}`;
    badges[0].textContent = priorityLabel(tc.priority);
  }
  if (badges[1]) {
    badges[1].className   = `tc-badge status-${tc.status}`;
    badges[1].textContent = statusLabel(tc.status);
  }

  // Štítky — smaž staré a vlož aktuální (zachovej pořadí)
  row.querySelectorAll('.tag-badge').forEach(el => el.remove());
  let tagAnchor = badges[1] || row.querySelector('.tc-row-head');
  (tc.tags || []).forEach(tag => {
    const tagBadge = document.createElement('span');
    tagBadge.className   = 'tc-badge tag-badge';
    tagBadge.textContent = tag;
    applyTagColorStyle(tagBadge, tag);
    tagAnchor.insertAdjacentElement('afterend', tagBadge);
    tagAnchor = tagBadge;
  });
}

/* ══════════════════════════════════════
   BUILD — řádek TC
══════════════════════════════════════ */
function buildTcRow(tc) {
  const isExpanded = state.expandedId === tc._uid;
  const isDeleted  = tc.deleted;
  const isDup      = isDuplicateId(tc.id);

  const row = document.createElement('div');
  row.className = 'tc-row' +
    (isExpanded ? ' expanded' : '') +
    (isDeleted  ? ' deleted'  : '') +
    (isDup      ? ' dup-warning' : '') +
    (!tc.locked ? ' tc-row-unlocked' : '');
  row.dataset.uid = tc._uid;

  /* hlavička */
  const head = document.createElement('div');
  head.className = 'tc-row-head';

  // Zámek
  const lockBtn = document.createElement('button');
  lockBtn.className = 'tc-lock-btn' + (tc.locked ? ' locked' : '');
  lockBtn.title     = tc.locked ? t('tc_lock') : t('tc_unlock');
  lockBtn.innerHTML = tc.locked ? iconLock() : iconUnlock();
  lockBtn.onclick   = (e) => { e.stopPropagation(); toggleLock(tc._uid); };

  // Chevron
  const chevron = document.createElement('span');
  chevron.className = 'tc-chevron';
  chevron.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;

  head.appendChild(lockBtn);
  head.appendChild(chevron);

  // Ikona smazání
  if (isDeleted) {
    const delIcon = document.createElement('span');
    delIcon.className = 'tc-deleted-icon';
    delIcon.title     = t('tc_deleted_title');
    delIcon.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
    head.appendChild(delIcon);
  }

  // ID
  const idEl = document.createElement('span');
  idEl.className   = 'tc-id' + (isDup ? ' dup-warning' : '');
  idEl.textContent = tc.id;
  if (isDup) idEl.title = t('dup_warning_title');

  // Název
  const nameEl = document.createElement('span');
  nameEl.className   = 'tc-name';
  nameEl.textContent = tc.name || t('tc_no_name');

  head.appendChild(idEl);
  head.appendChild(nameEl);

  // Ikona poznámky (jen pokud je vyplněná)
  if (tc.notes) {
    const notesIcon = document.createElement('span');
    notesIcon.className = 'tc-notes-icon';
    notesIcon.title     = tc.notes;
    notesIcon.innerHTML = notesIconSvg();
    head.appendChild(notesIcon);
  }

  // Badge priorita
  const priBadge = document.createElement('span');
  priBadge.className   = `tc-badge priority-${tc.priority}`;
  priBadge.textContent = priorityLabel(tc.priority);

  // Badge stav
  const staBadge = document.createElement('span');
  staBadge.className   = `tc-badge status-${tc.status}`;
  staBadge.textContent = statusLabel(tc.status);

  head.appendChild(priBadge);
  head.appendChild(staBadge);

  // Štítky
  (tc.tags || []).forEach(tag => {
    const tagBadge = document.createElement('span');
    tagBadge.className   = 'tc-badge tag-badge';
    tagBadge.textContent = tag;
    applyTagColorStyle(tagBadge, tag);
    head.appendChild(tagBadge);
  });

  // Checkbox pro výběr do exportu
  const exportCb = document.createElement('input');
  exportCb.type      = 'checkbox';
  exportCb.className = 'tc-export-check';
  exportCb.title     = t('tc_export_check_title');
  exportCb.checked   = tc.export_selected !== false;
  exportCb.onclick   = (e) => e.stopPropagation();
  exportCb.onchange  = () => {
    tc.export_selected = exportCb.checked;
    scheduleSave();
  };
  head.appendChild(exportCb);

  // Přesun nahoru/dolů — jen v administrátorském módu
  if (state.adminMode) {
    const idx = state.project.testCases.findIndex(t => t._uid === tc._uid);

    const moveWrap = document.createElement('div');
    moveWrap.className = 'tc-move-col';

    const upBtn = document.createElement('button');
    upBtn.className = 'tc-move-btn';
    upBtn.title      = t('tc_move_up_title');
    upBtn.disabled   = idx <= 0;
    upBtn.innerHTML  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m8 14 4-4 4 4"/></svg>`;
    upBtn.onclick    = (e) => { e.stopPropagation(); moveTc(tc._uid, -1); };

    const downBtn = document.createElement('button');
    downBtn.className = 'tc-move-btn';
    downBtn.title      = t('tc_move_down_title');
    downBtn.disabled   = idx === -1 || idx >= state.project.testCases.length - 1;
    downBtn.innerHTML  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m16 10-4 4-4-4"/></svg>`;
    downBtn.onclick    = (e) => { e.stopPropagation(); moveTc(tc._uid, 1); };

    moveWrap.appendChild(upBtn);
    moveWrap.appendChild(downBtn);
    head.appendChild(moveWrap);
  }

  // Klik na hlavičku = rozbalit/zabalit
  head.onclick = () => toggleExpand(tc._uid);
  row.appendChild(head);

  // Formulář pokud rozbaleno
  if (isExpanded) row.appendChild(buildTcForm(tc));

  return row;
}

/* ══════════════════════════════════════
   BUILD — formulář
══════════════════════════════════════ */
function buildTcForm(tc) {
  const form = document.createElement('div');
  const isLocked = tc.locked;
  form.className = 'tc-form' + (isLocked ? ' locked-form' : '');

  /* Priorita + Stav — nahoře */
  const row4 = document.createElement('div');
  row4.className = 'tc-form-row';

  row4.appendChild(formGroupPrioritySelect(tc, () => {
    refreshTcRowHead(tc._uid);
    scheduleSave();
  }));

  row4.appendChild(formGroupStatusSelect(tc, () => {
    refreshTcRowHead(tc._uid);
    scheduleSave();
  }));

  row4.appendChild(formGroupNotesInput(tc, () => {
    refreshTcRowHead(tc._uid);
    scheduleSave();
  }));

  form.appendChild(row4);

  /* Štítky */
  const tagsLabel = document.createElement('div');
  tagsLabel.className   = 'tc-form-label';
  tagsLabel.textContent = t('f_tags');
  form.appendChild(tagsLabel);

  const tagsContainer = document.createElement('div');
  tagsContainer.className = 'tags-section';
  renderTagsSection(tc, tagsContainer);
  form.appendChild(tagsContainer);

  /* Název */
  const row1 = document.createElement('div');
  row1.className = 'tc-form-row';
  const nameGroup = formGroupInput(t('f_name'), tc.name, t('f_name_placeholder'), v => {
    tc.name = v;
    const nameEl = document.querySelector(`[data-uid="${tc._uid}"] .tc-name`);
    if (nameEl) nameEl.textContent = v || t('tc_no_name');
    scheduleSave();
  });
  const nameInputEl = nameGroup.querySelector('input');
  if (nameInputEl) nameInputEl.classList.add('tc-name-input');
  row1.appendChild(nameGroup);
  form.appendChild(row1);

  /* Cíl */
  const row1b = document.createElement('div');
  row1b.className = 'tc-form-row';
  row1b.appendChild(formGroupInput(t('f_goal'), tc.goal, t('f_goal_placeholder'), v => {
    tc.goal = v;
    scheduleSave();
  }));
  form.appendChild(row1b);

  /* Testovací data */
  const row3 = document.createElement('div');
  row3.className = 'tc-form-row';
  row3.appendChild(formGroupTextarea(t('f_test_data'), tc.test_data, t('f_test_data_placeholder'), v => {
    tc.test_data = v;
    scheduleSave();
  }));
  form.appendChild(row3);

  /* Rodič dropdown — nad kroky */
  const rowParent = document.createElement('div');
  rowParent.className = 'tc-form-row';

  const parentGroup = document.createElement('div');
  parentGroup.className = 'tc-form-group';

  const parentLabel = document.createElement('div');
  parentLabel.className   = 'tc-form-label';
  parentLabel.textContent = t('f_parent');

  const parentSel = document.createElement('select');
  parentSel.className = 'inp';
  parentSel.style.width = '100%';

  const noneOpt = document.createElement('option');
  noneOpt.value       = '';
  noneOpt.textContent = t('f_parent_none');
  parentSel.appendChild(noneOpt);

  getActiveTcs().filter(other => other._uid !== tc._uid).forEach(other => {
    const opt = document.createElement('option');
    opt.value       = other._uid;
    opt.textContent = `${other.id} — ${other.name || t('tc_no_name')}`;
    if (tc.parent_id === other._uid) opt.selected = true;
    parentSel.appendChild(opt);
  });

  parentSel.onchange = () => {
    tc.parent_id = parentSel.value || null;
    const stepsContainer = form.querySelector('.steps-section');
    if (stepsContainer) renderStepsSection(tc, stepsContainer);
    scheduleSave();
  };

  parentGroup.appendChild(parentLabel);
  parentGroup.appendChild(parentSel);

  if (tc.parent_id) {
    const parent = getTcByUid(tc.parent_id);
    if (!parent || parent.deleted) {
      const warn = document.createElement('div');
      warn.className = 'parent-warn';
      warn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg> ${t('f_parent_warn')}`;
      parentGroup.appendChild(warn);
    }
  }

  rowParent.appendChild(parentGroup);
  form.appendChild(rowParent);

  /* Kroky (každý krok obsahuje i svůj vlastní Očekávaný výsledek) */
  const stepsLabel = document.createElement('div');
  stepsLabel.className   = 'tc-form-label';
  stepsLabel.textContent = t('f_steps');
  form.appendChild(stepsLabel);

  const stepsContainer = document.createElement('div');
  stepsContainer.className = 'steps-section';
  renderStepsSection(tc, stepsContainer);
  form.appendChild(stepsContainer);

  /* Očekávaný výsledek (samostatný, celkový) — před Předpoklady */
  const erLabel = document.createElement('div');
  erLabel.className   = 'tc-form-label';
  erLabel.textContent = t('f_expected_result');
  form.appendChild(erLabel);

  const erContainer = document.createElement('div');
  erContainer.className = 'er-section';
  renderExpectedResult(tc, erContainer);
  form.appendChild(erContainer);

  /* Předpoklady — za Očekávaným výsledkem */
  const inheritedPrecond = getInheritedPreconditionsChain(tc);
  if (inheritedPrecond) {
    const precondInhWrap = document.createElement('div');
    precondInhWrap.className = 'tc-form-row';

    const precondInhGroup = document.createElement('div');
    precondInhGroup.className = 'tc-form-group full precond-inherited' +
      (tc.inherited_preconditions_override !== undefined ? ' precond-overridden' : '');

    const precondInhLabel = document.createElement('div');
    precondInhLabel.className   = 'tc-form-label';
    precondInhLabel.textContent = `${t('f_preconditions_inherited_from')} ${getTcByUid(tc.parent_id)?.id || ''}`;
    precondInhGroup.appendChild(precondInhLabel);

    const precondInhTa = document.createElement('textarea');
    precondInhTa.className = 'inp';
    precondInhTa.rows      = 2;
    precondInhTa.value     = tc.inherited_preconditions_override !== undefined
      ? tc.inherited_preconditions_override
      : inheritedPrecond;
    precondInhTa.title = t('step_inherited_title');
    precondInhTa.addEventListener('input', () => {
      if (precondInhTa.value === inheritedPrecond) {
        delete tc.inherited_preconditions_override;
      } else {
        tc.inherited_preconditions_override = precondInhTa.value;
      }
      precondInhGroup.classList.toggle('precond-overridden', tc.inherited_preconditions_override !== undefined);
      scheduleSave();
    });
    precondInhGroup.appendChild(precondInhTa);

    const precondInhWrapRow = document.createElement('div');
    precondInhWrapRow.style.display = 'flex';
    precondInhWrapRow.style.width = '100%';
    precondInhWrapRow.appendChild(precondInhGroup);
    precondInhWrap.appendChild(precondInhWrapRow);
    form.appendChild(precondInhWrap);

    const precondDivider = document.createElement('div');
    precondDivider.className   = 'steps-divider';
    precondDivider.textContent = t('f_preconditions_own');
    form.appendChild(precondDivider);
  }

  const row2 = document.createElement('div');
  row2.className = 'tc-form-row';
  row2.appendChild(formGroupTextarea(t('f_preconditions'), tc.preconditions, t('f_preconditions_placeholder'), v => {
    tc.preconditions = v;
    scheduleSave();
  }));
  form.appendChild(row2);

  /* Akce */
  const actions = document.createElement('div');
  actions.className = 'tc-form-actions';

  const btnCopy = document.createElement('button');
  btnCopy.className = 'sbtn';
  btnCopy.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg> ${t('act_copy')}`;
  btnCopy.onclick = () => copyTcToClipboard(tc);
  actions.appendChild(btnCopy);

  const btnCopySettings = document.createElement('button');
  btnCopySettings.className = 'sbtn icon-only';
  btnCopySettings.title = t('copy_settings_title');
  btnCopySettings.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;
  btnCopySettings.onclick = () => openModalCopySettings();
  actions.appendChild(btnCopySettings);

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  actions.appendChild(spacer);

  if (!tc.deleted) {
    const btnVer = document.createElement('button');
    btnVer.className = 'sbtn warn';
    btnVer.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg> ${t('act_version')}`;
    btnVer.onclick = () => openModalVersion(tc._uid);
    actions.appendChild(btnVer);

    const btnSave = document.createElement('button');
    btnSave.className = 'sbtn success';
    btnSave.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg> ${t('act_save_lock')}`;
    btnSave.title = t('act_save_lock_title');
    btnSave.onclick = () => saveLockAndClose(tc._uid);
    actions.appendChild(btnSave);
  }

  if (!tc.deleted) {
    const btnDel = document.createElement('button');
    btnDel.className = 'sbtn danger';
    btnDel.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg> ${t('act_delete')}`;
    btnDel.onclick = () => {
      tc.deleted = true;
      scheduleSave();
      renderTcList();
    };
    actions.appendChild(btnDel);
  } else {
    const btnRestore = document.createElement('button');
    btnRestore.className = 'sbtn success';
    btnRestore.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> ${t('act_restore')}`;
    btnRestore.onclick = () => {
      tc.deleted = false;
      scheduleSave();
      renderTcList();
    };
    actions.appendChild(btnRestore);
  }

  form.appendChild(actions);

  /* Admin zóna — viditelná jen v admin módu */
  if (state.adminMode) {
    form.appendChild(buildAdminZone(tc));
  }

  /* ── Aplikovat readonly na všechny inputy pokud je TC zamčený ── */
  if (isLocked) {
    form.querySelectorAll('input:not([type="checkbox"]), textarea, select').forEach(el => {
      el.readOnly = true;
      el.classList.add('locked-input');
    });
  }

  return form;
}

/* Uložit TC (zamknout) + zabalit */
function saveLockAndClose(uid) {
  const tc = getTcByUid(uid);
  if (!tc) return;

  tc.locked = true;
  state.expandedId = null;
  scheduleSave();
  renderTcList();
}


function buildAdminZone(tc) {
  const zone = document.createElement('div');
  zone.className = 'admin-zone';

  const label = document.createElement('div');
  label.className = 'admin-zone-label';
  label.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 22c-3.806-1.45-7-3.966-7-9V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1v4"/><circle cx="17.695" cy="17.695" r="3"/></svg> ${t('admin_zone_label')}`;
  zone.appendChild(label);

  /* Editace ID */
  const idRow = document.createElement('div');
  idRow.className = 'admin-zone-row';

  const idGroup = document.createElement('div');
  idGroup.className = 'tc-form-group';
  idGroup.style.minWidth = '200px';
  const idLabel = document.createElement('div');
  idLabel.className = 'tc-form-label';
  idLabel.textContent = t('admin_id_label', { prefix: state.project.prefix });

  const idWrap = document.createElement('div');
  idWrap.style.display = 'flex';
  idWrap.style.alignItems = 'center';
  idWrap.style.gap = '4px';

  const prefixTag = document.createElement('span');
  prefixTag.style.fontFamily = "'Cascadia Code','Consolas',monospace";
  prefixTag.style.fontSize = '14px';
  prefixTag.style.color = 'var(--text4)';
  prefixTag.textContent = state.project.prefix;

  // Vytáhni jen číslo/suffix část za prefixem
  const suffix = tc.id.startsWith(state.project.prefix)
    ? tc.id.slice(state.project.prefix.length)
    : tc.id;

  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.className = 'inp mono';
  idInput.style.width = '100%';
  idInput.value = suffix;
  idInput.spellcheck = false;

  idWrap.appendChild(prefixTag);
  idWrap.appendChild(idInput);
  idGroup.appendChild(idLabel);
  idGroup.appendChild(idWrap);

  const idSaveBtn = document.createElement('button');
  idSaveBtn.className = 'sbtn warn';
  idSaveBtn.textContent = t('admin_id_save');
  idSaveBtn.onclick = () => applyIdSuffixChange(tc, idInput.value);

  idRow.appendChild(idGroup);
  idRow.appendChild(idSaveBtn);
  zone.appendChild(idRow);

  /* Trvalé smazání */
  const delRow = document.createElement('div');
  delRow.className = 'admin-zone-row';
  const hardDelBtn = document.createElement('button');
  hardDelBtn.className = 'sbtn danger';
  hardDelBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg> ${t('admin_hard_delete')}`;
  hardDelBtn.onclick = () => openModalHardDelete(tc._uid);
  delRow.appendChild(hardDelBtn);
  zone.appendChild(delRow);

  return zone;
}

/* Změna pouze číselné/suffix části ID — prefix zůstává nedotčen */
function applyIdSuffixChange(tc, newSuffix) {
  newSuffix = newSuffix.trim();
  if (!newSuffix) return;

  const newId = `${state.project.prefix}${newSuffix}`;
  if (newId === tc.id) return;

  tc.id = newId;
  renderTcList();
  scheduleSave();
}

/* Změna prefixu projektu — promítne se do všech TC, dostupné jen v admin módu */
function applyProjectPrefixChange(newPrefix) {
  newPrefix = newPrefix.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!newPrefix || !state.project) return;

  const oldPrefix = state.project.prefix;
  if (newPrefix === oldPrefix) return;

  state.project.prefix = newPrefix;
  document.getElementById('proj-prefix').value = newPrefix;

  state.project.testCases.forEach(t => {
    if (t.id.startsWith(oldPrefix)) {
      t.id = newPrefix + t.id.slice(oldPrefix.length);
    }
  });

  renderTcList();
  scheduleSave();
}

/* Ručně přečísluje ID všech TC podle jejich aktuálního pořadí v seznamu
   (drag&drop pozice). TC se stejnou verzovací rodinou (verze stejného TC,
   které se drží pohromadě hned pod sebou) dostanou stejné nové číslo,
   liší se jen -V příponou. Dostupné jen v administrátorském módu. */
function renumberTcsByOrder() {
  if (!state.project) return;
  if (!confirm(t('pb_renumber_order_confirm'))) return;

  const prefix = state.project.prefix;
  let counter      = 0;
  let lastBaseNum  = undefined;

  state.project.testCases.forEach(tc => {
    const m = tc.id.match(/-?(\d+)(?:-V\d+)?$/);
    const baseNum = m ? m[1] : null;
    if (baseNum !== lastBaseNum) {
      counter++;
      lastBaseNum = baseNum;
    }
    tc.id = formatTcId(prefix, counter, tc.version || 1);
  });

  renderTcList();
  scheduleSave();
}

/* ══════════════════════════════════════
   TRVALÉ SMAZÁNÍ (hard delete)
══════════════════════════════════════ */
function openModalHardDelete(uid) {
  const tc = getTcByUid(uid);
  if (!tc) return;
  state.hardDeleteTargetId = uid;
  document.getElementById('hd-target-id').textContent = tc.id;

  const input = document.getElementById('hd-confirm-input');
  const btn   = document.getElementById('hd-confirm-btn');
  input.value = '';
  btn.disabled = true;

  // Listener se váže znovu při každém otevření modalu — nezávisle na
  // pořadí inicializace zbytku aplikace (robustnější než jednorázový
  // listener navázaný jen jednou při startu).
  input.oninput = () => {
    const target = getTcByUid(state.hardDeleteTargetId);
    btn.disabled = !(target && input.value.trim() === target.id);
  };

  document.getElementById('modal-harddelete-ov').classList.add('open');
  setTimeout(() => input.focus(), 80);
}

function closeModalHardDelete() {
  document.getElementById('modal-harddelete-ov').classList.remove('open');
  state.hardDeleteTargetId = null;
}

/* ══════════════════════════════════════
   O APLIKACI
══════════════════════════════════════ */
function openModalAbout() {
  document.getElementById('modal-about-ov').classList.add('open');
}

function closeModalAbout() {
  document.getElementById('modal-about-ov').classList.remove('open');
}

/* ══════════════════════════════════════
   NAJÍT A NAHRADIT
══════════════════════════════════════ */
let frMatches = []; // [{ tc, field, index(optional for arrays), before, after }]

const FR_SIMPLE_FIELDS = ['name', 'goal', 'preconditions', 'test_data'];
const FR_ARRAY_FIELDS   = ['steps', 'expected_result'];

function openModalFindReplace() {
  if (!state.project) return;
  document.getElementById('fr-find').value = '';
  document.getElementById('fr-replace').value = '';
  document.getElementById('fr-case-sensitive').checked = false;
  document.getElementById('fr-results-wrap').classList.add('hidden');
  document.getElementById('fr-confirm-btn').disabled = true;
  frMatches = [];
  document.getElementById('modal-findreplace-ov').classList.add('open');
  setTimeout(() => document.getElementById('fr-find').focus(), 80);
}

function closeModalFindReplace() {
  document.getElementById('modal-findreplace-ov').classList.remove('open');
  frMatches = [];
}

function frGetSelectedFields() {
  const all = [...FR_SIMPLE_FIELDS, ...FR_ARRAY_FIELDS];
  return all.filter(f => {
    const cb = document.getElementById(`fr-field-${f}`);
    return cb && cb.checked;
  });
}

function frHighlight(text, find, caseSensitive) {
  const flags = caseSensitive ? 'g' : 'gi';
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, flags), m => `<mark>${m}</mark>`);
}

function frRunSearch() {
  const find   = document.getElementById('fr-find').value;
  const replace = document.getElementById('fr-replace').value;
  const caseSensitive = document.getElementById('fr-case-sensitive').checked;
  const fields = frGetSelectedFields();

  frMatches = [];

  if (!find || !fields.length || !state.project) {
    renderFrResults();
    return;
  }

  const flags = caseSensitive ? 'g' : 'gi';
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, flags);

  // Hledáme ve VŠECH TC včetně smazaných (dle zadání)
  state.project.testCases.forEach(tc => {
    FR_SIMPLE_FIELDS.forEach(field => {
      if (!fields.includes(field)) return;
      const val = tc[field] || '';
      if (re.test(val)) {
        frMatches.push({ tc, field, arrayIndex: null, before: val, after: val.replace(re, replace) });
      }
      re.lastIndex = 0;
    });

    // 'steps' hledá v textu kroku (tc.steps[].step)
    if (fields.includes('steps')) {
      (tc.steps || []).forEach((s, i) => {
        const val = s.step || '';
        if (re.test(val)) {
          frMatches.push({ tc, field: 'steps', arrayIndex: i, before: val, after: val.replace(re, replace) });
        }
        re.lastIndex = 0;
      });
    }
    // 'expected_result' hledá v samostatném (celkovém) seznamu očekávaných výsledků
    if (fields.includes('expected_result')) {
      (tc.expected_result || []).forEach((val, i) => {
        if (re.test(val)) {
          frMatches.push({ tc, field: 'expected_result', arrayIndex: i, before: val, after: val.replace(re, replace) });
        }
        re.lastIndex = 0;
      });
    }
  });

  renderFrResults();
}

function renderFrResults() {
  const wrap  = document.getElementById('fr-results-wrap');
  const list  = document.getElementById('fr-results-list');
  const count = document.getElementById('fr-results-count');
  const confirmBtn = document.getElementById('fr-confirm-btn');

  wrap.classList.remove('hidden');
  list.innerHTML = '';

  if (!frMatches.length) {
    list.innerHTML = `<div class="fr-no-results">${t('fr_no_results')}</div>`;
    count.textContent = '';
    confirmBtn.disabled = true;
    return;
  }

  const tcCount = new Set(frMatches.map(m => m.tc._uid)).size;
  count.textContent = t('fr_results_count', { n: frMatches.length, tc: tcCount });
  confirmBtn.disabled = false;

  const caseSensitive = document.getElementById('fr-case-sensitive').checked;
  const find = document.getElementById('fr-find').value;

  const fieldLabels = {
    name: t('f_name'), goal: t('f_goal'), preconditions: t('f_preconditions'),
    test_data: t('f_test_data'), steps: t('f_steps'), expected_result: t('f_expected_result')
  };

  frMatches.forEach(m => {
    const item = document.createElement('div');
    item.className = 'fr-result-item';

    const header = document.createElement('div');
    header.className = 'fr-result-header';
    const idEl = document.createElement('span');
    idEl.className = 'fr-result-id';
    idEl.textContent = m.tc.id + (m.tc.deleted ? ' 🗑' : '');
    const fieldEl = document.createElement('span');
    fieldEl.className = 'fr-result-field';
    fieldEl.textContent = fieldLabels[m.field] + (m.arrayIndex !== null ? ` #${m.arrayIndex + 1}` : '');
    header.appendChild(idEl);
    header.appendChild(fieldEl);

    const diff = document.createElement('div');
    diff.className = 'fr-result-diff';
    diff.innerHTML =
      `<div class="before">${frHighlight(m.before, find, caseSensitive)}</div>` +
      `<div class="after">${m.after.replace(
        new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi'),
        x => `<mark class="after-mark">${x.length ? x : ''}</mark>`
      )}</div>`;

    item.appendChild(header);
    item.appendChild(diff);
    list.appendChild(item);
  });
}

function confirmFindReplace() {
  if (!frMatches.length) return;

  frMatches.forEach(m => {
    if (m.field === 'steps') {
      m.tc.steps[m.arrayIndex].step = m.after;
    } else if (m.field === 'expected_result') {
      m.tc.expected_result[m.arrayIndex] = m.after;
    } else if (m.arrayIndex === null) {
      m.tc[m.field] = m.after;
    } else {
      m.tc[m.field][m.arrayIndex] = m.after;
    }
  });

  const replacedCount = frMatches.length;
  closeModalFindReplace();
  renderTcList();
  scheduleSave();

  // Krátké potvrzení přes autosave indikátor
  const ind = document.getElementById('autosave-ind');
  const originalText = ind.textContent;
  ind.textContent = t('fr_done', { n: replacedCount });
  ind.style.opacity = '1';
  setTimeout(() => {
    ind.style.opacity = '0';
    setTimeout(() => { ind.textContent = originalText; }, 500);
  }, 2200);
}

function confirmHardDelete() {
  const uid = state.hardDeleteTargetId;
  const tc  = getTcByUid(uid);
  if (!tc) return;

  state.project.testCases = state.project.testCases.filter(t => t._uid !== uid);
  if (state.expandedId === uid) state.expandedId = null;

  closeModalHardDelete();
  renderTcList();
  scheduleSave();
}

/* ══════════════════════════════════════
   FORM HELPERS
══════════════════════════════════════ */
function copyIconSvg() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
}

function checkIconSvg() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
}

/* Přidá malé tlačítko pro zkopírování hodnoty do libovolného kontejneru
   (label, řádek pole u kroků, ...) */
function addFieldCopyButton(container, getValueFn) {
  const btn = document.createElement('button');
  btn.type      = 'button';
  btn.className = 'field-copy-btn';
  btn.title     = t('copy_field_title');
  btn.innerHTML = copyIconSvg();

  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const val = getValueFn();
    if (!val) return;
    navigator.clipboard.writeText(val).then(() => {
      btn.innerHTML = checkIconSvg();
      btn.classList.add('field-copy-done');
      setTimeout(() => {
        btn.innerHTML = copyIconSvg();
        btn.classList.remove('field-copy-done');
      }, 900);
    });
  });

  container.appendChild(btn);
  return btn;
}

/* Přidá k popisku pole malé tlačítko pro zkopírování aktuálního obsahu
   daného pole do schránky (samostatně, mimo obecné kopírování celého TC) */
function addCopyButtonToLabel(labelDiv, getValueFn) {
  labelDiv.classList.add('tc-form-label-row');
  addFieldCopyButton(labelDiv, getValueFn);
}

function formGroupInput(label, value, placeholder, onChange) {
  const g = document.createElement('div');
  g.className = 'tc-form-group';

  const l = document.createElement('div');
  l.className   = 'tc-form-label';
  l.textContent = label;

  const inp = document.createElement('input');
  inp.type        = 'text';
  inp.className   = 'inp';
  inp.value       = value || '';
  inp.placeholder = placeholder || '';
  inp.addEventListener('input', () => onChange(inp.value));

  addCopyButtonToLabel(l, () => inp.value);

  g.appendChild(l);
  g.appendChild(inp);
  return g;
}

function formGroupTextarea(label, value, placeholder, onChange) {
  const g = document.createElement('div');
  g.className = 'tc-form-group full';

  const l = document.createElement('div');
  l.className   = 'tc-form-label';
  l.textContent = label;

  const ta = document.createElement('textarea');
  ta.className   = 'inp';
  ta.rows        = 2;
  ta.value       = value || '';
  ta.placeholder = placeholder || '';
  ta.addEventListener('input', () => onChange(ta.value));

  addCopyButtonToLabel(l, () => ta.value);

  g.appendChild(l);
  g.appendChild(ta);
  return g;
}

function formGroupSelect(label, value, options, onChange) {
  const g = document.createElement('div');
  g.className = 'tc-form-group';
  g.style.minWidth = '130px';
  g.style.flex     = '0 0 auto';

  const l = document.createElement('div');
  l.className   = 'tc-form-label';
  l.textContent = label;

  const sel = document.createElement('select');
  sel.className   = 'inp';
  sel.style.width = '100%';

  options.forEach(opt => {
    const o = document.createElement('option');
    o.value       = opt.value;
    o.textContent = opt.label;
    if (opt.value === value) o.selected = true;
    sel.appendChild(o);
  });

  sel.addEventListener('change', () => onChange(sel.value));

  g.appendChild(l);
  g.appendChild(sel);
  return g;
}

/* ── Priority select s barevným zvýrazněním ── */
function formGroupStatusSelect(tc, onChangeCb) {
  const g = document.createElement('div');
  g.className = 'tc-form-group';
  g.style.minWidth = '130px';
  g.style.flex     = '0 0 auto';

  const l = document.createElement('div');
  l.className   = 'tc-form-label';
  l.textContent = t('f_status');

  const sel = document.createElement('select');
  sel.className = `inp status-select status-${tc.status}`;
  sel.style.width = '100%';

  [
    { value: 'draft',      label: t('status_draft')      },
    { value: 'ready',      label: t('status_ready')      },
    { value: 'deprecated', label: t('status_deprecated') }
  ].forEach(opt => {
    const o = document.createElement('option');
    o.value       = opt.value;
    o.textContent = opt.label;
    if (opt.value === tc.status) o.selected = true;
    sel.appendChild(o);
  });

  sel.addEventListener('change', () => {
    tc.status = sel.value;
    sel.className = `inp status-select status-${sel.value}`;
    onChangeCb();
  });

  g.appendChild(l);
  g.appendChild(sel);
  return g;
}

/* Seznam dostupných štítků — společný napříč všemi projekty (localStorage),
   ne vázaný na jeden konkrétní projekt */
function loadGlobalTags() {
  try {
    const saved = JSON.parse(localStorage.getItem('tc_global_tags') || 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch (e) { /* ignore */ }
  return ['E2E', 'Regrese'];
}

let globalTags = loadGlobalTags();

function saveGlobalTags() {
  try {
    localStorage.setItem('tc_global_tags', JSON.stringify(globalTags));
  } catch (e) { /* ignore */ }
}

/* Barvy štítků — mapa jméno → hex barva, také napříč projekty */
const TAG_COLOR_PALETTE = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1'];

/* ══════════════════════════════════════
   NASTAVENÍ — tiché automatické zálohy
══════════════════════════════════════ */
function loadSilentBackupSetting() {
  const v = localStorage.getItem('tc_silent_backup_enabled');
  return v === null ? true : v === 'true'; // výchozí: zapnuto
}

let silentBackupEnabled = loadSilentBackupSetting();

function saveSilentBackupSetting(enabled) {
  silentBackupEnabled = enabled;
  try { localStorage.setItem('tc_silent_backup_enabled', enabled ? 'true' : 'false'); } catch (e) { /* ignore */ }
}

function openModalSettings() {
  document.getElementById('settings-silent-backup').checked = silentBackupEnabled;
  document.getElementById('modal-settings-ov').classList.add('open');
}

function closeModalSettings() {
  document.getElementById('modal-settings-ov').classList.remove('open');
}

const SILENT_BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minut

setInterval(async () => {
  if (!silentBackupEnabled) return;
  if (!state.project || !state.filePath) return;
  if (!dirtySinceLastBackup) return; // nic nového od poslední zálohy — přeskoč

  syncTagColorsIntoProject(state.project);
  const result = await window.api.silentBackup(state.filePath, state.project);
  if (result && result.success) dirtySinceLastBackup = false;
}, SILENT_BACKUP_INTERVAL_MS);

function loadTagColors() {
  try {
    const saved = JSON.parse(localStorage.getItem('tc_tag_colors') || 'null');
    if (saved && typeof saved === 'object') return saved;
  } catch (e) { /* ignore */ }
  return {};
}

let tagColors = loadTagColors();

function saveTagColors() {
  try {
    localStorage.setItem('tc_tag_colors', JSON.stringify(tagColors));
  } catch (e) { /* ignore */ }
}

/* Barva štítku — pokud nemá uloženou vlastní, přidělí se deterministicky z palety */
function getTagColor(tagName) {
  if (tagColors[tagName]) return tagColors[tagName];
  const idx = globalTags.indexOf(tagName);
  return TAG_COLOR_PALETTE[idx >= 0 ? idx % TAG_COLOR_PALETTE.length : 0];
}

/* Barvy štítků žijí jen v localStorage appky (napříč projekty), takže se
   samy o sobě do JSON projektu nikdy nedostanou. Tahle funkce před každým
   uložením/exportem vloží aktuální mapu { jméno_štítku: '#hex' } — jen pro
   štítky, které se v tomto projektu opravdu používají — přímo do dat
   projektu jako project.tagColors, aby ji mohly použít i jiné nástroje
   (např. TC Runner) a barvy jim seděly stejně jako v Creatoru. */
function syncTagColorsIntoProject(project) {
  if (!project || !Array.isArray(project.testCases)) return;
  const used = new Set();
  project.testCases.forEach(tc => (tc.tags || []).forEach(tag => used.add(tag)));

  const map = {};
  used.forEach(tag => { map[tag] = getTagColor(tag); });
  project.tagColors = map;
}

function hexToRgba(hex, alpha) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) return `rgba(124,124,124,${alpha})`;
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* Aplikuje barvu štítku na chip/badge element (border+text plná barva, pozadí jemný odstín) */
function applyTagColorStyle(el, tagName) {
  const color = getTagColor(tagName);
  el.style.borderColor     = color;
  el.style.color           = color;
  el.style.backgroundColor = hexToRgba(color, .14);
}

/* Štítky (tagy) — chipy s možností smazání, výběr existujícího štítku
   (společný seznam napříč projekty), nebo vytvoření zcela nového */
/* ══════════════════════════════════════
   MODAL — SPRÁVA ŠTÍTKŮ (globální, napříč projekty)
══════════════════════════════════════ */
function openModalManageTags() {
  renderTagsModalList();
  document.getElementById('modal-tags-ov').classList.add('open');
  document.getElementById('tags-modal-new-inp').value = '';
}

function closeModalManageTags() {
  document.getElementById('modal-tags-ov').classList.remove('open');
}

function renderTagsModalList() {
  const list = document.getElementById('tags-modal-list');
  if (!list) return;
  list.innerHTML = '';

  if (!globalTags.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:14px;font-size:12px;color:var(--text4);text-align:center;';
    empty.textContent = t('tags_modal_empty');
    list.appendChild(empty);
    return;
  }

  globalTags.forEach(tag => {
    const row = document.createElement('div');
    row.className = 'csv-tc-select-item';
    row.style.cursor = 'default';
    row.style.gap = '10px';

    const colorInp = document.createElement('input');
    colorInp.type  = 'color';
    colorInp.className = 'tag-color-picker';
    colorInp.value = getTagColor(tag);
    colorInp.title = t('tag_color_title');
    colorInp.addEventListener('input', () => {
      tagColors[tag] = colorInp.value;
      saveTagColors();
      applyTagColorStyle(label, tag);
      if (state.project) {
        if (state.expandedId) renderTcList();
        else document.querySelectorAll('.tag-badge').forEach(el => {
          if (el.textContent === tag) applyTagColorStyle(el, tag);
        });
      }
    });

    const label = document.createElement('span');
    label.className = 'tag-chip';
    label.textContent = tag;
    label.style.marginRight = 'auto';
    applyTagColorStyle(label, tag);

    const rm = document.createElement('button');
    rm.className = 'step-del';
    rm.innerHTML = '×';
    rm.title = t('tag_delete_everywhere_title');
    rm.addEventListener('click', () => {
      globalTags = globalTags.filter(x => x !== tag);
      saveGlobalTags();
      delete tagColors[tag];
      saveTagColors();

      // Odeber tento štítek i ze všech TC v aktuálně otevřeném projektu
      if (state.project) {
        state.project.testCases.forEach(tc => {
          if (tc.tags && tc.tags.includes(tag)) {
            tc.tags = tc.tags.filter(x => x !== tag);
          }
        });
        if (state.expandedId) renderTcList();
        scheduleSave();
      }

      renderTagsModalList();
    });

    row.appendChild(colorInp);
    row.appendChild(label);
    row.appendChild(rm);
    list.appendChild(row);
  });
}

function addNewGlobalTag() {
  const inp = document.getElementById('tags-modal-new-inp');
  const name = inp.value.trim();
  if (!name) return;
  const existing = globalTags.find(x => x.toLowerCase() === name.toLowerCase());
  if (!existing) {
    globalTags.push(name);
    saveGlobalTags();
  }
  inp.value = '';
  renderTagsModalList();
}

function renderTagsSection(tc, container) {
  container.innerHTML = '';
  if (!tc.tags) tc.tags = [];

  const chipsWrap = document.createElement('div');
  chipsWrap.className = 'tags-chips';

  tc.tags.forEach(tag => {
    const chip = document.createElement('span');
    chip.className   = 'tag-chip';
    chip.textContent = tag;
    applyTagColorStyle(chip, tag);

    const rm = document.createElement('button');
    rm.className = 'tag-chip-remove';
    rm.innerHTML = '×';
    rm.title     = t('tag_remove_title');
    rm.addEventListener('click', () => {
      tc.tags = tc.tags.filter(x => x !== tag);
      renderTagsSection(tc, container);
      refreshTcRowHead(tc._uid);
      scheduleSave();
    });

    chip.appendChild(rm);
    chipsWrap.appendChild(chip);
  });

  container.appendChild(chipsWrap);

  const addRow = document.createElement('div');
  addRow.className = 'tags-add-row';

  const availableTags = globalTags.filter(tg => !tc.tags.includes(tg));

  const sel = document.createElement('select');
  sel.className = 'inp tags-select';
  sel.style.flex = '1';

  const emptyOpt = document.createElement('option');
  emptyOpt.value       = '';
  emptyOpt.textContent = availableTags.length ? t('tag_pick_existing') : t('tag_none_available');
  sel.appendChild(emptyOpt);

  availableTags.forEach(tag => {
    const o = document.createElement('option');
    o.value       = tag;
    o.textContent = tag;
    sel.appendChild(o);
  });

  sel.addEventListener('change', () => {
    if (!sel.value) return;
    if (!tc.tags.includes(sel.value)) tc.tags.push(sel.value);
    renderTagsSection(tc, container);
    refreshTcRowHead(tc._uid);
    scheduleSave();
  });

  addRow.appendChild(sel);
  container.appendChild(addRow);
}

function formGroupNotesInput(tc, onChangeCb) {
  const g = document.createElement('div');
  g.className = 'tc-form-group';

  const l = document.createElement('div');
  l.className   = 'tc-form-label';
  l.textContent = t('f_notes');

  const inp = document.createElement('input');
  inp.type        = 'text';
  inp.className   = 'inp notes-inp' + (tc.notes ? ' notes-filled' : '');
  inp.value       = tc.notes || '';
  inp.placeholder = t('f_notes_placeholder');
  inp.title       = t('f_notes_title');
  inp.addEventListener('input', () => {
    tc.notes = inp.value;
    inp.classList.toggle('notes-filled', !!inp.value);
    onChangeCb();
  });

  addCopyButtonToLabel(l, () => inp.value);

  g.appendChild(l);
  g.appendChild(inp);
  return g;
}

function formGroupPrioritySelect(tc, onChangeCb) {
  const g = document.createElement('div');
  g.className = 'tc-form-group';
  g.style.minWidth = '130px';
  g.style.flex     = '0 0 auto';

  const l = document.createElement('div');
  l.className   = 'tc-form-label';
  l.textContent = t('f_priority');

  const sel = document.createElement('select');
  sel.className = `inp priority-select priority-${tc.priority}`;
  sel.style.width = '100%';

  [
    { value: 'high',   label: t('priority_high')   },
    { value: 'medium', label: t('priority_medium') },
    { value: 'low',    label: t('priority_low')    }
  ].forEach(opt => {
    const o = document.createElement('option');
    o.value       = opt.value;
    o.textContent = opt.label;
    if (opt.value === tc.priority) o.selected = true;
    sel.appendChild(o);
  });

  sel.addEventListener('change', () => {
    tc.priority = sel.value;
    sel.className = `inp priority-select priority-${sel.value}`;
    onChangeCb();
  });

  g.appendChild(l);
  g.appendChild(sel);
  return g;
}


function renderStepsSection(tc, container) {
  container.innerHTML = '';
  const order = buildStepRenderOrder(tc);
  const hasInherited = order.some(entry => entry.type === 'inherited');

  if (hasInherited) {
    const inhLabel = document.createElement('div');
    inhLabel.className   = 'steps-inherited-label';
    inhLabel.textContent = `${t('f_steps_inherited_from')} ${getTcByUid(tc.parent_id)?.id || ''}`;
    container.appendChild(inhLabel);
  }

  const list = document.createElement('div');
  list.className = 'steps-list';

  let stepNum = 1;

  list.appendChild(buildInsertStepDivider(tc, order, 0, container));

  order.forEach((entry, k) => {
    if (entry.type === 'inherited') {
      const displayNum = entry.item.deleted ? null : stepNum++;
      list.appendChild(buildInheritedStepPair(tc, entry.item, container, displayNum));
    } else {
      list.appendChild(buildStepItem(tc, entry.i, stepNum++, container));
    }
    list.appendChild(buildInsertStepDivider(tc, order, k + 1, container));
  });

  container.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.className = 'add-step-btn';
  addBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg> ${t('add_step')}`;
  addBtn.addEventListener('click', () => {
    tc.steps.push({ step: '', expected: '', test_data: '' });
    renderStepsSection(tc, container);
    scheduleSave();
    setTimeout(() => {
      const inputs = container.querySelectorAll('.steps-list .step-field');
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 30);
  });
  container.appendChild(addBtn);
}

/* "Vložit krok sem" — vždy viditelná "+" ikona vpravo na dělící lince mezi
   kroky. Funguje mezi vlastními i mezi zděděnými kroky (i před prvním
   zděděným) — nový krok se v druhém případě uloží jako vlastní, jen s
   vazbou "zobrazit hned za zděděným krokem č. X" (insert_after), takže se
   dál dědí dětem přesně na svém místě, stejně jako běžný krok. */
function buildInsertStepDivider(tc, order, k, container) {
  const wrap = document.createElement('div');
  wrap.className = 'step-insert-divider';

  const btn = document.createElement('button');
  btn.type      = 'button';
  btn.className = 'step-insert-btn';
  btn.title     = t('step_insert_title');
  btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;
  btn.addEventListener('click', () => {
    // Najdi cílový slot: nejbližší předchozí zděděná položka v pořadí
    let slot = 'start';
    for (let j = k - 1; j >= 0; j--) {
      if (order[j].type === 'inherited') { slot = order[j].item.globalIndex; break; }
    }

    const newStep = { step: '', expected: '', test_data: '' };
    if (slot !== 'start') newStep.insert_after = slot;

    // Najdi přesnou pozici v poli tc.steps
    let arrIdx;
    if (k > 0 && order[k - 1].type === 'own') {
      arrIdx = order[k - 1].i + 1;
    } else {
      let found = null;
      for (let j = k; j < order.length; j++) {
        if (order[j].type === 'own') { found = order[j].i; break; }
        if (order[j].type === 'inherited') break;
      }
      arrIdx = found !== null ? found : tc.steps.length;
    }

    tc.steps.splice(arrIdx, 0, newStep);
    renderStepsSection(tc, container);
    scheduleSave();
  });

  wrap.appendChild(btn);
  return wrap;
}

/* Vlastní krok + jeho vlastní Očekávaný výsledek (stejný pár, jedno tlačítko smazat) */
function buildStepItem(tc, index, displayNum, container) {
  const item = document.createElement('div');
  item.className = 'step-item step-pair';

  // Levý sloupec: jen číslo kroku
  const numCol = document.createElement('div');
  numCol.className = 'step-num-col';

  const num = document.createElement('span');
  num.className   = 'step-num';
  num.textContent = displayNum + '.';

  numCol.appendChild(num);

  // Pravý sloupec: zarovnaná pole Krok / Očekávaný výsledek / Testovací data
  const fieldsCol = document.createElement('div');
  fieldsCol.className = 'step-fields-col';

  const stepRow = document.createElement('div');
  stepRow.className = 'step-field-row';

  const inp = document.createElement('input');
  inp.type        = 'text';
  inp.className   = 'step-inp step-field';
  inp.dataset.arrIdx = index;
  inp.value       = tc.steps[index].step || '';
  inp.placeholder = `${t('f_step_placeholder')} ${displayNum}…`;
  inp.addEventListener('input', () => {
    tc.steps[index].step = inp.value;
    scheduleSave();
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const newStep = { step: '', expected: '', test_data: '' };
      const currentSlot = tc.steps[index].insert_after;
      if (currentSlot !== undefined && currentSlot !== null) newStep.insert_after = currentSlot;
      tc.steps.splice(index + 1, 0, newStep);
      renderStepsSection(tc, container);
      scheduleSave();
      setTimeout(() => {
        const next = container.querySelector(`.steps-list .step-field[data-arr-idx="${index + 1}"]`);
        if (next) next.focus();
      }, 30);
    }
    if (e.key === 'Backspace' && inp.value === '' && tc.steps.length > 1) {
      e.preventDefault();
      tc.steps.splice(index, 1);
      renderStepsSection(tc, container);
      scheduleSave();
      setTimeout(() => {
        const prev = container.querySelector(`.steps-list .step-field[data-arr-idx="${Math.max(0, index - 1)}"]`);
        if (prev) prev.focus();
      }, 30);
    }
  });
  addFieldCopyButton(stepRow, () => inp.value);
  stepRow.appendChild(inp);

  const delBtn = document.createElement('button');
  delBtn.className = 'step-del';
  delBtn.title     = t('f_step_remove');
  delBtn.innerHTML = '×';
  delBtn.addEventListener('click', () => {
    tc.steps.splice(index, 1);
    renderStepsSection(tc, container);
    scheduleSave();
  });
  stepRow.appendChild(delBtn);

  const erRow = document.createElement('div');
  erRow.className = 'step-field-row';

  const erInp = document.createElement('input');
  erInp.type        = 'text';
  erInp.className   = 'step-inp';
  erInp.value       = tc.steps[index].expected || '';
  erInp.placeholder = t('f_er_placeholder');
  erInp.addEventListener('input', () => {
    tc.steps[index].expected = erInp.value;
    scheduleSave();
  });
  addFieldCopyButton(erRow, () => erInp.value);
  erRow.appendChild(erInp);

  const tdRow = document.createElement('div');
  tdRow.className = 'step-field-row';

  const tdInp = document.createElement('input');
  tdInp.type        = 'text';
  tdInp.className   = 'step-inp';
  tdInp.value       = tc.steps[index].test_data || '';
  tdInp.placeholder = t('f_step_test_data_placeholder');
  tdInp.addEventListener('input', () => {
    tc.steps[index].test_data = tdInp.value;
    scheduleSave();
  });
  addFieldCopyButton(tdRow, () => tdInp.value);
  tdRow.appendChild(tdInp);

  fieldsCol.appendChild(stepRow);
  fieldsCol.appendChild(erRow);
  fieldsCol.appendChild(tdRow);

  item.appendChild(numCol);
  item.appendChild(fieldsCol);
  return item;
}

/* Zděděný krok + jeho zděděný Očekávaný výsledek — stejná logika jako u kroků:
   nezávislý přepis (override) a reset pro každé pole, jedno tlačítko
   smazat/obnovit pro celou dvojici (rodiče neovlivní) */
function buildInheritedStepPair(tc, item, container, displayNum) {
  const wrap = document.createElement('div');
  wrap.className = 'step-item step-inherited step-pair' +
    ((item.stepOverridden || item.expectedOverridden || item.testDataOverridden) ? ' step-overridden' : '') +
    (item.deleted ? ' step-deleted' : '');

  // Levý sloupec: jen číslo
  const numCol = document.createElement('div');
  numCol.className = 'step-num-col';

  const num = document.createElement('span');
  num.className   = 'step-num';
  num.textContent = item.deleted ? '—' : (displayNum + '.');

  // Tlačítko smazat / obnovit zděděnou dvojici krok+výsledek (rodiče neovlivní)
  const delRestoreBtn = document.createElement('button');
  delRestoreBtn.className = 'step-del' + (item.deleted ? ' step-restore' : '');
  delRestoreBtn.innerHTML = item.deleted ? resetIconSvg() : '×';
  delRestoreBtn.title = item.deleted ? t('step_restore_title') : t('step_delete_title');
  delRestoreBtn.addEventListener('click', () => {
    if (!tc.inherited_deleted) tc.inherited_deleted = [];
    const idx = tc.inherited_deleted.indexOf(item.globalIndex);
    if (item.deleted) {
      if (idx !== -1) tc.inherited_deleted.splice(idx, 1);
    } else {
      if (idx === -1) tc.inherited_deleted.push(item.globalIndex);
    }
    renderStepsSection(tc, container);
    scheduleSave();
  });

  numCol.appendChild(num);

  // Pravý sloupec: zarovnaná pole Krok / Očekávaný výsledek / Testovací data
  const fieldsCol = document.createElement('div');
  fieldsCol.className = 'step-fields-col';

  const stepRow = document.createElement('div');
  stepRow.className = 'step-field-row';

  const inp = document.createElement('input');
  inp.type      = 'text';
  inp.className = 'step-inp';
  inp.value     = item.step;
  inp.disabled  = item.deleted;
  inp.title     = item.deleted
    ? t('step_deleted_title')
    : (item.stepOverridden ? t('step_overridden_title') : t('step_inherited_title'));

  inp.addEventListener('input', () => {
    if (!tc.inherited_overrides) tc.inherited_overrides = {};
    if (!tc.inherited_overrides[item.globalIndex]) tc.inherited_overrides[item.globalIndex] = {};
    if (inp.value === item.originalStep) {
      delete tc.inherited_overrides[item.globalIndex].step;
    } else {
      tc.inherited_overrides[item.globalIndex].step = inp.value;
    }
    cleanupOverrideEntry(tc, item.globalIndex);
    const overridden = inp.value !== item.originalStep;
    wrap.classList.toggle('step-overridden', overridden || item.expectedOverridden || item.testDataOverridden);
    inp.title = overridden ? t('step_overridden_title') : t('step_inherited_title');
    if (resetBtn) resetBtn.style.display = overridden ? 'inline-flex' : 'none';
    scheduleSave();
  });

  // Tlačítko reset kroku (vrátit na původní hodnotu rodiče)
  const resetBtn = document.createElement('button');
  resetBtn.className = 'step-del';
  resetBtn.title = t('step_reset_title');
  resetBtn.innerHTML = resetIconSvg();
  resetBtn.style.display = (item.stepOverridden && !item.deleted) ? 'inline-flex' : 'none';
  resetBtn.addEventListener('click', () => {
    if (tc.inherited_overrides && tc.inherited_overrides[item.globalIndex]) {
      delete tc.inherited_overrides[item.globalIndex].step;
      cleanupOverrideEntry(tc, item.globalIndex);
    }
    inp.value = item.originalStep;
    inp.title = t('step_inherited_title');
    resetBtn.style.display = 'none';
    wrap.classList.toggle('step-overridden', item.expectedOverridden || item.testDataOverridden);
    scheduleSave();
  });

  addFieldCopyButton(stepRow, () => inp.value);
  stepRow.appendChild(inp);
  stepRow.appendChild(resetBtn);
  stepRow.appendChild(delRestoreBtn);

  const erRow = document.createElement('div');
  erRow.className = 'step-field-row';

  const erInp = document.createElement('input');
  erInp.type      = 'text';
  erInp.className = 'step-inp';
  erInp.value     = item.expected;
  erInp.disabled  = item.deleted;
  erInp.title     = item.deleted
    ? t('step_deleted_title')
    : (item.expectedOverridden ? t('step_overridden_title') : t('step_inherited_title'));

  erInp.addEventListener('input', () => {
    if (!tc.inherited_overrides) tc.inherited_overrides = {};
    if (!tc.inherited_overrides[item.globalIndex]) tc.inherited_overrides[item.globalIndex] = {};
    if (erInp.value === item.originalExpected) {
      delete tc.inherited_overrides[item.globalIndex].expected;
    } else {
      tc.inherited_overrides[item.globalIndex].expected = erInp.value;
    }
    cleanupOverrideEntry(tc, item.globalIndex);
    const overridden = erInp.value !== item.originalExpected;
    wrap.classList.toggle('step-overridden', overridden || item.stepOverridden || item.testDataOverridden);
    erInp.title = overridden ? t('step_overridden_title') : t('step_inherited_title');
    if (erResetBtn) erResetBtn.style.display = overridden ? 'inline-flex' : 'none';
    scheduleSave();
  });

  // Tlačítko reset očekávaného výsledku
  const erResetBtn = document.createElement('button');
  erResetBtn.className = 'step-del';
  erResetBtn.title = t('step_reset_title');
  erResetBtn.innerHTML = resetIconSvg();
  erResetBtn.style.display = (item.expectedOverridden && !item.deleted) ? 'inline-flex' : 'none';
  erResetBtn.addEventListener('click', () => {
    if (tc.inherited_overrides && tc.inherited_overrides[item.globalIndex]) {
      delete tc.inherited_overrides[item.globalIndex].expected;
      cleanupOverrideEntry(tc, item.globalIndex);
    }
    erInp.value = item.originalExpected;
    erInp.title = t('step_inherited_title');
    erResetBtn.style.display = 'none';
    wrap.classList.toggle('step-overridden', item.stepOverridden || item.testDataOverridden);
    scheduleSave();
  });

  addFieldCopyButton(erRow, () => erInp.value);
  erRow.appendChild(erInp);
  erRow.appendChild(erResetBtn);

  // Řádek s testovacími daty vázanými na tento krok
  const tdRow = document.createElement('div');
  tdRow.className = 'step-field-row';

  const tdInp = document.createElement('input');
  tdInp.type      = 'text';
  tdInp.className = 'step-inp';
  tdInp.value     = item.test_data;
  tdInp.disabled  = item.deleted;
  tdInp.title     = item.deleted
    ? t('step_deleted_title')
    : (item.testDataOverridden ? t('step_overridden_title') : t('step_inherited_title'));

  tdInp.addEventListener('input', () => {
    if (!tc.inherited_overrides) tc.inherited_overrides = {};
    if (!tc.inherited_overrides[item.globalIndex]) tc.inherited_overrides[item.globalIndex] = {};
    if (tdInp.value === item.originalTestData) {
      delete tc.inherited_overrides[item.globalIndex].test_data;
    } else {
      tc.inherited_overrides[item.globalIndex].test_data = tdInp.value;
    }
    cleanupOverrideEntry(tc, item.globalIndex);
    const overridden = tdInp.value !== item.originalTestData;
    wrap.classList.toggle('step-overridden', overridden || item.stepOverridden || item.expectedOverridden);
    tdInp.title = overridden ? t('step_overridden_title') : t('step_inherited_title');
    if (tdResetBtn) tdResetBtn.style.display = overridden ? 'inline-flex' : 'none';
    scheduleSave();
  });

  const tdResetBtn = document.createElement('button');
  tdResetBtn.className = 'step-del';
  tdResetBtn.title = t('step_reset_title');
  tdResetBtn.innerHTML = resetIconSvg();
  tdResetBtn.style.display = (item.testDataOverridden && !item.deleted) ? 'inline-flex' : 'none';
  tdResetBtn.addEventListener('click', () => {
    if (tc.inherited_overrides && tc.inherited_overrides[item.globalIndex]) {
      delete tc.inherited_overrides[item.globalIndex].test_data;
      cleanupOverrideEntry(tc, item.globalIndex);
    }
    tdInp.value = item.originalTestData;
    tdInp.title = t('step_inherited_title');
    tdResetBtn.style.display = 'none';
    wrap.classList.toggle('step-overridden', item.stepOverridden || item.expectedOverridden);
    scheduleSave();
  });

  addFieldCopyButton(tdRow, () => tdInp.value);
  tdRow.appendChild(tdInp);
  tdRow.appendChild(tdResetBtn);

  fieldsCol.appendChild(stepRow);
  fieldsCol.appendChild(erRow);
  fieldsCol.appendChild(tdRow);

  wrap.appendChild(numCol);
  wrap.appendChild(fieldsCol);
  return wrap;
}

/* ══════════════════════════════════════
   OČEKÁVANÝ VÝSLEDEK (samostatný, celkový seznam)
══════════════════════════════════════ */
function renderExpectedResult(tc, container) {
  container.innerHTML = '';

  // První pole je vždy vidět jako plnohodnotný vstup (nemusí se nejdřív klikat na "Přidat")
  if (!tc.expected_result || tc.expected_result.length === 0) {
    tc.expected_result = [''];
  }

  const list = document.createElement('div');
  list.className = 'steps-list';

  tc.expected_result.forEach((er, i) => {
    list.appendChild(buildErItem(tc, i, container));
  });

  container.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.className = 'add-step-btn';
  addBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg> ${t('add_result')}`;
  addBtn.addEventListener('click', () => {
    tc.expected_result.push('');
    renderExpectedResult(tc, container);
    scheduleSave();
    setTimeout(() => {
      const inputs = container.querySelectorAll('.step-inp');
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 30);
  });
  container.appendChild(addBtn);
}

function buildErItem(tc, index, container) {
  const item = document.createElement('div');
  item.className = 'step-item';

  const bullet = document.createElement('span');
  bullet.className   = 'step-bullet';
  bullet.textContent = '•';

  const inp = document.createElement('input');
  inp.type        = 'text';
  inp.className   = 'step-inp';
  inp.value       = tc.expected_result[index] || '';
  inp.placeholder = `${t('f_er_placeholder')} ${index + 1}…`;
  inp.addEventListener('input', () => {
    tc.expected_result[index] = inp.value;
    scheduleSave();
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      tc.expected_result.splice(index + 1, 0, '');
      renderExpectedResult(tc, container);
      scheduleSave();
      setTimeout(() => {
        const inputs = container.querySelectorAll('.step-inp');
        if (inputs[index + 1]) inputs[index + 1].focus();
      }, 30);
    }
    if (e.key === 'Backspace' && inp.value === '' && tc.expected_result.length > 1) {
      e.preventDefault();
      tc.expected_result.splice(index, 1);
      renderExpectedResult(tc, container);
      scheduleSave();
    }
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'step-del';
  delBtn.title     = t('f_result_remove');
  delBtn.innerHTML = '×';
  delBtn.style.visibility = tc.expected_result.length > 1 ? 'visible' : 'hidden';
  delBtn.addEventListener('click', () => {
    if (tc.expected_result.length <= 1) return;
    tc.expected_result.splice(index, 1);
    renderExpectedResult(tc, container);
    scheduleSave();
  });

  item.appendChild(bullet);
  addFieldCopyButton(item, () => inp.value);
  item.appendChild(inp);
  item.appendChild(delBtn);
  return item;
}

/* ══════════════════════════════════════
   TC INTERAKCE
══════════════════════════════════════ */
function toggleExpand(uid) {
  state.expandedId = state.expandedId === uid ? null : uid;
  renderTcList();
  if (state.expandedId) {
    setTimeout(() => {
      const el = document.querySelector(`[data-uid="${uid}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }
}

function toggleLock(uid) {
  const tc = getTcByUid(uid);
  if (!tc) return;
  tc.locked = !tc.locked;
  scheduleSave();

  const row = document.querySelector(`[data-uid="${uid}"]`);
  if (!row) return;

  // Aktualizuj ikonu zámku
  const lockBtn = row.querySelector('.tc-lock-btn');
  if (lockBtn) {
    lockBtn.innerHTML = tc.locked ? iconLock() : iconUnlock();
    lockBtn.className = 'tc-lock-btn' + (tc.locked ? ' locked' : '');
    lockBtn.title     = tc.locked ? t('tc_lock') : t('tc_unlock');
  }

  // Aktualizuj barvu řádku
  row.classList.toggle('tc-row-unlocked', !tc.locked);

  // Pokud je TC rozbalený, překresli formulář aby se readonly správně aplikovalo
  if (state.expandedId === uid) {
    const oldForm = row.querySelector('.tc-form');
    if (oldForm) oldForm.replaceWith(buildTcForm(tc));
  }

  initSortable();
}

/* ══════════════════════════════════════
   VERZOVÁNÍ
══════════════════════════════════════ */
function openModalVersion(uid) {
  const tc = getTcByUid(uid);
  if (!tc) return;
  state.versionTargetId = uid;

  const nextVer = (tc.version || 1) + 1;
  const newId   = tc.id.replace(/-V\d+$/, '') + `-V${nextVer}`;
  document.getElementById('modal-version-info').innerHTML =
    t('mv_info', { id: `<strong>${tc.id}</strong>`, newId: `<strong>${newId}</strong>` });
  document.getElementById('modal-version-ov').classList.add('open');
}

function closeModalVersion() {
  document.getElementById('modal-version-ov').classList.remove('open');
  state.versionTargetId = null;
}

function confirmVersion() {
  const uid = state.versionTargetId;
  if (!uid) return;
  const tc = getTcByUid(uid);
  if (!tc) return;

  const nextVer = (tc.version || 1) + 1;
  const baseId  = tc.id.replace(/-V\d+$/, '');
  const newId   = `${baseId}-V${nextVer}`;

  tc.deleted = true;

  const newTc = {
    ...JSON.parse(JSON.stringify(tc)),
    _uid:    generateUid(),
    id:      newId,
    version: nextVer,
    deleted: false,
    locked:  true
  };

  const idx = state.project.testCases.findIndex(t => t._uid === uid);
  state.project.testCases.splice(idx + 1, 0, newTc);

  state.expandedId = newTc._uid;
  closeModalVersion();
  renderTcList();
  scheduleSave();

  setTimeout(() => {
    const el = document.querySelector(`[data-uid="${newTc._uid}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 50);
}

/* ══════════════════════════════════════
   KOPÍROVAT DO SCHRÁNKY
══════════════════════════════════════ */
/* Které části TC se mají kopírovat do schránky (výběr přes ozubené kolo
   vedle tlačítka "Kopírovat", ukládá se do localStorage napříč projekty) */
const COPY_FIELD_LABELS = {
  name:            'copy_field_name',
  goal:            'copy_field_goal',
  preconditions:   'copy_field_preconditions',
  test_data:       'copy_field_test_data',
  steps:           'copy_field_steps',
  steps_expected:  'copy_field_steps_expected',
  expected_result: 'copy_field_expected_result'
};

function loadCopyFieldPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('tc_copy_fields') || 'null');
    if (Array.isArray(saved)) return new Set(saved);
  } catch (e) { /* ignore */ }
  return new Set(Object.keys(COPY_FIELD_LABELS)); // výchozí: vše
}

let copySelectedFields = loadCopyFieldPrefs();

function saveCopyFieldPrefs() {
  try {
    localStorage.setItem('tc_copy_fields', JSON.stringify([...copySelectedFields]));
  } catch (e) { /* ignore */ }
}

function openModalCopySettings() {
  renderCopySettingsList();
  document.getElementById('modal-copy-settings-ov').classList.add('open');
}

function closeModalCopySettings() {
  document.getElementById('modal-copy-settings-ov').classList.remove('open');
}

function renderCopySettingsList() {
  const container = document.getElementById('copy-settings-list');
  if (!container) return;
  container.innerHTML = '';

  Object.keys(COPY_FIELD_LABELS).forEach(key => {
    const label = document.createElement('label');
    label.className = 'csv-col-item';

    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = copySelectedFields.has(key);
    cb.addEventListener('change', () => {
      if (cb.checked) copySelectedFields.add(key);
      else copySelectedFields.delete(key);
      saveCopyFieldPrefs();
    });

    const span = document.createElement('span');
    span.textContent = t(COPY_FIELD_LABELS[key]);

    label.appendChild(cb);
    label.appendChild(span);
    container.appendChild(label);
  });
}

function copyTcToClipboard(tc) {
  const allSteps  = getEffectiveSteps(tc);
  const f = copySelectedFields;
  const lines = [];

  lines.push(`${t('clip_id')}: ${tc.id}`);
  if (f.has('name')          && tc.name)               lines.push(`${t('clip_name')}: ${tc.name}`);
  if (f.has('goal')          && tc.goal)                lines.push(`${t('clip_goal')}: ${tc.goal}`);
  if (f.has('preconditions') && getFullPreconditions(tc)) lines.push(`${t('clip_preconditions')}: ${getFullPreconditions(tc)}`);
  if (f.has('test_data')     && tc.test_data)           lines.push(`${t('f_test_data')}: ${tc.test_data}`);

  if (f.has('steps') && allSteps.length) {
    lines.push('', t('clip_steps'));
    allSteps.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.step}`);
      if (f.has('steps_expected') && s.expected) lines.push(`     → ${s.expected}`);
      if (f.has('test_data')      && s.test_data) lines.push(`     ⚙ ${s.test_data}`);
    });
  }

  if (f.has('expected_result') && tc.expected_result.some(Boolean)) {
    lines.push('', t('clip_expected_result'));
    tc.expected_result.filter(Boolean).forEach(r => lines.push(`  • ${r}`));
  }

  navigator.clipboard.writeText(lines.join('\n')).then(() => showAutosaveIndicator());
}

/* ══════════════════════════════════════
   EXPORT CSV
══════════════════════════════════════ */
/* Sestaví data pro export — společné pro CSV i XLSX */
/* Definice exportních sloupců — 'mandatory' sloupce nejdou vypnout,
   ostatní se řídí výběrem v checkboxech modalu (csvSelectedColumns) */
function getExportColumnDefs() {
  return [
    { key: 'id',              mandatory: true,  type: 'text',     header: t('csv_h_id'),              value: tc => tc.id },
    { key: 'priority',                          type: 'text',     header: t('csv_h_priority'),        value: tc => tc.priority },
    { key: 'name',            mandatory: true,  type: 'text',     header: t('csv_h_name'),            value: tc => tc.name },
    { key: 'goal',                              type: 'text',     header: t('csv_h_goal'),            value: tc => tc.goal },
    { key: 'preconditions',                     type: 'text',     header: t('csv_h_preconditions'),   value: tc => getFullPreconditions(tc) },
    { key: 'test_data',                         type: 'text',     header: t('csv_h_test_data'),       value: tc => getFullTestData(tc) },
    { key: 'steps',                             type: 'numbered', header: t('csv_h_steps'),           value: tc => getEffectiveSteps(tc).map(s => s.step) },
    { key: 'steps_expected',                    type: 'bulleted', header: t('csv_h_steps_expected'),  value: tc => getEffectiveSteps(tc).map(s => s.expected) },
    { key: 'expected_result',                   type: 'bulleted', header: t('csv_h_expected_result'), value: tc => tc.expected_result },
    { key: 'notes',                              type: 'text',     header: t('csv_h_notes'),           value: tc => tc.notes },
    { key: 'tags',                               type: 'text',     header: t('csv_h_tags'),             value: tc => (tc.tags || []).join(', ') },
    { key: 'result',          mandatory: true,  type: 'text',     header: t('mc_result_col'),         value: () => t('mc_result_not_tested') }
  ];
}

function buildExportData(selectedUids, selectedColumns) {
  if (!state.project) return { headers: [], rows: [], colTypes: [] };

  let active = state.project.testCases.filter(tc => !tc.deleted);
  if (selectedUids) active = active.filter(tc => selectedUids.has(tc._uid));

  const cols = getExportColumnDefs().filter(c => c.mandatory || !selectedColumns || selectedColumns.has(c.key));

  const headers  = cols.map(c => c.header);
  const colTypes = cols.map(c => c.type);
  const rows     = active.map(tc => cols.map(c => c.value(tc)));

  return { headers, rows, colTypes };
}

function buildCsv(format, selectedUids, selectedColumns) {
  if (!state.project) return '';
  const sep = format === 'pipe' ? ' | ' : '\r\n';
  const { headers, rows, colTypes } = buildExportData(selectedUids, selectedColumns);

  const csvRows = [headers, ...rows.map(row => row.map((cell, i) => {
    let val;
    if (colTypes[i] === 'numbered') val = (cell || []).map((s, idx) => `${idx + 1}. ${s}`).join(sep);
    else if (colTypes[i] === 'bulleted') val = (cell || []).map(r => `• ${r}`).join(sep);
    else val = String(cell || '');

    if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
      return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  }))];

  return csvRows.map(r => r.join(',')).join('\r\n');
}

/* Kategorie (sloupce), které lze v exportu zapnout/vypnout — s výchozím stavem "vše" */
const EXPORT_COLUMN_LABELS = {
  priority:        'mc_col_priority',
  goal:            'mc_col_goal',
  preconditions:   'mc_col_preconditions',
  test_data:       'mc_col_test_data',
  steps:           'mc_col_steps',
  steps_expected:  'mc_col_steps_expected',
  expected_result: 'mc_col_expected_result',
  notes:           'mc_col_notes',
  tags:            'mc_col_tags'
};
let csvSelectedColumns = new Set(Object.keys(EXPORT_COLUMN_LABELS));

function renderCsvColumnsList() {
  const container = document.getElementById('csv-columns-grid');
  if (!container) return;
  container.innerHTML = '';

  Object.keys(EXPORT_COLUMN_LABELS).forEach(key => {
    const label = document.createElement('label');
    label.className = 'csv-col-item';

    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = csvSelectedColumns.has(key);
    cb.addEventListener('change', () => {
      if (cb.checked) csvSelectedColumns.add(key);
      else csvSelectedColumns.delete(key);
    });

    const span = document.createElement('span');
    span.textContent = t(EXPORT_COLUMN_LABELS[key]);

    label.appendChild(cb);
    label.appendChild(span);
    container.appendChild(label);
  });
}

/* Sada vybraných _uid pro export — udržuje se po dobu otevřeného modalu */
let csvSelectedUids = new Set();

function openModalCsv() {
  if (!state.project) return;

  const active = state.project.testCases.filter(tc => !tc.deleted);
  // Předvyplnit výběr podle checkboxů "k exportu" u jednotlivých TC v seznamu
  csvSelectedUids = new Set(active.filter(tc => tc.export_selected !== false).map(tc => tc._uid));

  renderCsvSelectList();
  renderCsvColumnsList();
  document.getElementById('modal-csv-ov').classList.add('open');
  updateCsvHelpVisibility();
}

function closeModalCsv() {
  document.getElementById('modal-csv-ov').classList.remove('open');
}

function renderCsvSelectList() {
  const container = document.getElementById('csv-tc-select-list');
  container.innerHTML = '';

  const active = state.project.testCases.filter(tc => !tc.deleted);

  if (!active.length) {
    container.innerHTML = `<div class="csv-tc-select-empty">${t('csv_empty')}</div>`;
  } else {
    active.forEach(tc => {
      const item = document.createElement('label');
      item.className = 'csv-tc-select-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = csvSelectedUids.has(tc._uid);
      cb.addEventListener('change', () => {
        if (cb.checked) csvSelectedUids.add(tc._uid);
        else csvSelectedUids.delete(tc._uid);
        updateCsvSelectCount();
      });

      const idEl = document.createElement('span');
      idEl.className = 'csv-tc-select-id';
      idEl.textContent = tc.id;

      const nameEl = document.createElement('span');
      nameEl.className = 'csv-tc-select-name';
      nameEl.textContent = tc.name || t('tc_no_name');

      item.appendChild(cb);
      item.appendChild(idEl);
      item.appendChild(nameEl);
      container.appendChild(item);
    });
  }

  updateCsvSelectCount();
}

function updateCsvSelectCount() {
  const active = state.project.testCases.filter(tc => !tc.deleted);
  document.getElementById('csv-select-count').textContent =
    t('mc_select_count', { n: csvSelectedUids.size, total: active.length });
  document.getElementById('csv-confirm-btn').disabled = csvSelectedUids.size === 0;
}

function updateCsvHelpVisibility() {
  const format = document.querySelector('input[name="csv-format"]:checked').value;
  document.getElementById('csv-help-multiline').style.display =
    (format === 'multiline') ? 'block' : 'none';
  document.getElementById('json-flatten-row').style.display =
    (format === 'json') ? 'flex' : 'none';
}

async function confirmExportCsv() {
  if (!csvSelectedUids.size) return;
  const format = document.querySelector('input[name="csv-format"]:checked').value;
  const name   = state.project.project || 'export';
  closeModalCsv();

  if (format === 'xlsx') {
    await exportXlsx(csvSelectedUids, csvSelectedColumns);
    return;
  }

  if (format === 'json') {
    const flatten = document.getElementById('json-flatten-inheritance').checked;
    await exportJsonSelected(csvSelectedUids, flatten);
    return;
  }

  const content = buildCsv(format, csvSelectedUids, csvSelectedColumns);
  await window.api.exportCsv(name, '\uFEFF' + content);
}

async function exportXlsx(selectedUids, selectedColumns) {
  if (!state.project) return;
  const { headers, rows, colTypes } = buildExportData(selectedUids, selectedColumns);
  const name = state.project.project || 'export';

  // Připrav flat řádky pro main process (pole → join s \n)
  const flatRows = rows.map(row => row.map((cell, i) => {
    if (colTypes[i] === 'numbered') return (cell || []).map((s, idx) => `${idx + 1}. ${s}`).join('\n');
    if (colTypes[i] === 'bulleted') return (cell || []).map(r => `• ${r}`).join('\n');
    return cell || '';
  }));

  // Index sloupce Výsledek testu (vždy povinný, poslední)
  const resultColIndex = headers.length - 1;
  const dropdownValues = {
    col: resultColIndex,
    values: [
      t('mc_result_not_tested'),
      t('mc_result_error'),
      t('mc_result_success'),
      t('mc_result_blocked')
    ]
  };

  const result = await window.api.exportXlsx(name, flatRows, headers, dropdownValues);
  if (result && result.error) alert(result.error);
}

/* Úplná záloha projektu (tlačítko "Uložit" v topbaru) — každé uložení
   navrhne nový verzovaný název souboru (název_v1.json, název_v2.json, ...),
   ať se předchozí zálohy nepřepisují. Číslo verze se ukládá v projektu,
   takže pokračuje správně i po zavření a znovuotevření appky. */
async function exportJson() {
  if (!state.project) return;
  syncProjectBarToState();
  syncTagColorsIntoProject(state.project);

  const nextVersion = (state.project.saveVersion || 0) + 1;
  const baseName = state.project.project || 'export';
  const name = `${baseName}_v${nextVersion}`;

  const result = await window.api.exportJson(name, state.project);
  if (!result || result.canceled) return;
  if (result.error) { alert(result.error); return; }

  state.project.saveVersion = nextVersion;
  scheduleSave();
}

/* Vrátí nezávislou kopii TC, kde jsou zděděné kroky a předpoklady zapsané
   jako vlastní (plně vyřešené — s ohledem na přepisy, smazání i případné
   vlastní kroky vložené doprostřed zděděných) a vazba na rodiče je zrušená.
   Používá se při exportu vybraných TC do JSON pro trvale samostatný soubor,
   který nezávisí na tom, jestli je rodič součástí stejného souboru. */
function flattenTcForStandaloneExport(tc) {
  const resolvedSteps         = getEffectiveSteps(tc);
  const resolvedPreconditions = getFullPreconditions(tc);

  const flat = JSON.parse(JSON.stringify(tc));
  flat.steps         = resolvedSteps;
  flat.preconditions = resolvedPreconditions;
  flat.parent_id     = null;
  delete flat.inherited_overrides;
  delete flat.inherited_deleted;
  delete flat.inherited_preconditions_override;
  return flat;
}

/* JSON export jen vybraných TC (z modalu Export) */
async function exportJsonSelected(selectedUids, flatten) {
  if (!state.project) return;
  syncTagColorsIntoProject(state.project);

  let selectedTcs = state.project.testCases.filter(tc => !tc.deleted && selectedUids.has(tc._uid));
  if (flatten) selectedTcs = selectedTcs.map(flattenTcForStandaloneExport);

  const filtered = { ...state.project, testCases: selectedTcs };
  const name = state.project.project || 'export';
  await window.api.exportJson(name, filtered);
}

/* ══════════════════════════════════════
   DRAG AND DROP (SortableJS)
══════════════════════════════════════ */
let sortableInstance = null;

function initSortable() {
  if (typeof Sortable === 'undefined') return;
  if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }

  const list = document.getElementById('tc-list');

  // Přesun TC v seznamu se dělá tlačítky nahoru/dolů (jen v admin módu),
  // ne přetažením — drag&drop je proto trvale vypnutý.
  sortableInstance = Sortable.create(list, {
    sort: false,
    handle: '.tc-row-head'
  });
}

/* Přesune TC o jednu pozici nahoru (-1) nebo dolů (+1) v seznamu.
   Dostupné jen v administrátorském módu. */
function moveTc(uid, direction) {
  if (!state.project || !state.adminMode) return;
  const arr = state.project.testCases;
  const idx = arr.findIndex(tc => tc._uid === uid);
  if (idx === -1) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= arr.length) return;
  [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
  renderTcList();
  scheduleSave();
}

/* ══════════════════════════════════════
   SVG IKONY
══════════════════════════════════════ */
function iconLock() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/></svg>`;
}
function iconUnlock() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 9.33-2.5"/></svg>`;
}

/* ══════════════════════════════════════
   PROJECT BAR — živé změny
══════════════════════════════════════ */
function bindProjectBar() {
  document.getElementById('proj-name').addEventListener('input', () => {
    if (state.project) { state.project.project = document.getElementById('proj-name').value.trim(); scheduleSave(); }
  });
  // proj-prefix je readonly mimo admin mód — změna se aplikuje tlačítkem "Použít prefix"
  document.getElementById('proj-prefix-apply').addEventListener('click', () => {
    applyProjectPrefixChange(document.getElementById('proj-prefix').value);
  });
  document.getElementById('proj-renumber').addEventListener('change', () => {
    if (state.project) { state.project.renumber = document.getElementById('proj-renumber').checked; scheduleSave(); }
  });
  document.getElementById('btn-renumber-order').addEventListener('click', renumberTcsByOrder);
}

/* ══════════════════════════════════════
   TOPBAR TLAČÍTKA
══════════════════════════════════════ */
function bindTopbar() {
  document.getElementById('btn-new').addEventListener('click', openModalNew);
  document.getElementById('btn-open').addEventListener('click', openProject);
  document.getElementById('btn-export').addEventListener('click', openModalCsv);
  document.getElementById('btn-export-json').addEventListener('click', exportJson);
  document.getElementById('btn-find-replace').addEventListener('click', openModalFindReplace);
  document.getElementById('btn-manage-tags').addEventListener('click', openModalManageTags);
  document.getElementById('tags-modal-add-btn').addEventListener('click', addNewGlobalTag);
  document.getElementById('tags-modal-new-inp').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addNewGlobalTag(); }
  });
  document.getElementById('add-tc-btn').addEventListener('click', addTc);
  document.getElementById('scratchpad-add-btn').addEventListener('click', addScratchpadEntry);

  document.getElementById('settings-silent-backup').addEventListener('change', (e) => {
    saveSilentBackupSetting(e.target.checked);
  });

  document.getElementById('fr-search-btn').addEventListener('click', frRunSearch);
  document.getElementById('fr-confirm-btn').addEventListener('click', confirmFindReplace);

  document.querySelectorAll('input[name="csv-format"]').forEach(r => {
    r.addEventListener('change', updateCsvHelpVisibility);
  });

  document.getElementById('csv-select-all').addEventListener('click', () => {
    const active = state.project.testCases.filter(tc => !tc.deleted);
    csvSelectedUids = new Set(active.map(tc => tc._uid));
    renderCsvSelectList();
  });
  document.getElementById('csv-select-none').addEventListener('click', () => {
    csvSelectedUids = new Set();
    renderCsvSelectList();
  });
}

/* ══════════════════════════════════════
   KLÁVESOVÉ ZKRATKY
══════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModalNew();
    closeModalVersion();
    closeModalCsv();
    closeModalHardDelete();
    closeModalAbout();
    closeModalSettings();
    closeModalFindReplace();
    document.getElementById('scratchpad-panel').classList.remove('open');
    document.getElementById('btn-scratchpad').classList.remove('scratchpad-btn-active');
    if (state.expandedId) {
      state.expandedId = null;
      renderTcList();
    }
  }
});

/* ══════════════════════════════════════
   INIT
══════════════════════════════════════ */
(async function init() {
  const savedTheme = localStorage.getItem('tc_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);

  applyTranslations();

  bindTopbar();
  bindProjectBar();
  await loadLastProject();
})();
