# Phase 1 Acceptance Audit — SLP Orchestrator

| | |
|---|---|
| **Repository** | `anmeo2204/paseo-slp-orchestrator` |
| **Nhánh** | `an_dev` |
| **Commit được audit** | `e6be53d` — *Expand product spec and brief guidance for non-UI features* |
| **Phase** | Phase 1 — SPEC Quality & Contract Guidance |
| **Ngày audit** | 2026-11-06 |
| **Phạm vi** | Chỉ đọc. Không sửa source/prompt/schema/test, không commit, không merge, không đổi nhánh. |
| **Quyết định cuối cùng** | **ACCEPT WITH CONDITIONS** |

---

## 1. Tóm tắt điều hành

Phase 1 đã hoàn thành **ở tầng hướng dẫn (guidance)** và được khóa bằng test; **không** được cưỡng chế ở tầng runtime.

Template Product Spec của Supervisor và template Brief của Lead đều chứa đầy đủ mọi mục Phase 1 yêu cầu. Các template `.slp/` được seed sinh trực tiếp từ cùng hằng số mà engine tiêm vào prompt, nên chúng không thể lệch khỏi engine. Skill `slp-manager` tài liệu hóa cùng một hợp đồng. Cả ba đều được ghim bằng assertion bổ sung trong chính commit Phase 1.

Điểm phân biệt mấu chốt mà audit này được yêu cầu làm rõ: **phần duy nhất của Product Spec được máy kiểm tra là sự tồn tại và độ dài tối thiểu 80 ký tự** (`shared/pipeline.ts:94-95`). Không có gì xác minh các mục, cấu trúc Given/When/Then, assumptions đã ghi, hay việc một con người thực sự đã duyệt văn bản. Brief của Lead cũng vậy: `BriefCriterionSchema` chấp nhận mọi chuỗi không rỗng, nên "mỗi criterion truy vết được tới một kịch bản spec" là lời khuyên, không phải cổng chặn. Repo nêu rõ điều này: `tests/flow-brief-revision.test.ts:69-75` cố ý khẳng định 80 ký tự `"A"` lặp lại vẫn là Product Spec hợp lệ, nhằm bảo vệ tương thích ngược của wire contract.

Ba phát hiện cần kèm điều kiện trước khi chấp nhận: `slp_revise_brief` không bắt buộc peer phải đang pause, cơ chế phát hiện drift của root-role contract được xác nhận là **không tồn tại**, và toàn bộ suite có 3 test fail có sẵn từ trước Phase 1 đang che mờ tín hiệu regression.

---

## 2. Phần triển khai đã xác minh

### 2.1 Supervisor Product Spec

Template 6 mục nằm tại `server/prompts/default-workflows.ts:25-32`, trong `DEFAULT_WORKFLOWS.supervisor`:

- `:26` — **Scope / Out of scope**, bao gồm cả "tempting adjacent work".
- `:27` — **Observable behaviors**: điều hệ thống làm mà người ngoài code quan sát được, luồng chính trước, luồng phụ sau.
- `:28` — **Surfaces and states, *where the feature has a UI or API surface***: từng màn hình/panel/HUD/dialog/CLI command/endpoint và các phần tử trên đó, cùng trạng thái empty, loading, successful, failed, disabled, lacking permission.
- `:29` — **Business rules, data, edge cases**: giới hạn, định dạng, tính toán, lưu trữ, biên, lỗi, xung đột.
- `:30` — **Acceptance scenarios**: `"Given <context> When <user action> Then <visible result>"`, kèm ràng buộc *"Write each Then so someone who did not build the feature can check it"*.
- `:31` — **Unknowns and assumptions**: *"A written assumption is a decision the Lead can revisit; an unwritten one is a surprise."*
- `:32` — Đọc repo (read-only) để spec khớp thuật ngữ hiện có; tính năng không có bề mặt người dùng (migration, background job, thay đổi thư viện) **bỏ qua mục 3** và dựa vào mục 2 + 5; chỉ gọi `slp_delegate` sau khi con người *explicitly approves*; truyền nguyên văn làm `productSpec`.

