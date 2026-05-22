# Task: Swap App — Triển khai app mới thay thế `services/app`

## Mục đích

Template này dùng khi user clone repo odeploynamemanager thành thư mục mới, rồi nhờ AI Agent triển khai một app mới thay thế `services/app` hiện tại.
Luồng làm việc tuân thủ cấu trúc [task-template.md](task-template.md).

---

## User prompt

> Dán yêu cầu của user tại đây. Bao gồm đầy đủ các spec bên dưới.

### Spec 1 — App mô tả

> Mô tả ngắn app mới là gì, runtime gì, source code ở đâu.
>
> Ví dụ: "App quản lý PocketBase, code nằm ở `H:\nodejs-tester\pocketbase-admin`, runtime Go, port 8090."

### Spec 2 — Source code

> Source code app mới sẽ thay thế toàn bộ thư mục `services/app`.
>
> - Đường dẫn source gốc: `<path-to-source>`
> - Cách chuyển: copy toàn bộ source vào `services/app/` (xóa nội dung cũ trước)
> - Có Dockerfile riêng không? (Có / Không — nếu không, Agent tự tạo)

### Spec 3 — Docker Compose (`compose.apps.yml`)

> Mô tả thay đổi cho `compose.apps.yml`:
>
> - Runtime: `<node|python|go|java|rust|prebuilt-image|other>`
> - Delivery: `<build|image>`
> - Image (nếu Delivery=image): `<registry/image:tag>`
> - Build context (nếu Delivery=build): `./services/app`
> - Internal port (APP_PORT): `<number>`
> - Health path: `<path>` (ví dụ `/health`, `/api/health`, `/`)
> - Build args cần thêm: `<KEY1, KEY2, ...>` hoặc `không`
> - Environment vars cần thêm: `<KEY1, KEY2, ...>` hoặc `không`
> - Volumes cần mount: `<container_path1:host_path1, ...>` hoặc `dùng mặc định`
> - Auth: `<protected-by-tinyauth|public|app-internal-auth|custom>`
> - Depends on: `<litestream-restore|tinyauth|không>`

### Spec 4 — ENV mới (`.env.example`)

> Liệt kê các biến ENV mới cần thêm vào `.env.example`:
>
> ```text
> MY_APP_KEY=default-value
> MY_APP_SECRET=change-me
> ```
>
> Nếu không có ENV mới: ghi "Không cần thêm ENV mới."

### Spec 5 — SQLite / Litestream

> App mới có dùng SQLite không?
>
> - Không dùng SQLite → bỏ qua
> - Có dùng SQLite → cung cấp:
>   - DB file ENV: `<LITESTREAM_APP_DB_FILE>`
>   - Container path: `<ví dụ /data/app/app.db>`
>   - S3 path ENV: `<LITESTREAM_APP_S3_PATH>`

### Spec 6 — Thông tin bổ sung

> Ghi bất kỳ yêu cầu đặc biệt nào khác (cron, worker, sidecar, v.v.)
> Nếu không có: ghi "Không."

---

## Thông tin cần xác nhận

Agent điền mục này nếu prompt thiếu dữ liệu cần thiết để triển khai đúng.

- [ ] Không cần hỏi thêm
- [ ] Cần hỏi user trước khi làm

Câu hỏi cần xác nhận:

-

---

## Checklist triển khai

Agent tự tạo checklist từ các Spec ở trên, rồi đánh dấu khi từng bước hoàn tất.

### Phase 0 — Đọc hiểu & xác nhận

- [ ] Đọc yêu cầu user và xác định phạm vi thay đổi
- [ ] Kiểm tra rule bắt buộc trong `AGENTS.md`
- [ ] Đọc `AGENT_APP_SWAP.md` để nắm invariants (Scope And Invariants, mục 2)
- [ ] Xác nhận đủ 6 Spec — nếu thiếu, hỏi user trước khi làm

### Phase 1 — Chuẩn bị source code

- [ ] Xóa toàn bộ nội dung `services/app/` (giữ thư mục)
- [ ] Copy source code app mới vào `services/app/`
- [ ] Kiểm tra / tạo `services/app/Dockerfile` phù hợp runtime mới
- [ ] Kiểm tra `.dockerignore` trong `services/app/` (tạo nếu cần)

