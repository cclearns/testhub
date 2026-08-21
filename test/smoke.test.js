/* Kiểm tra tự động không phụ thuộc thư viện ngoài (dùng node:test có sẵn).
   Chạy: npm test  (hoặc: node --test) */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* Chạy test trên thư mục dữ liệu riêng, không động vào dữ liệu thật. */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-test-'));
process.env.TEST_DATA_DIR = path.join(tmpDir, 'data');
process.env.TEST_UPLOADS_DIR = path.join(tmpDir, 'uploads');

const mod = require('../server.js');
const { computeLate, gradeQuestion, sanitizeTest } = mod;

/* ---------------- Pure: computeLate ---------------- */
test('computeLate: không muộn khi chưa hết giờ', () => {
  const now = Date.now();
  assert.equal(computeLate(now - 5 * 60000, 30 * 60, 60000, now), false);
});
test('computeLate: muộn khi quá giờ + thời gian cho phép', () => {
  const now = Date.now();
  assert.equal(computeLate(now - 40 * 60000, 30 * 60, 60000, now), true);
});
test('computeLate: không muộn khi không có giờ hoặc không có mốc bắt đầu', () => {
  const now = Date.now();
  assert.equal(computeLate(null, 30 * 60, 60000, now), false);   // không mốc bắt đầu
  assert.equal(computeLate(now, 0, 60000, now), false);          // không giới hạn giờ
});

/* ---------------- Pure: gradeQuestion ---------------- */
test('gradeQuestion: trắc nghiệm đúng đủ điểm', () => {
  const q = { type: 'multiple_choice', points: 2, correct: ['a', 'b'] };
  const r = gradeQuestion(q, ['a', 'b']);
  assert.equal(r.earned, 2);
  assert.equal(r.correct, true);
  assert.equal(r.needsReview, false);
});
test('gradeQuestion: đúng/sai', () => {
  const q = { type: 'true_false', points: 1, correct: 'true' };
  assert.equal(gradeQuestion(q, 'true').earned, 1);
  assert.equal(gradeQuestion(q, 'false').earned, 0);
});
test('gradeQuestion: điền khuyết chấm từng phần', () => {
  const q = { type: 'fill_blank', points: 2, blanks: [{ answers: ['came'] }, { answers: ['arrived'] }] };
  assert.equal(gradeQuestion(q, ['came', 'nope']).earned, 1); // 1/2 đúng -> 1 điểm
});
test('gradeQuestion: tự luận cần chấm tay', () => {
  const q = { type: 'essay', points: 5 };
  const r = gradeQuestion(q, 'x');
  assert.equal(r.needsReview, true);
  assert.equal(r.correct, null);
});
test('sanitizeTest: loại đáp án nhưng giữ cấu trúc', () => {
  const t = {
    id: 't1', timeLimitMin: 10,
    sections: [{ id: 's1', questions: [{ id: 'q1', type: 'true_false', correct: 'true', explanation: 'e' }] }],
  };
  const s = sanitizeTest(t);
  assert.equal(s.sections[0].questions[0].correct, undefined);
  assert.equal(s.sections[0].questions[0].explanation, undefined);
  assert.equal(s.sections[0].questions[0].id, 'q1');
});