Việc lan truyền spec tới Lead và QA là **hành vi engine thật**, không phải lời nhắc prompt: `server/pipeline/delegation.ts:181` lưu `run.productSpec`, `:193` gán `featureSpec` cho từng Lead, `:206`/`:214` đưa spec vào briefing của Lead, và `server/prompts/qa-messages.ts:20,36` đưa spec của mọi feature vào roster của QA Lead kèm chỉ thị biến từng Given/When/Then thành test case. Mọi agent có thể đọc lại qua `slp_get_run`.

### 2.2 Lead Technical Brief

`DEFAULT_WORKFLOWS.master_lead` tại `server/prompts/default-workflows.ts:54-58`:

- `:54` — Brief là hợp đồng kỹ thuật, *"write it after reading the files the change touches"*.
- `:55` — `approach` phải nêu: module/file nào thay đổi, pattern và thư viện sẵn có nào được tái sử dụng, integration point với phần còn lại của hệ thống (kèm hợp đồng đã thỏa thuận với sibling Lead), hợp đồng data/API khi có (shape, tên trường, status code, migration), và hành vi *"when a dependency fails, input is invalid or the operation is interrupted"*.
- `:56` — `criteria`: *"Each requirement names the product spec scenario or acceptance criterion it covers"*; mỗi `verification` là thứ grader chạy được thật (command, đường dẫn test file, hoặc bước thủ công kèm kết quả mong đợi).
- `:57` — `inScope` / `outOfScope`.
- `:58` — Quy trình `slp_pause_peers` → `slp_revise_brief` → `slp_resume_peers`.

### 2.3 Skill generator và tương thích dự án

`server/project-prompts/defaults.ts:14,22,30` dựng `SUPERVISOR.md` / `LEAD.md` / `QA_LEAD.md` trực tiếp từ `DEFAULT_WORKFLOWS`, nên dự án mới scaffold không thể lệch khỏi engine. `server/skills/slp-manager/skill-markdown.ts:47,205,258` tài liệu hóa cùng các mục đó, kèm chỉ dẫn migration cho `.slp/` sẵn có.

An toàn tạo file đúng chuẩn: `writeMissingDefaultPromptFile` dùng `flag: "wx"` và chỉ nuốt `EEXIST` (`server/project-prompts/load.ts:58-67`); `initializeEmptyConfiguration` (`:69-86`) chỉ seed toàn bộ catalog khi **không có** role file nào, ngoài ra chỉ backfill đúng `QA_LEAD.md`. Khám phá root role bị giới hạn vào 3 tên file chuẩn (`:12,24-31`), và role đặt sai chỗ sẽ ném lỗi thay vì âm thầm áp dụng nhầm workflow (`:120-121`).

---

## 3. Kết quả thực thi test

Các lệnh đã chạy, dùng đúng script khai báo trong `package.json` (`typecheck`) và binary `vitest` đã cài:

| Lệnh | Kết quả |
|---|---|
| `npm run typecheck` | **PASS** — `tsc --noEmit`, exit 0, không output |
| `npx vitest run tests/flow-product-spec.test.ts tests/flow-brief-revision.test.ts tests/project-prompts.test.ts tests/slp-manager-skill.test.ts` | **PASS** — 4 file, **39 passed / 0 failed / 0 skipped** |
| `npx vitest run` (toàn bộ) | **381 passed / 3 failed / 0 skipped** trên 384 test, 43 file |

### 3.1 Ba test fail của toàn suite

- `tests/flow-run-start.test.ts` — 2 case khẳng định workspace của Lead khác `supervisorWorkspaceId`, nhưng nhận được `ws-supervisor`.
- `tests/flow-completion.test.ts:229` — `slp_delegate` tiếp theo sau khi run hoàn tất trả về `isError: true`.

