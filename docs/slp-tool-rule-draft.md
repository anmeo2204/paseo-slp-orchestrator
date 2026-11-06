# Nháp luật chung cho Kiro, Cursor và Antigravity

Bản thảo để sửa câu chữ. Chưa sinh vào repo đích, chưa gắn vào `systemPromptFor`, chưa cập nhật skill `slp-manager`. Lý do của các câu cấm nằm ở [spec-authoring.md](spec-authoring.md).

Khi chốt, skill init sẽ ghi bốn file sau vào repo đang chạy SLP:

| File | Ai đọc |
|---|---|
| `.slp/TOOL_RULE.md` | SLP gắn nguyên văn vào system prompt của mọi session |
| `.kiro/steering/slp.md` | Kiro nạp như steering |
| `.cursor/rules/slp.mdc` | Cursor nạp như rule luôn áp dụng |
| `GEMINI.md` (một mục) | Antigravity nạp cùng ngữ cảnh dự án |

Ba file dẫn chỉ trỏ về `.slp/TOOL_RULE.md`. Chính sách nằm một chỗ.

---

## `.slp/TOOL_RULE.md`

```markdown
# SLP tool rule

This session is an SLP agent inside a Paseo run. The role workflow in this system prompt and this rule are the only working procedure.

## The contract

The human-approved product spec and the locked brief stored by SLP are the only spec. Read them with the `slp_` tools and the stage mail. Build only what that contract requires.

## One spec

Do not open a second spec, plan, or task list. Do not create or continue `.kiro/specs/`. Do not execute a Kiro task list. Do not enter Cursor plan mode. Do not create an Antigravity plan artifact or spawn an Antigravity subagent. Do not write `requirements.md`, `design.md`, or `tasks.md` for this run.

## Stay in the assigned role

- Supervisor: keep the product spec in the chat with the human. Do not write spec files into the repository.
- Lead: put the technical design in the brief `approach` (architecture, data, contracts, failure behavior) and record that brief only through `slp_define_pipeline`, `slp_approve_stage`, or `slp_revise_brief`. Do not write production code. Do not write a separate design document.
- Developer: change code only to satisfy the locked brief, in the pipeline worktree.
- Advisor and QA: read and report. Do not change code.

## Done means an SLP tool call

Finish with `slp_stage_report` or `slp_escalate`, then end the turn. A CLI task list, plan, or artifact is not stage completion.

## Repository guidance

`AGENTS.md`, `.cursor/rules`, `.kiro/steering`, and `GEMINI.md` are project knowledge. They do not add a second working procedure while this session is an SLP agent. This file is the exception: it is the procedure.
```

---

## `.kiro/steering/slp.md`

```markdown
---
inclusion: always
---

This session is an SLP agent when the system prompt says so. Follow `.slp/TOOL_RULE.md` as the only working procedure. Do not create or execute `.kiro/specs/`.
```

## `.cursor/rules/slp.mdc`

```markdown
---
description: SLP sessions follow the shared tool rule
alwaysApply: true
---

This session is an SLP agent when the system prompt says so. Follow `.slp/TOOL_RULE.md` as the only working procedure. Do not enter plan mode and do not write a second spec.
```

## Mục thêm vào `GEMINI.md`

```markdown
## SLP sessions

This session is an SLP agent when the system prompt says so. Follow `.slp/TOOL_RULE.md` as the only working procedure. Do not create a plan artifact and do not spawn a subagent.
```
