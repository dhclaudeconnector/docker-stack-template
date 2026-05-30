# AI Agent Project Rules (dockerstack-s3proxy)

These rules are mandatory for ANY AI Agent (Codex, Claude Code, Antigravity, Cursor, etc.) working in this project.

## 1) Always update `.opushforce.message`

- For every completed user task, the AI Agent must update `.opushforce.message` before sending the final response.
- Do not skip this step, even for small edits.
- If no files were changed, still update `.opushforce.message` with a short note.

## 2) Message format

Use conversational summary content (not commit-style), aligned with what the AI Agent says to the user.

Required structure in `.opushforce.message`:

1. Opening line confirming rule-following, for example:
   `feat:<tóm tắt nội dung>` and/or `fix:<tóm tắt nội dung>`
2. Section: `Input của user`
3. Section: `Nguyên nhân gốc`
4. Section: `Cách đã chỉnh để khắc phục`
5. Section: `File đã áp fix bug`
6. Section: `Trả lời câu hỏi "<câu hỏi chính của user>"`
7. If runtime action is needed, include exact command(s) at the end.

Formatting rules:

- Write in Vietnamese, concise and clear.
- Prefer short lines or flat bullets; no nested bullets.
- In `Input của user`, include the user's original request text; if too long, keep a concise excerpt that preserves key constraints.
- If user input contains secrets/tokens, mask sensitive values.
- File list can be plain filenames or paths.
- Do not use `<type>: <summary>` commit prefix.

## 3) Completion gate

The AI Agent should treat the task as incomplete until `.opushforce.message` is updated (write or append) to reflect the latest work.

## 4) CodeGraph MCP usage

- This repo has CodeGraph initialized at `.codegraph/`.
- When CodeGraph MCP tools are available, use them first for code discovery and impact analysis.
- Use lightweight CodeGraph lookups directly for targeted work:
  - `codegraph_search`
  - `codegraph_callers`
  - `codegraph_callees`
  - `codegraph_impact`
  - `codegraph_node`
  - `codegraph_status`
  - `codegraph_files`
- Avoid using large context/explore calls in the main session unless the task truly needs broad source context.
- If CodeGraph tools are unavailable in a session, verify `~/.codex/config.toml` has the `mcp_servers.codegraph` entry and restart Codex so the MCP server is loaded.