**Đây không phải regression của Phase 1.** Ba lỗi giống hệt được tái hiện trong bản clone tách biệt tại `95ee338` (commit cha trực tiếp của Phase 1) và tại `0411a2a` (trước đợt refactor role/permission, sớm hơn 5 commit). Bản clone được tạo dưới `/tmp` và đã xóa; repo được audit không hề bị checkout hay sửa đổi.

Phù hợp về mặt kỹ thuật: commit Phase 1 chỉ thay đổi comment và **một** chuỗi thông báo lỗi Zod trong `shared/pipeline.ts` và `server/bus/tool-schemas.ts`, không chạm ngữ nghĩa schema.

### 3.2 Không thực thi

Lệnh lockstep `paseo plugin reload` trong AGENTS.md **không** được chạy, vì audit không tạo thay đổi source nào.

---

## 4. Acceptance Matrix

### A — Supervisor Product Spec

| # | Yêu cầu | Trạng thái | Bằng chứng | Mức cưỡng chế |
|---|---|---|---|---|
| A1 | Scope và out-of-scope | PASS | `default-workflows.ts:26` | prompt |
| A2 | Hành vi quan sát được mô tả rõ | PASS | `default-workflows.ts:27` | prompt |
| A3 | UI/API surfaces và states là có điều kiện | PASS | `default-workflows.ts:28,32`; test `flow-product-spec.test.ts:96-98` | prompt, khóa bằng test |
| A4 | Business rules, edge case, failure | PASS | `default-workflows.ts:29` | prompt |
| A5 | Kịch bản theo Given/When/Then | PASS | `default-workflows.ts:30`; test `flow-product-spec.test.ts:84` | prompt, khóa bằng test |
| A6 | Mỗi kịch bản kiểm chứng độc lập được | PASS | `default-workflows.ts:30`; test `flow-product-spec.test.ts:94` | prompt, khóa bằng test |
| A7 | Ghi nhận unknowns và assumptions | PASS | `default-workflows.ts:31`; test `flow-product-spec.test.ts:93` | prompt, khóa bằng test |
| A8 | **Cần người duyệt trước khi delegate** | **PARTIAL** | chỉ thị tại `default-workflows.ts:32`, `messages.ts:6`; runtime chỉ kiểm tra sự tồn tại + 80 ký tự tại `shared/pipeline.ts:94-95,124-133` | **chỉ prompt** |
| A9 | Spec đã duyệt tới được Lead và QA | PASS | `delegation.ts:181,193,206`; `qa-messages.ts:20,36`; test `flow-product-spec.test.ts:36-55,57-78` | **runtime** |
| A10 | Tính năng không UI không bị ép mô tả UI | PASS | `default-workflows.ts:32` ("skips section 3") | prompt, khóa bằng test |

### B — Lead Technical Brief

