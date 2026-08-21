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

const { after } = require('node:test');
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
