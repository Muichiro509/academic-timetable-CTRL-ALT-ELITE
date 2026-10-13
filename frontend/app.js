/* ============================================================
   Schedulr — frontend application  (full feature set)
   ============================================================ */
'use strict';

// ── Helpers ───────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ── State ─────────────────────────────────────────────────────
const state = {
  workingHours: { start: '09:00', end: '17:00' },
  days:        ['Monday','Tuesday','Wednesday','Thursday','Friday'],
  slots:       [],   // [{id, label, is_break}]
  rooms:       [],   // [{id, capacity, type}]
  classes:     [],   // [{id, name, strength, batches:[{id,name,strength}]}]
  subjects:    [],   // [{id,name,class_id,batch_id,faculty,weekly_periods,room_type,duration,session_type,fixed:{day,slot,room}}]
  unavailable:   [],   // [{faculty,day,slot}]
  availRanges:   [],   // [{faculty,day,from,to}]
  facConstraints:[],   // [{faculty,max_daily_periods}]
};

let lastResult  = null;   // last /api/generate response
let currentView = 'programme';
let editingEntry = null;  // entry being adjusted in modal

// ── Tab switching ─────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${name}`));
}

// ── View-mode buttons ─────────────────────────────────────────
document.querySelectorAll('.view-btn').forEach(btn =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    rebuildFilterSelect();
    if (lastResult) renderTimetable();
  }));

// ── Status banner ─────────────────────────────────────────────
function showStatus(msg, kind = 'ok') {
  const b = $('status-bar');
  b.textContent = msg;
  b.className = `status-bar ${kind}`;
}

// ── Working hours ─────────────────────────────────────────────
$('wh-start').addEventListener('change', e => { state.workingHours.start = e.target.value; });
$('wh-end'  ).addEventListener('change', e => { state.workingHours.end   = e.target.value; });

// ─────────────────────────────────────────────────────────────
//  Generic list renderer
// ─────────────────────────────────────────────────────────────
function renderList(containerId, items, rowFn) {
  const c = $(containerId);
  c.innerHTML = '';
  if (!items.length) {
    c.innerHTML = '<p class="muted small" style="padding:6px 0">No entries yet.</p>';
    return;
  }
  items.forEach((item, i) => {
    const rm = () => { items.splice(i, 1); renderList(containerId, items, rowFn); };
    c.appendChild(rowFn(item, i, rm));
  });
}

// ─────────────────────────────────────────────────────────────
//  Days chips
// ─────────────────────────────────────────────────────────────
const ALL_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function renderDaysGrid() {
  const g = $('days-grid');
  g.innerHTML = '';
  ALL_DAYS.forEach(day => {
    const sel = state.days.includes(day);
    const chip = document.createElement('label');
    chip.className = 'chip' + (sel ? ' selected' : '');
    chip.innerHTML = `<input type="checkbox" ${sel ? 'checked' : ''}><span>${day}</span>`;
    chip.addEventListener('click', () => {
      const idx = state.days.indexOf(day);
      if (idx === -1) state.days.push(day);
      else state.days.splice(idx, 1);
      chip.classList.toggle('selected');
      renderUnavail(); renderAvailRanges(); renderSubjects();
    });
    g.appendChild(chip);
  });
}

// ─────────────────────────────────────────────────────────────
//  Slots
// ─────────────────────────────────────────────────────────────
function renderSlots() {
  renderList('slots-list', state.slots, (slot, i, rm) => {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <label>Slot ID<input type="text" class="wide" value="${esc(slot.id)}" placeholder="09:00"></label>
      <label>Label<input type="text" class="wide" value="${esc(slot.label||'')}" placeholder="09:00 – 10:00"></label>
      <label style="flex-direction:row;align-items:center;gap:6px">
        <input type="checkbox" ${slot.is_break?'checked':''}> Break
      </label>
      <button class="secondary sm remove-btn">Remove</button>`;
    row.querySelectorAll('input[type="text"]')[0].addEventListener('change', e => { slot.id = e.target.value.trim(); renderUnavail(); renderAvailRanges(); });
    row.querySelectorAll('input[type="text"]')[1].addEventListener('change', e => { slot.label = e.target.value.trim(); });
    row.querySelector('input[type="checkbox"]').addEventListener('change', e => { slot.is_break = e.target.checked; });
    row.querySelector('.remove-btn').addEventListener('click', rm);
    return row;
  });
}
$('btn-add-slot').addEventListener('click', () => { state.slots.push({id:'',label:'',is_break:false}); renderSlots(); });

// ─────────────────────────────────────────────────────────────
//  Rooms
// ─────────────────────────────────────────────────────────────
function renderRooms() {
  renderList('rooms-list', state.rooms, (r, i, rm) => {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <label>Room ID<input type="text" value="${esc(r.id)}" placeholder="LH-101"></label>
      <label>Capacity<input type="number" value="${r.capacity}" min="1"></label>
      <label>Type<select>
        <option value="classroom" ${r.type==='classroom'?'selected':''}>Classroom</option>
        <option value="lab"       ${r.type==='lab'?'selected':''}>Lab</option>
      </select></label>
      <button class="secondary sm remove-btn">Remove</button>`;
    row.querySelectorAll('input')[0].addEventListener('change', e => { r.id = e.target.value.trim(); });
    row.querySelectorAll('input')[1].addEventListener('change', e => { r.capacity = parseInt(e.target.value)||0; });
    row.querySelector('select').addEventListener('change', e => { r.type = e.target.value; });
    row.querySelector('.remove-btn').addEventListener('click', rm);
    return row;
  });
}
$('btn-add-room').addEventListener('click', () => { state.rooms.push({id:'',capacity:40,type:'classroom'}); renderRooms(); });

