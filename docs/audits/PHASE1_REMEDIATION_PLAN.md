# Phase 1 Remediation Plan

| | |
|---|---|
| **Repository** | `anmeo2204/paseo-slp-orchestrator` |
| **Nhánh** | `an_dev` |
| **HEAD / Baseline** | `e6be53d` (HEAD == baseline == `origin/an_dev`) |
| **Audit trước** | `PHASE1_ACCEPTANCE_REPORT.md` (ACCEPT WITH CONDITIONS) |
| **Loại tài liệu** | **DESIGN-ONLY.** Không sửa source, schema, prompt, skill, test. Không bắt đầu Phase 2. |
| **Ngày** | 2026-11-06 |

> **Ghi chú về cấu trúc.** Cấu trúc được yêu cầu bị cắt sau `## 4. F2 → ### Exact Spec`. Tôi hoàn thiện phần 4 đối xứng với phần 3 (`Exact Spec Binding`, `Files to Change`, `Regression Tests`, `Compatibility and Recovery`, `Residual Risk`) rồi bổ sung mục 5–8 cho F6, F3/F4/F5, danh sách thay đổi hợp nhất và phần xin duyệt.

---

## 1. Executive Summary

- **Trạng thái nghiệm thu hiện tại:** ACCEPT WITH CONDITIONS. Hai điều kiện F1 và F2 vẫn mở; không điều nào đã được triển khai.
- **Phạm vi đề xuất:** F1 (an toàn revise brief) và F2 (tính toàn vẹn của việc con người duyệt spec) nằm trong phạm vi remediation Phase 1. F6 (fixture non-UI) đi kèm vì nó là bằng chứng runtime cho chính tuyên bố của commit Phase 1. F3 chuyển sang Phase 2. F4 hoãn. F5 tách thành hạng mục riêng.
- **Kết luận quan trọng nhất của đợt điều tra này:** F1 **nghiêm trọng hơn** mức mà audit trước ghi nhận. Audit trước mô tả F1 là thiếu một điều kiện tiên quyết về thứ tự gọi tool. Thực tế `pausedAt` là một **soft lock** và không chứng minh được peer đã ngừng ghi: agent chạy ở permission mode không-giám-sát của provider (`server/runtime/agent-gateway-helpers.ts:91-95` → `server/project-prompts/agent-settings.ts:22-24`), nên `decidePermission` chỉ được hỏi khi provider chịu hỏi; chính file đó tự gọi mình là *"Soft write-lock"* (`server/hooks/permissions.ts:1`). Bus **không** có kiểm tra `pausedAt` nào (`server/pipeline/tool-handlers.ts:61-124`), nên peer đang pause vẫn gọi được `slp_stage_report`. Và cơ chế "ngắt lượt" chỉ là `paseo.agents.ref(id).send(text)` (`server/runtime/agent-gateway.ts:280-287`), với chú thích của chính nó: *"send() resolves once the prompt is accepted, not when the turn finishes"* — lại còn bị `.catch(() => undefined)` nuốt lỗi (`server/pipeline/peer-pause.ts:133`).
- **Kết luận quan trọng thứ hai:** F2 **không bị blocked**. Repo đã có đúng một trust boundary dành cho con người: RPC của plugin, chỉ gọi được từ UI của plugin (`shared/rpc.ts:136-148`, `server/rpc-handlers.ts:175-179`, `client/components/pipeline-detail.tsx:165-199`), và agent không với tới được vì agent chỉ có token MCP bus với catalogue `BUS_TOOL_DEFINITIONS`. Tiền lệ đã chạy thật: `approveGateRpc`, `approvePipelineGateRpc`, `approveMainRpc`. Không cần phát minh API Paseo nào.
- **Rủi ro chính:** (a) mọi thay đổi F1/F2 đều chạm hành vi tool `slp_*` nên kích hoạt lockstep AGENTS.md §1; (b) một kiểm tra cấu trúc nội dung spec (Option A của F2) sẽ **phá** chính test tương thích mà commit Phase 1 vừa khóa; (c) suite đỏ sẵn (F5) làm giảm tín hiệu regression của chính đợt remediation này.
- **Khuyến nghị cuối:** duyệt **F1 Option B** và **F2 Option B**, triển khai theo 3 commit tách biệt (F1, F2, F6), và xử lý F5 **trước** để có suite xanh làm nền đối chứng. Không triển khai gì cho tới khi Manager duyệt.

---

## 2. Repository Baseline

| Mục | Giá trị |
|---|---|
| Nhánh | `an_dev` |
| HEAD SHA | `e6be53d435779331db371b3151b6e4ae5718faa1` |
| Baseline SHA | `e6be53d` (trùng HEAD) |
| Remote | `origin/an_dev` = `e6be53d` (đã đồng bộ) |
| Working tree | Sạch với file đã theo dõi. Một file chưa theo dõi: `PHASE1_ACCEPTANCE_REPORT.md` |
| Commit cha | `95ee338` *Document how SLP specs are authored and link it from README* |

### Kiến trúc liên quan

**Lưu trữ.** `RunStore.mutate` (`server/store/run-store.ts:56-69`) đồng bộ: chạy mutator, cập nhật `updatedAt`, ghi SQLite trong `transaction()`, và khi mutator ném lỗi thì `Object.assign(run, beforeMutation)` hoàn nguyên object sống. Toàn bộ `Run` được lưu dưới dạng **một blob JSON** ở cột `payload` và đọc lại bằng `RunSchema.parse` (`server/store/run-repository.ts:9,30-32`). Hệ quả then chốt cho cả hai thiết kế dưới đây: **thêm field mới có `.default()` không cần migration SQL và không cần nâng `PRAGMA user_version`** — hàng cũ vẫn parse được.

**Trust boundary.** Hai mặt tiếp xúc hoàn toàn tách biệt:

| Mặt tiếp xúc | Ai gọi được | Xác thực | Catalogue |
|---|---|---|---|
| MCP bus `slp-bus` | chỉ agent | token per-agent (`server/store/run-store.ts:71-79`) | `BUS_TOOL_DEFINITIONS` (`server/bus/tool-schemas.ts`), lọc theo role tại `server/pipeline/tool-handlers.ts:90` |
| Plugin RPC | chỉ UI của plugin | không có token agent; handler nhận `paseo` holder (`server/rpc-handlers.ts`) | `shared/rpc.ts` |

Agent **không** có đường nào gọi RPC. Đó là lý do một nút trên UI gắn với RPC là bằng chứng uỷ quyền thật, còn một tham số tool do agent truyền thì không.

**Cơ chế cổng người đã tồn tại.** `PipelineGateSchema` (`shared/pipeline.ts:195-201`) với `kind: "after_stage" | "before_integration"`; mở theo run mode tại `server/pipeline/stage-engine.ts:455-467`; đóng bằng `approvePipelineGate` (`server/pipeline/stage-control.ts:135-157`) qua RPC `slp.pipeline.approve_gate`. Khi cổng mở, engine còn mail cho Supervisor: *"Tell the human to open SLP Orchestrator and approve the pipeline gate"* (`stage-engine.ts:467`). Run mode là `STEP_BY_STEP_DEBUG | SEMI_AUTO | FULL_AUTO` (`shared/roles.ts:36-38`), được snapshot trên run và đổi được qua `setRunModeRpc`.

**Không có API "hỏi con người" nào của Paseo.** Tôi đã kiểm `node_modules/@getpaseo/plugin/dist` và `@getpaseo/protocol/dist`: không có API push cho human prompt/dialog ở tầng plugin. Paseo có permission request `kind: "question"`, nhưng SLP **chủ động từ chối** nó: *"No human is available. Decide yourself or call slp_escalate."* (`server/hooks/permissions.ts:149-151`). Vì vậy mọi thiết kế phải dựa vào UI của chính plugin (đã poll 3 giây, `client/use-run.ts:71-80`), không dựa vào thông báo đẩy.

---

## 3. F1 — Brief Revision Safety

### Current Behavior

Đường đi của ba tool, theo đúng source:

**`slp_pause_peers` → `pauseStagePeers` (`server/pipeline/peer-pause.ts:89-147`)**

1. `resolveLeadPipelineAndStage` (`:25-57`) suy ra pipeline từ `pipelineId` tường minh, `callerRecord.pipelineId`, hoặc tìm pipeline mà caller làm Lead/forked Lead; cưỡng chế ownership tại `:44-51`; chọn **stage đang chạy** `stages[currentStageIndex]` tại `:52-56`.
2. `selectTargetStagePeers` (`:61-86`) mặc định lấy **toàn bộ** `stage.peerAgentIds`, hoặc subset do Lead truyền; ném lỗi nếu peer không thuộc stage (`:73`) hoặc **đã archive** (`:77-79`).
3. Trong một `mutate` (`:100-124`): set `pausedAt`, `pausedReason`, xoá `awaitingTool`/`awaitingSince`/`nudges`, push message `[PAUSED BY LEAD]` vào stage, và **lọc mailbox** bỏ mọi mail chưa gửi cho peer bị pause (`:122-123`).
4. Ngoài transaction (`:127-134`): với từng peer gọi `ctx.gateway.prompt(...)` kèm chỉ thị *"Stop all file edits and shell commands immediately"*, **bọc `.catch(() => undefined)`**.
5. `logEvent` kind `peers.paused` (`:137-144`).

