---
title: "Wave 1 — Mentions system + Markdown renderer"
type: task
status: done
created: 2026-06-18
completed: 2026-06-18
branch: feat/markdown-renderer-and-mention-autocomplete
pr: "#112 (squash-merged to master, 5dcf4b0)"
priority: high
effort: MED-HIGH
candidates: "#4, #8, #22, #23, #30 (partial)"
---

# Wave 1 — Mentions + Markdown renderer

> **STATUS (2026-06-18): all 4 phases DONE** on branch
> `feat/markdown-renderer-and-mention-autocomplete` (9 commits). Mobile side
> verified on-device (mention rendering, autocomplete, markdown, badge). tsc
> clean (only pre-existing unrelated errors). Not yet merged — squash + self-merge
> when ready.
>
> - **Phase 1** — wire-format + send-path extraction (was already on master, `dcbf3aa`).
> - **Phase 2** — markdown renderer (hand-rolled, no dependency). DONE.
> - **Phase 3** — roles + @everyone autocomplete (permission-gated). DONE.
> - **Phase 4** — mention counts → combined badge (mentions+replies) + unread dot. DONE.
>
> **Device-testing fixes applied** (commits 4e95439, 99e2a41, 1513d0a, a7d85de,
> 9053c07, 1846dfe): spoiler hide/reveal, multi-line blockquote/list (CR
> normalization), channel `#<channelId>` wire format (tappable in both paths),
> pfp in mention menu, color-only pills unified to one accent, role mentions in
> accent color (not role color — matches desktop), edit/embed-caption send-path
> mention population, mention-menu hint contrast.
>
> **Follow-ups split into their own tasks:**
> - Unread dot full parity (needs lastReadTimestamp) →
>   `2026-06-18-channel-unread-dot-lastread-timestamp.md` (own PR).
> - Promote the preprocessing pipeline to quorum-shared (+ tests) →
>   `quorum-shared-migration/2026-06-18-adopt-shared-message-preprocessing.md`
>   (mobile) + desktop driver task.
>
> **Known unrelated issue hit during testing:** intermittent desktop↔mobile
> message delivery — tracked in
> `.agents/issues/.open/2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md`
> (Symptom B, open). Not caused by this work (our changes only touch the mentions
> field, not transport).