// ─────────────────────────────────────────────────────────────
//  Classes + Batches
// ─────────────────────────────────────────────────────────────
function renderClasses() {
  renderList('classes-list', state.classes, (cls, i, rm) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:0';

    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <label>ID<input type="text" value="${esc(cls.id)}" placeholder="CS1"></label>
      <label>Name<input type="text" class="wide" value="${esc(cls.name)}" placeholder="B.Tech CS – Sem 1"></label>
      <label>Strength<input type="number" value="${cls.strength}" min="1"></label>
      <button class="secondary sm" data-add-batch>+ Batch</button>
      <button class="secondary sm remove-btn">Remove</button>`;
    row.querySelectorAll('input')[0].addEventListener('change', e => { cls.id = e.target.value.trim(); renderSubjects(); renderUnavail(); });
    row.querySelectorAll('input')[1].addEventListener('change', e => { cls.name = e.target.value.trim(); });
    row.querySelectorAll('input')[2].addEventListener('change', e => { cls.strength = parseInt(e.target.value)||0; });
    row.querySelector('[data-add-batch]').addEventListener('click', () => {
      if (!cls.batches) cls.batches = [];
      cls.batches.push({id:'',name:'',strength:0});
      renderClasses();
    });
    row.querySelector('.remove-btn').addEventListener('click', () => { rm(); renderSubjects(); });
    wrap.appendChild(row);

    // Batch sub-list
    if (cls.batches && cls.batches.length) {
      const bWrap = document.createElement('div');
      bWrap.className = 'batch-sublist';
      cls.batches.forEach((b, bi) => {
        const bRow = document.createElement('div');
        bRow.className = 'batch-row';
        bRow.innerHTML = `
          <label>Batch ID<input type="text" value="${esc(b.id)}" placeholder="B1"></label>
          <label>Name<input type="text" value="${esc(b.name)}" placeholder="Batch A"></label>
          <label>Strength<input type="number" value="${b.strength}" min="1"></label>
          <button class="secondary sm remove-btn">✕</button>`;
        bRow.querySelectorAll('input')[0].addEventListener('change', e => { b.id = e.target.value.trim(); renderSubjects(); });
        bRow.querySelectorAll('input')[1].addEventListener('change', e => { b.name = e.target.value.trim(); });
        bRow.querySelectorAll('input')[2].addEventListener('change', e => { b.strength = parseInt(e.target.value)||0; });
        bRow.querySelector('.remove-btn').addEventListener('click', () => { cls.batches.splice(bi,1); renderClasses(); renderSubjects(); });
        bWrap.appendChild(bRow);
      });
      wrap.appendChild(bWrap);
    }
    return wrap;
  });
}
$('btn-add-class').addEventListener('click', () => { state.classes.push({id:'',name:'',strength:30,batches:[]}); renderClasses(); });

// ─────────────────────────────────────────────────────────────
//  Subjects
// ─────────────────────────────────────────────────────────────
function allBatches() {
  const out = [];
  state.classes.forEach(c => (c.batches||[]).forEach(b => out.push({...b, class_id:c.id, class_name:c.name})));
  return out;
}
function classOpts(cur) {
  return state.classes.map(c =>
    `<option value="${esc(c.id)}" ${c.id===cur?'selected':''}>${esc(c.name||c.id)}</option>`).join('');
}
function batchOpts(cur) {
  const opts = ['<option value="">— whole class —</option>'];
  allBatches().forEach(b =>
    opts.push(`<option value="${esc(b.id)}" ${b.id===cur?'selected':''}>${esc(b.name||b.id)} (${esc(b.class_name)})</option>`));
  return opts.join('');
}

function renderSubjects() {
  renderList('subjects-list', state.subjects, (s, i, rm) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:0';

    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <label>ID<input type="text" value="${esc(s.id)}" placeholder="CS101"></label>
      <label>Name<input type="text" class="wide" value="${esc(s.name)}" placeholder="Subject name"></label>
      <label>Class<select class="sel-class">${classOpts(s.class_id)}</select></label>
      <label>Batch<select class="sel-batch">${batchOpts(s.batch_id||'')}</select></label>
      <label>Faculty<input type="text" class="wide" value="${esc(s.faculty)}" placeholder="Dr. Patel"></label>
      <label>Periods/wk<input type="number" value="${s.weekly_periods}" min="1" max="10"></label>
      <label>Duration<input type="number" value="${s.duration||1}" min="1" max="4"></label>
      <label>Room<select class="sel-rtype">
        <option value="classroom" ${s.room_type==='classroom'?'selected':''}>Classroom</option>
        <option value="lab"       ${s.room_type==='lab'?'selected':''}>Lab</option>
      </select></label>
      <label>Type<select class="sel-stype">
        <option value="theory"    ${(s.session_type||'theory')==='theory'?'selected':''}>Theory</option>
        <option value="practical" ${s.session_type==='practical'?'selected':''}>Practical</option>
      </select></label>
      <button class="secondary sm" data-toggle-fixed>${s.fixed?'⚲ Fixed':'Pin slot'}</button>
      <button class="secondary sm remove-btn">Remove</button>`;
    const inputs = row.querySelectorAll('input');
    inputs[0].addEventListener('change', e => { s.id = e.target.value.trim(); });
    inputs[1].addEventListener('change', e => { s.name = e.target.value.trim(); });
    row.querySelector('.sel-class').addEventListener('change', e => { s.class_id = e.target.value; });
    row.querySelector('.sel-batch').addEventListener('change', e => { s.batch_id = e.target.value || null; });
    inputs[2].addEventListener('change', e => { s.faculty = e.target.value.trim(); renderUnavail(); renderAvailRanges(); renderFacCaps(); });
    inputs[3].addEventListener('change', e => { s.weekly_periods = parseInt(e.target.value)||1; });
    inputs[4].addEventListener('change', e => { s.duration = parseInt(e.target.value)||1; });
    row.querySelector('.sel-rtype').addEventListener('change', e => { s.room_type = e.target.value; });
    row.querySelector('.sel-stype').addEventListener('change', e => { s.session_type = e.target.value; });
    row.querySelector('[data-toggle-fixed]').addEventListener('click', () => {
      if (s.fixed) { s.fixed = null; } else { s.fixed = {day: state.days[0]||'', slot:'', room:''}; }
      renderSubjects();
    });
    row.querySelector('.remove-btn').addEventListener('click', rm);
    wrap.appendChild(row);

    // Fixed-session sub-row
    if (s.fixed) {
      const fRow = document.createElement('div');
      fRow.className = 'fixed-sub';
      fRow.innerHTML = `<span style="font-weight:700;color:#5b21b6">📌 Fixed:</span>
        <label>Day<select class="fx-day">${state.days.map(d=>`<option value="${esc(d)}" ${d===s.fixed.day?'selected':''}>${esc(d)}</option>`).join('')}</select></label>
        <label>Slot<select class="fx-slot">${state.slots.map(sl=>`<option value="${esc(sl.id)}" ${sl.id===s.fixed.slot?'selected':''}>${esc(sl.label||sl.id)}</option>`).join('')}</select></label>
        <label>Room<select class="fx-room"><option value="">— auto —</option>${state.rooms.map(r=>`<option value="${esc(r.id)}" ${r.id===s.fixed.room?'selected':''}>${esc(r.id)}</option>`).join('')}</select></label>`;
      fRow.querySelector('.fx-day').addEventListener('change', e => { s.fixed.day = e.target.value; });
      fRow.querySelector('.fx-slot').addEventListener('change', e => { s.fixed.slot = e.target.value; });
      fRow.querySelector('.fx-room').addEventListener('change', e => { s.fixed.room = e.target.value; });
      wrap.appendChild(fRow);
    }
    return wrap;
  });
}
$('btn-add-subject').addEventListener('click', () => {
  state.subjects.push({id:'',name:'',class_id:state.classes[0]?.id||'',batch_id:null,faculty:'',weekly_periods:2,duration:1,room_type:'classroom',session_type:'theory',fixed:null});
  renderSubjects();
});