| # | Yêu cầu | Trạng thái | Bằng chứng | Mức cưỡng chế |
|---|---|---|---|---|
| B1 | Đọc code repo trước khi chốt approach | PARTIAL | `default-workflows.ts:54` | chỉ prompt |
| B2 | Kiến trúc và cách triển khai | PASS | `default-workflows.ts:55`; schema bắt buộc `approach` không rỗng, `shared/pipeline.ts:50` | prompt + runtime tối thiểu |
| B3 | Xác định module/file bị ảnh hưởng | PARTIAL | `default-workflows.ts:55` | chỉ prompt |
| B4 | Tái sử dụng pattern/thư viện sẵn có | PARTIAL | `default-workflows.ts:55`; test `project-prompts.test.ts:184` | chỉ prompt |
| B5 | Integration point và shared contract | PARTIAL | `default-workflows.ts:49,55`; test `project-prompts.test.ts:185` | chỉ prompt |
| B6 | Hợp đồng data/API khi liên quan | PARTIAL | `default-workflows.ts:55`; test `project-prompts.test.ts:186` | chỉ prompt |
| B7 | Input sai, dependency lỗi, thao tác bị ngắt | PARTIAL | `default-workflows.ts:55`; test `project-prompts.test.ts:187` | chỉ prompt |
| B8 | **Criterion truy vết tới kịch bản spec** | **PARTIAL** | `default-workflows.ts:56`; test `project-prompts.test.ts:189`. `BriefCriterionSchema` (`shared/pipeline.ts:41-46`) nhận mọi chuỗi | **chỉ prompt** |
| B9 | Verification chạy/kiểm chứng được | PARTIAL | `default-workflows.ts:56` | chỉ prompt |
| B10 | **Revise brief đã khóa theo pause → revise → resume** | **PARTIAL** | ghi đè brief đã khóa **bị chặn thật** tại `stage-control.ts:30-32`; nhưng `reviseBrief` (`:51-84`) chỉ kiểm tra role và quyền sở hữu, **không** kiểm tra peer đang pause | **hỗn hợp** |

**Ghi chú B10.** Đây là chỗ duy nhất runtime cưỡng chế một nửa. `approveStage` từ chối cứng mọi nỗ lực thay brief đã khóa và nêu đích danh `slp_revise_brief` trong thông báo lỗi (`stage-control.ts:30-32`), được xác minh bởi `tests/flow-brief-revision.test.ts:26-31`. Nhưng bản thân `reviseBrief` không áp điều kiện pause; chuỗi trả về chỉ *gợi ý* bước kế tiếp (`stage-control.ts:83`). Quyền sở hữu được cưỡng chế đúng trong cả `reviseBrief` (`:64-67`) lẫn `pauseStagePeers`/`resumeStagePeers` (`peer-pause.ts:44-51`), và pause thật sự thu hồi quyền ghi và ngắt lượt đang chạy (`peer-pause.ts:107,133`).

### C — Skill generator và tương thích dự án

| # | Yêu cầu | Trạng thái | Bằng chứng |
|---|---|---|---|
| C1 | Dự án mới nhận guidance đã cập nhật | PASS | `defaults.ts:14,22,30`; test `project-prompts.test.ts:20-29` |
| C2 | Giữ nguyên tùy biến `.slp/` sẵn có | PASS | `load.ts:69-86`; test `project-prompts.test.ts:31-43,44-60` |
| C3 | Hành vi tạo file `wx` vẫn an toàn | PASS | `load.ts:58-67` (chỉ nuốt `EEXIST`, không gì khác) |
| C4 | Root role file được nạp đúng | PASS | `load.ts:12,24-31,104-126`; role trùng hoặc đặt sai chỗ đều ném lỗi |
| C5 | Tài liệu skill khớp runtime contract | PASS | `skill-markdown.ts:47,205,258`; test `slp-manager-skill.test.ts:232-255` kiểm tra mọi `slp_*` nêu trong SKILL.md đều tồn tại trong `BUS_TOOL_DEFINITIONS` |
| C6 | Dự án cũ được xử lý dự đoán được | **PARTIAL** | giữ nguyên và tiêm nguyên văn, nhưng lặng lẽ lạc hậu — xem dưới |
| C7 | Phát hiện drift root-role contract | **GAP (không tồn tại)** | `project-validator.ts:74-93` |

**Phát hiện drift root-role là một GAP, xác nhận bằng source, không phải năng lực sẵn có.** `checkRoles` chỉ duyệt `config.peers` (`project-validator.ts:74`); các definition `supervisor`, `lead`, `qaLead` không bao giờ đi qua nó. Hệ quả: kiểm tra `role.unknown_tool` tại `:81-83` — thứ sẽ bắt được một `.slp/SUPERVISOR.md` cũ vẫn gọi các tool `slp_board_*` đã bị gỡ — không bao giờ chạy trên root file. `tests/project-prompts.test.ts:44-60` ghim chính xác hành vi này một cách im lặng: `SUPERVISOR.md` cũ ghi "Draft the 5-section Product Spec" sống sót nguyên vẹn từng byte, và test **khẳng định** rằng guidance mới **không** xuất hiện trong prompt được dựng. Không có cảnh báo nào được phát ra ở bất cứ đâu.

