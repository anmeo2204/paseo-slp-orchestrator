# Mức trần session CLI khi chạy nhiều SLP

Ghi chú thảo luận, chưa phải quyết định triển khai. Engine hiện không có trần số agent.

## Trần nằm ở đâu

Trần đếm theo tài khoản CLI trên cả máy, cộng mọi SLP đang chạy. Không đếm theo từng project.

Mỗi project là một run, một repo, worktree riêng. Các run không tranh git index với nhau. Chúng dùng chung quota của Kiro, Cursor và Antigravity trên account đang đăng nhập, cùng CPU và RAM của máy.

Cấu hình máy chỉ quyết định máy chứa được bao nhiêu process CLI. Quota account không tăng khi máy mạnh hơn. Daemon không đọc được trần đồng thời của từng gói, nên không tự tính được số đúng. Nếu sau này có trần chủ động, người vận hành phải nhập số theo gói. Phần tự động làm được là xếp hàng và thử lại khi CLI thật sự từ chối vì rate limit hoặc hết quota.

## Khi chạy quá mức, engine hiện tại làm gì

Không có hàng chờ. `createAgent` xóa bản ghi agent nếu session chưa mở được, rồi lỗi nổi lên.

- Pipeline đang mở peer thì pause. Lead nhận mail và resume bằng `slp_resume_pipeline`. Các SLP khác vẫn chạy.
- Run chưa có Supervisor thì run đó không start.
- Máy hết RAM thì hệ điều hành có thể giết process, kể cả daemon. SQLite còn, restart khôi phục được run. Worktree của đúng branch đó có thể dở dang, chưa commit.
- Session đã mở vẫn tính usage cho đến khi CLI ngắt.

Hai SLP khác repo không ghi đè checkout của nhau. Hai SLP cùng một repo đã có khóa worktree và branch.

## Một SLP đang làm một feature giữ 4 agent

Chỉ agent của stage hiện tại được mở. Catalog `.slp/peers/` không được spawn hết.

| Agent | Khi nào sống |
|---|---|
| Supervisor | Suốt run. Một agent. |
| Lead | Từ lúc giao việc. Một agent cho mỗi feature song song. |
| Peer của stage hiện tại | Planning: các advisor được Lead chọn. Implement: đúng một developer. |
| QA Lead | Sinh cùng lúc với Lead, sống song song để chuẩn bị kiểm tra. Mặc định cùng provider với Lead, trừ khi `QA_LEAD.md` chỉ sang CLI khác. |

Giai đoạn implement là lúc chạy lâu nhất: Supervisor + Lead + một developer + QA Lead = 4 session mỗi project một feature.

## Mức 3–4 project, mỗi project một SLP

Mỗi project một feature, đang implement:

- 3 project: 12 session
- 4 project: 16 session

Chia theo tầng:

| Tầng | CLI | 4 project |
|---|---|---|
| Supervisor | Cursor | 4 |
| Lead và developer | Kiro | 8 |
| QA Lead, nếu tách provider | Antigravity | 4 |

4 session Cursor và 4 session Antigravity thì nhẹ. 8 session Kiro là mức cần để ý, chưa phải mức dễ bị từ chối hàng loạt. Với cách chia này, 3–4 project một feature chạy cùng lúc nằm trong vùng engine chịu được mà chưa cần trần trong code.

Số tăng lên khi:

- Supervisor tách một project thành nhiều feature song song. Hai feature thì project đó thành 6 agent. Bốn project đều tách đôi thì khoảng 24 session.
- Cả 4 project cùng ở stage planning và Lead gọi đủ 3 advisor mặc định (architect, reviewer, security). Mỗi project khoảng 6 agent, bốn project khoảng 24, dồn vào CLI của Lead.
- Cả 3 tầng cùng một CLI. Lúc đó 12–16 session đè lên một account.

## Chưa chốt

- Có làm trần chủ động trong daemon hay chỉ dựa vào pause khi CLI từ chối.
- Số nhập cho từng CLI, và đặt ở settings toàn cục hay theo máy.
- QA Lead có bắt buộc tách provider khỏi Lead hay để `QA_LEAD.md` tự quyết.
