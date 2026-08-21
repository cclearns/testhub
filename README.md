# Hệ thống làm bài test

Ứng dụng thi trực tuyến, giao diện tiếng Việt. Node thuần — **không cần cài
thư viện nào**, dữ liệu lưu dạng JSON.

## Chạy

```bash
node quiz/server.js
```

- Học viên: <http://localhost:3000>
- Giáo viên: <http://localhost:3000/admin.html> — mật khẩu `minmin`
  (đổi bằng biến môi trường `TEACHER_PASSWORD`).

Môi trường lưu trú có thể ghi đè bằng `TEST_DATA_DIR` và `TEST_UPLOADS_DIR`
(dùng khi chạy nhiều instance hoặc test).

## Kiểm tra

```bash
npm test
```

Dùng `node:test` (có sẵn trong Node 18+, không phụ thuộc thư viện ngoài).
Bài kiểm tra chạy trên thư mục dữ liệu tạm, không ảnh hưởng đến dữ liệu thật.

## Cấu trúc

| Tệp | Vai trò |
| --- | --- |
| `server.js` | API, xác thực giáo viên, chấm điểm tự động, lưu trữ |
| `public/index.html` | Học viên chọn đề → ghi tên → bắt đầu |
| `public/test.html` | Trang làm bài: hẹn giờ, bài nghe giới hạn lượt, nộp bài, xem kết quả |
| `public/admin.html` + `admin.js` | Đăng nhập, soạn đề, xem/chấm/xuất kết quả |
| `public/mdimport.js` | Bộ đọc đề viết bằng Markdown |
| `public/favicon.svg` | Icon tab — mặt cười xanh biển, má đỏ (dùng màu của theme) |
| `templates/mau-de.md` | Tệp đề mẫu — mở bằng nút “Tải mẫu” trong trang giáo viên |
| `templates/de-tv-so-cap-*.md` | Ba đề tiếng Việt sơ cấp cho sinh viên Nhật |
| `templates/de-tv-trung-cap-*.md` | Hai đề cho người đã học 100–200 giờ |
| `data/tests.json` | Ngân hàng đề |
| `data/submissions.json` | Bài làm + điểm của học viên |
| `uploads/` | Tệp âm thanh bài nghe |

## Các dạng câu hỏi

| Dạng | Chấm tự động | Ghi chú |
| --- | --- | --- |
| Trắc nghiệm | ✔ | một hoặc nhiều đáp án đúng |
| Đúng / Sai | ✔ | |
| Điền vào chỗ trống | ✔ (điểm từng phần) | dùng `___` trong câu; nhiều đáp án cách nhau bằng `|` |
| Trả lời ngắn | ✔ | để trống đáp án nếu muốn tự chấm |
| Nối cặp | ✔ (điểm từng phần) | cột phải được xáo trộn |
| Sắp xếp thứ tự | ✔ (điểm từng phần) | học viên thấy thứ tự xáo trộn |
| Tự luận | ✘ | giáo viên chấm tay ở trang Kết quả |

**Bài nghe** gắn ở cấp *phần thi*: tải tệp lên **hoặc dán link**, rồi đặt số
lần được nghe. Học viên chỉ có nút “Phát” — không có thanh tua, hết lượt thì
nút bị khoá. Số lần đã nghe thực tế được lưu cùng bài nộp.

Nguồn âm thanh nhận ba kiểu:

| Nguồn | Ghi thế nào |
| --- | --- |
| Tệp tải lên | Chọn tệp ở trình soạn đề → lưu thành `/uploads/…` |
| Link trực tiếp | `https://…/bai-nghe.mp3` |
| Google Drive / Dropbox / OneDrive | Dán thẳng link chia sẻ, ví dụ `https://drive.google.com/file/d/<ID>/view` |

Link chia sẻ của Google Drive trỏ tới trang HTML nên thẻ `<audio>` không phát
được. Máy chủ tự đổi sang địa chỉ tải trực tiếp
(`drive.usercontent.google.com/download?id=…`), tải hộ rồi phát lại cho học
viên qua `/api/audio/<mã đề>/<mã phần>` — có hỗ trợ tua từng phần (HTTP Range).

Hai hệ quả đáng chú ý:

- Tệp trên Drive **phải để quyền “Bất kỳ ai có đường liên kết”**. Nếu chưa,
  trang phát báo lỗi rõ ràng thay vì im lặng hỏng.
- Học viên **không thấy link gốc** — trang chỉ nhận `/api/audio/…`. Dù vậy
  vẫn có thể tải tệp đó về nghe lại ngoài hệ thống, nên giới hạn lượt nghe là
  ràng buộc trên lớp, không phải ràng buộc kỹ thuật tuyệt đối.

## Soạn đề bằng Markdown

Trang giáo viên → **Nhập đề từ Markdown**. Dán nội dung hoặc chọn tệp `.md`,
bấm **Kiểm tra** để soát lỗi (báo lỗi kèm số dòng), rồi **Tạo đề** — đề được
tạo ở trạng thái *đã đóng* và mở luôn trong trình soạn đề để rà lại.

Khối **Đề mẫu có sẵn** liệt kê mọi tệp trong `templates/`. Chọn một mẫu rồi:

- **Chèn vào ô soạn** — nạp nội dung vào ô bên dưới để sửa ngay tại trang.
- **Tải tệp .md về máy** — tải tệp thật về, sửa bằng trình soạn thảo rồi dán lại
  (hoặc dùng nút *Mở tệp từ máy*).

