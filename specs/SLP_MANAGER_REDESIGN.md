# Bản nháp: Thiết kế lại skill `slp-manager` (đang thảo luận)

> Trạng thái: **CHƯA TRIỂN KHAI**. Chỉ bắt đầu sửa code khi chủ dự án nhắn "Triển khai".
> Ngày ghi: 2026-10-30. Căn cứ code ở commit `5cde28b`.

## 1. Bối cảnh dự án sử dụng

- **Website / WebApp:** một monorepo, mỗi hệ thống con (CMS, CRM, Website...) là một thư mục riêng. Backend dùng PHP hoặc Go (có thể thêm ngôn ngữ khác). Frontend dùng React, Next.js, Angular...
- **Mobile:** repo riêng. Flutter cho dự án nhỏ, native (Android Kotlin, iOS Swift) cho dự án lớn.
- **Host:** Paseo chạy trên macOS, nên test được iOS.
- Cấu trúc thư mục thay đổi theo framework và theo từng dự án, nên giải pháp **không được giả định trước cấu trúc**.

## 2. Vấn đề của `slp-manager` hiện tại

1. Chỉ là tài liệu. Kết quả phụ thuộc vào agent, phần còn lại phải soát bằng mắt (`tier`, mục Protocol, lệnh test).
2. Mỗi peer tự chép mục SLP Peer Protocol, dễ chép sai mà không có gì phát hiện.
3. Thiên về game (template `TEST_POLICY` lấy Unity làm mẫu). Thiếu playbook PHP.
4. Nút "Reload role workflows" chỉ kiểm tra cú pháp parser: không kiểm tra `tier`, `model`, lệnh test hay worktree.

## 3. Các rủi ro thực tế với web/mobile (đã đối chiếu code)

| # | Vấn đề | Nguồn trong code | Hệ quả |
|---|---|---|---|
| 1 | Worktree mới không có dependency hay `.env` | Worktree tạo bằng `branch-off`, plugin không chạy setup | Developer phải tự cài. QA worktree không ai cài được |
| 2 | QA peer và QA Lead bị chặn `npm install` và `>` | `MUTATING_SHELL` trong `server/hooks/permissions.ts` | QA không tự cài được dependency để chạy test |
| 3 | Merge yêu cầu worktree sạch, kể cả file chưa track | `requireCleanWorktree(..., true)` trong `finalize-pipeline.ts` | `.next/`, `vendor/`, `coverage/`, `test-results/`, `ios/Pods` chưa ignore thì merge lỗi |
| 4 | Dev server chạy foreground | Shell watchdog báo sau 90 giây | Lead bị đánh thức liên tục |
| 5 | `curl` tới `localhost:6767` bị chặn | `DAEMON_BYPASS` | Không gọi được service qua proxy của Paseo |
| 6 | Feature song song dùng chung DB hoặc cổng | Engine không cấp tài nguyên riêng | Migration đè nhau, trùng cổng |
| 7 | Mỗi Run gắn một `repoPath` | `startRunRpc` | Feature cần cả web và mobile phải chạy 2 Run: backend trước, mobile sau |
| 8 | Angular `ng test` (Karma) mở Chrome | — | Phải xếp vào tier nặng |
| 9 | Native: Gradle và Xcode tốn 1–3 GB mỗi worktree | — | Giới hạn khoảng 2 feature song song, `-derivedDataPath` riêng cho từng worktree |

Paseo có `paseo.json` (`worktree.setup`, service dùng `$PASEO_PORT`) và `.worktreeinclude` để giải quyết rủi ro 1 và 6. **Chưa xác minh** các cơ chế này có chạy khi SLP tạo worktree qua `paseo.workspaces.create` hay không. Cần một lần chạy thử (Bước 0).

## 4. Giải pháp đề xuất: dò theo package + preset + validator + dry run

### 4.1. Nguyên tắc lõi: lấy package làm đơn vị, bỏ qua cấu trúc thư mục
Plugin quét repo (bỏ qua `node_modules`, `vendor` và thư mục build). Mỗi thư mục có file đánh dấu là một package:

| File đánh dấu | Stack | Cài dependency | Lệnh `fast` |
|---|---|---|---|
| `composer.json` | PHP (Laravel/Symfony) | `composer install` | scripts, PHPUnit/Pest |
| `go.mod` | Go | `go mod download` | `go test ./...` |
| `package.json` + `next.config.*` | Next.js | theo lockfile | scripts |
| `package.json` + `angular.json` | Angular | theo lockfile | scripts (Karma là lệnh nặng) |
| `package.json` + `react` | React | theo lockfile | scripts |
| `pubspec.yaml` | Flutter | `flutter pub get` | `flutter test` |
| `build.gradle*` + Android plugin | Android native | Gradle | `./gradlew test` |
| `*.xcodeproj` / `Package.swift` | iOS native | `pod install` / SPM | `xcodebuild test` (nặng) |

### 4.2. Sinh cấu hình từ danh sách package
- **Role:** mỗi stack một developer, `owned_paths` liệt kê các package của stack đó. Danh mục giữ khoảng 6–8 peer.
- **`paseo.json` setup:** lệnh cài dependency của từng package.
- **`.gitignore`:** báo các thư mục output còn thiếu theo stack.
- **`TEST_POLICY.md`:** lệnh lấy từ scripts thật. Lệnh mở browser, emulator hay Docker tự xếp vào tier nặng.
- Stack lạ thì dùng preset `generic` và cảnh báo.

### 4.3. Quy trình skill mới
1. Plugin dò package (code).
2. Plugin chọn preset, ghép role và file cấu hình.
3. Agent điền phần nghiệp vụ (`description`, module chính, lệnh test thật) và hỏi người dùng những chỗ chưa chắc.
4. Dry run: tạo worktree tạm, chạy setup và tier `fast`, ghi thời gian và RAM.
5. Validator kiểm tra lần cuối.
6. Người dùng duyệt và commit.