/* ---------------- Integration: server HTTP ---------------- */
test('nộp trùng chỉ lưu 1 bài, đánh dấu muộn, JSON hỏng trả 400', async (t) => {
  const httpServer = mod.server;
  await new Promise((resolve) => httpServer.listen(0, resolve));
  t.after(() => new Promise((r) => httpServer.close(r)));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const jar = {};

  const req = async (method, path, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (jar.token) headers.Cookie = 'qs_token=' + jar.token;
    const res = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /qs_token=([a-f0-9]+)/.exec(set);
      if (m) jar.token = m[1];
    }
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  };

  // đăng nhập
  let r = await req('POST', '/api/login', { password: 'minmin' });
  assert.equal(r.status, 200, 'login phải thành công');

  // tạo đề
  r = await req('POST', '/api/admin/tests', {
    title: 'Test Dedup',
    timeLimitMin: 30,
    published: true,
    showResultDetail: true,
    sections: [{
      id: 's1', title: 'Phần 1', instructions: '', passage: '', audio: null,
      questions: [{ id: 'q1', type: 'true_false', prompt: '2+2=4', points: 1, explanation: '', correct: 'true' }],
    }],
  });
  assert.equal(r.status, 200);
  const testId = r.body.id;

  // mở bài học viên -> máy chủ phát startedAt/deadline/submitId
  const student = await fetch(`${base}/api/tests/${testId}`).then((x) => x.json());
  assert.ok(student.startedAt, 'máy chủ phải phát mốc bắt đầu');
  assert.ok(student.deadline, ' máy chủ phải phát deadline');
  const submitId = student.submitId;
  const gap = Math.abs(Date.parse(student.deadline) - Date.parse(student.startedAt)) / 1000;
  assert.ok(gap >= 1799 && gap <= 1801, 'deadline - startedAt ≈ 30 phút');

  // nộp cùng một submitId hai lần -> lần hai là duplicate, cùng id
  const body = { testId, submitId, studentName: 'An', startedAt: student.startedAt, answers: { q1: 'true' } };
  const s1 = await req('POST', '/api/submit', body);
  const s2 = await req('POST', '/api/submit', body);
  assert.equal(s1.status, 200);
  assert.equal(s2.body.duplicate, true, 'nộp trùng phải báo duplicate');
  assert.equal(s2.body.id, s1.body.id, 'nộp trùng phải trả cùng bài');
  // (fix 1) phản hồi trùng phải kèm đáp án chi tiết để học viên xem được
  assert.ok(Array.isArray(s2.body.key), 'phản hồi trùng phải kèm key (đáp án chi tiết)');
  assert.equal(s2.body.key.length, 1, 'key phải có đáp án của câu hỏi');
  assert.equal(s2.body.score, s1.body.score, 'nộp trùng không đổi điểm');

  // chỉ có 1 bài nộp
  const subs = await req('GET', '/api/admin/submissions?testId=' + testId);
  assert.equal(subs.body.length, 1, 'chỉ nên có một bài nộp');

  // nộp muộn (bắt đầu từ 40 phút trước, giới hạn 30 phút) -> late
  const lateRes = await req('POST', '/api/submit', { ...body, submitId: 'late-only', startedAt: new Date(Date.now() - 40 * 60000).toISOString() });
  assert.equal(lateRes.body.late, true, 'nộp quá giờ phải đánh dấu muộn');

  // JSON hỏng -> 400
  const bad = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json',
  });
  assert.equal(bad.status, 400, 'JSON hỏng phải trả 400');

  // dọn bài test
  await req('DELETE', '/api/admin/submissions/' + s1.body.id);
  await req('DELETE', '/api/admin/submissions/' + lateRes.body.id);
  await req('DELETE', '/api/admin/tests/' + testId);
});

/* ---------------- mutate: serialize "đọc → sửa → ghi" ---------------- */
test('mutate: 50 thao tác đồng thời — không mất bản ghi', async () => {
  const { mutate, store } = mod;
  const N = 50;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  await Promise.all(Array.from({ length: N }, (_, i) => mutate(async () => {
    const arr = store.read('conc-test', []);
    await tick(); /* khoảng giữa đọc và ghi — nơi hai thao tác đè nhau nếu không serialize */
    arr.push(i);
    store.write('conc-test', arr);
  })));
  assert.equal(store.read('conc-test', []).length, N, 'mọi bản ghi phải được giữ');
});

