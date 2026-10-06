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

The subsequent boundary capture and installed-code analysis below locate the missing suffix before Mongle's clipboard handling. Virtual-scroll disabling did not fix this reproduction.

## Loss boundary and source analysis

A subsequent native test was performed by `gpt-6-astra` in the actual MongleTerminal window using Computer Use. The product web assets were unchanged. A test-only host recorded synthetic OSC 52 payloads immediately before its existing handler blocked them; it did not enable OSC clipboard writes or alter the selected text. See [the native evidence](astra-selection-boundary.md).

- Uncovered LIVE-295–300: OSC 52 decoded to the exact 359-character source.
- Covered LIVE-261–299: OSC 52 decoded to 2333 characters instead of 2339; only the final `ND-299` was missing. The mouse release was well to the right of both the hint and the original line ending.
- Mouse down, held-button movement and mouse up appeared in the UI-to-host input trace. Mongle clipboard-write calls were zero.
- The OS clipboard observation did not contain the synthetic text in this instrumented run. It is not counted as a successful OS clipboard test, nor used to infer why native clipboard delivery differed from the earlier uninstrumented tests.

Read-only inspection of the installed 2.1.291 executable found this path (minified names are version-specific):

1. `copySelectionNoClear()` obtains `getSelectedText()` and passes that string to `cv()`. That same string supplies the Windows native copy attempt and the returned OSC 52 sequence.
2. `getSelectedText()` reads the composited `frontFrame.screen` through `Dg` and the row extractor `wg`. Cells marked `noSelect` are excluded.
3. The floating `Jump to bottom` component is rendered over transcript cells and marked `noSelect`.
4. `Bd` also extracts departing selected rows from the composited screen. Missing characters can therefore persist in the offscreen selection cache.

The boundary capture establishes that this missing suffix already exists in Claude's outgoing selection string. The internal selection path explains the position of the loss. This is not a controlled comparison against another terminal, and does not claim all possible effects of terminal geometry and input behavior have been excluded.

### Direct fix proposal, not implemented

Preserve transcript cells in a selection plane with the same layout **before** non-selectable overlay composition. Use that plane for both visible selection extraction and departing-row capture. Keep input position, mouse selection and the visible hint unchanged. Clearing `noSelect` alone copies the hint instead of the hidden text; fixing only final extraction leaves previously cached damaged rows intact.

An independently written causal model in ignored test data passed seven checks covering those distinctions. It does not execute Claude's renderer and is not product or fix validation. Acceptance still requires the actual fixed renderer to pass partial selection under the hint, upward and downward auto-scroll, wide glyphs, wrapping, resize and output during selection, with exact clipboard comparison.

### Available integration boundary

The official npm latest version and installed executable were both 2.1.291 when checked. The npm root package supplies a launcher/installer; the Windows package contains the executable and metadata, not an editable TUI `cli.js`.

The [official Mods API](https://github.com/anthropics/claude-code/tree/main/mods) was also inspected. The [public type file](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts) identifies itself as generated by 2.1.277, so the following decisive details were checked separately in the installed 2.1.291 code:

- `$.ui.selection()` returns selected `text` and an optional transcript item `requestId`, not source cells or start/end offsets. Its text uses the same internal selection extraction.
- `ui.select` concerns a plugin's selection-list widget, not terminal text dragging.
- The built-in drag-copy path calls its internal copy function directly; it does not dispatch through a mod's `ui.copy` hook.
- `ui.render` does not expose the Jump hint or the complete transcript layout as a replaceable render target.

No official hook that repairs this built-in drag path was found. The installed executable, global settings and product clipboard security boundary were not modified. This draft has not been submitted externally and no fixed Claude build has been produced or deployed.

## Workaround and limitations

Classic rendering and fullscreen transcript view dumped to terminal scrollback (`Ctrl+O`, then `[`) each produced an exact 300-line copy in separate native tests. Downward dragging and wider windows succeeded under the conditions above, but neither guarantees accuracy for arbitrary line lengths or selections ending beneath the hint. These comparisons were performed only in MongleTerminal, not in Windows Terminal or another terminal implementation.

No credentials, private conversations, or raw personal logs are included. Related public report: [anthropics/claude-code#86954](https://github.com/anthropics/claude-code/issues/86954); similarity does not establish an identical cause.