**`slp_revise_brief` → `reviseBrief` (`server/pipeline/stage-control.ts:51-84`)**

Chỉ có ba kiểm tra: `isPipelineLeadRole(caller.role)` (`:57`), tồn tại `pipelineId` (`:62`), và ownership (`:64-67`). Rồi `mutate` ghi `brief`, `briefLockedAt`, `updatedAt` (`:69-74`) và `logEvent` kind `brief.revised` với `from: caller.agentId` + `input.reason` (`:75-82`). Chuỗi trả về chỉ **gợi ý**: *"If stage peers are paused, call slp_resume_peers…"* (`:83`). **Không có bất kỳ kiểm tra nào về trạng thái pause của peer.**

**`slp_resume_peers` → `resumeStagePeers` (`:150-201`)**: xoá `pausedAt`/`pausedReason`, push `[RESUMED BY LEAD]`, và enqueue stage mail chứa brief hiện hành (`formatBrief`) với `awaitTool: "slp_stage_report"`.

`pausedAt` **có** tác dụng ở ba chỗ: permission hook coi stage không còn current (`server/hooks/permission-handler.ts:27`), mailbox không giao mail (`server/runtime/mailbox.ts:35`), lifecycle hook không nudge (`server/hooks/lifecycle-hooks.ts:27`).

### Confirmed Risks

Trả lời trực tiếp 8 câu hỏi được yêu cầu:

**1. `slp_revise_brief` có thể đổi brief đã khóa khi developer peer đang hoạt động? — CÓ.** Không có kiểm tra nào ở `stage-control.ts:51-84`. Ngược lại, `approveStage` **chặn cứng** việc thay brief đã khóa (`:30-32`) — tức engine bảo vệ đường này mà bỏ trống đường kia.

**2. `pausedAt` có bảo đảm mọi thao tác ghi đang chạy đã dừng? — KHÔNG.** Bốn lý do độc lập, tất cả có nguồn:

- **Permission mode không-giám-sát.** Agent được tạo với `modeId: permissionModeFor(provider)` (`agent-gateway.ts:216`), tức `unattendedModeForProvider` (`agent-gateway-helpers.ts:91-95`), ví dụ `antigravity` → `"full-access"` (`agent-settings.ts:22-24`). Provider ở mode này có thể **không phát permission request** cho file write, nên hook không bao giờ chạy và `pausedAt` không chặn gì. `permissions.ts:1` tự mô tả: *"Soft write-lock: every permission request is answered by this pure policy"* — chính sách chỉ *trả lời* request, không *tạo ra* request.
- **Shell đang chạy vẫn chạy.** `pausedAt` không giết process. Repo có cơ chế nhìn thấy shell đang chạy (`ctx.gateway.activeShellCall`, `agent-gateway.ts:304-308`) nhưng `pauseStagePeers` **không dùng**.
- **Bus không khoá.** `resolveCaller` chỉ loại `archivedAt` (`tool-handlers.ts:65`); `dispatch` recheck cũng chỉ `archivedAt` (`:82`). Peer đang pause vẫn gọi được `slp_stage_report` và nộp kết quả làm theo brief cũ.
- **Lệnh "ngắt" không được xác nhận.** `ctx.gateway.prompt` = `paseo.agents.ref(agentId).send(text)` (`agent-gateway.ts:281-287`). Chú thích ngay trên nó: *"send() resolves once the prompt is accepted, not when the turn finishes"*. `shell-watchdog.ts:360` có comment khẳng định gửi message sẽ ngắt lượt, nhưng đó là **giả định về hành vi Paseo, không phải bảo đảm được kiểm chứng trong repo**. Thêm nữa `peer-pause.ts:133` nuốt mọi lỗi gửi, nên pause vẫn báo thành công khi việc ngắt thất bại hoàn toàn.

**3. Nếu peer đang chạy shell lúc pause? —** `pausedAt` được ghi, mail bị lọc, một message được gửi vào session. Process shell **vẫn tiếp tục** tới khi tự xong hoặc provider thực sự ngắt lượt. Nếu shell đó là `npm test` thì vô hại; nếu là một script sinh code hoặc `git commit` thì nó ghi dưới brief cũ sau khi pause đã "thành công".

**4. Race condition giữa pause / revise / resume? — CÓ, một TOCTOU rõ ràng.** Cả `pauseStagePeers` và `resumeStagePeers` đọc `initialRun` (`:94`, `:155`), validate pipeline/stage/peers trên **snapshot đó**, rồi mới vào `mutate` và **re-resolve lại** `stages[currentStageIndex]` (`:102`, `:163`). Giữa hai thời điểm, `scheduleRecovery` → `recoverPipelines` chạy bất đồng bộ (`stage-control.ts:13-16`) và có thể đã đóng stage, tăng `currentStageIndex`. Khi đó `pausedAt` được ghi lên peer của stage **đã đóng**, còn `mutableStage?.messages` nhận message của stage **mới**. `reviseBrief` cũng resolve ngoài rồi re-resolve trong `mutate` (`stage-control.ts:63,70`).

**5. Lead có thể pause một phần rồi revise? — CÓ, và đây là đường lách thẳng.** `selectTargetStagePeers` nhận `peerAgentIds` subset (`:67-69`). Lead pause một advisor rồi revise brief trong lúc developer vẫn chạy — không gì chặn.

**6. Peer đã hoàn thành / archive / không khả dụng / bị ngắt? —** Có một **bug thực sự** ở đây: `selectTargetStagePeers` **ném lỗi** khi gặp peer `archivedAt` (`:77-79`). Vì lời gọi mặc định nhắm *toàn bộ* `stage.peerAgentIds`, một stage chỉ cần có **một** peer đã archive là **không thể pause được nữa** bằng lời gọi mặc định; Lead buộc phải liệt kê subset tay. Peer đã nộp report nhưng còn sống vẫn nằm trong `peerAgentIds` và vẫn phải pause (vô hại). Mọi cổng an toàn đề xuất dưới đây vì vậy **phải coi peer đã archive là trạng thái an toàn**, nếu không cổng sẽ không bao giờ thoả.

**7. Sau restart hoặc hồi sinh agent? —** Phần peer **ổn**: `pausedAt`/`pausedReason` nằm trong `AgentRecordSchema` (`shared/state.ts:34-35`) nên được lưu trong blob JSON và sống qua restart; `run-restore.ts` không xoá chúng; và recovery **không** tái tạo peer đã có vì `stage-engine.ts:232` bỏ qua slot đã điền (`if (current.stage.peerAgentIds[peerIndex]) continue`). Phần Lead **lỏng hơn**: Lead thay thế có `agentId` mới và `pausedAt: null` (`agent-gateway.ts:126`), và `resolveLeadPipelineAndStage` chấp nhận `run.masterLeadAgentId` (`peer-pause.ts:46`), nên một Lead mới có thể `slp_resume_peers` các peer mà nó chưa từng pause. Đây là hệ quả cố ý của việc ownership tính theo vai trò, không phải theo danh tính — chấp nhận được, nhưng là lý do audit event phải ghi danh tính (hiện đã ghi).

**8. Có thể làm brief revision atomic so với state runtime? — CÓ.** `RunStore.mutate` đồng bộ, bọc `writeRun` trong `transaction()`, và rollback object sống khi mutator ném (`run-store.ts:56-69`). Nếu đưa **cả** việc kiểm tra cổng an toàn **và** việc ghi brief vào **một** mutator, mọi lỗi sẽ rollback nguyên trạng. Ngoại lệ duy nhất: `logEvent` ghi vào `comm_logs` ngoài transaction đó (`run-store.ts:89-93`) — append-only, chấp nhận được, nhưng phải nêu rõ.

### Option A — Cổng trạng thái thuần (state-only gate)

`reviseBrief` từ chối khi còn peer của stage hiện tại chưa pause.

- Kiểm tra: với mọi `agentId` trong `stage.peerAgentIds`, nếu `run.agents[id]` tồn tại, **không** `archivedAt`, và `pausedAt === null` → `ToolError` liệt kê các peer đó.
- Đồng thời sửa `selectTargetStagePeers` để **bỏ qua** peer đã archive thay vì ném lỗi (Q6).
- Không thêm field schema, không I/O, không chạm bus, không chạm permission.

**Đóng được:** câu 1, 5 (partial pause), 6 (bug archive), và 8 nếu đặt kiểm tra trong mutator.
**Không đóng được:** câu 2, 3, 4 — `pausedAt` vẫn chỉ là soft lock, shell vẫn chạy, bus vẫn nhận `slp_stage_report` từ peer đang pause.

### Option B — Pause được xác nhận + khoá đường ghi (verified quiesce)

Ba thành phần, đều tối thiểu:

**B1. Trạng thái pause được xác nhận.** Thêm `AgentRecord.pauseConfirmedAt: z.string().nullable().default(null)` (`shared/state.ts`). Trong `pauseStagePeers`, sau khi gửi lệnh ngắt, poll **bằng cơ chế đã có** — `ctx.gateway.liveStatuses(runId)` trả `status: "initializing" | "idle" | "running" | "error" | "closed"` (`agent-gateway.ts:31-36,312-353`) và `ctx.gateway.activeShellCall(agentId)` (`:304-308`) — cho tới khi peer ở `idle`/`closed`/`error` **và** không còn shell đang chạy, với timeout có chặn (đề xuất 30 giây, poll 1 giây). Peer nào đạt trạng thái im lặng thì set `pauseConfirmedAt`; peer nào không đạt thì để `null` và **nêu đích danh trong chuỗi trả về** để Lead biết phải `slp_handle_peer_shell` hoặc `slp_escalate`. Việc gửi lệnh ngắt **không còn** bị `.catch(() => undefined)`: lỗi gửi được ghi log và khiến peer đó không được xác nhận.

**B2. Cổng an toàn của `reviseBrief`.** Giống Option A nhưng điều kiện mạnh hơn: với mọi peer **còn sống** của stage hiện tại phải có `pausedAt !== null` **và** `pauseConfirmedAt !== null`. Peer `archivedAt` được coi là an toàn. Toàn bộ kiểm tra nằm **trong** mutator để hưởng rollback (Q8).

**B3. Khoá đường ghi tại bus.** Trong `dispatch` (`server/pipeline/tool-handlers.ts:80-90`), nếu `lookup.agentRecord.pausedAt` khác null thì chỉ cho phép tập tool đọc + `slp_escalate` (`slp_get_run`, `slp_get_pipeline`, `slp_list_pipelines`, `slp_await_answer`, `slp_answer`, `slp_escalate`), và từ chối `slp_stage_report` kèm thông báo rõ: peer đang pause, chờ brief mới. Không xung đột với resume vì `resumeStagePeers` xoá `pausedAt` **trước** khi enqueue mail đòi `slp_stage_report`.

**Đóng được:** câu 1, 2 (phần kiểm chứng được: không còn tin lệnh gửi là bằng chứng dừng), 3 (shell đang chạy ngăn việc xác nhận), 5, 6, 8.
**Không đóng hoàn toàn:** câu 2 ở mức tuyệt đối — không cơ chế nào trong repo *giết* được một process con của provider. B1 biến điều đó thành **thất bại hiện rõ** (peer không được xác nhận → revise bị từ chối) thay vì **thành công giả**.

Câu 4 (TOCTOU) được xử lý **chung cho cả hai option**: chuyển `resolveLeadPipelineAndStage` + `selectTargetStagePeers` vào bên trong `mutate` ở cả `pauseStagePeers` và `resumeStagePeers`, để validate và ghi nằm trong cùng một transaction.

### Comparison

| Tiêu chí | Option A | Option B |
|---|---|---|
| Developer đang chạy không thể tiếp tục dưới brief cũ | một phần (soft lock) | **có, kiểm chứng được** |
| Brief khóa không đổi được trước khi peer an toàn | có (theo `pausedAt`) | **có (theo `pauseConfirmedAt`)** |
| Partial pause không lách được cổng | có | có |
| Peer nộp việc theo brief cũ bị chặn | không | **có (B3)** |
| Shell đang chạy được phát hiện | không | **có** |
| Ownership / authorization giữ nguyên | có | có |
| Hồi phục sau restart | có (`pausedAt` đã lưu) | có (cả hai field trong blob JSON) |
| Audit ai revise và vì sao | đã có, cần làm dày | đã có, cần làm dày |
| Thêm field schema | 0 | 1 (`.default(null)`, không migration) |
| Thêm I/O vào đường pause | 0 | poll có chặn ≤ 30 s |
| Số file source đổi | 2 | 4 |
| Rủi ro hồi quy | rất thấp | thấp–trung bình (pause trở thành async có timeout) |

### Recommended Design

**Option B**, trọn gói B1+B2+B3 cộng bản sửa TOCTOU, trong **một** commit.

Lý do chọn B thay vì A: cổng của Option A hoàn toàn là **tập con** của cổng Option B, nên làm A trước rồi B sau sẽ phải viết lại cùng một đoạn kiểm tra và cùng một bộ test hai lần. Quan trọng hơn, yêu cầu thiết kế nói rõ *"No active developer can continue writing under an outdated brief"* và *"Do not assume that sending an interrupt automatically proves process termination"* — Option A **không** thoả cả hai: nó tin `pausedAt` là bằng chứng dừng, mà mục 3.2 đã chứng minh điều đó sai.

Nếu Manager muốn giảm phạm vi tối đa, thứ tự cắt được là **bỏ B3 trước** (chỉ còn B1+B2): vẫn chặn được revise khi peer chưa thực sự im lặng, nhưng mất lớp chặn peer nộp việc cũ.

**Audit làm dày (thuộc cả hai option).** `logEvent` kind `brief.revised` hiện chỉ có `${pipeline.name}: ${input.reason}`. Bổ sung vào `summary`: `briefLockedAt` cũ, số criterion trước/sau, và danh sách peer đã được xác nhận pause tại thời điểm revise. `from` đã là `caller.agentId`. Thêm một event `brief.revise_blocked` với `outcome: "blocked"` khi cổng từ chối, để lần thử lách để lại dấu vết.

### State Transitions

Trạng thái một stage peer trong vòng revise (đề xuất; `archived` là trạng thái hấp thụ):

```text
                    slp_pause_peers (B1: gửi ngắt + poll xác nhận)
   active ──────────────────────────────────────────────┐
     ▲                                                  │
     │                                      ┌───────────┴───────────┐
     │                                      │ quiesce trong timeout │
     │                                      └───────┬───────┬───────┘
     │                                         có   │       │   không
     │                                              ▼       ▼
     │                                    pause_confirmed  pause_unconfirmed
     │                                    (pausedAt≠null,  (pausedAt≠null,
     │                                     confirmed≠null)  confirmed=null)
     │                                              │       │
     │  slp_resume_peers                            │       │
     └──────────────────────────────────────────────┘       │
                                                            │
   slp_revise_brief:  CHO PHÉP  ⇐ mọi peer còn sống ở pause_confirmed hoặc archived
                      TỪ CHỐI   ⇐ còn bất kỳ peer ở active hoặc pause_unconfirmed
```

Bất biến của pipeline: `brief` và `briefLockedAt` chỉ đổi khi (a) `approveStage` đóng stage planning lần đầu và `briefLockedAt === null` (`stage-control.ts:30-32,37-41`), hoặc (b) `reviseBrief` và cổng an toàn ở trên thoả. Cả hai nhánh ghi trong một `mutate`.

### Files to Change

| File | Thay đổi | Ghi chú |
|---|---|---|
| `shared/state.ts` | thêm `pauseConfirmedAt` vào `AgentRecordSchema` (sau `pausedReason`, dòng ~35) | `.default(null)` → không migration SQL, không nâng `user_version` |
| `server/pipeline/peer-pause.ts` | B1 (poll xác nhận, không nuốt lỗi gửi), Q6 (bỏ qua peer archive thay vì ném), sửa TOCTOU ở cả pause và resume; `resumeStagePeers` xoá cả `pauseConfirmedAt` | file đổi nhiều nhất |
| `server/pipeline/stage-control.ts` | B2 (cổng trong mutator của `reviseBrief`) + audit dày hơn + event `brief.revise_blocked` | không chạm `approveStage`, `resumePipeline`, `relayHumanDecision`, `approvePipelineGate` |
| `server/pipeline/tool-handlers.ts` | B3 (khoá tool ghi khi `pausedAt`) | chỉ thêm nhánh chặn trong `dispatch`; **không** đổi `roles` hay `input` của tool nào |
| `server/bus/tool-schemas.ts` | cập nhật `description` của `slp_revise_brief` và `slp_pause_peers` cho đúng hành vi mới | chỉ chuỗi mô tả |
| `server/prompts/default-workflows.ts` | `master_lead`: nêu rõ pause phải được xác nhận, và phải làm gì khi một peer không im lặng | lockstep AGENTS.md §1 mục 2 |
| `server/skills/slp-manager/skill-markdown.ts` | mục 1 bullet brief và mục 4 checklist LEAD item 5 | lockstep AGENTS.md §1 mục 3 |

**Không chạm:** MCP bus transport (`server/bus/http-mcp.ts`), schema SQLite (`server/store/database.ts`), `server/hooks/permissions.ts`, pipeline execution (`stage-engine.ts`), QA scoring (`verify-loop.ts`, `qa/*`), merge (`finalize-pipeline.ts`), provider adapter (`agent-gateway.ts`).

### Regression Tests

Mở rộng `tests/flow-brief-revision.test.ts` (đã có fixture `SINGLE_DEVELOPER_PIPELINE` + `SAMPLE_BRIEF`):