/* ---------------- Integration: nộp đồng thời ---------------- */
test('API: cả lớp nộp cùng lúc — không mất bài, không trùng bài', async (t) => {
  const httpServer = mod.server;
  await new Promise((resolve) => httpServer.listen(0, resolve));
  t.after(() => new Promise((r) => httpServer.close(r)));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const jar = {};
  const req = async (method, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (jar.token) headers.Cookie = 'qs_token=' + jar.token;
    const res = await fetch(base + p, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) { const m = /qs_token=([a-f0-9]+)/.exec(set); if (m) jar.token = m[1]; }
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const login = await req('POST', '/api/login', { password: 'minmin' });
  assert.equal(login.status, 200);

  const created = await req('POST', '/api/admin/tests', {
    title: 'Thi đồng thời', timeLimitMin: 30, published: true,
    sections: [{
      id: 's1', title: 'P1',
      questions: [{ id: 'q1', type: 'true_false', prompt: '2+2=4', points: 2, correct: 'true' }],
    }],
  });
  const testId = created.body.id;

  /* 30 học viên nộp cùng một khoảnh khắc — mô phỏng cả lớp nộp khi hết giờ. */
  const N = 30;
  const resps = await Promise.all(Array.from({ length: N }, (_, i) =>
    req('POST', '/api/submit', {
      testId, studentName: 'HS' + i, submitId: 'sub' + i,
      answers: { q1: i % 2 ? 'true' : 'false' },
    })));
  assert.ok(resps.every((r) => r.status === 200), 'mọi bài nộp phải thành công');
  assert.equal(new Set(resps.map((r) => r.body.id)).size, N, 'mỗi phản hồi phải là một bài riêng');

  const list = await req('GET', '/api/admin/submissions?testId=' + testId);
  assert.equal(list.body.length, N, 'không bài nào bị mất');

  /* Nộp lại cùng submitId: idempotent — không tạo bài trùng. */
  const again = await req('POST', '/api/submit', {
    testId, studentName: 'HS0', submitId: 'sub0', answers: { q1: 'true' },
  });
  assert.equal(again.body.duplicate, true, 'nộp lại phải báo duplicate');
  const list2 = await req('GET', '/api/admin/submissions?testId=' + testId);
  assert.equal(list2.body.length, N, 'nộp lại không được tạo bài mới');

  /* Xoá đề xoá luôn 30 bài nộp theo. */
  const del = await req('DELETE', '/api/admin/tests/' + testId);
  assert.equal(del.body.removedSubmissions, N);
});

/* ---------------- Integration: thống kê theo câu hỏi ---------------- */
test('API: thống kê theo câu hỏi — sai nhiều, chờ chấm tay, chấm tay', async (t) => {
  const httpServer = mod.server;
  await new Promise((resolve) => httpServer.listen(0, resolve));
  t.after(() => new Promise((r) => httpServer.close(r)));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const jar = {};
  const req = async (method, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (jar.token) headers.Cookie = 'qs_token=' + jar.token;
    const res = await fetch(base + p, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) { const m = /qs_token=([a-f0-9]+)/.exec(set); if (m) jar.token = m[1]; }
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const login = await req('POST', '/api/login', { password: 'minmin' });
  assert.equal(login.status, 200);

  const created = await req('POST', '/api/admin/tests', {
    title: 'Thi thống kê', timeLimitMin: 0, published: true,
    sections: [{
      id: 's1', title: 'P1',
      questions: [
        { id: 'qa', type: 'true_false', prompt: 'Câu A', points: 1, correct: 'true' },
        { id: 'qb', type: 'true_false', prompt: 'Câu B', points: 1, correct: 'true' },
        { id: 'qc', type: 'essay', prompt: 'Câu C', points: 2 },
      ],
    }],
  });
  const testId = created.body.id;

  const answers = [
    { qa: 'true', qb: 'false', qc: 'đáp của S0' },
    { qa: 'true', qb: 'false', qc: 'đáp của S1' },
    { qa: 'false', qb: 'false', qc: 'đáp của S2' },
  ];
  const subIds = [];
  for (let i = 0; i < answers.length; i++) {
    const r = await req('POST', '/api/submit', {
      testId, studentName: 'S' + i, submitId: 'st' + i, answers: answers[i],
    });
    assert.equal(r.status, 200);
    subIds.push(r.body.id);
  }

  /* Chưa đăng nhập -> 401 */
  const anon = await fetch(base + '/api/admin/tests/' + testId + '/stats');
  assert.equal(anon.status, 401, 'thống kê phải yêu cầu đăng nhập');

  const st = (await req('GET', '/api/admin/tests/' + testId + '/stats')).body;
  assert.equal(st.submissionCount, 3);
  const qa = st.questions.find((q) => q.id === 'qa');
  const qb = st.questions.find((q) => q.id === 'qb');
  const qc = st.questions.find((q) => q.id === 'qc');
  assert.equal(qa.attempts, 3);
  assert.equal(qa.avgPercent, 66.7, '2/3 bài đúng -> 66,7%');
  assert.equal(qa.wrongCount, 1);
  assert.equal(qb.avgPercent, 0, 'tất cả sai -> 0%');
  assert.equal(qb.wrongCount, 3);
  /* Tự luận chưa chấm: không tính vào trung bình, đếm riêng ở pendingReview. */
  assert.equal(qc.pendingReview, 3);
  assert.equal(qc.avgPercent, null);
  assert.equal(qc.wrongCount, 0);

  /* Chấm tay S0 được 2/2 -> trung bình câu C tính trên 1 bài đã chấm. */
  const g = await req('POST', '/api/admin/grade', {
    submissionId: subIds[0], questionId: 'qc', earned: 2,
  });
  assert.equal(g.status, 200);
  const st2 = (await req('GET', '/api/admin/tests/' + testId + '/stats')).body;
  const qc2 = st2.questions.find((q) => q.id === 'qc');
  assert.equal(qc2.pendingReview, 2);
  assert.equal(qc2.avgPercent, 100);
  assert.equal(qc2.wrongCount, 0);

  /* Sửa điểm câu hỏi SAU khi nộp: thống kê vẫn theo điểm thời điểm chấm. */
  const full = (await req('GET', '/api/tests/' + testId + '?full=1')).body;
  full.sections[0].questions[0].points = 2; /* qa: 1 -> 2 */
  const upd = await req('POST', '/api/admin/tests', full);
  assert.equal(upd.status, 200);
  const st3 = (await req('GET', '/api/admin/tests/' + testId + '/stats')).body;
  const qa3 = st3.questions.find((q) => q.id === 'qa');
  assert.equal(qa3.avgPercent, 66.7, 'trung bình phải theo max lúc chấm (1đ), không phải điểm mới (2đ)');

  /* Đề không tồn tại -> 404 */
  const missing = await req('GET', '/api/admin/tests/khongtontai/stats');
  assert.equal(missing.status, 404);

  await req('DELETE', '/api/admin/tests/' + testId);
});

const { after } = require('node:test');
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