Có một biện pháp giảm nhẹ runtime khiến đây không bị xếp FAIL: `supervisorBriefing()` tiêm luật Product Spec vào mọi run và vô hiệu hóa tường minh các tool board đã gỡ — *"Do not call any `slp_board` tool; that board has been removed"* (`server/prompts/messages.ts:6`). Dự án legacy vì vậy vẫn nhận được luật duyệt-rồi-mới-delegate và đúng tool, nhưng **mất** cấu trúc 6 mục, luật surface có điều kiện, và luật ghi assumptions.

**Quan sát liên quan, không phải lỗi:** `scaffoldProjectSetup` seed 3 root role file qua `emit` (`scaffold.ts:169-171`), và với `overwrite: true` thì đó là ghi đè thật (`:155`). Mặc định là `skip`, và overwrite là lựa chọn tường minh của người dùng trên UI, nên root role đã sửa tay an toàn theo mặc định. Hàm anh em `removeUnmodifiedDefaultPeers` (`:141-150`) so khớp chính xác từng byte và bỏ qua đúng mọi file đã sửa.

### E — Kịch bản nghiệm thu runtime

| Kịch bản | Trạng thái | Bằng chứng |
|---|---|---|
| **1 — Tính năng UI** (form, validation, loading, success, error) | **PARTIAL** | `SAMPLE_PRODUCT_SPEC` (`tests/helpers/flow-steps.ts:66-71`) đúng hình dạng này (file picker, nút Import disabled, spinner, error banner, Given/When/Then), và `flow-product-spec.test.ts:36-55` chứng minh nó tới Lead và QA nguyên vẹn. Nửa phía Lead yếu hơn: `SAMPLE_BRIEF` (`flow-steps.ts:11-16`) có một criterion mà `requirement` không nêu kịch bản spec nào, nên **truy vết brief chưa bao giờ được kiểm chứng end-to-end**. |
| **2 — Tính năng không UI** | **NOT TESTED** | Chỉ được phủ bởi assertion so khớp chuỗi prompt (`flow-product-spec.test.ts:96-98`, `slp-manager-skill.test.ts:248-250`). Không tồn tại fixture spec non-UI nào, nên không flow test nào cho thấy một migration hay background job tạo ra spec không có mục surface mà vẫn giữ hành vi quan sát được, xử lý lỗi và verification. |
| **3 — Dự án legacy** | **PASS phần bảo toàn, GAP phần cảnh báo** | `project-prompts.test.ts:44-60` chứng minh không ghi đè; việc thiếu cảnh báo drift được báo cáo ở đây là một GAP, theo đúng yêu cầu, thay vì tính là pass. |
| **Tích hợp CLI trực tiếp** | **NOT TESTED** | Không chạy `paseo` thật; mọi bằng chứng đến từ source cộng với flow fixture in-process. |

---

## 5. Phát hiện

### 5.1 Nghiêm trọng (điều kiện để chấp nhận)

#### F1 — `slp_revise_brief` không yêu cầu peer phải đang pause

- **Mức độ:** Cao
- **Vị trí:** `server/pipeline/stage-control.ts:51-84`
- **Tác động:** Lead có thể thay hợp đồng đã khóa trong lúc một developer peer đang ghi file, tạo ra công việc chia làm hai hợp đồng khác nhau mà không có dấu vết audit nào phân biệt chúng. QA chấm theo brief mới trong khi một phần code được viết theo brief cũ.
- **Hành động đề xuất:** Để `reviseBrief` từ chối (hoặc tối thiểu ghi một sự kiện cảnh báo) khi bất kỳ peer nào của stage hiện tại có `pausedAt === null`.