1. **Từ chối khi chưa pause** — định nghĩa pipeline, gọi `slp_revise_brief` ngay: `isError === true`, thông báo nêu đích danh `slp_pause_peers` và agentId của developer; `pipeline.brief` **không đổi**; `pipeline.briefLockedAt` **không đổi**.
2. **Từ chối khi pause một phần** — pipeline 2 peer (dùng `DEFAULT_PIPELINE` ở stage planning), pause **một** peer rồi revise: `isError === true`, nêu peer còn lại.
3. **Cho phép khi pause toàn bộ đã xác nhận** — pause toàn bộ, kiểm `pauseConfirmedAt` khác null, revise thành công, `brief.criteria` đổi, `briefLockedAt` tiến lên.
4. **Peer archive được coi là an toàn** — archive một peer của stage, pause phần còn lại, revise thành công (test này đồng thời khoá bản sửa bug Q6).
5. **Peer đang pause không nộp được stage report** — pause rồi gọi `slp_stage_report` từ peer: `isError === true`; sau `slp_resume_peers` thì gọi lại thành công (chứng minh B3 không làm hỏng vòng resume).
6. **Rollback khi cổng từ chối** — sau một revise bị từ chối, `pipeline.brief`, `briefLockedAt`, `updatedAt` của pipeline giữ nguyên giá trị trước đó (chứng minh tính atomic Q8).
7. **Audit** — `flow` tail log chứa `brief.revised` với `from` là Lead và reason, và chứa `brief.revise_blocked` với `outcome: "blocked"` cho lần bị từ chối.
8. **Tương thích ngược brief** — giữ nguyên `describe("brief schema compatibility")` đã có ở `tests/flow-brief-revision.test.ts`; không được sửa.
9. **Lockstep skill** — thêm assertion vào `tests/slp-manager-skill.test.ts`: SKILL.md nói pause phải được xác nhận trước khi revise, và mọi `slp_*` được nêu vẫn tồn tại trong `BUS_TOOL_DEFINITIONS`.
10. **Không hồi quy runtime** — chạy lại nguyên trạng: `flow-single-writer`, `flow-gates`, `flow-qa-phase`, `flow-verification`, `flow-collaboration`, `flow-peer-questions`, `tool-dispatcher`, `permissions`, `mailbox`, `lifecycle-hooks`.

Fixture cần bổ sung: `flow-fixture` hiện mô phỏng gateway; B1 poll `liveStatuses`/`activeShellCall` nên fixture phải trả được trạng thái `idle` (mặc định, để test 3 chạy được) và `running` + một `activeShellCall` (để test một peer không xác nhận được). Đây là điểm **phức tạp nhất** của F1 và cần xác nhận khi triển khai: nếu fake gateway không mô phỏng được, timeout 30 s sẽ làm test chậm — khi đó timeout phải lấy từ settings để test ghi đè xuống mức ms.

### Compatibility and Recovery

- **Schema:** `pauseConfirmedAt` có `.default(null)`; run cũ parse ra `null`. Vì `reviseBrief` chỉ yêu cầu `pauseConfirmedAt` cho peer **còn sống của stage đang chạy**, một run cũ đang có peer sống sẽ cần pause lại một lần — đúng mong muốn, vì ta không có bằng chứng im lặng cho peer đó.
- **Không migration:** blob JSON + `RunSchema.parse` (`run-repository.ts:9`). Không nâng `PRAGMA user_version`.
- **Wire contract:** `slp_pause_peers`, `slp_revise_brief`, `slp_resume_peers` giữ nguyên `input` schema và `roles`. Chỉ hành vi từ chối và chuỗi trả về đổi. Không tool mới.
- **Recovery:** cả `pausedAt` và `pauseConfirmedAt` được lưu, nên pause-rồi-restart vẫn giữ cổng đóng. Lead thay thế sau hồi sinh vẫn resume được (ownership theo vai trò), và audit event ghi `agentId` thật nên chuỗi pause→revise→resume vẫn truy vết được qua ranh giới restart.
- **Rủi ro:** poll có chặn trong một lời gọi tool. `slp_pause_peers` hiện trả gần như tức thì; sau B1 nó có thể mất tới timeout. Phải đặt timeout vào `shared/settings.ts` cạnh `shellWatchdog` để vận hành điều chỉnh được, và chuỗi trả về phải nói rõ peer nào chưa im lặng.

---

## 4. F2 — Human Approval Integrity

### Current Behavior

Toàn bộ vòng đời Supervisor → Product Spec → duyệt → `slp_delegate` → Lead → QA:

1. **Chỉ thị.** `DEFAULT_WORKFLOWS.supervisor` (`server/prompts/default-workflows.ts:25-32`) bắt Supervisor trình từng bản nháp trong chat và *"call slp_delegate only after the human explicitly approves it"*. `supervisorBriefing()` (`server/prompts/messages.ts:4-7`) nhắc lại mỗi run.
2. **Kiểm tra máy.** `DelegationSubmissionSchema` (`shared/pipeline.ts:107-133`) chỉ đòi: có `productSpec` cho **mọi** feature, và mỗi cái dài ≥ `PRODUCT_SPEC_MIN_LENGTH = 80` (`:94-95`). Hết.
3. **Lan truyền.** `delegate` (`server/pipeline/delegation.ts:117-234`) lưu `run.productSpec` (`:181`), gán `leadRecord.featureSpec` cho từng Lead (`:193`), đưa spec vào briefing Lead (`:206,214` → `messages.ts:45-46`) và vào roster QA Lead (`qa-messages.ts:20,36`).
4. **Chỉ thị dành cho Lead.** `messages.ts:46` nói Lead *"treat its assumptions as the decisions they record"*, và `default-workflows.ts:47` nói spec là hợp đồng.

Trả lời 10 câu hỏi:

**1. Việc con người duyệt hiện được biểu diễn thế nào? —** Không được biểu diễn. Không có field, không có event, không có trạng thái. Chỉ có một câu trong prompt.

**2. Là trạng thái runtime hay chỉ chỉ thị prompt? — Chỉ chỉ thị prompt.** Không có gì trong `RunSchema` (`shared/state.ts:126-179`) ghi nhận việc duyệt.

**3. Spec chưa duyệt có delegate được không? — CÓ.** Bất kỳ chuỗi ≥ 80 ký tự đều qua. Repo **chủ động** khoá điều này bằng test: `tests/flow-brief-revision.test.ts` khẳng định `"A".repeat(80)` là `productSpec` hợp lệ — cố ý, để bảo vệ tương thích wire contract.

**4. Supervisor có thể sửa spec sau khi duyệt? — CÓ, không để lại dấu.** Supervisor trình bản X trong chat rồi truyền bản Y vào `slp_delegate`; engine không có bản X để so.

**5. Engine có chứng minh được nội dung đã được duyệt? — KHÔNG.** Không có bản ghi nội dung nào trước thời điểm `slp_delegate`.

**6. Duyệt phủ toàn bộ spec hay từng feature? —** Hiện không phủ gì. Khi làm, phải là **từng feature**: `tasks[].productSpec` là per-feature (`shared/pipeline.ts:98-105`) và mỗi Lead chỉ nhận spec của mình (`delegation.ts:193`), đã được test khoá (`flow-product-spec.test.ts:55-77`).

**7. Sau restart / recovery? —** `run.productSpec` và `agent.featureSpec` đều được lưu, nên *nội dung* sống sót; nhưng vì không có bản ghi duyệt, không có gì để phục hồi. `run-restore.ts:418` truyền lại `productSpec` cho Lead thay thế mà không có khái niệm duyệt.

**8. Thêm việc duyệt mà không phá run hiện có? — CÓ**, nếu cưỡng chế được gắn vào một knob đã được snapshot trên run (xem Recommended Design).

**9. Giữ nguyên được hợp đồng `slp_delegate`? — CÓ.** `DelegationSubmissionSchema` không cần đổi field nào; chỉ thêm một `.refine()` / kiểm tra ở handler dựa trên state của run.

**10. Phân biệt giả định nghiệp vụ với quyết định kỹ thuật của Lead? —** Phase 1 đã đặt nền ở tầng prompt: mục 6 của spec là *"Unknowns and assumptions"* của Supervisor (nghiệp vụ), còn `approach` của brief là của Lead (kỹ thuật) (`default-workflows.ts:31,55`). Ở tầng runtime chúng vẫn là hai chuỗi tự do. Thiết kế dưới đây **không** cố cấu trúc hoá chúng — đó là việc của Phase 2; nó chỉ đảm bảo chuỗi nghiệp vụ *đã được một con người duyệt*.

### Trust Boundary

