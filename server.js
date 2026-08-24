/* Hệ thống thi trực tuyến — server thuần Node, không phụ thuộc thư viện ngoài.
   Dữ liệu lưu dạng JSON trong ./data, file nghe lưu trong ./uploads. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
/* Cho phép ghi đè thư mục dữ liệu/nghe (dùng cho test, hoặc chạy nhiều instance). */
const DATA = process.env.TEST_DATA_DIR || path.join(ROOT, 'data');
const UPLOADS = process.env.TEST_UPLOADS_DIR || path.join(ROOT, 'uploads');
const PORT = process.env.PORT || 3000;
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'minmin';

for (const d of [DATA, UPLOADS]) fs.mkdirSync(d, { recursive: true });

/* ---------- lưu trữ ---------- */
/* store.write dùng ghi atomic (tmp → rename): thao tác đọc (GET) luôn thấy
   snapshot nhất quán, không cần vào hàng đợi mutate — chỉ các thao tác
   "đọc → sửa → ghi" (mutate) mới cần serialize. */
const store = {
  read(name, fallback) {
    const f = path.join(DATA, name + '.json');
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
  },
  write(name, value) {
    const f = path.join(DATA, name + '.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(value, null, 2));
    fs.renameSync(f + '.tmp', f);
  },
};
const tests = () => store.read('tests', []);
const saveTests = (v) => store.write('tests', v);
const subs = () => store.read('submissions', []);
const saveSubs = (v) => store.write('submissions', v);

/* Hàng đợi duy nhất cho mọi thao tác "đọc → sửa → ghi" (mutate): các thao tác
   chạy lần lượt, không chồng lên nhau — cả lớp nộp cùng lúc cũng không bài nào
   bị đè lên bài khác. fn được phép async; lỗi trong fn không chặn hàng đợi. */
let mutationQueue = Promise.resolve();
function mutate(fn) {
  const run = mutationQueue.then(async () => fn());
  mutationQueue = run.catch(() => {});
  return run;
}

const uid = () => crypto.randomBytes(8).toString('hex');

/* ---------- phiên đăng nhập giáo viên ---------- */
const sessions = new Map(); // token -> expiry
const SESSION_MS = 12 * 60 * 60 * 1000;

/* Cho phép học viên nộp trễ một chút (mạng) mà không bị đánh dấu muộn.
   (= 60 giây) */
const SUBMIT_GRACE_MS = 60 * 1000;

/* Deep clone an toàn: structuredClone có sẵn từ Node 17, các bản cũ hơn lùi về JSON. */
const deepClone = typeof structuredClone === "function"
  ? structuredClone
  : (x) => JSON.parse(JSON.stringify(x));
function newSession() {
  const t = crypto.randomBytes(24).toString('hex');
  sessions.set(t, Date.now() + SESSION_MS);
  return t;
}
function isTeacher(req) {
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)qs_token=([a-f0-9]+)/.exec(cookie);
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) { sessions.delete(m[1]); return false; }
  return true;
}

/* ---------- chấm điểm ---------- */
const norm = (s, caseSensitive) => {
  let t = String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
  if (!caseSensitive) t = t.toLowerCase();
  return t;
};
const sameSet = (a, b) => {
  const A = new Set(a || []), B = new Set(b || []);
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
};

/* Độ muộn: học viên nộp quá giờ làm bài (+thời gian cho phép) so với mốc bắt đầu
   do máy chủ phát. startedMs/nowMs tính bằng ms; limitSec/graceMs tính bằng giây. */
function computeLate(startedMs, limitSec, graceMs, nowMs) {
  if (!(limitSec > 0) || !startedMs) return false;
  return (nowMs - startedMs) / 1000 > limitSec + graceMs / 1000;
}