#### F2 — Việc con người duyệt Product Spec không thể xác minh bởi engine

- **Mức độ:** Cao
- **Vị trí:** `shared/pipeline.ts:94-95,124-133`; chứng minh bởi `tests/flow-brief-revision.test.ts:69-75`
- **Tác động:** Kết hợp với `server/prompts/messages.ts:46` — chỉ thị Lead *"treat its assumptions as the decisions they record"* — một bản nháp chưa duyệt hoặc nặng giả định mà vượt qua 80 ký tự sẽ trở thành hợp đồng ràng buộc. Đây chính là rủi ro mà phạm vi audit nêu đích danh, và nó đối nghịch trực tiếp với tiêu chí thoát số 7 của Phase 1.
- **Hành động đề xuất:** Một kiểm tra cấu trúc nhẹ trên `productSpec` — yêu cầu ít nhất một lần xuất hiện `Given…When…Then` và một dấu hiệu assumptions/unknowns không rỗng — trả về `ToolError` mô tả rõ thay vì lỗi schema cứng, để các run đã lưu vẫn đọc được.

### 5.2 Không nghiêm trọng

#### F3 — Drift của root-role contract không được phát hiện

- **Mức độ:** Trung bình
- **Vị trí:** `server/project-setup/project-validator.ts:74-93`
- **Tác động:** Dự án sẵn có giữ guidance Supervisor và Lead lạc hậu mà không có tín hiệu nào ở validator, luồng Reload, hay Start Run guard. Được giảm nhẹ một phần bởi `messages.ts:6`.
- **Hành động đề xuất (Phase 2, không triển khai bây giờ):** Mở rộng `checkRoles` sang 3 root definition, phát `role.unknown_tool` ở mức error và thêm cảnh báo mới `role.stale_guidance` khi một root workflow thiếu các dấu hiệu của hợp đồng hiện hành.

#### F4 — Truy vết criterion của brief không được kiểm tra

- **Mức độ:** Thấp
- **Vị trí:** `shared/pipeline.ts:41-46`
- **Tác động:** QA Lead được yêu cầu phát hiện kịch bản chưa được phủ nhưng không có hỗ trợ cấu trúc nào. Rủi ro thấp khi vẫn còn con người review scorecard.

#### F5 — Ba test fail có sẵn từ trước

- **Mức độ:** Trung bình
- **Vị trí:** `tests/flow-run-start.test.ts` (2 case) và `tests/flow-completion.test.ts:229` (1 case); tái hiện tại `95ee338` và `0411a2a`
- **Tác động:** Không phải regression của Phase 1, nhưng một suite đỏ làm suy giảm tín hiệu regression mà mọi phase sau phụ thuộc vào.
- **Hành động đề xuất:** Phân loại tách khỏi Phase 1 — hoặc sửa hành vi engine, hoặc cập nhật assertion cho khớp với cơ chế cấp workspace lazy sau refactor.

#### F6 — Thiếu fixture runtime cho tính năng không UI

- **Mức độ:** Thấp
- **Vị trí:** `tests/helpers/flow-steps.ts:66-71`
- **Tác động:** Tuyên bố chính của commit Phase 1 được xác minh bằng so khớp chuỗi thay vì bằng flow thật.
- **Hành động đề xuất:** Thêm fixture spec thứ hai cho một migration hoặc background job và khẳng định nó delegate sạch mà không có mục surface.

---

## 6. Rủi ro hoãn lại (Deferred)

Kiểm tra cấu trúc nội dung spec và brief ở runtime là mối quan tâm của Phase 2 theo chủ đích; repo nêu rõ ý định này tại `tests/flow-brief-revision.test.ts:56-58`, nơi tương thích ngược của wire contract được **chọn** thay cho schema chặt hơn.