| Nguồn | Tin được? | Vì sao |
|---|---|---|
| Supervisor nói "người dùng đã duyệt" trong chat | **không** | lời của LLM, không phải bằng chứng |
| Tham số tool do agent truyền (kể cả `approvedBy: "human"`) | **không** | agent soạn mọi tham số; `dispatch` không xác thực nội dung (`tool-handlers.ts:91-92`) |
| Hash của nội dung spec | **không, một mình nó** | hash chứng minh *đồng nhất nội dung*, không chứng minh *uỷ quyền*. Agent tự tính được hash cho văn bản tự viết |
| Nội dung spec có đủ `Given/When/Then` | **không** | LLM sinh được dễ dàng; là kiểm tra chất lượng, không phải uỷ quyền |
| RPC của plugin gọi từ UI của plugin | **có** | không dùng token agent; agent không có đường gọi RPC. Tiền lệ đang chạy: `approveGateRpc`, `approvePipelineGateRpc`, `approveMainRpc` (`shared/rpc.ts:136-161`, `server/rpc-handlers.ts:175-179`) |
| Run mode do người chọn trên UI | **có** | set qua `startRunRpc`/`setRunModeRpc`, snapshot trên run, và đã điều khiển cổng người ở `stage-engine.ts:455` |

Uỷ quyền **chỉ** đến từ hai dòng cuối. Hash là công cụ *ràng buộc*, không phải công cụ *uỷ quyền* — hai vai trò này phải tách bạch trong thiết kế.

### Option A — Kiểm tra cấu trúc nội dung spec

Chính là hành động mà audit trước đề xuất cho F2: đòi `productSpec` có ít nhất một `Given…When…Then` và một dấu hiệu assumptions/unknowns, trả `ToolError` mô tả rõ.

| Phân tích | Kết quả |
|---|---|
| Trust boundary | **không có.** Hoàn toàn nằm trong vùng agent kiểm soát |
| Thẩm quyền duyệt | không ai. Đây là linter, không phải cổng duyệt |
| Chuyển trạng thái | không có state |
| Ràng buộc nội dung chính xác | không |
| Vô hiệu khi nội dung đổi | không áp dụng |
| Delegation nhiều feature | áp được từng feature |
| Lưu trữ / hồi phục | không cần |
| Tương thích ngược | **PHÁ.** Mâu thuẫn trực tiếp với test tương thích đã khóa ở `tests/flow-brief-revision.test.ts` (`"A".repeat(80)` phải hợp lệ) và sẽ phá `delegateToLead` nếu `SAMPLE_PRODUCT_SPEC` thiếu mục assumptions — nó **đang** thiếu (`tests/helpers/flow-steps.ts:66-71` chỉ có Screens/States/Given/Rules/Out of scope) |
| UI / API | không cần |
| Rủi ro migration | thấp, nhưng mọi run đang lưu dở có thể bị chặn ở lần delegate tiếp theo |
| Độ phức tạp | rất thấp |

**Kết luận:** Option A **không giải quyết F2**. Yêu cầu thiết kế nói rõ *"Do not confuse content validation with human approval"* và *"An LLM statement such as 'the user approved this' is not sufficient evidence"* — Option A đúng là thứ bị cảnh báo. Nó còn tốn một lần phá tương thích. **Đề xuất loại bỏ**, và nếu muốn, đưa về Phase 2 như một *warning* không chặn trong `project-validator`.

### Option B — Bản ghi duyệt tin cậy, ràng buộc theo hash nội dung

Ba phần:

**B1. Tool bus mới `slp_submit_spec`** (role `supervisor`), input `{ featureName?: string, productSpec: string }`. Handler ghi vào `run.specApprovals` một bản ghi `status: "pending"` với `specHash = sha256(normalize(productSpec))`, `submittedAt`, `submittedBy = caller.agentId`, `featureName`. Nộp lại cho cùng `featureName` **thay thế** bản pending và **vô hiệu** bản approved cũ (chuyển `superseded`). Tool trả về chỉ thị: trình spec trong chat, nói người dùng mở SLP Orchestrator và bấm Approve, rồi **kết thúc lượt**. Đây là tool **không** kết thúc run, giống `slp_notify`.

**B2. RPC + UI duyệt.** `approveProductSpecRpc` (`slp.spec.approve`), input `{ runId, specHash }`, output `{ ok, message }`. Handler (`server/rpc-handlers.ts`) tìm bản ghi pending có `specHash` khớp và set `status: "approved"`, `approvedAt`, `approvedVia: "slp-orchestrator-ui"`. UI: một thẻ trong `client/components/run-detail.tsx` liệt kê spec pending, **hiển thị nguyên văn** nội dung đã nộp, và một nút Approve — y hệt khuôn mẫu cổng pipeline ở `client/components/pipeline-detail.tsx:165-199` và `client/use-run.ts:64-80`. Việc truyền `specHash` (không phải index) đảm bảo người duyệt đúng văn bản đang xem.

**B3. Cổng ở `slp_delegate`.** Trong `delegate` (`server/pipeline/delegation.ts:122-128`), **trước** khi provision QA worktree (`:129`), với mỗi feature tính `sha256(normalize(task.productSpec))` và đòi có bản ghi `status: "approved"` khớp hash. Thiếu hoặc lệch → `ToolError` nói rõ: chưa duyệt, hay đã duyệt bản khác và bản gửi đi đã bị sửa.

| Phân tích | Kết quả |
|---|---|
| Trust boundary | **RPC-chỉ-UI**, giống `approvePipelineGateRpc`. Agent không với tới |
| Thẩm quyền duyệt | con người vận hành SLP Orchestrator |
| Chuyển trạng thái | `pending → approved → superseded`, cộng nhánh `pending → superseded` |
| Ràng buộc nội dung chính xác | **có**, qua `specHash`; `slp_delegate` tính lại trên văn bản thực gửi |
| Vô hiệu khi nội dung đổi | **có**, tự động: sửa một ký tự là hash lệch và cổng từ chối |
| Delegation nhiều feature | **có**, một bản ghi mỗi `featureName`; dạng single-feature dùng `featureName: null` |
| Lưu trữ / hồi phục | blob JSON, sống qua restart; bản ghi gắn với run nên Lead hồi sinh không cần duyệt lại |
| Tương thích ngược | run cũ có `specApprovals: []`; xem Recommended Design về cách bật cưỡng chế |
| UI / API | 1 RPC mới + 1 thẻ UI; **không** API Paseo mới |
| Rủi ro migration | không có SQL migration; rủi ro là vận hành (người dùng phải biết bấm nút) |
| Độ phức tạp | trung bình: 1 tool bus, 1 RPC, 1 thẻ UI, 1 field schema, lockstep AGENTS.md §1 |

### Comparison

| Tiêu chí | Option A | Option B |
|---|---|---|
| Cưỡng chế uỷ quyền thật của con người | **không** | **có** |
| Chứng minh được nội dung đã duyệt | không | có (hash) |
| Chặn Supervisor đổi spec sau khi duyệt | không | có |
| Dùng API/khuôn mẫu đã tồn tại | có | có (`approvePipelineGateRpc`) |
| Phá test/tương thích đã khóa | **có** | không (nếu cưỡng chế theo run mode) |
| Số mặt tiếp xúc mới | 0 | 1 tool bus + 1 RPC + 1 thẻ UI |
| Thoả yêu cầu bảo mật của đề bài | **không** | có |

### Recommended Design

**Option B**, với cưỡng chế gắn vào **run mode** đã có:

- `STEP_BY_STEP_DEBUG` và `SEMI_AUTO`: **bắt buộc** mọi feature có bản ghi `approved` khớp hash trước `slp_delegate`.
- `FULL_AUTO`: **không** bắt buộc; `slp_submit_spec` vẫn ghi bản ghi `pending` để lưu vết nội dung Supervisor khẳng định đã trình, nhưng `slp_delegate` không chặn.

Vì sao gắn vào run mode thay vì một setting mới: `run.mode` đã là knob "người trong vòng lặp" duy nhất của hệ, do người chọn trên UI, được snapshot trên run, và **đã** điều khiển cổng người ở `stage-engine.ts:455-467`. Ngữ nghĩa khớp chính xác: hai mode kia nghĩa là "dừng lại hỏi tôi", `FULL_AUTO` nghĩa là "đừng dừng". Thêm nữa, toàn bộ flow fixture chạy `createFlow({ mode: "FULL_AUTO" })`, nên **không test hiện có nào bị phá** và không cần sửa `delegateToLead`.

**Phải nói thẳng:** trong `FULL_AUTO` vẫn **không có** việc con người duyệt. Đó là đánh đổi có ý thức, không phải lỗ hổng bị bỏ qua: người vận hành chọn mode không-giám-sát thì nhận hệ quả không-giám-sát, giống như hiện tại `FULL_AUTO` đã bỏ qua cổng tích hợp. Nếu Manager muốn cưỡng chế cả `FULL_AUTO`, đó là một quyết định riêng cần duyệt riêng, vì nó buộc phải sửa mọi flow fixture và sẽ chặn mọi run đang lưu dở — tôi khuyến nghị để việc đó cho Phase 2 sau khi helper test đã có đường nộp-và-duyệt spec.

**Không bị blocked.** Không phụ thuộc nào còn thiếu: trust boundary (RPC), nơi lưu (blob JSON), khuôn mẫu UI (thẻ cổng pipeline), và đường nhắc người dùng (`stage-engine.ts:467` đã làm việc này cho cổng pipeline) đều đã tồn tại và đã chạy trong production code.