### Phase 2 — Cập nhật compose.apps.yml

- [ ] Sửa `compose.apps.yml` theo Spec 3 (image/build, port, env, volumes, labels, healthcheck)
- [ ] Giữ đúng invariants từ `AGENT_APP_SWAP.md`:
  - Service name vẫn là `app`
  - Container name vẫn là `main-app`
  - Network vẫn là `app_net`
  - `APP_PORT` là source of truth cho port
  - Healthcheck phải có
  - Caddy labels dùng env vars, không hard-code domain
- [ ] Auth labels: thêm/giữ/bỏ `forward_auth` theo Spec 3

### Phase 3 — Cập nhật .env.example

- [ ] Thêm ENV mới theo Spec 4 vào section `APPLICATION` trong `.env.example`
- [ ] Cập nhật `APP_IMAGE`, `APP_PORT`, `HEALTH_PATH` nếu khác mặc định
- [ ] Xóa ENV cũ không còn dùng (ví dụ: các biến `DPDNS_CLOUDFLARED_MANAGER_*` nếu app mới không dùng)

### Phase 4 — SQLite / Litestream (nếu có)

- [ ] Cập nhật `services/litestream/litestream.yml` thêm DB mới (theo Spec 5)
- [ ] Cập nhật `services/litestream/entrypoint.sh` thêm restore gate cho app DB
- [ ] Cập nhật `docker-compose/compose.auth.yml` — mount volume app data cho litestream containers
- [ ] Cập nhật `LITESTREAM_REPLICATE_DBS` trong `.env.example`

### Phase 5 — Cập nhật docs & validate

- [ ] Cập nhật `docs/services/app.md` mô tả app mới
- [ ] Cập nhật `docs/services/litestream.md` nếu có thay đổi Litestream
- [ ] Chạy `npm run dockerapp-validate:env`
- [ ] Chạy `npm run dockerapp-validate:compose`
- [ ] Cập nhật `docker-compose/scripts/validate-env.js` nếu có ENV mới cần validate

### Phase 6 — Hoàn tất

- [ ] Kiểm tra lại toàn bộ thay đổi phù hợp yêu cầu
- [ ] Cập nhật `.opushforce.message` đúng format trong `AGENTS.md`
- [ ] Trả lời user ngắn gọn kèm danh sách file đã chỉnh

---

## File liên quan — Danh sách file mà Agent có thể đọc/chỉnh

Tham chiếu từ `AGENT_APP_SWAP.md` mục 3 (Default Editable Files):

| File | Hành động | Ghi chú |
|---|---|---|
| `services/app/**` | Xóa cũ + thay source mới | Thư mục chính của app |
| `services/app/Dockerfile` | Tạo mới / sửa | Dockerfile phù hợp runtime |
| `compose.apps.yml` | Sửa | Service `app` definition |
| `.env.example` | Sửa | Thêm/sửa ENV mới |
| `docker-compose/compose.auth.yml` | Sửa (nếu cần) | Litestream volumes, Tinyauth |
| `services/litestream/litestream.yml` | Sửa (nếu app dùng SQLite) | Thêm DB replica config |
| `services/litestream/entrypoint.sh` | Sửa (nếu app dùng SQLite) | Restore gate |
| `docker-compose/scripts/validate-env.js` | Sửa (nếu ENV mới) | Validation rules |
| `docs/services/app.md` | Sửa | Tài liệu app mới |
| `docs/services/litestream.md` | Sửa (nếu cần) | Tài liệu Litestream |
| `docs/services/tinyauth.md` | Sửa (nếu auth thay đổi) | Tài liệu Tinyauth |

Agent cập nhật thêm file đã đọc/chỉnh vào đây:

-

---

## Kết quả kiểm tra

Agent ghi command đã chạy hoặc lý do không chạy.

- `npm run dockerapp-validate:env` →
- `npm run dockerapp-validate:compose` →

---

## Ghi chú cho lần sau

Chỉ ghi thông tin hữu ích trực tiếp cho task này, không thay cho memory dài hạn.

-
