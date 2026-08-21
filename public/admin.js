/* Trang giáo viên: soạn đề, mở/đóng bài, xem và chấm kết quả. */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Math.random().toString(16).slice(2, 10);
const api = (url, opts) => fetch(url, opts).then(r => r.json());

const TYPES = {
  multiple_choice: 'Trắc nghiệm',
  true_false: 'Đúng / Sai',
  fill_blank: 'Điền vào chỗ trống',
  short_answer: 'Trả lời ngắn',
  matching: 'Nối cặp',
  ordering: 'Sắp xếp thứ tự',
  essay: 'Tự luận (chấm tay)',
};

let draft = null; // bài test đang soạn

/* ---------- đăng nhập ---------- */
api('/api/me').then(m => m.teacher ? enter() : $('pw').focus());
$('loginBtn').onclick = login;
$('pw').onkeydown = e => { if (e.key === 'Enter') login(); };
async function login() {
  const r = await api('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('pw').value }),
  });
  if (r.error) { $('loginErr').textContent = r.error; $('loginErr').classList.remove('hidden'); return; }
  enter();
}
function enter() {
  $('loginView').classList.add('hidden');
  $('app').classList.remove('hidden');
  ['navTests', 'navSubs', 'logout'].forEach(id => $(id).classList.remove('hidden'));
  loadTests();
}
$('logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
$('navTests').onclick = () => { show('testsView'); loadTests(); };
$('navSubs').onclick = () => showSubmissions();
function show(id) {
  ['testsView', 'editView', 'subsView', 'importView']
    .forEach(v => $(v).classList.toggle('hidden', v !== id));
}

/* ---------- danh sách bài test ---------- */
async function loadTests() {
  const list = await api('/api/admin/tests');
  $('testList').innerHTML = list.length ? list.map(t => `
    <div class="entry">
      <div class="row">
        <div class="grow">
          <h3>${esc(t.title || '(chưa đặt tên)')}
            <span class="pill ${t.published ? '' : 'off'}">${t.published ? 'Đang mở' : 'Đã đóng'}</span></h3>
          <p class="meta">${t.questionCount} câu<span class="sep">·</span>${t.submissionCount} bài nộp</p>
        </div>
        <button class="sm" data-edit="${t.id}">Sửa</button>
        <button class="sm" data-subs="${t.id}">Kết quả</button>
        <button class="sm" data-copy="${t.id}">Sao chép link</button>
        <button class="sm danger" data-del="${t.id}">Xoá</button>
      </div>
    </div>`).join('') : '<div class="card muted">Chưa có bài test nào.</div>';

  $('testList').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editTest(b.dataset.edit));
  $('testList').querySelectorAll('[data-subs]').forEach(b => b.onclick = () => showSubmissions(b.dataset.subs));
  $('testList').querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
    const url = location.origin + '/test.html?id=' + b.dataset.copy;
    navigator.clipboard.writeText(url); b.textContent = 'Đã sao chép';
    setTimeout(() => b.textContent = 'Sao chép link', 1500);
  });
  $('testList').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const x = await api(`/api/admin/tests/${b.dataset.del}/impact`);
    if (x.error) return alert(x.error);
    const mất = [
      `đề “${x.title}”`,
      x.submissions ? `${x.submissions} bài nộp của học viên (kèm điểm)` : null,
      x.files ? `${x.files} tệp nghe đã tải lên` : null,
    ].filter(Boolean);
    if (!confirm(`Xoá vĩnh viễn:\n· ${mất.join('\n· ')}\n\nKhông thể hoàn tác. Tiếp tục?`)) return;
    const r = await api('/api/admin/tests/' + b.dataset.del, { method: 'DELETE' });
    if (r.error) return alert(r.error);
    loadTests();
  });
}

/* ---------- nhập đề từ Markdown ---------- */
$('importBtn').onclick = () => renderImport();

