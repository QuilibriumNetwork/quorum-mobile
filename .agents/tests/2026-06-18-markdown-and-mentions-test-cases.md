---
title: "Manual test cases — markdown renderer + mentions (Wave 1 Phase 2/3)"
type: test
created: 2026-06-18
branch: feat/markdown-renderer-and-mention-autocomplete
---

# Manual test — markdown renderer + mentions

Paste each line below into the mobile composer (a space channel, not a DM) and send.
Lines are written plain (no backtick wrappers) so you can select and copy directly.
After each line, the "→" note says what you should SEE.

Two render paths — this matters for the results:
- A message with NO markdown syntax → old MentionableText path. Here @name (bare)
  and #channelName (by name, spaces allowed) become pills.
- A message WITH markdown (asterisks, backticks, >, lists, etc.) → new
  MessageMarkdownRenderer. Here only the wire formats become pills: @<address>
  for users, @everyone, @<roleId> for roles, #<channelId> for channels. A bare
  @name / #channelName renders as plain text in this path.
- The composer autocomplete always inserts the wire format, so the realistic
  flow (type @, pick from the list) works in BOTH paths.

Values to reuse:
- user address: @QmVYRWmquW98yaymeRv7aLn6bqRYr9PAtWcG87Kj25YvPY
- user bare name (no-markdown path only): @lamat
- channel by name: #general
- channel with a space in the name: #Test Channel

=============================================================
A. MENTIONS — no-markdown path (plain messages)
=============================================================

hey @lamat are you around?
→ @lamat is a blue pill (bare name resolved against members).

ping @QmVYRWmquW98yaymeRv7aLn6bqRYr9PAtWcG87Kj25YvPY take a look
→ the address renders as a pill showing the member's display name.

@everyone standup in 5
→ @everyone is a highlighted pill.

see #general for details
→ #general is a channel pill, tappable → navigates.

posted in #Test Channel earlier
→ #Test Channel (with the space) is a channel pill, IF the name is exactly "Test Channel".

=============================================================
B. MENTIONS — markdown path (message also contains markdown)
=============================================================

**heads up** @QmVYRWmquW98yaymeRv7aLn6bqRYr9PAtWcG87Kj25YvPY check this
→ "heads up" bold; the address is a user pill.

**heads up** @QmQuCGpEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imXST1

> note for @everyone
→ blockquote containing an @everyone pill.

- follow up with @QmVYRWmquW98yaymeRv7aLn6bqRYr9PAtWcG87Kj25YvPY
→ list item with a user pill.

(Channels in the markdown path need the #<channelId> wire form — bare #general
will NOT pill here. To test, paste the channel's ID:)
**fyi** #<PASTE_CHANNEL_ID_HERE>

=============================================================
C. MARKDOWN FORMATTING — inline
=============================================================

**bold** and _italic_ and ~~strike~~ and `inline code`
→ each styled; "inline code" has a monospace chip background.

||this is a secret||
→ hidden/blacked-out text; tap to reveal, tap again to hide.

### A heading
→ "A heading" bold + larger.

check https://quilibrium.com for info
→ the URL is a tappable link (works in both paths).

=============================================================
D. MARKDOWN FORMATTING — blocks
=============================================================

(Code block — type three backticks, a newline, the code, a newline, three backticks.
Copy the 5 lines below as-is; they already use real backticks:)

```
const x = 1;
hello(x);
```
→ a code block with a copy button (top-right). Tap it → copies, icon flips to a check.

(Blockquote — copy both lines:)
> a quoted line
> second quoted line
→ left-border blockquote.

(Bulleted list — copy all three:)
- first
- second
- third
→ bulleted list.

(Numbered list — copy all three:)
1. one
2. two
3. three
→ numbered list.

(Thematic break — copy all three lines:)
above
---
below
→ a thin horizontal divider between the two lines.

=============================================================
E. NO-REGRESSION CHECKS
=============================================================

just a normal message with no formatting
→ renders exactly as before (no markdown processing).

🎉🎉🎉
→ emoji-only renders large (existing behavior preserved).

=============================================================
F. COMPOSE AUTOCOMPLETE (Phase 3) — type, don't paste
=============================================================

1. Type @ → list shows: everyone (only if you have the mention:everyone
   permission), then matching roles, then members. Capped at 8.
2. Type @e → @everyone stays at top (prefix of "everyone").
3. Pick a role → inserts @<roleId>; on send renders as the role-name pill in
   the role's color.
4. Pick @everyone → inserts @everyone; renders as the everyone pill.
5. From an account WITHOUT mention:everyone → the @everyone option is absent
   (not greyed — omitted).

=============================================================
G. CROSS-PLATFORM (desktop ↔ mobile)
=============================================================

- Send @<address> / @everyone / a role mention FROM desktop → all render as
  pills on mobile.
- Send the same FROM mobile (via autocomplete) → render as pills on desktop,
  and desktop fires the notification (Phase 1 wired extractMentionsFromText on
  the mobile send path).

=============================================================
NOTES / known gaps surfaced while writing these
=============================================================

- Channel mention in the markdown path only matches #<channelId>, not #name.
  The no-markdown path matches by name (#general). So a channel mention written
  as #general inside an otherwise-markdown message won't pill. Mirrors desktop's
  tokenizer, but the mobile composer's # autocomplete inserts #channelName (not
  the ID). Follow-up: either teach the markdown path to resolve #name against
  the channels prop, or have the # autocomplete insert #<channelId>.

Last updated: 2026-06-18