// ─────────────────────────────────────────────────────────────
//  Faculty availability — block slots
// ─────────────────────────────────────────────────────────────
function allFaculties() {
  return [...new Set(state.subjects.map(s => s.faculty).filter(Boolean))];
}
function facOpts(cur) {
  return allFaculties().map(f=>`<option value="${esc(f)}" ${f===cur?'selected':''}>${esc(f)}</option>`).join('');
}
function dayOpts(cur) {
  return state.days.map(d=>`<option value="${esc(d)}" ${d===cur?'selected':''}>${esc(d)}</option>`).join('');
}
function slotOpts(cur) {
  return state.slots.map(s=>`<option value="${esc(s.id)}" ${s.id===cur?'selected':''}>${esc(s.label||s.id)}</option>`).join('');
}

function renderUnavail() {
  renderList('unavail-list', state.unavailable, (u, i, rm) => {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <label>Faculty<select>${facOpts(u.faculty)}</select></label>
      <label>Day<select>${dayOpts(u.day)}</select></label>
      <label>Slot<select>${slotOpts(u.slot)}</select></label>
      <button class="secondary sm remove-btn">Remove</button>`;
    const [fs,ds,ss] = row.querySelectorAll('select');
    fs.addEventListener('change', e => { u.faculty = e.target.value; });
    ds.addEventListener('change', e => { u.day     = e.target.value; });
    ss.addEventListener('change', e => { u.slot    = e.target.value; });
    row.querySelector('.remove-btn').addEventListener('click', rm);
    return row;
  });
}
$('btn-add-unavail').addEventListener('click', () => {
  state.unavailable.push({faculty:allFaculties()[0]||'',day:state.days[0]||'Monday',slot:state.slots[0]?.id||''});
  renderUnavail();
});

// ─────────────────────────────────────────────────────────────
//  Available ranges
// ─────────────────────────────────────────────────────────────
function renderAvailRanges() {
  renderList('avail-range-list', state.availRanges, (r, i, rm) => {
    const row = document.createElement('div');
    row.className = 'range-row';
    row.innerHTML = `
      <label>Faculty<select>${facOpts(r.faculty)}</select></label>
      <label>Day<select>${dayOpts(r.day)}</select></label>
      <label>From<select>${slotOpts(r.from)}</select></label>
      <label>To (excl.)<select>${slotOpts(r.to)}</select></label>
      <button class="secondary sm remove-btn">Remove</button>`;
    const [fs,ds,frS,toS] = row.querySelectorAll('select');
    fs.addEventListener('change', e => { r.faculty = e.target.value; });
    ds.addEventListener('change', e => { r.day     = e.target.value; });
    frS.addEventListener('change',e => { r.from    = e.target.value; });
    toS.addEventListener('change',e => { r.to      = e.target.value; });
    row.querySelector('.remove-btn').addEventListener('click', rm);
    return row;
  });
}
$('btn-add-range').addEventListener('click', () => {
  const slots = state.slots.filter(s => !s.is_break);
  state.availRanges.push({faculty:allFaculties()[0]||'',day:state.days[0]||'Monday',from:slots[0]?.id||'',to:slots[slots.length-1]?.id||''});
  renderAvailRanges();
});

// ─────────────────────────────────────────────────────────────
//  Faculty daily caps
// ─────────────────────────────────────────────────────────────
function renderFacCaps() {
  renderList('fac-cap-list', state.facConstraints, (fc, i, rm) => {
    const row = document.createElement('div');
    row.className = 'cap-row';
    row.innerHTML = `
      <label>Faculty<select>${facOpts(fc.faculty)}</select></label>
      <label>Max periods/day<input type="number" value="${fc.max_daily_periods||3}" min="1" max="10"></label>
      <button class="secondary sm remove-btn">Remove</button>`;
    row.querySelector('select').addEventListener('change', e => { fc.faculty = e.target.value; });
    row.querySelector('input').addEventListener('change', e => { fc.max_daily_periods = parseInt(e.target.value)||3; });
    row.querySelector('.remove-btn').addEventListener('click', rm);
    return row;
  });
}
$('btn-add-cap').addEventListener('click', () => {
  state.facConstraints.push({faculty:allFaculties()[0]||'',max_daily_periods:3});
  renderFacCaps();
});

// ─────────────────────────────────────────────────────────────
//  Build API payload
// ─────────────────────────────────────────────────────────────
function buildPayload() {
  return {
    working_hours: {...state.workingHours},
    days: [...state.days],
    slots: state.slots.map(s => ({id:s.id, label:s.label||s.id, is_break:!!s.is_break})),
    rooms: state.rooms.map(r => ({id:r.id, capacity:r.capacity, type:r.type})),
    classes: state.classes.map(c => ({
      id:c.id, name:c.name, strength:c.strength,
      batches: (c.batches||[]).map(b => ({id:b.id,name:b.name,strength:b.strength})),
    })),
    subjects: state.subjects.map(s => ({
      id:s.id, name:s.name, class_id:s.class_id,
      batch_id:s.batch_id||undefined,
      faculty:s.faculty, weekly_periods:s.weekly_periods,
      room_type:s.room_type, duration:s.duration||1,
      session_type:s.session_type||'theory',
      ...(s.fixed ? {fixed:s.fixed} : {}),
    })),
    faculty_unavailable:    state.unavailable.map(u => ({faculty:u.faculty,day:u.day,slot:u.slot})),
    faculty_available_ranges: state.availRanges.map(r => ({faculty:r.faculty,day:r.day,from:r.from,to:r.to})),
    faculty_constraints:    state.facConstraints.map(fc => ({faculty:fc.faculty,max_daily_periods:fc.max_daily_periods})),
  };
}

// ─────────────────────────────────────────────────────────────
//  Load sample
// ─────────────────────────────────────────────────────────────
async function loadSample() {
  $('btn-load').disabled = true;
  try {
    const data = await fetch('/api/sample').then(r => r.json());
    if (data.working_hours) {
      state.workingHours.start = data.working_hours.start || '09:00';
      state.workingHours.end   = data.working_hours.end   || '17:00';
      $('wh-start').value = state.workingHours.start;
      $('wh-end'  ).value = state.workingHours.end;
    }
    state.days    = (data.days||[]).map(d => typeof d==='string'?d:d.id);
    state.slots   = (data.slots||[]).map(s => typeof s==='string'?{id:s,label:s,is_break:false}:{id:s.id,label:s.label||s.id,is_break:!!s.is_break});
    state.rooms   = (data.rooms||[]).map(r => ({id:r.id,capacity:r.capacity||0,type:r.type||'classroom'}));
    state.classes = (data.classes||[]).map(c => ({
      id:c.id, name:c.name||c.id, strength:c.strength||0,
      batches:(c.batches||[]).map(b=>({id:b.id,name:b.name||b.id,strength:b.strength||0})),
    }));
    state.subjects = (data.subjects||[]).map(s => ({
      id:s.id, name:s.name, class_id:s.class_id,
      batch_id:s.batch_id||null, faculty:s.faculty||'',
      weekly_periods:s.weekly_periods||1, duration:s.duration||1,
      room_type:s.room_type||'classroom', session_type:s.session_type||'theory',
      fixed:s.fixed||null,
    }));
    state.unavailable    = (data.faculty_unavailable||[]).map(u=>({faculty:u.faculty,day:u.day,slot:u.slot}));
    state.availRanges    = (data.faculty_available_ranges||[]).map(r=>({faculty:r.faculty,day:r.day,from:r.from,to:r.to}));
    state.facConstraints = (data.faculty_constraints||[]).map(fc=>({faculty:fc.faculty,max_daily_periods:fc.max_daily_periods}));
    renderAll();
    showStatus('Sample data loaded. Edit any field, then Generate.', 'ok');
  } catch {
    showStatus('Could not load sample data. Is the Flask server running?', 'error');
  } finally {
    $('btn-load').disabled = false;
  }
}

function renderAll() {
  renderDaysGrid(); renderSlots(); renderRooms(); renderClasses();
  renderSubjects(); renderUnavail(); renderAvailRanges(); renderFacCaps();
}

// ─────────────────────────────────────────────────────────────
//  Validate
// ─────────────────────────────────────────────────────────────
async function validateData() {
  $('btn-validate').disabled = true;
  try {
    const res  = await fetch('/api/validate', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(buildPayload())});
    const data = await res.json();
    if (data.valid) {
      showStatus('Validation passed — no data issues found.', 'ok');
    } else {
      showStatus(`Validation found ${data.warnings.length} issue(s) — see Conflicts tab.`, 'warn');
      renderIssuesList(data.warnings);
      switchTab('conflicts');
    }
  } catch { showStatus('Validation request failed.', 'error'); }
  finally { $('btn-validate').disabled = false; }
}

// ─────────────────────────────────────────────────────────────
//  Generate
// ─────────────────────────────────────────────────────────────
async function generate() {
  const btn = $('btn-generate');
  btn.disabled = true; btn.textContent = 'Generating…';
  try {
    const res    = await fetch('/api/generate', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(buildPayload())});
    const result = await res.json();
    lastResult   = result;
    updateStats(result);
    rebuildFilterSelect();
    renderTimetable();
    renderIssuesList(result.issues);
    renderFacultyStats(result.stats_by_faculty||{});
    renderClassStats(result.stats_by_class||{}, state.classes);
    const hasE = result.entries.length > 0;
    $('btn-export').disabled     = !hasE;
    $('btn-print').disabled      = !hasE;
    $('btn-save-draft').disabled = !hasE;
    $('btn-publish').disabled    = !hasE;
    const kind = result.success ? 'ok' : 'warn';
    const s = result.summary || {};
    showStatus(result.success
      ? `Timetable generated — ${s.scheduled_sessions} sessions scheduled.`
      : `Partial timetable — ${s.unscheduled_sessions} session(s) unscheduled. See Conflicts tab.`, kind);
    switchTab('timetable');
  } catch { showStatus('Generation failed. Check the terminal.', 'error'); }
  finally { btn.disabled = false; btn.innerHTML = 'Generate ↗'; }
}

function updateStats(result) {
  const s = result.summary || {};
  $('st-scheduled').textContent   = s.scheduled_sessions   ?? result.entries.length;
  $('st-unscheduled').textContent = s.unscheduled_sessions  ?? result.issues.length;
  $('st-total').textContent       = s.total_requested_sessions ?? '—';
  $('st-subjects').textContent    = state.subjects.length;
  $('st-rooms').textContent       = state.rooms.length;
}

// ─────────────────────────────────────────────────────────────
//  Filter / View
// ─────────────────────────────────────────────────────────────
function rebuildFilterSelect() {
  const sel = $('class-filter');
  const prev = sel.value;
  sel.innerHTML = '<option value="all">All</option>';
  if (!lastResult) return;

  if (currentView === 'faculty') {
    const facs = [...new Set(lastResult.entries.map(e => e.faculty))].sort();
    facs.forEach(f => { const o = document.createElement('option'); o.value = o.textContent = f; sel.appendChild(o); });
  } else if (currentView === 'room') {
    const rooms = [...new Set(lastResult.entries.map(e => e.room))].sort();
    rooms.forEach(r => { const o = document.createElement('option'); o.value = o.textContent = r; sel.appendChild(o); });
  } else {
    const seen = new Map();
    lastResult.entries.forEach(e => seen.set(e.class_id, e.class_name));
    seen.forEach((name, id) => { const o = document.createElement('option'); o.value = id; o.textContent = name||id; sel.appendChild(o); });
  }
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

$('class-filter').addEventListener('change', () => { if (lastResult) renderTimetable(); });

function filterEntries(entries) {
  const v = $('class-filter').value;
  if (v === 'all') return entries;
  if (currentView === 'faculty') return entries.filter(e => e.faculty === v);
  if (currentView === 'room')    return entries.filter(e => e.room    === v);
  return entries.filter(e => e.class_id === v);
}

// ─────────────────────────────────────────────────────────────
//  Timetable render dispatcher
// ─────────────────────────────────────────────────────────────
function renderTimetable() {
  if (!lastResult) return;
  const entries = filterEntries(lastResult.entries);
  renderGrid(entries);
  renderSessionList(lastResult.entries, entries);
}

// ─────────────────────────────────────────────────────────────
//  Timetable GRID
// ─────────────────────────────────────────────────────────────
function renderGrid(entries) {
  const wrap = $('tt-grid');
  if (!entries.length) {
    wrap.innerHTML = '<p class="muted center" style="padding:40px">No sessions to display.</p>';
    return;
  }

  const days  = state.days.length ? state.days : [...new Set(lastResult.entries.map(e=>e.day))];
  const slots = state.slots.length ? state.slots : buildSlotsFromEntries(lastResult.entries);

  // Index: key=`${day}|${slotId}` -> entry; skip set for rowspan cells
  const index = {}, skip = {};
  entries.forEach(entry => {
    entry.slots.forEach((sid, i) => {
      const key = `${entry.day}|${sid}`;
      if (i === 0) index[key] = entry;
      else         skip[key]  = true;
    });
  });

  const outer = document.createElement('div');
  outer.className = 'tt-grid-outer';
  const tbl = document.createElement('table');
  tbl.className = 'tt-grid-table';

  // Header
  const hrow = tbl.createTHead().insertRow();
  const thS = document.createElement('th'); thS.textContent = 'Slot'; hrow.appendChild(thS);
  days.forEach(d => { const th = document.createElement('th'); th.textContent = d; hrow.appendChild(th); });

  // Body
  const tbody = tbl.createTBody();
  slots.forEach(slot => {
    const sid   = typeof slot==='string' ? slot : slot.id;
    const label = (typeof slot==='object' && slot.label) ? slot.label : sid;
    const isBrk = typeof slot==='object' && !!slot.is_break;

    const row = tbody.insertRow();
    const lc  = row.insertCell(); lc.className = 'slot-label'; lc.textContent = label;

    days.forEach(day => {
      const key = `${day}|${sid}`;
      if (skip[key]) return;
      const entry = index[key];
      const cell  = row.insertCell();

      if (isBrk && !entry) {
        cell.className = 'break-cell'; cell.textContent = 'Break'; return;
      }
      cell.className = 'tt-cell';
      if (entry) {
        if (entry.duration > 1) cell.rowSpan = entry.duration;
        const div = document.createElement('div');
        div.className = 'tt-session'
          + (entry.room_type==='lab' ? ' lab' : '')
          + (entry.locked ? ' locked-session' : '');
        const batch = entry.batch_name ? `<span class="tt-meta">(${esc(entry.batch_name)})</span>` : '';
        const pin   = entry.locked ? ' 🔒' : '';
        div.innerHTML = `<strong>${esc(entry.subject)}${pin}</strong>${batch}
          <span class="tt-meta">${esc(entry.faculty)}</span>
          <span class="tt-meta">${esc(entry.room)}</span>`;
        div.style.cursor = 'pointer';
        div.addEventListener('click', () => openModal(entry));
        cell.appendChild(div);
      }
    });
  });

  outer.appendChild(tbl);
  wrap.innerHTML = '';
  wrap.appendChild(outer);
}

function buildSlotsFromEntries(entries) {
  return [...new Set(entries.flatMap(e => e.slots))].sort().map(id => ({id, label:id}));
}

// ─────────────────────────────────────────────────────────────
//  Session list
// ─────────────────────────────────────────────────────────────
function renderSessionList(allEntries, shownEntries) {
  const tbody = $('tt-rows');
  if (!shownEntries.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">No sessions to display.</td></tr>`;
    return;
  }
  const dayOrder = state.days.length ? state.days : [...new Set(allEntries.map(e=>e.day))];
  const sorted = [...shownEntries].sort((a,b) => {
    const di = dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day);
    return di || a.start.localeCompare(b.start);
  });

  tbody.innerHTML = sorted.map(e => {
    const typeBadge = `<span class="badge badge-${esc(e.room_type)}">${esc(e.room_type)}</span>`
      + (e.batch_name ? ` <span class="badge badge-batch">${esc(e.batch_name)}</span>` : '')
      + (e.locked     ? ` <span class="badge badge-fixed">locked</span>` : '');
    const classLabel = e.batch_name
      ? `${esc(e.class_name)} › ${esc(e.batch_name)}`
      : esc(e.class_name);
    return `<tr class="${e.locked?'locked-row':''}" data-sid="${esc(e.subject_id)}">
      <td class="lock-cell">${e.locked?'🔒':''}</td>
      <td>${esc(e.day)}</td>
      <td>${esc(e.start)} – ${esc(e.end)}</td>
      <td><strong>${esc(e.subject)}</strong></td>
      <td>${classLabel}</td>
      <td>${esc(e.faculty)}</td>
      <td>${esc(e.room)}</td>
      <td>${typeBadge}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr[data-sid]').forEach(row => {
    row.addEventListener('click', () => {
      const sid = row.dataset.sid;
      const entry = lastResult.entries.find(e => e.subject_id === sid);
      if (entry) openModal(entry);
    });
  });
}

// ─────────────────────────────────────────────────────────────
//  Adjust Modal
// ─────────────────────────────────────────────────────────────
function openModal(entry) {
  editingEntry = entry;
  $('modal-title').textContent = `Adjust: ${entry.subject}`;
  $('adj-lock').checked = !!entry.locked;

  // Populate selects
  const dayS  = $('adj-day');
  const slotS = $('adj-slot');
  const roomS = $('adj-room');
  dayS.innerHTML  = state.days.map(d  => `<option value="${esc(d)}"  ${d===entry.day  ?'selected':''}>${esc(d)}</option>`).join('');
  slotS.innerHTML = state.slots.filter(s=>!s.is_break).map(s => `<option value="${esc(s.id)}" ${s.id===entry.start?'selected':''}>${esc(s.label||s.id)}</option>`).join('');
  roomS.innerHTML = state.rooms.filter(r=>r.type===entry.room_type).map(r => `<option value="${esc(r.id)}" ${r.id===entry.room?'selected':''}>${esc(r.id)} (cap ${r.capacity})</option>`).join('');

  $('adj-conflicts').className = 'adj-conflicts hidden';
  $('adj-conflicts').textContent = '';
  $('modal-overlay').classList.remove('hidden');
}
function closeModal() { $('modal-overlay').classList.add('hidden'); editingEntry = null; }

$('modal-close').addEventListener('click',  closeModal);
$('modal-cancel').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', e => { if (e.target === $('modal-overlay')) closeModal(); });

$('modal-save').addEventListener('click', async () => {
  if (!editingEntry || !lastResult) return;
  const day   = $('adj-day').value;
  const start = $('adj-slot').value;
  const room  = $('adj-room').value;
  const locked = $('adj-lock').checked;

  // Build updated entry
  const slotIdx = state.slots.findIndex(s => s.id === start);
  const duration = editingEntry.duration || 1;
  const newSlots = state.slots.slice(slotIdx, slotIdx + duration).map(s => s.id);
  const endIdx   = slotIdx + duration;
  const end      = endIdx < state.slots.length ? state.slots[endIdx].id : 'End of day';

  const updated = {...editingEntry, day, start, end, slots:newSlots, room, locked};

  // Server-side conflict check
  const body = {
    entries: lastResult.entries.map(e => e.subject_id === editingEntry.subject_id ? updated : e),
    changed: updated,
  };
  try {
    const res  = await fetch('/api/adjust', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data = await res.json();
    if (!data.ok) {
      const cd = $('adj-conflicts');
      cd.innerHTML = data.conflicts.map(c => `• ${esc(c)}`).join('<br>');
      cd.className = 'adj-conflicts';
      return;
    }
    // Commit
    const idx = lastResult.entries.findIndex(e => e.subject_id === editingEntry.subject_id);
    if (idx !== -1) lastResult.entries[idx] = updated;
    renderTimetable();
    closeModal();
    showStatus(`Session '${updated.subject}' moved to ${day} ${start} in ${room}.`, 'ok');
  } catch { showStatus('Adjust request failed.', 'error'); }
});

// ─────────────────────────────────────────────────────────────
//  Conflicts / Stats
// ─────────────────────────────────────────────────────────────
function renderIssuesList(issues) {
  const ul = $('issues-list');
  if (!issues || !issues.length) {
    ul.innerHTML = '<li class="ok">All requested sessions were scheduled successfully.</li>';
    return;
  }
  ul.innerHTML = issues.map(i => `<li>${esc(i)}</li>`).join('');
}
function renderFacultyStats(stats) {
  const el = $('faculty-stats');
  if (!Object.keys(stats).length) { el.innerHTML = '<p class="muted">—</p>'; return; }
  const max = Math.max(1, ...Object.values(stats));
  const rows = Object.entries(stats).sort((a,b)=>b[1]-a[1]).map(([n,l]) =>
    `<tr><td>${esc(n)}</td><td><strong>${l}</strong></td>
     <td class="load-bar-cell"><div class="load-bar"><div class="load-bar-fill" style="width:${Math.round(l/max*100)}%"></div></div></td></tr>`
  ).join('');
  el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Faculty</th><th>Periods</th><th>Load</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function renderClassStats(stats, classes) {
  const el = $('class-stats');
  if (!Object.keys(stats).length) { el.innerHTML = '<p class="muted">—</p>'; return; }
  const max = Math.max(1, ...Object.values(stats));
  const nameMap = Object.fromEntries(classes.map(c => [c.id, c.name||c.id]));
  const rows = Object.entries(stats).sort((a,b)=>b[1]-a[1]).map(([id,l]) =>
    `<tr><td>${esc(nameMap[id]||id)}</td><td><strong>${l}</strong></td>
     <td class="load-bar-cell"><div class="load-bar"><div class="load-bar-fill" style="width:${Math.round(l/max*100)}%"></div></div></td></tr>`
  ).join('');
  el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Class</th><th>Periods</th><th>Load</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ─────────────────────────────────────────────────────────────
//  CSV export
// ─────────────────────────────────────────────────────────────
$('btn-export').addEventListener('click', () => {
  if (!lastResult?.entries?.length) return;
  const entries = filterEntries(lastResult.entries);
  const cols = ['day','start','end','subject','class_name','batch_name','faculty','room','room_type','session_type','duration','locked'];
  const lines = [cols.join(','), ...entries.map(e =>
    cols.map(k => `"${String(e[k]??'').replace(/"/g,'""')}"`).join(','))];
  const blob = new Blob([lines.join('\n')], {type:'text/csv;charset=utf-8;'});
  const a = Object.assign(document.createElement('a'), {href:URL.createObjectURL(blob), download:'timetable.csv'});
  a.click(); URL.revokeObjectURL(a.href);
});