### 4.4. Validator (RPC `slp.project.validate`, gắn vào nút Reload)
Mức ✗ chặn Start run, mức ⚠ chỉ cảnh báo.
- **Role:** `tier` hợp lệ và khớp `kind`. Có mục Protocol. Mọi `slp_*` đều tồn tại trong bus. Không hướng dẫn hỏi peer khác. YAML có `: ` phải có nháy.
- **Lệnh test:** lệnh trong `TEST_POLICY` có trong scripts. Lệnh nặng không nằm trong `fast`.
- **Độ phủ:** mỗi stack dò được có developer. Có ít nhất 1 peer `qa`.
- **Worktree:** output đã gitignore. Có setup cài dependency. Có `.worktreeinclude` cho `.env`.
- **Git:** `.slp/` đã commit trên nhánh hiện tại.
- **Môi trường:** host phù hợp stack (iOS cần macOS).
- **Không kiểm tra:** chất lượng prompt, lựa chọn peer của Lead, test có pass hay không (việc này thuộc Dry run).

### 4.5. Cảnh báo lúc Start Run
Việc tạo role luôn phải xong **trước** khi Start Run có tác dụng, vì hai ràng buộc của code:
- Start Run chụp snapshot `.slp/` vào SQLite ngay lúc bắt đầu; role sinh sau đó chỉ áp dụng cho Run kế tiếp.
- Worktree của Lead/Peer tách từ commit của nhánh gốc; role và `TEST_POLICY.md` chưa commit thì không có trong worktree.

Để người dùng không vô tình chạy Run với role sai, thêm bước kiểm tra lúc Start Run:
- `.slp/` vẫn là bộ mặc định (chưa tạo role theo dự án): **cảnh báo** và đề nghị sang tab Skills làm bước Init → điền → dry run → validator trước.
- Validator còn lỗi ✗, hoặc `.slp/` chưa commit trên nhánh hiện tại: **chặn** Start Run, kèm lý do và đường dẫn file.

Việc tạo role vẫn không chạy tự động bên trong Run: nó cần quyền ghi file và cần người dùng trả lời câu hỏi, cả hai đều không có trong Run.

### 4.6. Nguồn gốc các thành phần (đã đối chiếu code ở commit `5cde28b`)
- **Commit `.slp/` trước khi Start Run:** ràng buộc **có sẵn** của code (`server/git/worktree.ts` dùng `branch-off`). Đã ghi trong README mục 6 và `docs/project-workflows.md`.
- **Validator (`slp.project.validate`):** **đề xuất mới**, chưa có trong code. Hiện chỉ có nút "Reload role workflows" gọi `loadProjectPrompts` (kiểm tra cú pháp parser).
- **Dry Run:** **đề xuất mới**, chưa có trong code. Khác với `tools/bin/slp-smoke` (chạy Run thật với agent, tốn token).

## 5. Lộ trình triển khai (khi có lệnh "Triển khai")

0. Chạy thử trên một repo web: kiểm tra `paseo.json` setup và `.worktreeinclude` có áp dụng cho worktree của SLP không.
1. Dò package và Validator, kèm test.
2. Preset `web-monorepo` (PHP, Go, React/Next, Angular).
3. Preset `mobile-flutter` và `mobile-native`.
4. Dry run.
5. Rút gọn `slp-manager` còn khoảng 1 trang. Cập nhật README và `tests/slp-manager-skill.test.ts` theo luật lockstep của `AGENTS.md`.

## 5b. Cách thêm stack mới (ví dụ Game: Unity/Unreal/Godot)

Thiết kế mở rộng bằng cách **thêm preset**, không sửa lõi. Lõi là dò package + validator + dry run, không gắn với stack nào. Để thêm một stack:

1. **Dò package:** thêm dòng nhận diện vào bảng (ví dụ `ProjectSettings/ProjectVersion.txt` → Unity, `*.uproject` → Unreal, `project.godot` → Godot).
2. **Preset:** thêm mẫu role (`gameplay-developer`, `ui-developer`, `gameplay-architect`, `playtester`...) và mẫu `TEST_POLICY` cho stack đó (tier `fast` = logic thuần, tier nặng = engine batch mode).
3. **Validator và Dry Run:** hầu như không sửa — chúng kiểm tra theo nguyên tắc chung (tier khớp kind, lệnh test có thật, output đã gitignore, `max_concurrent` cho tài nguyên nặng).

Kiến thức game đã có sẵn trong tài liệu `slp-manager` hiện tại (playbook Unity/Unreal/Godot, template TEST_POLICY lấy Unity làm mẫu). Việc thêm game là chuyển kiến thức đó từ "tài liệu cho agent đọc" sang "preset có code dò và kiểm tra".

**Khi nào mới cần redesign thật:** chỉ khi loại công việc chạm vào giả định gốc của SLP (một repo, có developer viết code, có QA). Ví dụ: công việc không phải code (viết tài liệu, phân tích dữ liệu), hoặc một Run trải trên nhiều repo. Game không thuộc nhóm này.

## 6. Ngoài phạm vi, cần quyết định riêng

- Engine tự chèn Protocol theo `kind`, hay giữ nguyên tắc "không bọc `# Workflow`" và để validator kiểm tra.
- Engine kiểm tra `tier` và từ chối peer `integration` trong pipeline feature.
- Nới `DAEMON_BYPASS` để không chặn hostname `*.localhost` của service.
- Hỗ trợ một Run trải trên nhiều repo (thay đổi kiến trúc lớn).
- Sửa comment cũ của `slp_notify` trong `server/bus/tool-schemas.ts`.
