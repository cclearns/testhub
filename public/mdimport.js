/* Bộ đọc đề viết bằng Markdown.
   Cú pháp đầy đủ nằm trong quiz/templates/mau-de.md — hàm dưới đây là bản cài đặt.
   parseMarkdownTest(md) → { test, errors, warnings } */

const MD_TYPES = {
  'trắc nghiệm': 'multiple_choice',
  'trac nghiem': 'multiple_choice',
  'mc': 'multiple_choice',
  'nhiều đáp án': 'multiple_choice_multi',
  'nhieu dap an': 'multiple_choice_multi',
  'multi': 'multiple_choice_multi',
  'đúng/sai': 'true_false',
  'dung/sai': 'true_false',
  'đúng sai': 'true_false',
  'tf': 'true_false',
  'điền khuyết': 'fill_blank',
  'dien khuyet': 'fill_blank',
  'điền vào chỗ trống': 'fill_blank',
  'fill': 'fill_blank',
  'trả lời ngắn': 'short_answer',
  'tra loi ngan': 'short_answer',
  'short': 'short_answer',
  'nối cặp': 'matching',
  'noi cap': 'matching',
  'nối': 'matching',
  'match': 'matching',
  'sắp xếp': 'ordering',
  'sap xep': 'ordering',
  'order': 'ordering',
  'tự luận': 'essay',
  'tu luan': 'essay',
  'essay': 'essay',
};

const mdId = () => Math.random().toString(16).slice(2, 10);

/* `> khoá: giá trị` → ['khoá', 'giá trị'] (khoá đã bỏ dấu, viết thường) */
function metaLine(line) {
  const m = /^>\s*([^:]{1,40}):\s*(.*)$/.exec(line);
  if (!m) return null;
  const key = m[1].trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  return [key, m[2].trim()];
}

/* Chỉ những khoá này mới được coi là thuộc tính; mọi dòng `>` khác nằm trong
   bài đọc đều là nội dung (ví dụ hội thoại "> B: Hai trăm nghìn đồng."). */
const MD_KEYS = new Set([
  'thoi gian', 'mo ta', 'hien dap an', 'xao tron', 'mo cho hoc vien', 'cong khai',
  'huong dan', 'audio', 'bai nghe', 'so lan nghe', 'luot nghe', 'bai doc', 'doan van',
  'dap an', 'cau', 'noi dung', 'giai thich', 'diem', 'phan biet hoa thuong',
]);

const isYes = v => /^(có|co|yes|true|1|x|bật|bat)$/i.test(v.trim());
const splitAlts = v => v.split('|').map(x => x.trim()).filter(Boolean);