Phát hiện drift (F3) cũng được hoãn và đã bị loại tường minh khỏi phạm vi audit này.

Xác minh CLI trực tiếp cho vòng end-to-end Supervisor → Lead → QA nằm ngoài harness hiện tại.

Không mục nào trong số này được tính là thất bại của Phase 1.

---

## 7. Sửa chữa bắt buộc trước khi chấp nhận

Đang chờ Manager (con người) phê duyệt. **Chưa có mục nào được triển khai.**

1. **Thêm điều kiện tiên quyết pause** (hoặc cảnh báo được ghi nhận) vào `reviseBrief` — xử lý **F1**.
2. **Thêm kiểm tra cấu trúc tối thiểu cho `productSpec`** trong `slp_delegate` — xử lý **F2** và tiêu chí thoát số 7.
3. **Phân loại 3 test fail có sẵn** thành hạng mục công việc riêng để suite xanh trở lại trước Phase 2 — xử lý **F5**.

> Mục 1 và 2 chạm vào hành vi tool `slp_*`, nên theo **AGENTS.md §1** mỗi thay đổi sẽ cần cập nhật đồng bộ `server/skills/slp-manager/skill-markdown.ts` và `tests/slp-manager-skill.test.ts` trong **cùng một change**.

---

## 8. Quyết định cuối cùng

### ACCEPT WITH CONDITIONS

**Có thể đóng Phase 1 ngay bây giờ không? — KHÔNG.**

Phase 1 về cơ bản đã được giao. Cả 10 yêu cầu Supervisor và cả 10 yêu cầu Lead đều hiện diện trong guidance mà engine thực sự tiêm vào; các template `.slp/` được seed và skill `slp-manager` được sinh từ cùng hằng số nên không thể lệch khỏi engine; và commit Phase 1 đã bổ sung assertion trên 4 file test để khóa điều đó.

- **Tiêu chí thoát 2 — ĐẠT**, bằng chứng mạnh: commit chỉ thay đổi `shared/pipeline.ts` và `server/bus/tool-schemas.ts` ở comment và một chuỗi lỗi; các test tương thích xác nhận brief tối thiểu và spec đạt độ dài tối thiểu vẫn parse được.
- **Tiêu chí thoát 3 — ĐẠT** cho các test liên quan (39/39) và typecheck.
- **Tiêu chí thoát 4 — ĐẠT**: 3 lỗi của suite được tái hiện ở 2 và 5 commit phía trước.
- **Tiêu chí thoát 5 — ĐẠT**, chứng minh bởi `project-prompts.test.ts:31-60` và đường ghi file `wx`.
- **Tiêu chí thoát 6 — ĐẠT** qua chính báo cáo này.

**Tiêu chí thoát 7 — CHƯA ĐẠT.** Engine không phân biệt được spec đã duyệt với spec chưa duyệt, ngưỡng 80 ký tự là cổng nội dung duy nhất, và Lead được chỉ thị coi mọi thứ nhận được là quyết định đã chốt — nên một giả định nghiệp vụ chưa được duyệt **có thể** bị ủy quyền âm thầm xuống Lead. Tách biệt với điều đó, `slp_revise_brief` cho phép tráo hợp đồng đã khóa ngay dưới một peer đang ghi file.

Cả hai là **lỗ hổng cưỡng chế nằm trong phạm vi Phase 1**, không phải enhancement còn thiếu của Phase 2 — vì vậy chúng là *điều kiện* chứ không phải khoản hoãn. Không điều nào đủ nghiêm trọng để REJECT, vì tầng prompt đã chỉ thị hành vi đúng và cổng delegation vẫn chặn trường hợp thiếu hẳn spec.

Sau khi hai sửa chữa **F1** và **F2** được Manager duyệt và triển khai (kèm đồng bộ skill theo AGENTS.md), Phase 1 có thể đóng.

**Phase 2 chưa bắt đầu. Không có sửa chữa đề xuất nào được áp dụng.**