### Approval State Machine

```text
                       slp_submit_spec(featureName, productSpec)
      (không có bản ghi) ──────────────────────────────────► pending(specHash)
                                                               │      │
                        approveProductSpecRpc(runId, specHash)  │      │ slp_submit_spec lại
                        ── chỉ gọi được từ UI plugin ──────────►│      │ cùng featureName
                                                               ▼      ▼
                                                          approved  superseded
                                                               │
                                        slp_submit_spec lại    │
                                        cùng featureName ──────┘──► superseded
                                                                     (+ pending mới)

slp_delegate cho feature F ở STEP_BY_STEP_DEBUG | SEMI_AUTO:
   CHO PHÉP  ⇐ ∃ bản ghi { featureName: F, status: "approved", specHash: sha256(normalize(spec gửi đi)) }
   TỪ CHỐI   ⇐ không có bản ghi approved cho F          → "spec chưa được duyệt"
   TỪ CHỐI   ⇐ có approved cho F nhưng hash lệch        → "spec đã bị sửa sau khi duyệt"
slp_delegate ở FULL_AUTO: luôn cho phép (hành vi hiện tại giữ nguyên)
```

Bất biến: `status` chỉ tiến theo một chiều; `approved` không bao giờ quay về `pending`. Mọi lần nộp lại tạo bản ghi mới nên lịch sử duyệt là append-only và audit được.

### Exact Spec Binding

Ràng buộc nội dung phải chịu được khác biệt vô hại về khoảng trắng mà không nới ra thành "gần giống":

- `normalize(text)` = `text.replace(/\r\n/g, "\n").trim()`. Chỉ vậy. **Không** chuẩn hoá chữ hoa/thường, **không** bỏ khoảng trắng giữa dòng, **không** so khớp mờ — mọi nới lỏng thêm đều mở đường cho sửa nội dung mà hash không đổi.
- `specHash = createHash("sha256").update(normalize(text), "utf8").digest("hex")` bằng `node:crypto` (đã dùng trong repo: `randomUUID`, `randomBytes` ở `agent-gateway.ts:3`).
- Bản ghi lưu thêm `specLength` và **nguyên văn** `productSpec` đã nộp, vì UI phải hiển thị đúng văn bản mà người sẽ duyệt. Lưu nguyên văn là bắt buộc: duyệt một hash mà không đọc được nội dung thì không phải duyệt.
- `slp_delegate` tính lại hash trên `task.productSpec` **thực gửi**, không tin hash nào do agent truyền. Không có field hash nào trong `DelegationSubmissionSchema`.
- Nhắc lại cho rõ: hash chỉ chứng minh *"văn bản delegate đúng là văn bản được bấm Approve"*. Việc *"một con người đã bấm"* đến từ việc `status: "approved"` chỉ ghi được bởi handler RPC.

### Files to Change

| File | Thay đổi |
|---|---|
| `shared/state.ts` | `ProductSpecApprovalSchema` mới + `RunSchema.specApprovals: z.array(...).default([])` |
| `shared/rpc.ts` | `approveProductSpecRpc` (`slp.spec.approve`) |
| `server/bus/tool-schemas.ts` | `slp_submit_spec` (role `supervisor`) |
| `server/pipeline/tool-handlers.ts` | map `slp_submit_spec` → handler mới |
| `server/pipeline/spec-approval.ts` *(file mới)* | `submitProductSpec`, `approveProductSpec`, `requireApprovedSpecs`, `productSpecHash` |
| `server/pipeline/delegation.ts` | gọi `requireApprovedSpecs` trước `provisionQaWorkspace` (`:129`) |
| `server/rpc-handlers.ts` | handler cho `approveProductSpecRpc` |
| `client/use-run.ts` | `useRpc(approveProductSpecRpc)` + mutation |
| `client/components/run-detail.tsx` | thẻ "Product specs awaiting approval" + nút Approve |
| `server/prompts/default-workflows.ts` | `supervisor`: nộp bằng `slp_submit_spec`, chờ người bấm Approve, rồi mới `slp_delegate`; cập nhật luật kết thúc lượt |
| `server/prompts/messages.ts` | `supervisorBriefing()`: thêm bước nộp-và-chờ-duyệt |
| `server/skills/slp-manager/skill-markdown.ts` | mục 1 bullet Supervisor, mục 4 checklist SUPERVISOR item 3 + item 8 (turn rule), mục 6 migration item 1 |

**Không chạm:** `DelegationSubmissionSchema` field/type, `PRODUCT_SPEC_MIN_LENGTH`, permission, pipeline execution, QA scoring, merge, provider adapter, schema SQLite.

### Regression Tests

Trong `tests/flow-product-spec.test.ts` (mở rộng) và một `tests/spec-approval.test.ts` mới:

1. **FULL_AUTO không đổi hành vi** — toàn bộ test hiện có của `flow-product-spec`, `flow-handshake`, `flow-completion`, `flow-qa-phase` chạy nguyên trạng, không sửa một dòng. Đây là test tương thích quan trọng nhất của F2.
2. **SEMI_AUTO chặn spec chưa duyệt** — `slp_delegate` trả `isError`, thông báo nêu `slp_submit_spec`; **không agent nào được spawn** (soi `Object.values(run.agents).map(a => a.role)` chỉ còn `["supervisor"]`, theo khuôn mẫu `flow-product-spec.test.ts:31-32`); không worktree QA nào được tạo.
3. **Vòng duyệt đủ** — `slp_submit_spec` → bản ghi `pending` với hash đúng → RPC approve → `slp_delegate` thành công; `run.productSpec` và `featureSpec` của Lead khớp văn bản đã duyệt.
4. **Phát hiện sửa sau duyệt** — duyệt bản X, delegate bản X + một ký tự: `isError`, thông báo nói spec đã bị sửa sau khi duyệt.
5. **Uỷ quyền không giả được** — gọi `slp_submit_spec` rồi `slp_delegate` **không** qua RPC: vẫn bị chặn ở SEMI_AUTO. Và không có tool bus nào đặt được `status: "approved"` (assert `BUS_TOOL_DEFINITIONS` không chứa tool nào làm việc đó).
6. **Nhiều feature** — duyệt 2/3 feature, delegate cả 3: bị chặn, nêu đích danh feature thiếu duyệt (khuôn mẫu `flow-product-spec.test.ts:24-32`).
7. **Nộp lại vô hiệu bản cũ** — approved rồi `slp_submit_spec` lại: bản cũ thành `superseded`, delegate bản mới bị chặn tới khi duyệt lại.
8. **Hồi phục** — sau khi `restoreRun`, `run.specApprovals` còn nguyên và delegate vẫn qua mà không cần duyệt lại.
9. **Run cũ** — parse một payload run không có `specApprovals`: `RunSchema.parse` ra `[]` và run FULL_AUTO vẫn delegate được (chứng minh không cần migration).
10. **Lockstep skill** — `tests/slp-manager-skill.test.ts`: `slp_submit_spec` được nêu trong SKILL.md và tồn tại trong `BUS_TOOL_DEFINITIONS`; checklist SUPERVISOR nói tới bước duyệt; turn rule có `slp_submit_spec`.

### Compatibility and Recovery

- **Không migration SQL.** `specApprovals` có `.default([])`; blob JSON (`run-repository.ts:9,30-32`); không nâng `user_version`.
- **Wire contract `slp_delegate` giữ nguyên.** Không thêm/bớt/sửa field nào của `DelegationSubmissionSchema`. Chỉ thêm một kiểm tra dựa trên state ở handler.
- **Run đang lưu dở.** Run `FULL_AUTO` không bị ảnh hưởng. Run `SEMI_AUTO`/`STEP_BY_STEP_DEBUG` chưa delegate sẽ cần một vòng nộp-và-duyệt — đúng chủ đích. Run đã delegate không bị ảnh hưởng (cổng chỉ ở `delegate`).
- **Hồi phục.** Bản ghi gắn với run nên sống qua restart và `restoreRun`; Lead hồi sinh nhận lại `featureSpec` như hiện nay (`run-restore.ts:418`) mà không cần duyệt lại.
- **Nhắc người dùng.** Dùng lại khuôn mẫu `stage-engine.ts:467`: khi có spec pending, mail cho Supervisor nói bảo người dùng mở SLP Orchestrator. Không cần API push.

### Residual Risk

1. **`FULL_AUTO` vẫn không có duyệt người.** Có ý thức, nêu rõ ở trên. Phase 2 có thể lật mặc định sau khi helper test hỗ trợ vòng duyệt.
2. **Duyệt chứng nhận văn bản, không chứng nhận sự hiểu.** Người có thể bấm Approve mà không đọc. Không cơ chế kỹ thuật nào sửa được; giảm nhẹ bằng việc UI buộc hiển thị nguyên văn và `specHash` gắn vào nút.
3. **Supervisor có thể vòng tránh bằng cách không nộp.** Ở SEMI_AUTO thì `slp_delegate` chặn nên không vòng được. Ở FULL_AUTO thì vòng được — xem rủi ro 1.
4. **Chưa phân biệt được giả định nghiệp vụ với quyết định kỹ thuật ở tầng runtime** (câu 10). Vẫn là hai chuỗi tự do; thuộc Phase 2.

