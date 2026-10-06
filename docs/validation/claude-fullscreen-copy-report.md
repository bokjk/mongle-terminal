# Claude fullscreen copy truncation — report draft

Draft only; not submitted externally. Reproduced on 2026-10-06 with Claude Code 2.1.291 on Windows 11 in an isolated MongleTerminal test profile. The terminal used PR #44's mouse-event fixes; this is not a claim about an unmodified public release.

## Symptom

In fullscreen mode, the floating `Jump to bottom` hint overlaps transcript characters. A long upward drag that auto-scrolls can copy alternating rows with the overlapping characters missing. A visible row selected underneath the hint also loses the covered suffix.

## Reproduction

1. Start Claude with `CLAUDE_CODE_NO_FLICKER=1`. The test also used `--safe-mode --tools "" --no-chrome`.
2. Ask for 300 numbered plain-text lines, without code fences, in this format, with matching numbers:

   `LIVE-001 selection test 가나다라마 ABCDEFGHIJ 0123456789 END-001`

3. Add later output so these lines are above the latest response. At 148 columns, scroll to the end of the 300-line response. Confirm that the floating hint overlaps the `END-nnn` suffix.
4. Drag upward from near the end of the response to the upper transcript boundary, holding there for about eight seconds to auto-scroll, then release.
5. Compare the actual clipboard with the generated lines. Repeat from the beginning downward, holding beyond the lower transcript boundary until the selected lines have moved above the hint.

## Observed comparisons

| Condition | Result |
| --- | --- |
| 148 columns, upward drag | Lines 001–297 were continuous, but 149 suffixes were truncated to `E` |
| 148 columns, downward drag with auto-scroll | Lines 001–300 matched exactly |
| 148 columns, selection ending on the hint-covered visible row without auto-scroll | That row's suffix was truncated |
| 170 columns, upward drag, hint no longer overlapping line endings | Lines 001–300 matched exactly |
| 148 columns, upward drag with `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1` | Same 149 truncated lines out of 297 |

Every drag delivered one press, twelve moves and one release. The terminal application's clipboard-write handler was not called in these fullscreen cases. Comparison excluded screen padding and the initial response marker; it did not reconstruct missing text. The 170-column selection included earlier material, so the comparison used the final contiguous 001–300 block.

This supports an overlap-related problem in Claude's selection/copy path. The exact internal implementation defect is not established. Virtual-scroll disabling did not fix this reproduction.

## Workaround and limitations

Classic rendering and fullscreen transcript view dumped to terminal scrollback (`Ctrl+O`, then `[`) each produced an exact 300-line copy in separate native tests. Downward dragging and wider windows succeeded under the conditions above, but neither guarantees accuracy for arbitrary line lengths or selections ending beneath the hint. These comparisons were performed only in MongleTerminal, not in Windows Terminal or another terminal implementation.

No credentials, private conversations, or raw personal logs are included. Related public report: [anthropics/claude-code#86954](https://github.com/anthropics/claude-code/issues/86954); similarity does not establish an identical cause.