/** Trả về {earned, max, correct(null nếu cần chấm tay), needsReview} */
function gradeQuestion(q, ans) {
  const max = Number(q.points) || 1;
  const res = (ok) => ({ earned: ok ? max : 0, max, correct: ok, needsReview: false });
  const partial = (ratio) => ({
    earned: Math.round(max * ratio * 100) / 100, max,
    correct: ratio === 1, needsReview: false,
  });

  switch (q.type) {
    case 'multiple_choice': {
      const chosen = Array.isArray(ans) ? ans : ans == null ? [] : [ans];
      return res(sameSet(chosen, q.correct));
    }
    case 'true_false':
      return res(String(ans) === String(q.correct));

    case 'fill_blank': {
      const blanks = q.blanks || [];
      if (!blanks.length) return res(false);
      const given = Array.isArray(ans) ? ans : [ans];
      let hit = 0;
      blanks.forEach((b, i) => {
        const accepted = (b.answers || []).map((x) => norm(x, b.caseSensitive));
        if (accepted.includes(norm(given[i], b.caseSensitive))) hit++;
      });
      return partial(hit / blanks.length);
    }
    case 'short_answer': {
      const accepted = (q.answers || []).map((x) => norm(x, q.caseSensitive));
      if (!accepted.length) return { earned: 0, max, correct: null, needsReview: true };
      return res(accepted.includes(norm(ans, q.caseSensitive)));
    }
    case 'matching': {
      const pairs = q.pairs || {};
      const keys = Object.keys(pairs);
      if (!keys.length) return res(false);
      const given = ans || {};
      const hit = keys.filter((k) => given[k] === pairs[k]).length;
      return partial(hit / keys.length);
    }
    case 'ordering': {
      const correct = (q.items || []).map((i) => i.id);
      const given = Array.isArray(ans) ? ans : [];
      if (!correct.length) return res(false);
      const hit = correct.filter((id, i) => given[i] === id).length;
      return partial(hit / correct.length);
    }
    case 'essay':
      return { earned: 0, max, correct: null, needsReview: true };
    default:
      return { earned: 0, max, correct: null, needsReview: true };
  }
}

/* Tên các tệp nghe nằm trong thư mục uploads mà đề này dùng (link ngoài bỏ qua). */
function localAudioFiles(test) {
  return (test.sections || [])
    .map((s) => s.audio && s.audio.url)
    .filter((u) => u && u.startsWith('/uploads/'))
    .map((u) => path.basename(decodeURIComponent(u.slice('/uploads/'.length))));
}

function allQuestions(test) {
  return (test.sections || []).flatMap((s) => s.questions || []);
}

function gradeSubmission(test, answers) {
  const details = {};
  let score = 0, maxScore = 0, needsReview = false;
  for (const q of allQuestions(test)) {
    const r = gradeQuestion(q, answers[q.id]);
    details[q.id] = r;
    score += r.earned;
    maxScore += r.max;
    if (r.needsReview) needsReview = true;
  }
  return {
    details,
    score: Math.round(score * 100) / 100,
    maxScore: Math.round(maxScore * 100) / 100,
    needsReview,
  };
}

/* Xây kết quả trả về học viên: điểm + (đáp án chi tiết nếu đề cho hiện). */
function buildResult(sub, t) {
  const result = {
    id: sub.id, score: sub.score, maxScore: sub.maxScore,
    needsReview: sub.needsReview, late: sub.late,
    percent: sub.maxScore ? Math.round((sub.score / sub.maxScore) * 1000) / 10 : 0,
  };
  if (t.showResultDetail) {
    result.details = sub.details;
    result.key = allQuestions(t).map((q) => ({
      id: q.id, prompt: q.prompt, type: q.type,
      correct: q.correct, answers: q.answers, pairs: q.pairs,
      blanks: q.blanks, items: q.items, options: q.options,
      left: q.left, right: q.right, explanation: q.explanation,
    }));
  }
  return result;
}

