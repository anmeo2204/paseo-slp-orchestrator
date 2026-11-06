# Spec của SLP và spec của Kiro

Đánh giá cách hai bên tạo spec, và phần nào được đưa vào tài liệu vận hành. Engine không đổi theo tài liệu này. Luật chung cho Kiro, Cursor và Antigravity vẫn là bản nháp tại [slp-tool-rule-draft.md](slp-tool-rule-draft.md).

## SLP viết hai hợp đồng, từ hai file workflow

Lúc chạy, không có skill nào được gọi để viết spec. Skill `slp-manager` chỉ giúp soạn `.slp/` trước khi có run.

| Hợp đồng | Ai viết | File workflow được gắn vào system prompt | Lưu ở đâu |
|---|---|---|---|
| Product spec: phạm vi và ngoài phạm vi, hành vi quan sát được, surface và trạng thái nếu có, luật nghiệp vụ và edge case, kịch bản Given/When/Then, điều chưa biết và giả định | Supervisor, thảo với người dùng trong chat | `.slp/SUPERVISOR.md` | SQLite, field `productSpec` của run. `slp_delegate` từ chối nếu ngắn hơn 80 ký tự |
| Brief kỹ thuật: `approach`, `criteria` (mỗi tiêu chí có `verification`), `inScope`, `outOfScope` | Lead | `.slp/LEAD.md` | SQLite, khóa trên pipeline khi duyệt planning hoặc khi định nghĩa pipeline không có planning |

`approach` là chỗ của thiết kế kỹ thuật: kiến trúc, dữ liệu, contract. Stage planning và advisor dùng khi hướng làm chưa rõ. Developer xây đúng brief đã khóa. QA chấm từng `criterion`. Đổi brief đã khóa chỉ qua `slp_pause_peers`, `slp_revise_brief`, `slp_resume_peers`.

Runtime không ghi spec ra repo. Worktree của Lead được tách từ commit đã có trên `baseBranch`, nên spec nằm trong SQLite thì mọi worktree đọc cùng một bản qua tool `slp_`.

## Kiro viết ba file rồi tự code

Một agent Kiro đi Requirements → Design → Tasks → Code. Người dùng duyệt từng cổng, hoặc quick plan sinh cả ba file một lượt. File nằm trong `.kiro/specs/<feature>/`:

| File | Nội dung |
|---|---|
| `requirements.md` | User story và tiêu chí dạng WHEN … THE SYSTEM SHALL … |
| `design.md` | Kiến trúc, luồng, sơ đồ, lỗi, cách test |
| `tasks.md` | Việc nhỏ có phụ thuộc. Các task không đụng cùng file có thể chạy song song |

Cùng agent đó thực thi `tasks.md`. Trong một session SLP, prompt của `.slp/` được gắn thêm, không gỡ workflow spec sẵn của Kiro.

## Đánh giá

Kiro cho một bản thiết kế có sơ đồ và một danh sách việc nằm trong git, sinh trong một lượt, rồi bám file đó lúc code. SLP tách người quyết định hành vi (người dùng, qua Supervisor), người khóa hợp đồng kỹ thuật (Lead) và người code (một developer). QA chấm bằng chứng theo `verification`, không phải chính người viết spec tự nhận là xong.

Phần không mang từ Kiro sang:

- Không mở `.kiro/specs/`, không viết `requirements.md`, `design.md`, `tasks.md` trong một run SLP. Đó là hợp đồng thứ hai, lệch product spec và brief trong SQLite.
- Không chạy task song song của Kiro trong một worktree. Pipeline feature cố ý một developer. Việc độc lập thì Supervisor tách thành nhiều feature, mỗi feature một worktree.
- Không ghi spec runtime vào repo để "review bằng git". Engine cố ý để spec trong SQLite. Xem lại bằng chat của Supervisor, `slp_get_run` và `slp_get_pipeline`.

Phần Kiro làm dày hơn thì SLP chứa trong `brief.approach` cùng `criteria`, và workflow mặc định trong `server/prompts/default-workflows.ts` giờ đã bắt Lead viết đủ: `approach` ghi module và file bị sửa, pattern tái dùng, điểm tích hợp, contract dữ liệu/API khi có, và hành vi khi dependency lỗi hoặc input không hợp lệ; mỗi `criterion` trỏ về một scenario của product spec hoặc một acceptance criterion, kèm `verification` mà grader chạy được. Advisor của stage planning vẫn là chỗ bàn thiết kế trước khi khóa. Đây là sửa `.slp/LEAD.md`, không phải bật spec của Kiro. `.slp/` đã có trong project thì không bị ghi đè; nâng cấp theo checklist mục 6 của skill `slp-manager`.

Cursor và Antigravity không có bộ ba file spec đó. Cursor chỉ trùng khi rule của repo bắt lập plan trước. Antigravity trùng khi agent lập plan artifact hoặc tự mở subagent sau khi brief đã khóa. Cùng một luật: brief đã khóa là hợp đồng kỹ thuật duy nhất.