function renderImport() {
  show('importView');
  $('importView').innerHTML = `
    <div class="row" style="margin-bottom:var(--space-lg)">
      <h2 class="grow">Nhập đề từ Markdown</h2>
      <button id="impBack">Quay lại</button>
    </div>
    <div class="card">
      <p class="muted">Soạn đề bằng Markdown rồi dán vào đây, hoặc mở tệp <code>.md</code> có sẵn.</p>

      <div class="card inset" style="margin-bottom:var(--space-md)">
        <label class="field" style="margin-bottom:var(--space-sm)"><span>Đề mẫu có sẵn</span>
          <select id="impPick"></select></label>
        <div class="row">
          <button id="impInsert">Chèn vào ô soạn</button>
          <a id="impDownload" href="/mau-de.md?tai=1" download><button type="button">Tải tệp .md về máy</button></a>
          <span class="small muted">Chèn để sửa ngay tại đây, hoặc tải về sửa bằng trình soạn thảo.</span>
        </div>
      </div>

      <div class="row" style="margin-bottom:var(--space-md)">
        <label class="small muted">Mở tệp từ máy:
          <input type="file" id="impFile" accept=".md,.markdown,.txt"></label>
      </div>
      <textarea id="impText" rows="18" spellcheck="false"
        placeholder="# Tên đề&#10;&gt; Thời gian: 30&#10;&#10;## Phần 1&#10;&#10;### [Trắc nghiệm] (1đ) Câu hỏi…&#10;- [x] đáp án đúng&#10;- đáp án sai"></textarea>
      <div class="row" style="margin-top:var(--space-md)">
        <button class="primary" id="impCheck">Kiểm tra</button>
        <button id="impSave" disabled>Tạo đề</button>
      </div>
      <div id="impResult" style="margin-top:var(--space-md)"></div>
    </div>`;

  let parsed = null;
  $('impBack').onclick = () => { show('testsView'); loadTests(); };

  /* Danh sách đề mẫu nằm trong quiz/templates/ */
  const urlOf = f => (f === 'mau-de.md' ? '/mau-de.md' : '/templates/' + f);
  api('/api/templates').then(list => {
    $('impPick').innerHTML = list.map(t =>
      `<option value="${esc(t.file)}">${esc(t.label)}</option>`).join('');
    syncDownload();
  });
  const syncDownload = () => {
    const f = $('impPick').value;
    $('impDownload').href = urlOf(f) + '?tai=1';
    $('impDownload').setAttribute('download', f);
  };
  $('impPick').onchange = syncDownload;
  $('impInsert').onclick = async () => {
    const btn = $('impInsert');
    btn.disabled = true; btn.textContent = 'Đang nạp…';
    try {
      const res = await fetch(urlOf($('impPick').value));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      $('impText').value = await res.text();
      check();
    } catch (e) {
      $('impResult').innerHTML =
        `<p class="notice err">Không nạp được tệp mẫu (${esc(e.message)}). Kiểm tra xem máy chủ còn chạy không.</p>`;
    } finally {
      btn.disabled = false; btn.textContent = 'Chèn vào ô soạn';
    }
  };
  $('impFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    $('impText').value = await f.text();
    check();
  };
  $('impCheck').onclick = check;
  $('impSave').onclick = async () => {
    if (!parsed) return;
    const r = await api('/api/admin/tests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    if (r.error) return alert(r.error);
    draft = r;
    renderEditor();   /* mở luôn trình soạn đề để rà lại và bấm mở cho học viên */
  };

  function check() {
    const out = $('impResult');
    const src = $('impText').value.trim();
    if (!src) { out.innerHTML = '<p class="notice err">Chưa có nội dung nào.</p>'; return; }
    const res = parseMarkdownTest(src);
    parsed = res.errors.length ? null : res.test;
    $('impSave').disabled = !parsed;

    const list = arr => arr.map(x => `<li>${esc(x)}</li>`).join('');
    out.innerHTML = `
      ${res.errors.length
        ? `<div class="notice err"><strong>${res.errors.length} lỗi cần sửa</strong>
             <ul style="margin:var(--space-xs) 0 0">${list(res.errors)}</ul></div>`
        : `<div class="notice ok"><strong>Đọc được đề:</strong> ${esc(res.test.title)} —
             ${res.test.sections.length} phần, ${res.questionCount} câu,
             tổng ${res.test.sections.flatMap(s => s.questions).reduce((a, q) => a + (q.points || 0), 0)} điểm.
             Bấm “Tạo đề” để lưu (đề được tạo ở trạng thái <em>đã đóng</em>).</div>`}
      ${res.warnings.length
        ? `<div class="notice" style="margin-top:var(--space-sm)"><strong>Ghi chú</strong>
             <ul style="margin:var(--space-xs) 0 0">${list(res.warnings)}</ul></div>` : ''}
      ${parsed ? `<div class="card inset" style="margin-top:var(--space-md)">
          ${parsed.sections.map(s => `<h3>${esc(s.title)}</h3>
            <ol class="small muted">${s.questions.map(q =>
              `<li>${esc(TYPES[q.type])}${q.multiple ? ' (nhiều đáp án)' : ''} — ${esc(q.prompt.slice(0, 70))}</li>`).join('')}</ol>`).join('')}
        </div>` : ''}`;
  }
}

$('newTest').onclick = () => {
  draft = {
    title: '', description: '', timeLimitMin: 0, published: false,
    showResultDetail: true, shuffleQuestions: false,
    sections: [newSection()],
  };
  renderEditor();
};
async function editTest(id) {
  draft = await api('/api/tests/' + id + '?full=1');
  renderEditor();
}
const newSection = () => ({ id: uid(), title: 'Phần 1', instructions: '', passage: '', audio: null, questions: [] });
function newQuestion(type) {
  const q = { id: uid(), type, prompt: '', points: 1, explanation: '' };
  if (type === 'multiple_choice') {
    q.multiple = false;
    q.options = [{ id: uid(), text: '' }, { id: uid(), text: '' }, { id: uid(), text: '' }, { id: uid(), text: '' }];
    q.correct = [];
  }
  if (type === 'true_false') q.correct = 'true';
  if (type === 'fill_blank') { q.text = ''; q.blanks = [{ answers: [''], caseSensitive: false }]; }
  if (type === 'short_answer') { q.answers = ['']; q.caseSensitive = false; }
  if (type === 'matching') { q.left = [{ id: uid(), text: '' }]; q.right = [{ id: uid(), text: '' }]; q.pairs = {}; }
  if (type === 'ordering') q.items = [{ id: uid(), text: '' }, { id: uid(), text: '' }];
  return q;
}

/* ---------- trình soạn đề ---------- */
function renderEditor() {
  show('editView');
  $('editView').innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <h2 class="grow">Soạn bài test</h2>
      <button id="backBtn">← Quay lại</button>
      <button class="primary" id="saveBtn">Lưu bài test</button>
    </div>
    <div class="card">
      <label class="field"><span>Tên bài test</span><input type="text" id="f_title" value="${esc(draft.title)}"></label>
      <label class="field"><span>Mô tả / hướng dẫn chung</span><textarea id="f_desc">${esc(draft.description)}</textarea></label>
      <div class="row">
        <label class="field grow"><span>Thời gian làm bài (phút, 0 = không giới hạn)</span>
          <input type="number" id="f_time" min="0" value="${draft.timeLimitMin || 0}"></label>
      </div>
      <label class="row" style="gap:8px"><input type="checkbox" id="f_pub" ${draft.published ? 'checked' : ''}> Mở cho học viên làm bài</label>
      <label class="row" style="gap:8px"><input type="checkbox" id="f_detail" ${draft.showResultDetail ? 'checked' : ''}> Hiện đáp án chi tiết cho học viên sau khi nộp</label>
      <label class="row" style="gap:8px"><input type="checkbox" id="f_shuffle" ${draft.shuffleQuestions ? 'checked' : ''}> Xáo trộn thứ tự câu hỏi</label>
    </div>
    <div id="sections"></div>
    <button id="addSection">+ Thêm phần thi</button>`;

  $('backBtn').onclick = () => { show('testsView'); loadTests(); };
  $('saveBtn').onclick = saveDraft;
  $('addSection').onclick = () => { collect(); draft.sections.push({ ...newSection(), title: 'Phần ' + (draft.sections.length + 1) }); renderSections(); };
  renderSections();
}

function renderSections() {
  $('sections').innerHTML = draft.sections.map((s, si) => `
    <div class="card" data-si="${si}">
      <div class="row">
        <input type="text" class="grow s_title" value="${esc(s.title)}" placeholder="Tên phần thi">
        <button class="sm danger s_del">Xoá phần</button>
      </div>
      <label class="field" style="margin-top:10px"><span>Hướng dẫn của phần</span>
        <input type="text" class="s_instr" value="${esc(s.instructions || '')}"></label>
      <label class="field"><span>Bài đọc (để trống nếu không có)</span>
        <textarea class="s_passage">${esc(s.passage || '')}</textarea></label>

      <div class="card" style="background:var(--bg)">
        <h3>Bài nghe</h3>
        <div class="row">
          <input type="file" class="s_file" accept="audio/*">
          <span class="small muted s_audio">${s.audio && s.audio.url ? 'Nguồn: ' + esc(s.audio.url) : 'Chưa có tệp'}</span>
        </div>
        <label class="field" style="margin-top:var(--space-sm)">
          <span>Hoặc dán link (Google Drive, Dropbox, OneDrive, URL trực tiếp)</span>
          <input type="text" class="s_link" value="${s.audio && s.audio.url && !s.audio.url.startsWith('/uploads/') ? esc(s.audio.url) : ''}"
            placeholder="https://drive.google.com/file/d/…/view"></label>
        <p class="small muted">Với Google Drive, tệp phải ở chế độ <strong>“Bất kỳ ai có đường liên kết”</strong>.
          Máy chủ sẽ tải hộ và phát cho học viên — học viên không thấy link gốc.</p>
        <label class="field" style="margin-top:10px"><span>Số lần được phép nghe</span>
          <input type="number" min="1" max="10" class="s_plays" style="max-width:120px" value="${(s.audio && s.audio.maxPlays) || 1}"></label>
        ${s.audio && s.audio.url ? `<audio controls style="width:100%;margin-top:var(--space-sm)"
            src="${esc(draft.id ? `/api/audio/${draft.id}/${s.id}` : s.audio.url)}"></audio>
          <p class="small muted">Nghe thử ở đây để chắc chắn link chạy được trước khi mở đề.</p>
          <button class="sm danger s_audiodel">Gỡ bài nghe</button>` : ''}
      </div>

      <div class="qlist">${s.questions.map((q, qi) => renderQEditor(q, si, qi)).join('')}</div>
      <div class="row" style="margin-top:10px">
        <select class="q_type" style="max-width:220px">
          ${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <button class="sm q_add">+ Thêm câu hỏi</button>
      </div>
    </div>`).join('');
  wireSections();
}

function renderQEditor(q, si, qi) {
  let extra = '';
  if (q.type === 'multiple_choice') {
    extra = `<label class="row small" style="gap:8px;margin-bottom:8px">
        <input type="checkbox" class="q_multi" ${q.multiple ? 'checked' : ''}> Cho phép chọn nhiều đáp án</label>
      ${q.options.map(o => `<div class="row" style="margin-bottom:6px">
        <input type="${q.multiple ? 'checkbox' : 'radio'}" name="c_${q.id}" class="q_correct" data-oid="${o.id}"
          ${(q.correct || []).includes(o.id) ? 'checked' : ''}>
        <input type="text" class="grow q_opt" data-oid="${o.id}" value="${esc(o.text)}" placeholder="Nội dung lựa chọn">
        <button class="sm danger q_optdel" data-oid="${o.id}">×</button></div>`).join('')}
      <button class="sm q_optadd">+ Thêm lựa chọn</button>
      <p class="small muted">Đánh dấu ô bên trái cho đáp án đúng.</p>`;
  } else if (q.type === 'true_false') {
    extra = `<label class="field" style="max-width:160px"><span>Đáp án đúng</span>
      <select class="q_tf"><option value="true" ${q.correct === 'true' ? 'selected' : ''}>Đúng</option>
      <option value="false" ${q.correct === 'false' ? 'selected' : ''}>Sai</option></select></label>`;
  } else if (q.type === 'fill_blank') {
    extra = `<label class="field"><span>Câu có chỗ trống — dùng <code>___</code> cho mỗi chỗ trống</span>
        <textarea class="q_text" placeholder="She ___ to school every day.">${esc(q.text || '')}</textarea></label>
      ${(q.blanks || []).map((b, bi) => `<label class="field"><span>Đáp án chỗ trống ${bi + 1} (nhiều đáp án cách nhau bằng dấu |)</span>
        <input type="text" class="q_blank" data-bi="${bi}" value="${esc((b.answers || []).join(' | '))}"></label>`).join('')}
      <div class="row"><button class="sm q_blankadd">+ Thêm chỗ trống</button>
        <button class="sm q_blankdel">− Bớt chỗ trống</button></div>`;
  } else if (q.type === 'short_answer') {
    extra = `<label class="field"><span>Đáp án chấp nhận (cách nhau bằng dấu |, để trống nếu muốn tự chấm)</span>
      <input type="text" class="q_answers" value="${esc((q.answers || []).join(' | '))}"></label>
      <label class="row small" style="gap:8px"><input type="checkbox" class="q_case" ${q.caseSensitive ? 'checked' : ''}> Phân biệt chữ hoa/thường</label>`;
  } else if (q.type === 'matching') {
    extra = `<div class="row" style="align-items:flex-start;gap:20px">
        <div class="grow"><h3 class="small">Cột trái</h3>
          ${q.left.map(l => `<div class="row" style="margin-bottom:6px">
            <input type="text" class="grow q_left" data-id="${l.id}" value="${esc(l.text)}">
            <select class="q_pair" data-id="${l.id}" style="max-width:150px">
              <option value="">— nối với —</option>
              ${q.right.map(r => `<option value="${r.id}" ${q.pairs[l.id] === r.id ? 'selected' : ''}>${esc(r.text || '(trống)')}</option>`).join('')}
            </select></div>`).join('')}
          <button class="sm q_leftadd">+ Thêm dòng trái</button></div>
        <div class="grow"><h3 class="small">Cột phải</h3>
          ${q.right.map(r => `<input type="text" class="q_right" data-id="${r.id}" value="${esc(r.text)}" style="margin-bottom:6px">`).join('')}
          <button class="sm q_rightadd">+ Thêm dòng phải</button></div>
      </div><p class="small muted">Nhập nội dung hai cột, bấm “Lưu bài test” rồi chọn lại để ghép cặp.</p>`;
  } else if (q.type === 'ordering') {
    extra = `<p class="small muted">Nhập các phần theo <strong>đúng thứ tự</strong>; học viên sẽ thấy thứ tự bị xáo trộn.</p>
      ${q.items.map(it => `<input type="text" class="q_item" data-id="${it.id}" value="${esc(it.text)}" style="margin-bottom:6px">`).join('')}
      <button class="sm q_itemadd">+ Thêm phần</button>`;
  } else if (q.type === 'essay') {
    extra = '<p class="small muted">Câu này sẽ được chấm tay ở trang Kết quả.</p>';
  }

  return `<div class="q" data-si="${si}" data-qi="${qi}">
    <div class="row">
      <span class="pill">${TYPES[q.type]}</span>
      <span class="grow"></span>
      <label class="small muted">Điểm <input type="number" min="0" step="0.5" class="q_points" style="width:70px" value="${q.points ?? 1}"></label>
      <button class="sm danger q_del">Xoá câu</button>
    </div>
    <label class="field" style="margin-top:8px"><span>Câu hỏi</span>
      <textarea class="q_prompt" rows="2">${esc(q.prompt)}</textarea></label>
    ${extra}
    <label class="field" style="margin-top:8px"><span>Giải thích (hiện cho học viên sau khi nộp)</span>
      <input type="text" class="q_expl" value="${esc(q.explanation || '')}"></label>
  </div>`;
}

function wireSections() {
  $('sections').querySelectorAll('.card[data-si]').forEach(card => {
    const si = Number(card.dataset.si);
    const s = draft.sections[si];
    card.querySelector('.s_del').onclick = () => { collect(); draft.sections.splice(si, 1); renderSections(); };
    card.querySelector('.q_add').onclick = () => {
      collect();
      draft.sections[si].questions.push(newQuestion(card.querySelector('.q_type').value));
      renderSections();
    };
    const del = card.querySelector('.s_audiodel');
    if (del) del.onclick = () => {
      collect();
      card.querySelector('.s_link').value = '';
      draft.sections[si].audio = null;
      renderSections();
    };

    card.querySelector('.s_file').onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      const note = card.querySelector('.s_audio');
      note.textContent = 'Đang tải lên…';
      const r = await fetch('/api/admin/upload', {
        /* Tên tệp có dấu tiếng Việt không đặt thẳng vào header được — phải mã hoá. */
        method: 'POST', headers: { 'X-Filename': encodeURIComponent(file.name) }, body: file,
      }).then(x => x.json());
      if (r.error) { note.textContent = 'Lỗi: ' + r.error; return; }
      collect();
      draft.sections[si].audio = { url: r.url, maxPlays: Number(card.querySelector('.s_plays').value) || 1 };
      renderSections();
    };

    card.querySelectorAll('.q[data-qi]').forEach(qe => {
      const q = s.questions[Number(qe.dataset.qi)];
      qe.querySelector('.q_del').onclick = () => {
        collect(); s.questions.splice(Number(qe.dataset.qi), 1); renderSections();
      };
      const multi = qe.querySelector('.q_multi');
      if (multi) multi.onchange = () => { collect(); q.multiple = multi.checked; q.correct = []; renderSections(); };
      const optadd = qe.querySelector('.q_optadd');
      if (optadd) optadd.onclick = () => { collect(); q.options.push({ id: uid(), text: '' }); renderSections(); };
      qe.querySelectorAll('.q_optdel').forEach(b => b.onclick = () => {
        collect();
        q.options = q.options.filter(o => o.id !== b.dataset.oid);
        q.correct = (q.correct || []).filter(id => id !== b.dataset.oid);
        renderSections();
      });
      const ba = qe.querySelector('.q_blankadd');
      if (ba) ba.onclick = () => { collect(); q.blanks.push({ answers: [''], caseSensitive: false }); renderSections(); };
      const bd = qe.querySelector('.q_blankdel');
      if (bd) bd.onclick = () => { collect(); if (q.blanks.length > 1) q.blanks.pop(); renderSections(); };
      const la = qe.querySelector('.q_leftadd');
      if (la) la.onclick = () => { collect(); q.left.push({ id: uid(), text: '' }); renderSections(); };
      const ra = qe.querySelector('.q_rightadd');
      if (ra) ra.onclick = () => { collect(); q.right.push({ id: uid(), text: '' }); renderSections(); };
      const ia = qe.querySelector('.q_itemadd');
      if (ia) ia.onclick = () => { collect(); q.items.push({ id: uid(), text: '' }); renderSections(); };
    });
  });
}

/* Đọc mọi ô nhập vào đối tượng draft. */
function collect() {
  draft.title = $('f_title').value.trim();
  draft.description = $('f_desc').value;
  draft.timeLimitMin = Number($('f_time').value) || 0;
  draft.published = $('f_pub').checked;
  draft.showResultDetail = $('f_detail').checked;
  draft.shuffleQuestions = $('f_shuffle').checked;

  $('sections').querySelectorAll('.card[data-si]').forEach(card => {
    const s = draft.sections[Number(card.dataset.si)];
    s.title = card.querySelector('.s_title').value;
    s.instructions = card.querySelector('.s_instr').value;
    s.passage = card.querySelector('.s_passage').value;

    const link = card.querySelector('.s_link').value.trim();
    const plays = Number(card.querySelector('.s_plays').value) || 1;
    if (link) s.audio = { url: link, maxPlays: plays };          /* link ghi đè tệp đã tải */
    else if (s.audio && s.audio.url.startsWith('/uploads/')) s.audio.maxPlays = plays;
    else if (s.audio) s.audio = null;

    card.querySelectorAll('.q[data-qi]').forEach(qe => {
      const q = s.questions[Number(qe.dataset.qi)];
      q.prompt = qe.querySelector('.q_prompt').value;
      q.points = Number(qe.querySelector('.q_points').value) || 0;
      q.explanation = qe.querySelector('.q_expl').value;

      if (q.type === 'multiple_choice') {
        qe.querySelectorAll('.q_opt').forEach(i => {
          const o = q.options.find(x => x.id === i.dataset.oid); if (o) o.text = i.value;
        });
        q.correct = [...qe.querySelectorAll('.q_correct')].filter(i => i.checked).map(i => i.dataset.oid);
      }
      if (q.type === 'true_false') q.correct = qe.querySelector('.q_tf').value;
      if (q.type === 'fill_blank') {
        q.text = qe.querySelector('.q_text').value;
        qe.querySelectorAll('.q_blank').forEach(i => {
          q.blanks[Number(i.dataset.bi)] = {
            answers: i.value.split('|').map(x => x.trim()).filter(Boolean), caseSensitive: false,
          };
        });
      }
      if (q.type === 'short_answer') {
        q.answers = qe.querySelector('.q_answers').value.split('|').map(x => x.trim()).filter(Boolean);
        q.caseSensitive = qe.querySelector('.q_case').checked;
      }
      if (q.type === 'matching') {
        qe.querySelectorAll('.q_left').forEach(i => {
          const l = q.left.find(x => x.id === i.dataset.id); if (l) l.text = i.value;
        });
        qe.querySelectorAll('.q_right').forEach(i => {
          const r = q.right.find(x => x.id === i.dataset.id); if (r) r.text = i.value;
        });
        q.pairs = {};
        qe.querySelectorAll('.q_pair').forEach(sel => { if (sel.value) q.pairs[sel.dataset.id] = sel.value; });
      }
      if (q.type === 'ordering') {
        qe.querySelectorAll('.q_item').forEach(i => {
          const it = q.items.find(x => x.id === i.dataset.id); if (it) it.text = i.value;
        });
      }
    });
  });
}

async function saveDraft() {
  collect();
  if (!draft.title) return alert('Vui lòng đặt tên cho bài test.');
  const r = await api('/api/admin/tests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  if (r.error) return alert(r.error);
  draft = r;
  $('saveBtn').textContent = 'Đã lưu ✓';
  setTimeout(() => $('saveBtn').textContent = 'Lưu bài test', 1500);
  renderSections();
}

/* ---------- kết quả & chấm tay ---------- */
async function showSubmissions(testId) {
  show('subsView');
  const list = await api('/api/admin/submissions' + (testId ? '?testId=' + testId : ''));
  const hasClass = list.some(s => (s.studentClass || '').trim());   /* cột Lớp chỉ hiện khi có dữ liệu */
  const avg = list.length
    ? Math.round(list.reduce((a, s) => a + (s.maxScore ? s.score / s.maxScore : 0), 0) / list.length * 1000) / 10 : 0;

  $('subsView').innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <h2 class="grow">Kết quả học viên</h2>
      <a href="/api/admin/export${testId ? '?testId=' + testId : ''}"><button>Tải CSV</button></a>
    </div>
    <div class="stat-row">
      <div class="stat"><div class="label">Số bài nộp</div><div class="figure">${list.length}</div></div>
      <div class="stat"><div class="label">Điểm trung bình</div><div class="figure">${avg}%</div></div>
      <div class="stat"><div class="label">Cần chấm tay</div><div class="figure">${list.filter(s => s.needsReview).length}</div></div>
      <div class="stat"><div class="label">Muộn</div><div class="figure">${list.filter(s => s.late).length}</div></div>
    </div>
    <div class="card"><div class="table-scroll"><table><thead><tr>
      <th>Họ tên</th>${hasClass ? '<th>Lớp</th>' : ''}<th>Bài test</th><th>Điểm</th><th>%</th><th>Muộn</th><th>Nộp lúc</th><th></th>
    </tr></thead><tbody>
      ${list.map(s => `<tr>
        <td>${esc(s.studentName)}</td>${hasClass ? `<td>${esc(s.studentClass || '')}</td>` : ''}<td>${esc(s.testTitle)}</td>
        <td>${s.score}/${s.maxScore}</td>
        <td>${s.maxScore ? Math.round(s.score / s.maxScore * 1000) / 10 : 0}%</td>
        <td>${s.late ? '<span class="pill late">Muộn</span>' : '<span class="small muted">—</span>'}</td>
        <td class="small muted">${new Date(s.submittedAt).toLocaleString('vi-VN')}</td>
        <td>${s.needsReview ? '<span class="pill">cần chấm</span> ' : ''}
          <button class="sm" data-view="${s.id}">Xem</button>
          <button class="sm danger" data-delsub="${s.id}">Xoá</button></td>
      </tr>`).join('') || `<tr><td colspan="${hasClass ? 8 : 7}" class="muted">Chưa có bài nộp nào.</td></tr>`}
    </tbody></table></div></div>
    <div id="detail"></div>`;

  $('subsView').querySelectorAll('[data-view]').forEach(b => b.onclick = () =>
    viewSubmission(list.find(s => s.id === b.dataset.view)));
  $('subsView').querySelectorAll('[data-delsub]').forEach(b => b.onclick = async () => {
    if (!confirm('Xoá bài nộp này?')) return;
    await api('/api/admin/submissions/' + b.dataset.delsub, { method: 'DELETE' });
    showSubmissions(testId);
  });
}

async function viewSubmission(s) {
  const test = await api('/api/tests/' + s.testId + '?full=1');
  const qs = (test.sections || []).flatMap(x => x.questions || []);
  $('detail').innerHTML = `<div class="card"><h3>Bài làm của ${esc(s.studentName)}</h3>
    <p class="small muted">Thời gian làm: ${s.durationSec ? Math.round(s.durationSec / 60) + ' phút' : '—'}
      ${s.late ? ' · <span class="pill late">Muộn</span>' : ''}
      ${Object.keys(s.audioPlays || {}).length ? ' · số lần nghe: ' + Object.values(s.audioPlays).join(', ') : ''}</p>
    ${qs.map(q => {
      const d = s.details[q.id] || {};
      const mark = d.correct === true ? '<span class="correct">✔</span>'
        : d.correct === false ? '<span class="wrong">✘</span>' : '<span class="review">?</span>';
      return `<div class="q"><div class="prompt">${mark} ${esc(q.prompt)}
        <span class="muted small">(${d.earned ?? 0}/${d.max ?? 0})</span></div>
        <p class="small">Học viên trả lời: <strong>${esc(fmtAnswer(q, s.answers[q.id]))}</strong></p>
        ${d.needsReview ? `<div class="row"><input type="number" min="0" max="${d.max}" step="0.5"
            style="width:90px" id="g_${q.id}" value="${d.earned || 0}">
          <button class="sm primary" data-grade="${q.id}">Cho điểm</button></div>` : ''}
      </div>`;
    }).join('')}</div>`;

  $('detail').querySelectorAll('[data-grade]').forEach(b => b.onclick = async () => {
    const r = await api('/api/admin/grade', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        submissionId: s.id, questionId: b.dataset.grade,
        earned: Number($('g_' + b.dataset.grade).value),
      }),
    });
    if (r.error) return alert(r.error);
    alert('Đã lưu. Tổng điểm mới: ' + r.score);
    showSubmissions(s.testId);
  });
  $('detail').scrollIntoView({ behavior: 'smooth' });
}

function fmtAnswer(q, a) {
  if (a == null || a === '') return '(không trả lời)';
  if (q.type === 'multiple_choice')
    return [].concat(a).map(id => (q.options.find(o => o.id === id) || {}).text || id).join(', ');
  if (q.type === 'true_false') return a === 'true' ? 'Đúng' : 'Sai';
  if (q.type === 'matching')
    return Object.entries(a).map(([l, r]) =>
      `${(q.left.find(x => x.id === l) || {}).text} → ${(q.right.find(x => x.id === r) || {}).text || '?'}`).join('; ');
  if (q.type === 'ordering')
    return a.map(id => (q.items.find(x => x.id === id) || {}).text).join(' → ');
  if (Array.isArray(a)) return a.join(' | ');
  return String(a);
}