/* Bản đề gửi cho học viên: bỏ hết đáp án. */
function sanitizeTest(test) {
  const clone = deepClone(test);
  for (const s of clone.sections || []) {
    for (const q of s.questions || []) {
      delete q.correct; delete q.answers; delete q.pairs; delete q.explanation;
      if (q.type === 'fill_blank') q.blanks = (q.blanks || []).map(() => ({}));
      if (q.type === 'matching') q.right = shuffle(q.right || []);
      if (q.type === 'ordering') q.items = shuffle(q.items || []);
    }
    if (clone.shuffleQuestions) s.questions = shuffle(s.questions || []);
    /* Học viên không bao giờ thấy link gốc — luôn phát qua máy chủ. */
    if (s.audio && s.audio.url) s.audio.url = `/api/audio/${clone.id}/${s.id}`;
  }
  return clone;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------- link nghe từ dịch vụ lưu trữ ---------- */
/* Link chia sẻ của Google Drive / Dropbox trỏ tới trang HTML, không phải tệp
   âm thanh. Hàm này đổi sang địa chỉ tải trực tiếp. */
function directAudioUrl(url) {
  const u = String(url || '').trim();

  const drive = /drive\.google\.com\/(?:file\/d\/([\w-]{10,})|open\?id=([\w-]{10,})|uc\?[^]*id=([\w-]{10,}))/.exec(u);
  if (drive) {
    const id = drive[1] || drive[2] || drive[3];
    return `https://drive.usercontent.google.com/download?id=${id}&export=download`;
  }
  if (/drive\.usercontent\.google\.com\/download/.test(u)) return u;

  if (/dropbox\.com\//.test(u)) {
    return u.replace(/([?&])dl=0/, '$1dl=1').replace(/(\?.*)?$/, m => (m && m.includes('dl=') ? m : (m ? m + '&dl=1' : '?dl=1')));
  }
  if (/onedrive\.live\.com|1drv\.ms/.test(u)) return u.includes('download') ? u : u + '&download=1';
  return u;
}

/* Chặn địa chỉ nội bộ — link chỉ do giáo viên đặt, nhưng vẫn kiểm tra. */
function isPublicHttpUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return false;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  return true;
}

/* Phát tệp nghe: tệp đã tải lên thì đọc từ đĩa, link ngoài thì máy chủ tải hộ
   (tránh lỗi CORS và giấu link gốc với học viên). Hỗ trợ tua từng phần. */
async function streamAudio(req, res, rawUrl) {
  if (rawUrl.startsWith('/uploads/')) {
    return serveStatic(res, UPLOADS, decodeURIComponent(rawUrl.slice('/uploads/'.length)));
  }
  const target = directAudioUrl(rawUrl);
  if (!isPublicHttpUrl(target)) return send(res, 400, 'Link bài nghe không hợp lệ');

  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  let up;
  try {
    up = await fetch(target, { headers, redirect: 'follow' });
  } catch {
    return send(res, 502, 'Không tải được tệp nghe từ link đã cấu hình');
  }
  const type = up.headers.get('content-type') || '';
  if (!up.ok || /text\/html/.test(type)) {
    return send(res, 502,
      'Link không trả về tệp âm thanh. Với Google Drive, hãy đặt quyền "Bất kỳ ai có đường liên kết".');
  }
  const out = { 'Content-Type': type || 'audio/mpeg', 'Accept-Ranges': 'bytes' };
  for (const h of ['content-length', 'content-range']) {
    const v = up.headers.get(h);
    if (v) out[h === 'content-length' ? 'Content-Length' : 'Content-Range'] = v;
  }
  res.writeHead(up.status === 206 ? 206 : 200, out);
  require('stream').Readable.fromWeb(up.body).pipe(res);
}

/* ---------- tiện ích HTTP ---------- */
const send = (res, code, body, headers = {}) => {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body)
      ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(data);
};
const readBody = (req, limit = 40 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Tệp quá lớn')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
const readJson = async (req) => {
  const b = await readBody(req, 8 * 1024 * 1024);
  if (!b.length) return {};
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    /* Dữ liệu gửi đi hỏng: báo 400 rõ ràng thay vì 500 chung chung. */
    const err = new Error('Dữ liệu gửi đi không hợp lệ');
    err.friendly = true;
    throw err;
  }
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.webm': 'audio/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};
function serveStatic(res, base, rel, extraHeaders = {}) {
  const file = path.join(base, rel);
  if (!file.startsWith(base)) return send(res, 403, 'Từ chối');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Không tìm thấy');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      ...extraHeaders,
    });
    res.end(buf);
  });
}