function parseMarkdownTest(md) {
  const errors = [], warnings = [];
  const test = {
    title: '', description: '', timeLimitMin: 0, published: false,
    showResultDetail: true, shuffleQuestions: false, sections: [],
  };
  let section = null, q = null, passageMode = false, inComment = false;

  const lines = String(md).replace(/\r/g, '').split('\n');

  const flushQ = () => {
    if (!q) return;
    finishQuestion(q, errors);
    section.questions.push(q);
    q = null;
  };
  const ensureSection = () => {
    if (!section) {
      section = { id: mdId(), title: 'Phần 1', instructions: '', passage: '', audio: null, questions: [] };
      test.sections.push(section);
    }
    return section;
  };

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const line = raw.trim();
    const at = ` (dòng ${n + 1})`;

    /* Ghi chú HTML, kể cả loại trải nhiều dòng */
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    if (line.startsWith('<!--')) { if (!line.includes('-->')) inComment = true; continue; }

    if (!line) { passageMode = false; continue; }

    /* Bài đọc nhiều dòng: mọi dòng `>` liền sau `> Bài đọc:` */
    const asMeta = metaLine(line);
    if (passageMode && line.startsWith('>') && !(asMeta && MD_KEYS.has(asMeta[0]))) {
      const text = line.replace(/^>\s?/, '').trim();
      if (!text) { section.passage += '\n\n'; continue; }   /* "> " trống = sang đoạn mới */
      /* Xuống dòng khi soạn thảo không phải ngắt dòng thật: nối lại thành đoạn.
         Riêng lượt thoại ("A: …") thì giữ mỗi lượt một dòng. */
      const newTurn = /^[A-ZĐ][\wÀ-ỹ ]{0,14}:\s/.test(text);
      const sep = !section.passage ? '' : (newTurn || section.passage.endsWith('\n\n') ? '\n' : ' ');
      section.passage += sep + text;
      continue;
    }

    /* ── Tiêu đề đề thi ── */
    if (/^#\s+/.test(line)) {
      flushQ();
      test.title = line.replace(/^#\s+/, '').trim();
      continue;
    }

    /* ── Phần thi ── */
    if (/^##\s+/.test(line)) {
      flushQ();
      section = { id: mdId(), title: line.replace(/^##\s+/, '').trim(),
        instructions: '', passage: '', audio: null, questions: [] };
      test.sections.push(section);
      passageMode = false;
      continue;
    }

    /* ── Câu hỏi ── */
    if (/^###\s+/.test(line)) {
      flushQ();
      ensureSection();
      const head = line.replace(/^###\s+/, '');
      const m = /^\[([^\]]+)\]\s*(?:\(([\d.,]+)\s*(?:đ|d|điểm|diem|pts?)?\))?\s*(.*)$/i.exec(head);
      if (!m) {
        errors.push(`Câu hỏi thiếu dấu [dạng câu hỏi]${at}: "${head.slice(0, 40)}"`);
        continue;
      }
      const typeKey = m[1].trim().toLowerCase();
      const type = MD_TYPES[typeKey];
      if (!type) {
        errors.push(`Không nhận ra dạng câu hỏi "[${m[1]}]"${at}`);
        continue;
      }
      q = {
        id: mdId(),
        type: type === 'multiple_choice_multi' ? 'multiple_choice' : type,
        multiple: type === 'multiple_choice_multi' || undefined,
        prompt: m[3].trim(),
        points: m[2] ? Number(String(m[2]).replace(',', '.')) : 1,
        explanation: '',
        _line: n + 1,
      };
      if (q.type === 'multiple_choice') { q.options = []; q.correct = []; }
      if (q.type === 'fill_blank') { q.text = ''; q.blanks = []; }
      if (q.type === 'short_answer') { q.answers = []; q.caseSensitive = false; }
      if (q.type === 'matching') { q.left = []; q.right = []; q.pairs = {}; }
      if (q.type === 'ordering') q.items = [];
      passageMode = false;
      continue;
    }

    /* ── Dòng metadata `> khoá: giá trị` ── */
    const meta = metaLine(line);
    if (meta) {
      const [key, val] = meta;
      if (q) {
        switch (key) {
          case 'dap an': applyAnswer(q, val, errors, at); break;
          case 'cau': case 'noi dung': q.text = val; break;
          case 'giai thich': q.explanation = val; break;
          case 'phan biet hoa thuong': q.caseSensitive = isYes(val); break;
          case 'diem': q.points = Number(val.replace(',', '.')) || 1; break;
          default: warnings.push(`Bỏ qua thuộc tính lạ "${key}"${at}`);
        }
        continue;
      }
      if (section) {
        switch (key) {
          case 'huong dan': section.instructions = val; break;
          case 'audio': case 'bai nghe':
            section.audio = { url: val, maxPlays: (section.audio && section.audio.maxPlays) || 1 };
            break;
          case 'so lan nghe': case 'luot nghe':
            section.audio = section.audio || { url: '', maxPlays: 1 };
            section.audio.maxPlays = Math.max(1, Number(val) || 1);
            break;
          case 'bai doc': case 'doan van':
            section.passage = val;
            passageMode = true;
            break;
          default: warnings.push(`Bỏ qua thuộc tính lạ "${key}"${at}`);
        }
        continue;
      }
      switch (key) {
        case 'thoi gian': test.timeLimitMin = Number(String(val).replace(/\D/g, '')) || 0; break;
        case 'mo ta': test.description = val; break;
        case 'hien dap an': test.showResultDetail = isYes(val); break;
        case 'xao tron': test.shuffleQuestions = isYes(val); break;
        case 'mo cho hoc vien': case 'cong khai': test.published = isYes(val); break;
        default: warnings.push(`Bỏ qua thuộc tính lạ "${key}"${at}`);
      }
      continue;
    }

    /* ── Lựa chọn `- ...` ── */
    if (/^[-*]\s+/.test(line)) {
      if (!q) { warnings.push(`Dòng lựa chọn nằm ngoài câu hỏi${at}`); continue; }
      const body = line.replace(/^[-*]\s+/, '');
      if (q.type === 'multiple_choice') {
        const mk = /^\[([ xX])\]\s*(.*)$/.exec(body);
        const text = mk ? mk[2].trim() : body.trim();
        const opt = { id: mdId(), text };
        q.options.push(opt);
        if (mk && mk[1].toLowerCase() === 'x') q.correct.push(opt.id);
      } else if (q.type === 'matching') {
        const parts = body.split(/\s*(?:=|->|→)\s*/);
        if (parts.length < 2) { errors.push(`Cặp nối thiếu dấu "="${at}`); continue; }
        const l = { id: mdId(), text: parts[0].trim() };
        const r = { id: mdId(), text: parts[1].trim() };
        q.left.push(l); q.right.push(r); q.pairs[l.id] = r.id;
      } else if (q.type === 'ordering') {
        q.items.push({ id: mdId(), text: body.trim() });
      } else {
        warnings.push(`Dạng "${q.type}" không dùng danh sách gạch đầu dòng${at}`);
      }
      continue;
    }

    /* ── Mục đánh số `1. ...` — dùng cho dạng sắp xếp ── */
    if (/^\d+[.)]\s+/.test(line)) {
      if (q && q.type === 'ordering') {
        q.items.push({ id: mdId(), text: line.replace(/^\d+[.)]\s+/, '').trim() });
      } else if (q) {
        warnings.push(`Mục đánh số chỉ dùng cho dạng [Sắp xếp]${at}`);
      }
      continue;
    }

    /* ── Dòng chữ thường: nối vào câu hỏi hoặc mô tả đề ── */
    if (q) q.prompt += (q.prompt ? ' ' : '') + line;
    else if (section) section.instructions += (section.instructions ? ' ' : '') + line;
    else test.description += (test.description ? ' ' : '') + line;
  }
  flushQ();

  /* ── Kiểm tra tổng thể ── */
  if (!test.title) errors.push('Thiếu tên đề — dòng đầu tiên phải là "# Tên đề".');
  const total = test.sections.reduce((a, s) => a + s.questions.length, 0);
  if (!total) errors.push('Đề chưa có câu hỏi nào.');
  test.sections.forEach(s => {
    if (s.audio && !s.audio.url)
      errors.push(`Phần "${s.title}" khai báo số lần nghe nhưng thiếu "> Audio: <đường dẫn>".`);
  });

  return { test, errors, warnings, questionCount: total };
}