> **Why these are one task.** The mention wire-format fix (#22) requires touching the message renderer (`MentionableText.tsx`). Porting the markdown renderer (#4) **also** requires replacing `MentionableText` with a new `MessageRenderer` component that knows both markdown AND `@<address>` mentions. Building them separately means rewriting the same component twice. The two features share one prerequisite (the wire-format alignment) and one output (the new renderer). Ship together.

## Context

### The wire-format mismatch (critical — read first)

Desktop and mobile currently store mentions in incompatible formats:

| Platform | Compose inserts | Wire/storage format | Render parses |
|---|---|---|---|
| Desktop | `@<QmAbc123>` | `@<QmAbc123>` (angle-brackets) | `/@<([^>]+)>/g` |
| Mobile | `@QmAbc123 ` (bare, no brackets) | `@QmAbc123` | `/@([a-zA-Z0-9_.\-]+)/g` |

Result:
- Desktop→mobile mentions render as literal `@<QmAbc123>` text (mobile regex can't match the brackets).
- Mobile→desktop mentions don't highlight on desktop (desktop expects brackets).
- The shared `extractMentionsFromText` uses the angle-bracket format; mobile never calls it, so `mentions: { memberIds: [], roleIds: [], channelIds: [] }` is empty on every mobile send — no desktop notifications fire for mobile-authored mentions.

**The canonical format is `@<address>`.** Align mobile to desktop. This is a correctness fix, not an aesthetic choice.

### Current mobile state

**`components/Chat/MentionableText.tsx`** — mobile's current message renderer:
- Custom tokenizer: `@mention`, `#channel`, `:emoji:`, URL — zero markdown awareness.
- User mention regex: `/@([a-zA-Z0-9_.\-]+)/g` — cannot parse `@<address>`.
- No roles, no `@everyone`, no markdown, no spoilers.
- Does NOT call any shared mention utilities.

**`components/Chat/MessageInput.tsx:420`** — compose inserts `@${member.address} ` (bare, no brackets):
```ts
const newText = value.slice(0, lastAtIndex) + `@${member.address} ` + textAfterCursor;
```

**`services/space/spaceMessageService.ts`** lines ~285, ~402, ~563, ~631 — every send path hardcodes:
```ts
mentions: { memberIds: [], roleIds: [], channelIds: [] }
```

`extractMentionsFromText` from `@quilibrium/quorum-shared` is never called.

### Shared utilities already available (no shared migration needed)

All of these are in the currently-installed `@quilibrium/quorum-shared`:

| Export | File | Used for |
|---|---|---|
| `extractMentionsFromText` | `utils/mentions.ts` | Send-path: extract mention metadata from composed text |
| `isMentionedWithSettings` | `utils/mentions.ts` | Notification gating (receives `@everyone` role check, already fixed in shared `2.1.0-30`) |
| `isMentioned`, `getMentionType` | `utils/mentions.ts` | Per-message notification decisions |
| `hasWordBoundaries` | `utils/mentions.ts` | Safe token matching in renderer |
| `createIPFSCIDRegex` | `utils/validation.ts` | Build the `@<address>` regex dynamically |
| `stripMarkdown`, `processMarkdownText`, `replaceMentionsWithDisplayNames` | `utils/markdownStripping.ts` + **`.native.ts`** | Notification text, search snippets, DM preview lines |
| `toggleBold`, `toggleItalic`, `toggleSpoiler`, `wrapCode`, etc. | `utils/markdownFormatting.ts` | Composer toolbar (existing; no new wiring needed) |
| `extractCodeContent`, `shouldUseScrollContainer`, `getScrollContainerMaxHeight` | `utils/codeFormatting.ts` | Code block rendering |
| `Mentions`, `Message`, `PostMessage` | `types/message.ts` | Type safety on the send path |

**Note on the `@everyone` permission check:** The receive-side role check (`hasPermission(senderId, 'mention:everyone', space)`) landed in shared PR #41 (`fc73eb2`, source `2.1.0-30`) inside `isMentionedWithSettings`. Mobile must bump to `2.1.0-30` (or later) before the `@everyone` send-gate enforcement is meaningful. See the Wave 0 task for context.

### Markdown on desktop (for porting reference)

Desktop's preprocessing pipeline (in `src/components/message/MessageMarkdownRenderer.tsx`) runs inline functions in this order before handing off to `react-markdown`:

1. `processInviteLinks` — converts bare invite URLs to markdown image syntax.
2. `processStandaloneYouTubeUrls` — replaces standalone YouTube URLs with an embed placeholder (uses shared `extractYouTubeVideoId`).
3. `processMentions` — converts `@<address>` → internal token `<<<MENTION_USER:address>>>`. Skips code blocks and inline code.
4. `processRoleMentions` — converts `@roleTag` → `<<<MENTION_ROLE:roleTag:displayName>>>`.
5. `processChannelMentions` — converts `#<channelId>` → `<<<MENTION_CHANNEL:channelId:channelName>>>`.
6. `processMessageLinks` — converts jump URLs to `<<<MESSAGE_LINK:...>>>`.
7. `processURLs` — converts bare `https?://` URLs to `[url](url)` markdown links. Must run after step 6.
8. `convertHeadersToH3` — rewrites `#` / `##` → `###` (only one header level allowed).
9. `fixUnclosedCodeBlocks` — appends closing ` ``` ` if the fence count is odd.

After preprocessing, `ReactMarkdown` (+ `remarkGfm` + `remarkBreaks`) renders the tree. A `text` node override (`processMentionTokens`) does the final inline pass: splits strings on `<<<...>>>` tokens and `||spoiler||` patterns into React elements.

**Mobile cannot use `react-markdown`** (DOM-only). The RN equivalent is `react-native-markdown-display` or a hand-rolled inline-to-RN-elements pipeline. **The preprocessing pipeline above is portable — it's pure string transforms.** Only the final rendering step is platform-specific.

**Spoilers on desktop:** `||text||` → `<span class="message-spoiler" onClick={...}>` (click/keyboard toggles `message-spoiler--revealed` CSS class). On mobile: a `<Text onPress>` wrapper that toggles a local `revealed` state suffices. The `toggleSpoiler` formatting helper is already in shared (for the toolbar).

---

## Scope

### Phase 1 — Wire-format fix + send-path mention extraction (prerequisite for everything)

**Goal:** mobile-authored mentions reach desktop notifications and cross-platform pills render correctly.

1. **Align compose insert format.** In `components/Chat/MessageInput.tsx:420`, change:
   ```ts
   `@${member.address} `
   ```
   to:
   ```ts
   `@<${member.address}> `
   ```
   The display in the TextInput will now show the raw address with brackets — acceptable short-term until Phase 2 adds proper pill-in-input (see out-of-scope note below).

2. **Call `extractMentionsFromText` on every send path.** In `services/space/spaceMessageService.ts`, at every point that currently hardcodes `mentions: { memberIds: [], roleIds: [], channelIds: [] }` (lines ~285, ~402, ~563, ~631), replace with a call to the shared helper:
   ```ts
   import { extractMentionsFromText } from '@quilibrium/quorum-shared';
   // ...
   mentions: extractMentionsFromText(messageText, { members, roles }),
   ```
   Verify `extractMentionsFromText`'s exact signature in the installed dist before writing the call — it may accept an options object or positional args. The `members` and `roles` arrays should come from the space context already available at each send site.

3. **Align `MentionableText` mention regex to parse `@<address>`.** In `components/Chat/MentionableText.tsx:43`, change:
   ```ts
   const MENTION_REGEX = /@([a-zA-Z0-9_.\-]+)/g;
   ```
   to one that matches both the angle-bracket format (desktop/canonical) AND optionally the bare format (legacy messages already in storage):
   ```ts
   // Matches @<address> (canonical) and @address (legacy mobile)
   const MENTION_REGEX = /@<([^>]+)>|@([a-zA-Z0-9_.\-]+)/g;
   ```
   Update the capture-group references in the match loop accordingly (group 1 = bracketed, group 2 = bare). The `memberMap` lookup (currently by `display_name`, `name`, `address`) remains valid — `address` lookup covers both.

   **Alternatively** (cleaner but more invasive): use the shared `createIPFSCIDRegex()` helper to build the address pattern dynamically, matching exactly what desktop uses.

4. **Add `@everyone` to render.** In `MentionableText`, add a match pass for the literal token `@everyone` and render it as a highlighted non-tappable pill. No member-map lookup needed — it's always present when the text contains `@everyone`.

5. **Add role mention render (basic).** Roles are stored as `@<roleId>` in the wire format per desktop's `processRoleMentions` logic (note: roleId is a UUID, same angle-bracket wrapping). Add a match pass in `MentionableText` that checks the captured address against a `roles` prop (array of space roles). If matched, render as a colored pill showing the role's `name`. If not matched (unknown role or cross-space message), fall back to showing `@<roleId>` as a styled token.

   New prop on `MentionableText`: `roles?: SpaceRole[]` (already in shared types).

### Phase 2 — Markdown renderer ✅ DONE (2026-06-18)

**Status:** Shipped mobile-local. New files: `utils/messagePreprocessing.ts` (pure
string transforms + `hasMarkdown` detector), `components/Chat/MessageMarkdownRenderer.native.tsx`
(hand-rolled block+inline RN renderer — no third-party markdown lib; chosen over
`react-native-markdown-display`, which is unmaintained / risky on React 19),
`components/Chat/MessageRenderer.tsx` (router). Wired into all 3 `MentionableText`
call sites in `MessagesList.tsx`; `roles` flows from `spaceData.roles` via
`SpaceChatArea` (no channel-screen prop change needed). `tsc` clean (0 new errors);
tokenizer + emphasis verified by runtime smoke test.

**Two decisions (2026-06-18):**
- **Markdown engine:** hand-rolled, no dependency (user-approved).
- **Tests + shared promotion:** preprocessing stays mobile-local for now; promotion
  to `quorum-shared` (which de-dups desktop's inlined copy) AND its unit tests are
  tracked as a cross-repo pair:
  - mobile consumer leg: `quorum-shared-migration/2026-06-18-adopt-shared-message-preprocessing.md`
  - desktop driver leg: `quorum-desktop/.agents/tasks/quorum-shared-migration/2026-06-18-promote-message-preprocessing-to-shared.md`
  Tests belong in shared (mobile has no test runner; shared already uses Vitest) —
  writing them in mobile now would be throwaway once the logic moves.

**Goal:** bold, italic, strikethrough, blockquote, lists, inline code, fenced code blocks, spoilers render correctly. Messages that contain no markdown syntax continue to route through the existing `MentionableText` tokenizer (no regression).

**Architecture decision:** do NOT replace `MentionableText` for non-markdown messages. Instead, create a new `MessageRenderer` component that:
- Detects whether the content contains any markdown syntax (use `hasMarkdown(text)` — a small helper or shared `processMarkdownText` output comparison).
- If no markdown: renders `<MentionableText>` (unchanged path, no performance regression).
- If markdown: runs the preprocessing pipeline and hands off to the markdown rendering path.

**New component:** `components/Chat/MessageRenderer.tsx`

Steps:

1. **Add a markdown library.** The recommended choice is `react-native-markdown-display` (actively maintained, customizable component overrides). Add to `package.json` and run `yarn`. No native rebuild needed (pure JS).

   Alternative: `@expensify/react-native-markdown-composer` or a hand-rolled inline parser. The hand-rolled path is more effort but gives full control and avoids a JS bundle size hit.

2. **Port the preprocessing pipeline.** Extract the desktop preprocessing steps (see Context section above) into a shared-importable function `prepareMessageContent(text, opts)`. This function is **pure string transforms** — platform-agnostic. It should live either:
   - In a new mobile-local `utils/messagePreprocessing.ts` file (simplest, no shared change needed), OR
   - Promoted to `quorum-shared/src/utils/messagePreprocessing.ts` (longer term; discuss with lead dev).

   For this task, start with a mobile-local file. Only port the steps that are relevant to mobile initially:
   - `fixUnclosedCodeBlocks` — always needed.
   - `convertHeadersToH3` — always needed.
   - `processURLs` — always needed.
   - `processMentions` — needed for the `@<address>` → token step (lets the markdown lib pass through safely without mangling the token).
   - `processRoleMentions` — needed for `@roleTag` → token.
   - `processChannelMentions` — needed for `#<channelId>` → token.
   
   Defer `processStandaloneYouTubeUrls` to the YouTube facade task (#5). Defer `processInviteLinks` and `processMessageLinks` until those features land.

3. **Build the RN renderer.** Create `components/Chat/MessageMarkdownRenderer.native.tsx` using the chosen library. Override the following components:
   - `code` (inline) → RN `<Text>` with monospace font + `bg-surface-4`-equivalent background.
   - `fence` (code block) → RN `<ScrollView horizontal>` wrapping a `<Text>` with monospace font; add a copy-to-clipboard icon (top-right). Apply `extractCodeContent` from shared to strip leading/trailing whitespace. Gate the scroll wrapper on `shouldUseScrollContainer` (from shared `codeFormatting.ts`).
   - `mention` token → reuse `MentionableText`'s existing mention pill logic (same colors and press handler). The token from step 2 carries the address.
   - `mention_everyone` token → static `@everyone` pill.
   - `mention_role` token → role pill (same as Phase 1 role render).
   - `channel` token → channel pill.
   - `spoiler` — a `<Text>` that starts with `opacity: 0` / blurred text (or solid background), and toggles to revealed on `onPress`. Keep it simple: a local `useState(false)` per spoiler is fine.
   - `link` → use `Linking.openURL` on press. No `<a>` tags.
   - Heading → `<Text>` with `fontWeight: 'bold'` + slightly larger size (H3 equivalent after `convertHeadersToH3`). No `<h1>`/`<h2>` needed.
   - Blockquote → a left-border accent `<View>` wrapping the content.
   - `thematicBreak` → a thin `<View>` separator.

4. **Wire `MessageRenderer` into the message list.** In `components/Chat/MessagesList.tsx` (and any other location that currently calls `<MentionableText>`), switch to `<MessageRenderer>`. Pass `roles` as a new prop from the space context.

5. **Pass `roles` down the prop chain.** `SpaceChatArea.tsx` → `MessagesList.tsx` → `MessageRenderer` → `MentionableText` (for non-markdown) or `MessageMarkdownRenderer` (for markdown). The `roles` array is already available in the space context.

### Phase 3 — Compose: roles + @everyone autocomplete

**Goal:** authors can trigger `@role` and `@everyone` from the compose UI.

1. **Add roles tier to autocomplete.** In `MessageInput.tsx`, when the user types `@` followed by a query:
   - Current: only `members` (up to 6).
   - New: show matching `roles` first (filtered by role name), then matching members. Cap the combined list at 8.
   - New prop on `MessageInput`: `roles?: SpaceRole[]`. Pass from `SpaceChatArea`.

2. **Add `@everyone` as a special autocomplete option.** Always show `@everyone` as the first autocomplete option when the user types `@` (or `@e`). Gate its visibility on `hasPermission(currentUserId, 'mention:everyone', space)` using the shared helper — if the user lacks the permission, don't show the option at all (don't show it grayed out; silently omit). This prevents confusion and mirrors desktop's behavior.

   On selection, insert the literal token `@everyone ` (no angle brackets — that's how it's stored in the wire format per desktop).

3. **Role selection insert format.** When a user selects a role from autocomplete, insert `@<roleId> ` (angle-bracket wrapped UUID — same as desktop's `processRoleMentions` wire format). The display pill in the sent message will resolve this to the role name via the `roles` prop.

### Phase 4 — Mention notification counts (scaffolding)

**Goal:** channel-level mention badge shows client-computed counts, not just the server-vended value.

This phase is a lighter lift because `DisplayChannel.mentionCount` is already plumbed server-side. What's needed:

1. **Call `isMentioned` / `isMentionedWithSettings` on incoming messages** in the WebSocket receive path (wherever new space messages are processed). When `isMentioned(message, currentUserAddress, userRoles)` returns true, increment a local MMKV counter for that channel — analogous to how reply counts work in `useReplyTracking.ts`.

2. **Clear the counter on channel entry** (already done for reply counts — same pattern).

3. **Show a distinction between reply-count badge and mention badge.** Desktop shows `@N` for mentions and a bubble count for replies. This is a UX call for the lead dev; at minimum, mention counts should drive the red dot on the channel row (higher urgency than reply counts).

> Phase 4 depends on Phase 1 (mentions must be correctly populated on receive before `isMentioned` can work). It does NOT depend on Phase 2 or 3.

---

## Out of scope (this task)

- **Pill-in-TextInput** (replacing the raw `@<address>` token with a non-editable inline chip while composing). Desktop uses a custom ProseMirror plugin for this; on RN it requires a complex custom TextInput or a library like `react-native-controlled-mentions`. The wire-format fix in Phase 1 makes the `@<address>` visible in the input, which is acceptable short-term. Revisit when the rest of the mention system is stable.
- **Mention viewport highlight** (#30) — needs `lastReadTimestamp` plumbed to the FlashList, which is a separate scroll-position task. Pairs with scroll-to-first-unread (#28).
- **YouTube embed** in the renderer (#5/#6) — wire separately once the markdown renderer exists (it's an additive override for the YouTube token).
- **Invite-link cards** — desktop renders these as custom components from the `processInviteLinks` step. Defer.
- **Message jump links** (`processMessageLinks`) — requires cross-message deep-link navigation; defer.
- **Notification counts full convergence** (#23 / #1 / #2) — the full `useChannelMentionCounts` / per-space settings sync story is a larger task. Phase 4 above is the minimal scaffolding that unblocks the badge.
- **QNS awareness in autocomplete** — autocomplete currently searches address/name/display_name. Adding QNS resolution (`.q` suffix matching) is a follow-up once the base mention system is stable.
- **Syntax highlighting in code blocks** — desktop intentionally omits it ("no syntax-color highlighting" per candidates.md). Don't add it here.

---

## Sequencing

```
Phase 1  →  Phase 2  →  Phase 3
   ↓
Phase 4 (independent, unblocked by 2/3)
```

Phase 1 is the mandatory foundation. It's also the only phase that touches correctness bugs that are live today — prioritize it.

Phase 4 can be picked up in parallel with Phase 2 once Phase 1 ships, because it only needs the receive-path to have correct mention metadata.

---

## Files to touch

| File | Phase | Change |
|---|---|---|
| `components/Chat/MessageInput.tsx:420` | 1 | Insert `@<address>` format; add roles prop + tier; add @everyone autocomplete |
| `services/space/spaceMessageService.ts:~285,~402,~563,~631` | 1 | Call `extractMentionsFromText` instead of empty literal |
| `components/Chat/MentionableText.tsx:43` | 1 | Dual-format mention regex; add @everyone + role render |
| `components/Chat/MessagesList.tsx` | 2 | Switch render to `<MessageRenderer>` |
| `components/Chat/MessageRenderer.tsx` | 2 | New: detects markdown, routes to `MentionableText` or `MessageMarkdownRenderer` |
| `components/Chat/MessageMarkdownRenderer.native.tsx` | 2 | New: markdown renderer with component overrides |
| `utils/messagePreprocessing.ts` | 2 | New: ported preprocessing pipeline (pure string transforms) |
| `app/(tabs)/spaces/[id]/[channelId].tsx` | 3 | Pass `roles` prop down to `SpaceChatArea` / `MessageInput` |
| `components/Chat/SpaceChatArea.tsx` | 3 | Thread `roles` → `MessageInput` |
| WebSocket receive path (wherever mention handling belongs) | 4 | Call `isMentioned`; update MMKV badge counter |

---

## Verification checklist (before marking done)

- [ ] Send a message with `@<username>` from mobile → verify it appears as a highlighted pill on desktop.
- [ ] Send a message with `@<username>` from desktop → verify it appears as a highlighted pill on mobile.
- [ ] Send a message with `@everyone` from a permissioned account on mobile → verify desktop notification fires.
- [ ] Send a message with `@everyone` from an account without `mention:everyone` → verify autocomplete option is hidden.
- [ ] Send a role mention → verify the role name pill appears on both platforms.
- [ ] Bold (`**text**`), italic (`_text_`), strikethrough (`~~text~~`) render correctly on mobile.
- [ ] Inline code (`` `code` ``) renders with monospace background.
- [ ] Fenced code block renders scrollable; copy button works.
- [ ] `||spoiler||` renders as hidden text; tap reveals it.
- [ ] A message with no markdown syntax routes through the old `MentionableText` path — no regression.
- [ ] Emoji-only messages still render larger (existing `MentionableText` behavior preserved).
- [ ] Non-markdown DMs are unaffected.
- [ ] Channel mention (`#general`) still renders and navigates correctly after the regex change.
- [ ] Legacy messages in storage (bare `@address` format) still render as mention pills after the dual-format regex change.

---

## Shared package version note

The `@everyone` receive-side permission check landed in `quorum-shared@2.1.0-30` (PR #41). Mobile is currently on `2.1.0-29`. The bump to `2.1.0-30` is already planned (it also carries the owner-bypass fix from the Wave 0 task). Phase 1 and Phase 2 work does NOT require the bump — only the `@everyone` permission gate in Phase 3 benefits from it. The bump can land independently.

---

*Last updated: 2026-06-18*