/* ---------- định tuyến ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const api = (m, pattern) => req.method === m && p === pattern;

  try {
    /* --- xác thực --- */
    if (api('POST', '/api/login')) {
      const { password } = await readJson(req);
      if (password !== TEACHER_PASSWORD) return send(res, 401, { error: 'Mật khẩu không đúng' });
      const token = newSession();
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `qs_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`,
      });
    }
    if (api('POST', '/api/logout')) {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'qs_token=; Path=/; Max-Age=0' });
    }
    if (api('GET', '/api/me')) return send(res, 200, { teacher: isTeacher(req) });

    /* --- học viên --- */
    if (api('GET', '/api/tests')) {
      const list = tests().filter((t) => t.published).map((t) => ({
        id: t.id, title: t.title, description: t.description,
        timeLimitMin: t.timeLimitMin,
        questionCount: allQuestions(t).length,
      }));
      return send(res, 200, list);
    }
    if (req.method === 'GET' && /^\/api\/tests\/[\w]+$/.test(p)) {
      const id = p.split('/').pop();
      const t = tests().find((x) => x.id === id);
      if (!t) return send(res, 404, { error: 'Không tìm thấy bài test' });
      if (isTeacher(req) && url.searchParams.get('full') === '1') return send(res, 200, t);
      if (!t.published) return send(res, 403, { error: 'Bài test chưa được mở' });
      const now = Date.now();
      const clean = sanitizeTest(t);
      /* Học viên đếm ngược theo đồng hồ máy chủ (không thể chỉnh bằng trình duyệt). */
      if (t.timeLimitMin) {
        clean.serverNow = new Date(now).toISOString();
        clean.startedAt = new Date(now).toISOString();
        clean.deadline = new Date(now + t.timeLimitMin * 60000).toISOString();
      }
      /* Mỗi lần mở bài là một lượt làm bài riêng — dùng để tránh nộp trùng. */
      clean.submitId = uid();
      return send(res, 200, clean);
    }
    /* Phát bài nghe theo đề + phần thi (link gốc nằm ở máy chủ) */
    if (req.method === 'GET' && /^\/api\/audio\/\w+\/\w+$/.test(p)) {
      const [, , , testId, sectionId] = p.split('/');
      const t = tests().find((x) => x.id === testId);
      const s = t && (t.sections || []).find((x) => x.id === sectionId);
      if (!s || !s.audio || !s.audio.url) return send(res, 404, 'Không có tệp nghe');
      return streamAudio(req, res, s.audio.url);
    }

    if (api('POST', '/api/submit')) {
      const body = await readJson(req);
      const t = tests().find((x) => x.id === body.testId);
      if (!t) return send(res, 404, { error: 'Không tìm thấy bài test' });
      if (!t.published) return send(res, 403, { error: 'Bài test đã đóng' });
      const name = String(body.studentName || '').trim();
      if (!name) return send(res, 400, { error: 'Vui lòng nhập họ tên' });

      /* Nộp gấp / nộp lại trùng: mỗi submitId chỉ lưu một lần (kiểm tra trên dữ
         liệu đã lưu, an toàn khi khởi động lại). "Đọc → kiểm tra trùng → ghi" phải
         nằm trong một khối serialize (mutate) để hai bài nộp đồng thời không đè nhau. */
      const outcome = await mutate(() => {
        const all = subs();
        const dupIndex = body.submitId
          ? all.findIndex((s) => s.submitId === body.submitId && s.testId === t.id)
          : -1;
        if (dupIndex >= 0) {
          /* Đã lưu rồi — trả lại kết quả cũ (idempotent), không tạo bài trùng.
             Vẫn kèm đáp án chi tiết nếu đề cho hiện, để học viên nộp lại vẫn xem được. */
          return { duplicate: true, sub: all[dupIndex] };
        }

        const answers = body.answers || {};
        const g = gradeSubmission(t, answers);

        /* Tự động nộp phải dựa vào đồng hồ máy chủ, không phải trình duyệt.
           Mốc bắt đầu do máy chủ phát (miễn học viên gửi lại giá trị đó), nên
           không bị sai số đồng hồ thiết bị. */
        const limitSec = (t.timeLimitMin || 0) * 60;
        const startedMs = body.startedAt ? Date.parse(body.startedAt) : null;
        const late = computeLate(startedMs, limitSec, SUBMIT_GRACE_MS, Date.now());

        const sub = {
          id: uid(), testId: t.id, testTitle: t.title, submitId: body.submitId || null,
          studentName: name, studentClass: String(body.studentClass || '').trim(),
          startedAt: body.startedAt || null, submittedAt: new Date().toISOString(),
          durationSec: body.durationSec || null,
          audioPlays: body.audioPlays || {}, late, answers, ...g,
        };
        all.push(sub); saveSubs(all);
        return { duplicate: false, sub };
      });

      return send(res, 200, outcome.duplicate
        ? { ...buildResult(outcome.sub, t), duplicate: true }
        : buildResult(outcome.sub, t));
    }

    /* --- giáo viên (yêu cầu đăng nhập) --- */
    if (p.startsWith('/api/admin')) {
      if (!isTeacher(req)) return send(res, 401, { error: 'Chưa đăng nhập' });

      if (api('GET', '/api/admin/tests')) {
        return send(res, 200, tests().map((t) => ({
          id: t.id, title: t.title, published: t.published,
          createdAt: t.createdAt, updatedAt: t.updatedAt,
          questionCount: allQuestions(t).length,
          submissionCount: subs().filter((s) => s.testId === t.id).length,
        })));
      }
      if (api('POST', '/api/admin/tests')) {
        const body = await readJson(req);
        const t = await mutate(() => {
          const now = new Date().toISOString();
          const all = tests();
          if (body.id && all.some((x) => x.id === body.id)) {
            const ex = all.find((x) => x.id === body.id);
            Object.assign(ex, body, { updatedAt: now });
            saveTests(all);
            return ex;
          }
          const nt = { ...body, id: body.id || uid(), createdAt: now, updatedAt: now };
          all.push(nt);
          saveTests(all);
          return nt;
        });
        return send(res, 200, t);
      }
      /* Xoá đề = xoá luôn bài nộp và tệp nghe của riêng đề đó.
         Hai file được ghi trong cùng một khối mutate: không request nào
         đọc/xoá chồng lên nhau. Nếu process chết giữa 2 ghi, bấm "Xoá" lại
         vẫn chạy được (idempotent) — không cần khôi phục tay. */
      if (req.method === 'DELETE' && /^\/api\/admin\/tests\/\w+$/.test(p)) {
        const id = p.split('/').pop();
        const outcome = await mutate(() => {
          const all = tests();
          const target = all.find((t) => t.id === id);
          if (!target) return { notFound: true };

          const remaining = all.filter((t) => t.id !== id);

          /* Tệp nghe: chỉ xoá tệp không còn đề nào khác dùng tới. */
          const stillUsed = new Set(remaining.flatMap(localAudioFiles));
          const removedFiles = [];
          for (const name of new Set(localAudioFiles(target))) {
            if (stillUsed.has(name)) continue;
            try { fs.unlinkSync(path.join(UPLOADS, name)); removedFiles.push(name); }
            catch { /* tệp đã bị xoá tay từ trước */ }
          }

          const before = subs();
          const keptSubs = before.filter((s) => s.testId !== id);
          const removedSubs = before.length - keptSubs.length;

          saveSubs(keptSubs);
          saveTests(remaining);
          return { removedSubs, removedFiles };
        });
        if (outcome.notFound) return send(res, 404, { error: 'Không tìm thấy bài test' });
        return send(res, 200, { ok: true, removedSubmissions: outcome.removedSubs, removedFiles: outcome.removedFiles });
      }
      /* Thống kê theo câu hỏi: câu nào sai nhiều nhất — để biết dạy lại chỗ nào.
         Trung bình chỉ tính bài đã chấm; câu chờ chấm tay (needsReview) chưa
         tính vào điểm trung bình mà được đếm riêng ở pendingReview.
         Lưu ý: endpoint chỉ đọc (GET) nên không cần vào hàng đợi mutate —
         store.write dùng ghi atomic (tmp → rename) nên mỗi lần đọc luôn thấy
         snapshot nhất quán, không đọc dở giữa chừng. */
      if (req.method === 'GET' && /^\/api\/admin\/tests\/\w+\/stats$/.test(p)) {
        const id = p.split('/')[4];
        const t = tests().find((x) => x.id === id);
        if (!t) return send(res, 404, { error: 'Không tìm thấy bài test' });
        const list = subs().filter((s) => s.testId === id);
        const sectionOf = (qid) =>
          ((t.sections || []).find((s) => (s.questions || []).some((q) => q.id === qid)) || {}).title || '';
        const questions = allQuestions(t).map((q) => {
          const max = Number(q.points) || 1;
          /* earned/max được ghi theo điểm thời điểm chấm (d.max) — nếu giáo viên
             sửa điểm câu hỏi sau khi học viên nộp, thống kê vẫn đúng. */
          let earnedSum = 0, denomSum = 0, graded = 0, wrong = 0, pending = 0;
          for (const s of list) {
            const d = s.details && s.details[q.id];
            if (!d) continue;
            if (d.needsReview) { pending++; continue; }
            graded++;
            const dm = d.max != null ? d.max : max;
            earnedSum += d.earned || 0;
            denomSum += dm;
            if ((d.earned || 0) < dm) wrong++;
          }
          return {
            id: q.id, type: q.type, points: max, prompt: q.prompt,
            sectionTitle: sectionOf(q.id),
            /* attempts = số bài thực sự chứa câu này (graded+pending), không phải
               list.length — tránh lệch khi câu được thêm sau khi đã có bài nộp
               cũ không chứa câu đó. */
            attempts: graded + pending,
            graded,
            avgPercent: denomSum > 0 ? Math.round(earnedSum / denomSum * 1000) / 10 : null,
            wrongCount: wrong,
            pendingReview: pending,
          };
        });
        return send(res, 200, { testId: id, title: t.title, submissionCount: list.length, questions });
      }
      /* Số liệu để hỏi xác nhận trước khi xoá */
      if (req.method === 'GET' && /^\/api\/admin\/tests\/\w+\/impact$/.test(p)) {
        const id = p.split('/')[4];
        const t = tests().find((x) => x.id === id);
        if (!t) return send(res, 404, { error: 'Không tìm thấy bài test' });
        const others = new Set(tests().filter((x) => x.id !== id).flatMap(localAudioFiles));
        return send(res, 200, {
          title: t.title,
          submissions: subs().filter((s) => s.testId === id).length,
          files: [...new Set(localAudioFiles(t))].filter((f) => !others.has(f)).length,
        });
      }
      if (api('GET', '/api/admin/submissions')) {
        const testId = url.searchParams.get('testId');
        let list = subs();
        if (testId) list = list.filter((s) => s.testId === testId);
        return send(res, 200, list.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1)));
      }
      /* xoá nhiều bài nộp cùng lúc: { ids: ['id1', 'id2', ...] } */
      if (api('POST', '/api/admin/submissions/batch-delete')) {
        const { ids } = await readJson(req);
        if (!Array.isArray(ids) || !ids.length) return send(res, 400, { error: 'Thiếu danh sách ID' });
        const idSet = new Set(ids.map(String));
        let deleted = 0;
        await mutate(() => {
          const all = subs();
          const keep = all.filter((s) => !idSet.has(s.id));
          deleted = all.length - keep.length;
          saveSubs(keep);
        });
        return send(res, 200, { ok: true, deleted });
      }
      if (req.method === 'DELETE' && /^\/api\/admin\/submissions\/\w+$/.test(p)) {
        const id = p.split('/').pop();
        await mutate(() => saveSubs(subs().filter((s) => s.id !== id)));
        return send(res, 200, { ok: true });
      }
      /* chấm tay: {submissionId, questionId, earned} */
      if (api('POST', '/api/admin/grade')) {
        const { submissionId, questionId, earned } = await readJson(req);
        const outcome = await mutate(() => {
          const all = subs();
          const s = all.find((x) => x.id === submissionId);
          if (!s) return { notFound: 'sub' };
          const d = s.details && s.details[questionId];
          if (!d) return { notFound: 'q' };
          d.earned = Math.max(0, Math.min(Number(earned) || 0, d.max));
          d.needsReview = false;
          d.correct = d.earned === d.max;
          s.score = Math.round(Object.values(s.details).reduce((a, x) => a + x.earned, 0) * 100) / 100;
          s.needsReview = Object.values(s.details).some((x) => x.needsReview);
          saveSubs(all);
          return { score: s.score, needsReview: s.needsReview };
        });
        if (outcome.notFound === 'sub') return send(res, 404, { error: 'Không tìm thấy bài làm' });
        if (outcome.notFound === 'q') return send(res, 404, { error: 'Không tìm thấy câu hỏi' });
        return send(res, 200, outcome);
      }
      if (api('GET', '/api/admin/export')) {
        const testId = url.searchParams.get('testId');
        const list = subs().filter((s) => !testId || s.testId === testId);
        const rows = [['Họ tên', 'Lớp', 'Bài test', 'Điểm', 'Tổng điểm', '%', 'Muộn', 'Nộp lúc', 'Thời gian (phút)']];
        for (const s of list) {
          rows.push([s.studentName, s.studentClass || '', s.testTitle, s.score, s.maxScore,
            s.maxScore ? Math.round((s.score / s.maxScore) * 1000) / 10 : 0,
            s.late ? 'Có' : '',
            s.submittedAt, s.durationSec ? Math.round(s.durationSec / 60) : '']);
        }
        const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
        return send(res, 200, csv, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="ket-qua.csv"',
        });
      }
      /* tải tệp nghe: body nhị phân, tên tệp ở header X-Filename */
      if (api('POST', '/api/admin/upload')) {
        let raw = String(req.headers['x-filename'] || 'audio');
        try { raw = decodeURIComponent(raw); } catch { /* giữ nguyên nếu không mã hoá */ }
        const ext = (path.extname(raw) || '.mp3').toLowerCase().slice(0, 6);
        const name = uid() + ext;
        const buf = await readBody(req);
        fs.writeFileSync(path.join(UPLOADS, name), buf);
        return send(res, 200, { url: '/uploads/' + name });
      }
      return send(res, 404, { error: 'Không có endpoint này' });
    }

    /* --- tệp tĩnh --- */
    if (p.startsWith('/uploads/')) return serveStatic(res, UPLOADS, p.slice('/uploads/'.length));
    /* Tệp mẫu: /mau-de.md và /templates/<tên>.md — thêm ?tai=1 để tải về máy */
    if (p === '/mau-de.md' || /^\/templates\/[\w.-]+\.md$/.test(p)) {
      const name = path.basename(p === '/mau-de.md' ? 'mau-de.md' : p);
      const headers = url.searchParams.get('tai')
        ? { 'Content-Disposition': `attachment; filename="${name}"` } : {};
      return serveStatic(res, path.join(ROOT, 'templates'), name, headers);
    }
    if (api('GET', '/api/templates')) {
      const files = fs.readdirSync(path.join(ROOT, 'templates')).filter((f) => f.endsWith('.md'));
      const nhan = {
        'mau-de.md': 'Mẫu trắng — đủ 8 dạng câu hỏi kèm chú thích',
        'de-tv-so-cap-1.md': 'Tiếng Việt sơ cấp 1 — Chào hỏi và giới thiệu',
        'de-tv-so-cap-2.md': 'Tiếng Việt sơ cấp 2 — Số đếm, thời gian, mua sắm',
        'de-tv-so-cap-3.md': 'Tiếng Việt sơ cấp 3 — Thanh điệu và phát âm',
        'de-tv-trung-cap-1.md': 'Trung cấp thấp 1 — Ngữ pháp và đọc hiểu',
        'de-tv-trung-cap-2.md': 'Trung cấp thấp 2 — Giao tiếp và tình huống',
      };
      return send(res, 200, files.map((f) => ({ file: f, label: nhan[f] || f })));
    }
    /* Trình duyệt cũ vẫn tự xin /favicon.ico — trả về icon SVG thay vì 404 */
    if (p === '/favicon.ico') return serveStatic(res, PUBLIC, 'favicon.svg');
    if (p === '/') return serveStatic(res, PUBLIC, 'index.html');
    return serveStatic(res, PUBLIC, p.replace(/^\//, ''));
  } catch (e) {
    /* Lỗi có thông báo thân thiện (ví dụ JSON hỏng) trả 400, phần còn lại vẫn là 500. */
    if (e && e.friendly) return send(res, 400, { error: e.message });
    return send(res, 500, { error: e.message });
  }
});

/* Cho phép require trong test mà không tự động mở cổng. */
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Hệ thống thi đang chạy: http://localhost:${PORT}`);
    console.log(`Trang giáo viên: http://localhost:${PORT}/admin.html (mật khẩu: ${TEACHER_PASSWORD})`);
  });
}

module.exports = {
  server, computeLate, gradeQuestion, gradeSubmission, sanitizeTest,
  directAudioUrl, isPublicHttpUrl, mutate, store,
};