---

## 5. F6 — Non-UI Regression Coverage

Kịch bản đại diện: **một background job dọn dữ liệu kèm migration schema** — không màn hình, không endpoint, nhưng có hành vi quan sát được, có edge case và có cách kiểm chứng độc lập.

### Fixture Content

Thêm vào `tests/helpers/flow-steps.ts`, cạnh `SAMPLE_PRODUCT_SPEC` (`:66-71`):

```text
NON_UI_PRODUCT_SPEC (mô tả nội dung, không phải code sẽ commit)
  Scope: một job nền hằng đêm đánh dấu hoá đơn quá 90 ngày là 'expired',
         cộng một migration thêm cột expired_at. Out of scope: thông báo cho
         người dùng, và mọi thay đổi giao diện.
  Observable behaviors: job chạy mỗi 02:00; mỗi lần chạy ghi một dòng log
         tổng kết số hoá đơn đã đổi trạng thái; chạy lại cùng ngày không đổi
         thêm bản ghi nào (idempotent).
  (KHÔNG có mục surfaces/states — tính năng không có bề mặt người dùng)
  Business rules, data and edge cases: ngưỡng tính theo UTC; hoá đơn đã
         'paid' không bị đổi; khi DB mất kết nối giữa lúc chạy, job dừng và
         không để lại cập nhật một phần.
  Acceptance scenarios:
    GWT-1: Given một hoá đơn 91 ngày ở trạng thái 'open'
           When job hằng đêm chạy Then trạng thái là 'expired' và expired_at
           bằng thời điểm chạy.
    GWT-2: Given một hoá đơn 91 ngày ở trạng thái 'paid'
           When job chạy Then trạng thái không đổi.
    GWT-3: Given job đã chạy xong hôm nay
           When job chạy lại Then không bản ghi nào đổi và log ghi 0.
    GWT-4: Given DB ngắt kết nối giữa lúc chạy
           When job chạy Then không hoá đơn nào bị đổi một phần.
  Unknowns and assumptions: giả định scheduler hiện có chạy được job; chưa
         biết có cần backfill dữ liệu lịch sử hay không — đã hỏi, chờ trả lời.
```

Và một `NON_UI_BRIEF` mà **mỗi `requirement` nêu đích danh một scenario**, vì audit trước ghi nhận `SAMPLE_BRIEF` (`flow-steps.ts:11-16`) có `C1` không trỏ về scenario nào, nên truy vết brief chưa từng được kiểm chứng end-to-end:

```text
approach: migration thêm expired_at; một service job dùng scheduler sẵn có;
          cập nhật trong một transaction; không chạm tầng HTTP.
criteria:
  C1 requirement "GWT-1: hoá đơn open quá 90 ngày thành expired kèm expired_at"
     verification "npm run test -- invoice-expiry (case open-91-days)"
  C2 requirement "GWT-2: hoá đơn paid không bị job đổi"
     verification "npm run test -- invoice-expiry (case paid-untouched)"
  C3 requirement "GWT-3: lần chạy thứ hai trong ngày không đổi bản ghi nào"
     verification "npm run test -- invoice-expiry (case idempotent-rerun)"
  C4 requirement "GWT-4: lỗi DB giữa lúc chạy không để lại cập nhật một phần"
     verification "npm run test -- invoice-expiry (case rollback-on-disconnect)"
inScope:  ["migration expired_at", "service job hết hạn hoá đơn"]
outOfScope: ["thông báo người dùng", "mọi thay đổi UI", "backfill lịch sử"]
```

### Test File Location

`tests/flow-product-spec.test.ts`, thêm một `describe("non-UI feature delegation")`. Lý do đặt cùng file: nó dùng chung `useFlowFixture`, `delegateToLead` và các assertion lan truyền spec mà file đó đã dựng, nên không phải nhân đôi hạ tầng.

### Required Assertions

1. **Delegate sạch, không mục surface** — `slp_delegate` với `NON_UI_PRODUCT_SPEC` trả `isError === false`; spec **không** chứa `"Screens"`/`"States"`; `run.productSpec` khớp nguyên văn.
2. **Hành vi quan sát được có mặt** — `run.productSpec` chứa mục observable behaviors và tính idempotent.
3. **Edge case và lỗi có mặt** — chứa `GWT-4` và mệnh đề "không cập nhật một phần".
4. **Scenario kiểm chứng độc lập được** — mỗi `GWT-n` có mệnh đề `Then` nêu trạng thái quan sát được, không nêu chi tiết nội bộ.
5. **Lan truyền tới Lead** — `flow.mailTo(runId, masterLeadAgentId)` chứa `"Human-Approved Product Spec"` và `GWT-1`; `agents[leadId].featureSpec` khớp.
6. **Lan truyền tới QA** — mail của QA Lead chứa `GWT-1`..`GWT-4` và câu `"turn every Given/When/Then scenario"` (`qa-messages.ts:36`).
7. **Truy vết brief** — định nghĩa pipeline với `NON_UI_BRIEF`, rồi khẳng định **mỗi** `requirement` của brief đã khóa chứa một id `GWT-n` xuất hiện trong `run.productSpec`. Đây là lần đầu truy vết criterion→scenario được kiểm chứng ở runtime chứ không chỉ bằng so khớp chuỗi prompt.
8. **Mail của peer chứa brief đã khóa** — stage mail của developer chứa `C4` và mệnh đề rollback (`formatBrief`, `stage-briefing-sections.ts:6-14`).
9. **Đọc lại được** — `slp_get_run` từ QA Lead trả về đúng `productSpec`.

### Existing Helpers Reuse

Dùng lại được gần hết: `useFlowFixture`, `flow.callAsRole`, `flow.mailTo`, `flow.run`, `definePipeline`, `currentStage`, `eventually`, `SINGLE_DEVELOPER_PIPELINE` (thay `brief` bằng `NON_UI_BRIEF`).

Một thay đổi helper cần thiết: `delegateToLead(flow, runId)` hiện hard-code `SAMPLE_PRODUCT_SPEC` (`flow-steps.ts:73-79`). Thêm tham số thứ ba **có giá trị mặc định** — `delegateToLead(flow, runId, productSpec = SAMPLE_PRODUCT_SPEC)` — nên mọi lời gọi hiện có không đổi.

### Expected Behavior

Không hành vi engine nào đổi. F6 **thuần thêm test**: nó chuyển tuyên bố "tính năng không UI bỏ được mục surface" từ so khớp chuỗi prompt (`flow-product-spec.test.ts:96-101`) thành bằng chứng flow thật qua `slp_delegate` → Lead → QA → brief → mail peer. Nếu test này **thất bại** ngay lần đầu viết, đó là phát hiện mới chứ không phải lỗi fixture, và phải báo lại trước khi sửa.

---

## 6. Remaining Findings

### F3 — Root-role contract drift → **Phase 2, không chặn Phase 1**

Xác nhận lại bằng source: `checkRoles` chỉ duyệt `config.peers` (`server/project-setup/project-validator.ts:74`), nên `config.supervisor`, `config.lead`, `config.qaLead` không bao giờ đi qua kiểm tra `role.unknown_tool` (`:81-83`). `isDefaultCatalog` cũng chỉ so **ID của peer** (`server/project-setup/start-run-guard.ts:17-28`), nên nội dung root file không tham gia cổng Start Run.

**Không chặn Phase 1** vì ba lý do: (a) đây là tính năng **chưa từng tồn tại**, không phải thứ Phase 1 làm hỏng; (b) nó bị loại tường minh khỏi phạm vi audit trước; (c) có giảm nhẹ runtime thật — `supervisorBriefing()` tiêm luật spec và vô hiệu hoá tool `slp_board_*` đã gỡ ở **mọi** run (`server/prompts/messages.ts:4-7`), nên project cũ vẫn nhận luật duyệt-trước-delegate và đúng catalogue tool.

Lưu ý quan hệ với F2: nếu F2 Option B được duyệt, drift của root-role trở nên **đáng chú ý hơn**, vì một `.slp/SUPERVISOR.md` cũ sẽ không biết tới `slp_submit_spec` và Supervisor sẽ đi thẳng tới `slp_delegate` rồi bị chặn ở SEMI_AUTO. Giảm nhẹ nằm sẵn trong thiết kế: thông báo `ToolError` của B3 phải nêu đích danh `slp_submit_spec`, để một Supervisor dùng prompt cũ vẫn tự sửa được trong cùng lượt. Đó là lý do tôi khuyến nghị **không** nâng F3 lên chặn Phase 1, mà xử lý nó như hạng mục Phase 2 với hai việc: mở `checkRoles` cho 3 root definition, và thêm cảnh báo `role.stale_guidance`.