Mẫu trắng [`templates/mau-de.md`](templates/mau-de.md) có đủ 8 dạng câu hỏi kèm
chú thích. Tóm tắt cú pháp:

```markdown
# Tên đề
> Thời gian: 45
> Hiện đáp án: có

## Phần 1 — Ngữ pháp
> Hướng dẫn: Chọn đáp án đúng.
> Audio: /uploads/bai-nghe.mp3
> Số lần nghe: 2

### [Trắc nghiệm] (1đ) She ___ to school every day.
- go
- [x] goes

### [Điền khuyết] (2đ) Điền dạng đúng của động từ.
> Câu: He ___ TV when I ___ home.
> Đáp án: was watching
> Đáp án: came | arrived

### [Nối cặp] (2đ) Nối từ với nghĩa.
- diligent = chăm chỉ
```

- `#` tên đề · `##` phần thi · `###` câu hỏi (mở đầu bằng `[dạng]` và `(số điểm)`)
- `>` thuộc tính · `-` lựa chọn (`[x]` = đáp án đúng) · `1.` mục sắp xếp
- Đáp án trắc nghiệm ghi được bằng `[x]` hoặc `> Đáp án: C`
- Nhiều cách viết đúng ngăn cách bằng `|` · ghi chú `<!-- ... -->` bị bỏ qua
- Bài đọc: xuống dòng thoải mái khi soạn, hệ thống nối lại thành đoạn liền mạch;
  dòng chỉ có `>` là sang đoạn mới; hội thoại `Tên: câu nói` giữ mỗi lượt một dòng

## Đề mẫu có sẵn

Ba đề tiếng Việt sơ cấp dành cho sinh viên Nhật, đã nạp sẵn vào hệ thống
(soạn bằng Markdown, nhập qua chức năng ở trên):

| Tệp | Nội dung | Quy mô |
| --- | --- | --- |
| `templates/de-tv-so-cap-1.md` | Chào hỏi, đại từ nhân xưng, tự giới thiệu | 13 câu · 22 điểm · 25 phút |
| `templates/de-tv-so-cap-2.md` | Số đếm, thời gian, hội thoại mua sắm (có bài đọc) | 14 câu · 22 điểm · 30 phút |
| `templates/de-tv-so-cap-3.md` | Sáu thanh điệu, nguyên âm ư/u, phân biệt bàn–bán | 12 câu · 20 điểm · 25 phút |

Hai đề cho trình độ **100–200 giờ học** (tương đương A2):

| Tệp | Nội dung | Quy mô |
| --- | --- | --- |
| `templates/de-tv-trung-cap-1.md` | Loại từ, thì, cặp liên từ (vì…nên, tuy…nhưng), được/bị, đọc hiểu, viết 100–120 từ | 18 câu · 30 điểm · 45 phút |
| `templates/de-tv-trung-cap-2.md` | Nói lịch sự, hỏi đường, đặt phòng, đi khám, tường thuật, viết 100 từ | 16 câu · 29 điểm · 40 phút |

Đề dùng song ngữ Việt–Nhật ở phần nghĩa từ vựng, để sinh viên mới học vẫn
hiểu đề. Nạp lại bất cứ lúc nào: trang giáo viên → *Nhập đề từ Markdown* →
dán nội dung tệp.

## Tính năng khác

- Hẹn giờ, tự động nộp khi hết giờ.
- Xáo trộn thứ tự câu hỏi (tuỳ chọn từng đề).
- Mở/đóng đề; link riêng cho từng đề để gửi học viên.
- Bài đọc (reading passage) cho từng phần thi.
- Hiện đáp án + giải thích cho học viên sau khi nộp (bật/tắt được).
- Thống kê: số bài nộp, điểm trung bình, số bài cần chấm tay; xuất CSV.
- Luồng vào bài hai bước: chọn đề trước, ghi tên sau (tên được nhớ lại cho lần
  sau trên cùng máy). Không hỏi lớp.
- Học viên **thoát giữa chừng** được (có hỏi xác nhận), và về trang chủ sau khi nộp.
- Nộp bài hỏng do mất mạng thì báo lỗi ngay và cho **nộp lại**, không mất bài làm.
- **Xoá đề là xoá sạch**: bài nộp của đề đó và tệp nghe riêng của nó bị xoá theo;
  tệp nghe đang được đề khác dùng thì giữ lại. Hộp xác nhận nói rõ số bài nộp và
  số tệp sẽ mất trước khi xoá.

## Giao diện

Theme riêng của ứng dụng: **Bến cảng** — nền giấy kem, khối bo tròn, mực xanh
đêm, nhấn xanh biển, đỏ son dành cho lỗi. Palette gốc do người dùng cung cấp:
`#12103D` `#0C5D7B` `#F20231` `#EFBF7F` `#F8E4CC` (đã quy đổi sang OKLCH).
Token nằm ở [`public/tokens.css`](public/tokens.css); mọi màu và font trong
`style.css` đều gọi token theo tên. Font là **Baloo 2** (tiêu đề) +
**Be Vietnam Pro** (nội dung) — cả hai phủ đủ bộ dấu tiếng Việt, nên chữ có dấu
không bị nhảy sang font dự phòng. Site học thuật ở thư mục gốc vẫn giữ theme
Atelier riêng của nó.

## Bảo mật

Mật khẩu giáo viên gác toàn bộ API `/api/admin/*`; đáp án bị loại khỏi đề
trước khi gửi cho học viên. Đây là mức đủ cho lớp học nội bộ — nếu đưa lên
Internet công cộng, nên chạy sau HTTPS và đổi mật khẩu mặc định.