// ─────────────────────────────────────────────────────────────
//  Print
// ─────────────────────────────────────────────────────────────
$('btn-print').addEventListener('click', () => window.print());

// ─────────────────────────────────────────────────────────────
//  Save draft
// ─────────────────────────────────────────────────────────────
$('btn-save-draft').addEventListener('click', async () => {
  if (!lastResult) return;
  try {
    await fetch('/api/draft', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(lastResult)});
    showStatus('Draft saved.', 'ok');
  } catch { showStatus('Could not save draft.', 'error'); }
});

// ─────────────────────────────────────────────────────────────
//  Publish
// ─────────────────────────────────────────────────────────────
$('btn-publish').addEventListener('click', async () => {
  if (!lastResult?.entries?.length) return;
  const btn = $('btn-publish');
  btn.disabled = true; btn.textContent = 'Publishing…';
  try {
    const res  = await fetch('/api/publish', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entries:lastResult.entries})});
    const data = await res.json();
    if (data.published) {
      showStatus('Timetable published successfully.', 'ok');
      const badge = $('publish-badge');
      badge.classList.remove('hidden');
      $('publish-time').textContent = ' · ' + new Date().toLocaleString();
    } else {
      showStatus(`Publish blocked — ${data.conflicts.length} conflict(s) found.`, 'error');
      renderIssuesList(data.conflicts);
      switchTab('conflicts');
    }
  } catch { showStatus('Publish request failed.', 'error'); }
  finally { btn.disabled = false; btn.innerHTML = 'Publish ↗'; }
});

// ─────────────────────────────────────────────────────────────
//  Button wiring
// ─────────────────────────────────────────────────────────────
$('btn-load').addEventListener('click',     loadSample);
$('btn-validate').addEventListener('click', validateData);
$('btn-generate').addEventListener('click', generate);

// ─────────────────────────────────────────────────────────────
//  Init
// ─────────────────────────────────────────────────────────────
renderDaysGrid();
renderSlots();
renderRooms();
renderClasses();
renderSubjects();
renderUnavail();
renderAvailRanges();
renderFacCaps();