### F4 — Brief criterion traceability → **hoãn, không cưỡng chế runtime bây giờ**

`BriefCriterionSchema` nhận mọi chuỗi không rỗng (`shared/pipeline.ts:41-46`). Cưỡng chế truy vết ở runtime đòi một định dạng id scenario có cấu trúc trong `productSpec` — tức phải cấu trúc hoá Product Spec, đúng thứ Phase 1 **chủ động** không làm và `tests/flow-brief-revision.test.ts` chủ động khoá chiều ngược lại.

Khuyến nghị: **hoãn cưỡng chế**, nhưng lấy phần lợi dễ nhất ngay trong F6 — assertion số 7 ở trên biến truy vết thành thứ được kiểm chứng ở tầng fixture. Rủi ro còn lại thấp vì QA Lead vẫn trình scorecard cho con người xem (`qa-messages.ts`, `humanDecisionRequest`).

### F5 — Ba test fail có sẵn → **xác nhận là lỗi có trước, hạng mục riêng, không sửa trong task này**

Tôi đã **tự kiểm chứng**, không dựa vào báo cáo trước:

| Bằng chứng | Kết quả |
|---|---|
| `npx vitest run tests/flow-run-start.test.ts tests/flow-completion.test.ts` tại HEAD `e6be53d` | 3 failed / 6 passed |
| Cùng lệnh tại commit cha `95ee338`, trong worktree tạm `/tmp` có symlink `node_modules`, đã xoá sau khi chạy | **3 failed / 6 passed — y hệt** |
| `git show --name-only e6be53d` đối chiếu với code cấp phát workspace / hoàn tất pipeline | **không file nào liên quan**: commit chỉ chạm 4 file prompt/skill/schema-comment và 4 file test |

Ba lỗi:

1. `flow-run-start.test.ts:40` — `expect(leadSpec?.workspaceId).not.toBe(delegatedRun.supervisorWorkspaceId)` nhận `'ws-supervisor'`.
2. `flow-run-start.test.ts:60` — `expect(pipeline.workspaceId).not.toBe(run.supervisorWorkspaceId)` nhận `'ws-supervisor'`.
3. `flow-completion.test.ts` — `expected true to be false` trong case merge-conflict/auto-merge.

**Kết luận: lỗi có trước, không phải regression của Phase 1.** Nguyên nhân gốc khả năng cao nằm ở việc cấp workspace trở nên lazy sau đợt refactor role/permission, khiến assertion kỳ vọng workspace riêng cho Lead không còn đúng — nhưng **xác định nguyên nhân gốc và sửa nằm ngoài phạm vi task này** và không được thực hiện ở đây.

**Khuyến nghị thứ tự:** xử lý F5 **trước** F1/F2. Lý do thực dụng: F1 và F2 đều chạm đường delegate và đường stage; nếu suite vẫn đỏ 3 test thì mọi lần chạy sau sẽ phải phân biệt tay giữa đỏ-cũ và đỏ-mới, chính xác là kiểu che tín hiệu mà audit trước cảnh báo.

---

## 7. Consolidated Change List & Sequencing

| # | Hạng mục | Loại | File source | File test | Lockstep AGENTS.md §1 |
|---|---|---|---|---|---|
| 0 | F5 — phân loại và sửa 3 test fail | hạng mục riêng | chưa xác định (cần điều tra riêng) | `flow-run-start`, `flow-completion` | không |
| 1 | F1 — pause được xác nhận + cổng revise + khoá đường ghi | remediation Phase 1 | `shared/state.ts`, `peer-pause.ts`, `stage-control.ts`, `tool-handlers.ts`, `tool-schemas.ts`, `default-workflows.ts`, `skill-markdown.ts` | `flow-brief-revision`, `slp-manager-skill` | **có** |
| 2 | F2 — bản ghi duyệt tin cậy ràng buộc hash | remediation Phase 1 | `shared/state.ts`, `shared/rpc.ts`, `tool-schemas.ts`, `tool-handlers.ts`, `spec-approval.ts` (mới), `delegation.ts`, `rpc-handlers.ts`, `use-run.ts`, `run-detail.tsx`, `default-workflows.ts`, `messages.ts`, `skill-markdown.ts` | `flow-product-spec`, `spec-approval` (mới), `slp-manager-skill` | **có** |
| 3 | F6 — fixture và flow test non-UI | bằng chứng Phase 1 | không (chỉ helper test) | `flow-steps.ts`, `flow-product-spec` | không |
| 4 | F3 — phát hiện drift root-role | **Phase 2** | `project-validator.ts`, `start-run-guard.ts` | `project-validator`, `start-run-guard` | không |
| 5 | F4 — cưỡng chế truy vết criterion | **hoãn** | — | — | — |

Thứ tự đề xuất: **0 → 3 → 1 → 2**. F6 đi trước F1/F2 vì nó chỉ thêm test, cho suite xanh dày hơn làm nền đối chứng, và assertion truy vết của nó là thứ F2 sẽ dựa vào.

Mỗi hạng mục một commit riêng. Lệnh xác minh mỗi commit, theo AGENTS.md §3 và script thật của repo: `npm run typecheck`, `npx vitest run tests/slp-manager-skill.test.ts`, suite liên quan, rồi `npx vitest run` toàn bộ. Không `paseo plugin reload`, không commit, không push, không merge trừ khi được yêu cầu riêng.

---

## 8. Risks, Rollback and Approval Request

### Rủi ro

| Rủi ro | Mức | Giảm nhẹ |
|---|---|---|
| F1 biến `slp_pause_peers` thành lời gọi có chặn tới 30 s | trung bình | timeout đặt trong `shared/settings.ts` cạnh `shellWatchdog`; test ghi đè xuống ms; chuỗi trả về nêu peer chưa im lặng |
| Fake gateway của flow fixture chưa mô phỏng được `liveStatuses`/`activeShellCall` cho pause | trung bình | điểm phức tạp nhất của F1; phải xác nhận ngay đầu khi triển khai và báo lại nếu fixture cần mở rộng lớn |
| F1 B3 chặn `slp_stage_report` làm hỏng một luồng chưa lường | thấp | test số 5 phủ trực tiếp vòng pause→report→resume→report; B3 là phần cắt được nếu cần giảm phạm vi |
| F2 làm Supervisor dùng prompt `.slp` cũ bị kẹt ở SEMI_AUTO | trung bình | `ToolError` nêu đích danh `slp_submit_spec`; cộng migration item 1 trong skill; liên quan F3 |
| F2 thêm một tool bus và một RPC → tăng mặt tiếp xúc | thấp | theo đúng khuôn mẫu `approvePipelineGateRpc` đã chạy; `roles: ["supervisor"]` giữ nguyên ma trận quyền |
| Suite đỏ sẵn che regression của chính đợt remediation | trung bình | làm hạng mục 0 trước |
| Phình prompt Supervisor/Lead lần nữa | thấp | Phase 1 đã dùng +29% ngân sách mỗi prompt; F1/F2 chỉ thêm 1–2 dòng mỗi role |

### Rollback

- **F1:** một field schema có `.default(null)` + logic. `git revert` commit là phục hồi hoàn toàn; `pauseConfirmedAt` còn sót trong blob JSON là field lạ **vô hại** vì `RunSchema` không `.strict()` ở cấp đó và field không được đọc nữa. Không migration để lùi.
- **F2:** `git revert` xoá tool, RPC, UI và cổng. `specApprovals` còn sót trong payload cũng vô hại theo cùng lý do. Run đã delegate không bị ảnh hưởng vì cổng chỉ nằm ở `delegate`.
- **F6:** thuần test; revert là xoá test.
- **Chung:** không hạng mục nào cần migration SQLite, nâng `PRAGMA user_version`, hay đổi MCP wire contract, nên không có trạng thái một-chiều nào cần lùi.

### Xin duyệt

Cần Manager quyết **bốn** điểm trước khi viết dòng code đầu tiên:

1. **F1: duyệt Option B trọn gói (B1+B2+B3) hay cắt còn B1+B2?** Tôi khuyến nghị trọn gói.
2. **F2: duyệt Option B với cưỡng chế theo run mode (SEMI_AUTO + STEP_BY_STEP_DEBUG), miễn FULL_AUTO?** Tôi khuyến nghị có. Nếu Manager muốn cưỡng chế cả FULL_AUTO, đó là quyết định riêng: nó phá mọi flow fixture và chặn run đang lưu dở, nên cần một đợt duyệt riêng.
3. **F2 Option A (kiểm tra cấu trúc nội dung) có bị loại bỏ hẳn không?** Tôi khuyến nghị loại khỏi Phase 1 — nó không cung cấp uỷ quyền và sẽ phá chính test tương thích mà Phase 1 vừa khóa.
4. **Thứ tự 0 → 3 → 1 → 2, tức F5 làm trước?** Tôi khuyến nghị có.

**Chưa có hạng mục nào được triển khai. Không file source, schema, prompt, skill hay test nào bị sửa trong task này. Phase 2 chưa bắt đầu.**