/* `> Đáp án: ...` — ý nghĩa tuỳ theo dạng câu hỏi */
function applyAnswer(q, val, errors, at) {
  switch (q.type) {
    case 'true_false':
      q.correct = /^(đúng|dung|true|đ|t|yes)$/i.test(val.trim()) ? 'true' : 'false';
      break;
    case 'fill_blank':
      q.blanks.push({ answers: splitAlts(val), caseSensitive: false });
      break;
    case 'short_answer':
      q.answers = splitAlts(val);
      break;
    case 'multiple_choice': {
      /* cho phép "> Đáp án: B" hoặc "> Đáp án: A, C" thay cho dấu [x] */
      const wanted = val.split(/[,\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
      q._letterAnswers = wanted;
      break;
    }
    default:
      errors.push(`Dạng câu hỏi này không dùng "> Đáp án:"${at}`);
  }
}

/* Chốt câu hỏi: chuyển đáp án dạng chữ cái, kiểm tra thiếu sót */
function finishQuestion(q, errors) {
  const where = ` (dòng ${q._line})`;
  if (q.type === 'multiple_choice') {
    if (q._letterAnswers) {
      for (const letter of q._letterAnswers) {
        const idx = letter.charCodeAt(0) - 65;
        if (q.options[idx]) q.correct.push(q.options[idx].id);
        else errors.push(`Không có lựa chọn "${letter}"${where}`);
      }
    }
    if (!q.options.length) errors.push(`Câu trắc nghiệm chưa có lựa chọn nào${where}`);
    else if (!q.correct.length) errors.push(`Câu trắc nghiệm chưa đánh dấu đáp án đúng ([x] hoặc "> Đáp án:")${where}`);
    if (q.correct.length > 1) q.multiple = true;
    q.multiple = !!q.multiple;
  }
  if (q.type === 'fill_blank') {
    const holes = (q.text.match(/_{2,}/g) || []).length;
    if (!q.text) errors.push(`Dạng điền khuyết thiếu "> Câu: ..."${where}`);
    else if (!holes) errors.push(`Câu điền khuyết chưa có chỗ trống "___"${where}`);
    else if (holes !== q.blanks.length)
      errors.push(`Có ${holes} chỗ trống nhưng ${q.blanks.length} dòng "> Đáp án:"${where}`);
  }
  if (q.type === 'true_false' && q.correct === undefined)
    errors.push(`Câu đúng/sai thiếu "> Đáp án: Đúng" hoặc "Sai"${where}`);
  if (q.type === 'matching' && !q.left.length)
    errors.push(`Câu nối cặp chưa có cặp nào (dùng "- vế trái = vế phải")${where}`);
  if (q.type === 'ordering' && q.items.length < 2)
    errors.push(`Câu sắp xếp cần ít nhất 2 mục${where}`);
  if (!q.prompt) errors.push(`Câu hỏi chưa có nội dung${where}`);
  delete q._letterAnswers;
  delete q._line;
}
