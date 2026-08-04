---
type: task
title: "Adopt shared image-compression CONFIG on mobile (numbers only, not orchestration)"
status: done
priority: medium
ai_generated: true
created: 2026-06-24
updated: 2026-07-20
---

# Adopt shared image-compression CONFIG on mobile (config-only)

## Status

shipped in PR #156 (commit 201ac52); config-only adoption complete, all 3 bugs fixed, desktop doc updated


> **⚠️ AI-Generated**: Verify file paths and numeric values before implementing. References checked on 2026-06-24.

## ⚠️ SCOPE DECISION (2026-06-24): config-only, NOT the orchestration adapter

After mapping mobile's image surfaces, the team chose **config-only adoption**. Rationale: mobile's image complexity (base64/URI handling, the 150KB avatar OOM cap, PNG-vs-JPEG, per-surface return shapes, the byte-target quality sweep) is **inherent to mobile and already exists** — it is NOT created by sharing. The shared *engine* can never be shared (compressorjs vs expo-image-manipulator). The genuine win is **killing config drift** (avatar was 123 desktop / 512 mobile; emoji 36 / 128). That win comes from the `IMAGE_CONFIGS` numbers alone. The `ImagePlatform`/`processImageWithConfig` orchestration adapter would be nearly as much net-new code as it replaces, and it sits on the live upload path — high risk, thin payoff.

**So: mobile keeps ALL its existing image functions unchanged** (`pickImage`, `pickMedia`, `compressAvatarImage`, `pickEmoji`, `pickSticker`, the sweep, the PNG logic, `ProcessedAttachment`). **The ONLY change is that the hardcoded numbers are read from shared `IMAGE_CONFIGS` instead of inline objects.** Do NOT build the adapter, do NOT call `processImageWithConfig`/`processAttachmentWithConfig`, do NOT touch the return shapes.

The full-adoption analysis (adapter design, the 5 open decisions, impedance mismatch) is preserved at the bottom under "Appendix: full-adoption analysis (NOT the chosen path)" for reference if mobile ever revisits.

## Why

Desktop and mobile had drifting per-surface limits (avatar 512 vs 123; emoji 128 vs 36). Desktop already consumes shared `IMAGE_CONFIGS` (shipped). This makes mobile read the same numbers so a future dimension change is one edit in `quorum-shared`, both apps — drift can't silently return.

## Prereqs

- ✅ Shared `imageConfig`/`imageOrchestration` MODULES published in `2.1.0-33` (present in the installed dist; symbols resolve in mobile TS).
- ✅ Mobile dep bumped `2.1.0-32`→`2.1.0-33` + installed (master commit `8ade56a`).
- ✅ **The required VALUES are now published in `2.1.0-34`.** Verified 2026-07-16 against the published tarball (`npm pack @quilibrium/quorum-shared@2.1.0-34`, `dist/index.native.js`): `IMAGE_CONFIGS.avatar.maxWidth === 512` and `emoji.maxWidth === 128` — exactly what this task needed. `2.1.0-34` is npm's `latest` dist-tag.
- 🟢 **UNBLOCKED (2026-07-16).** The only remaining action is the dep bump: `package.json` `2.1.0-33`→`2.1.0-34` + install, then start the code changes below. (Config values, not wire types, so this is a normal additive bump — merge the mobile PR once installed; nothing lead-gated remains.)
- ⚠️ **Do a post-install sanity check anyway:** after bumping, confirm `IMAGE_CONFIGS.avatar.maxWidth === 512` in the *installed* `node_modules/@quilibrium/quorum-shared/dist/index.native.js` before treating the code changes as verifiable. (Don't switch to stable `2.1.0` — it's an older line with no `IMAGE_CONFIGS`.)

> Note: the current working branch is not this task's branch — bump + install only when you actually start this work, not while parked on an unrelated branch.

---

## The change (config-only)

For each surface, replace the inline numeric config with a read from shared `IMAGE_CONFIGS`. The surrounding logic (picker calls, `manipulateAsync` actions, the byte-target sweep, PNG/JPEG choice, GIF passthrough, return shapes) stays exactly as-is.

```ts
import { IMAGE_CONFIGS } from '@quilibrium/quorum-shared';
```

| File | Today (inline) | After (read from shared) | Net behavior change |
|---|---|---|---|
| `services/media/imageAttachment.ts:25-34` | `IMAGE_CONFIG = { maxWidth:1200, maxHeight:1200, quality:0.8, thumbnailMaxSize:300, thumbnailThreshold:300, targetFileSizeBytes:1MB, maxGifSizeMB:2, maxFileSizeMB:25(dead) }` | `IMAGE_CONFIGS.messageAttachment` (maxWidth/Height 1200, quality 0.8, thumbnailConfig 300, gifSizeLimit 2MB). Keep mobile's `targetFileSizeBytes` (1MB) local — shared has no byte target. | none (1200 unchanged) |
| `compressAvatarImage` `imageAttachment.ts:468` | `MAX_DIM = 512` | `IMAGE_CONFIGS.avatar.maxWidth` = **512** (shared bumped 256→512 on 2026-06-25, ships in `2.1.0-34`). | none (512 unchanged, now sourced from shared) |
| `customAssets.ts` `EMOJI_CONFIG` `:15-19` | `maxSize:128, quality:0.8, maxGifSizeKB:100, maxInputSizeMB:5` | `IMAGE_CONFIGS.emoji` (maxWidth **128** — shared bumped 96→128 on 2026-06-25, ships in `2.1.0-34`; gifSizeLimit 100KB) + `FILE_SIZE_LIMITS.MAX_EMOJI_INPUT_SIZE` (5MB) | none (128 unchanged, now sourced from shared) |
| `customAssets.ts` `STICKER_CONFIG` `:22-25` | `maxSize:512, quality:0.8, maxGifSizeKB:750, maxInputSizeMB:25` | `IMAGE_CONFIGS.sticker` (maxWidth 512, gifSizeLimit 750KB) + `FILE_SIZE_LIMITS.MAX_INPUT_SIZE` (25MB) | none (512 unchanged) |
| Space icon `SpaceSettingsModal.tsx:924` (uses `pickImage` → 1200) | reuses attachment 1200 | give it `IMAGE_CONFIGS.spaceIcon` (256) — small refactor so icon doesn't ride the 1200 attachment path | **icon → 256** |
| Space banner `SpaceSettingsModal.tsx:931` (uses `pickImage` → 1200) | reuses attachment 1200 | give it `IMAGE_CONFIGS.spaceBanner` (1600×900) | **banner → 1600×900** |

Notes on the read:
- `maxSize` for emoji/sticker (longest-axis) maps to `IMAGE_CONFIGS.emoji.maxWidth` / `.sticker.maxWidth` (both square in shared; mobile uses the value as a single max bound — fine).
- Keep mobile's PNG (`customAssets`) and JPEG (`imageAttachment`) `SaveFormat` choices exactly as they are — shared config has no format field and we're not introducing one here.
- Keep the avatar 150KB byte sweep and the attachment 1MB target as mobile-local constants — they have no shared equivalent and are load-bearing (the 150KB cap prevents an okhttp OOM, `imageAttachment.ts:448-451`).

## Number decisions — ✅ DECIDED (2026-06-24, revised 2026-06-25)

- **D-AVATAR — KEEP 512, sourced from shared.** Decision evolved: 2026-06-24 said adopt shared's 256; 2026-06-25 the team kept 512 because avatars open full-screen when tapped (e.g. Farcaster author avatars) and 256 looks soft enlarged. Rather than diverge mobile-locally, **shared's `IMAGE_CONFIGS.avatar` was bumped 256→512** so it stays a single source of truth (desktop adopts 512 too). Mobile reads `IMAGE_CONFIGS.avatar.maxWidth` like every other surface — **no mobile-local override**. Gated on `2.1.0-34`. **Keep the 150KB byte cap** regardless (OOM protection, independent of dimension; stays mobile-local — shared has no byte target).
- **D-EMOJI — KEEP 128, sourced from shared.** Decision evolved: 2026-06-24 said adopt shared's 96; 2026-06-25 the team kept 128. **Shared's `IMAGE_CONFIGS.emoji` was bumped 96→128**; mobile reads it. **Keep mobile's aspect-preserving resize** (do NOT switch to the square crop shared's `cropToFit` nominally implies) — just source the max bound from `IMAGE_CONFIGS.emoji.maxWidth` (128).

(Both only affect newly-uploaded images; existing stored ones keep their size.)

> **Shared change required + the publish gate.** Unlike the rest of this config-only task, D-AVATAR and D-EMOJI required editing `quorum-shared` (done 2026-06-25, `src/utils/imageConfig.ts`). Because we cannot publish shared ourselves, mobile is BLOCKED until the lead publishes `2.1.0-34` and mobile bumps. See Prereqs.

Everything else (PNG/JPEG, skins, the adapter) is not in play under config-only scope.

## Bugs to fix while here (independent of scope)
1. **Dead `IMAGE_CONFIG.maxFileSizeMB: 25`** (`imageAttachment.ts:31`, single unreferenced occurrence — input size is never enforced today). Either wire an input-size guard using `FILE_SIZE_LIMITS.MAX_INPUT_SIZE`, or remove the dead field. Prefer wiring the guard (cheap real protection).
2. **Onboarding avatar uncompressed** (`profile-setup.tsx:73,92`): stores the raw picker URI → becomes `user.profileImage` → can broadcast as `userIcon` (a full multi-MP photo). Route it through `compressAvatarImage` like the other avatar surfaces. **This closes a real OOM/bandwidth risk, not just consistency.**
3. **`exif:false` missing** on 4 pickers — add while touching them: `ProfileModal.tsx:985`, `UnifiedProfileEditModal.tsx:97-106`, `SpaceSettingsModal.tsx:618-624` (space avatar), `SkinEditor.tsx:157-160`. (Chat/emoji/sticker/onboarding pickers already have it — verified.)

## Acceptance (config-only)
- Inline `IMAGE_CONFIG`/`EMOJI_CONFIG`/`STICKER_CONFIG` numbers come from shared `IMAGE_CONFIGS`/`FILE_SIZE_LIMITS`; no orchestration adapter added; all existing functions + return shapes unchanged.
- Avatar **512 (read from shared `2.1.0-34`)** with the 150KB cap intact; emoji **128 (read from shared)**; icon 256; banner 1600×900.
- PNG transparency for emoji/sticker preserved (unchanged code, but verify); avatar byte cap preserved.
- 3 bugs fixed (dead `maxFileSizeMB`, onboarding avatar compressed, `exif:false` on the 4 pickers).
- Typecheck + lint green; **dev-build/device check** of avatar, emoji (transparent PNG), sticker, space icon, banner, message image (+ thumbnail + large GIF), Farcaster cast image. Video path unchanged.
- Update the "Mobile" section in desktop `.agents/docs/features/messages/client-side-image-compression.md` to "implemented (config shared; engine + orchestration remain per-platform by design)".

## Notes
- Mobile `.agents/` is gitignored — no separate mobile doc; the desktop feature doc is the cross-platform source of truth.
- The shared `imageOrchestration` (`processImageWithConfig`/`ImagePlatform`) stays UNUSED by mobile under this scope. It still serves desktop. Revisit full adoption only if mobile's image surfaces are later unified (see appendix).

---

# Appendix: full-adoption analysis (NOT the chosen path)

> Kept for reference. This was the original full plan (adapter + orchestration). The team chose config-only above. Read this only if revisiting full adoption.
>
> **On the existing shared/desktop work:** nothing was rethought or reverted. `imageConfig` is the high-value piece mobile adopts. `imageOrchestration` (`processImageWithConfig` + `ImagePlatform`) stays in shared serving DESKTOP only — it's working, tested, and left as-is by decision (2026-06-24). It's a cross-platform abstraction with one consumer for now; that's intentional, not abandoned. Desktop's dimension changes + GIF/EXIF fixes (PRs #215/#216) stood on their own merit regardless of mobile's scope.

## ⚠️ The data-flow impedance mismatch (why full adoption is heavy)

This is NOT a drop-in like desktop. Desktop's pipeline is `File → File` (browser canvas), and the shared orchestrator was designed around desktop's shape. **Mobile works in URIs and base64 data URLs, not `File` objects**, and its surfaces return platform-specific shapes that many callers destructure. The shared orchestrator is generic (`<F extends {size,type}, R>`), so it CAN accommodate mobile — but the mobile `ImagePlatform` adapter has to bridge a real gap. The bulk of full adoption is writing that adapter correctly and preserving every caller's return shape, NOT swapping configs.

**Verified facts this plan rests on (all checked 2026-06-24, file:line below):**
- Mobile has NO single image util — logic is spread across `services/media/imageAttachment.ts`, `services/media/customAssets.ts`, and an inline `pickImage` in `components/skins/SkinEditor.tsx`.
- Each surface returns a DIFFERENT mobile-specific shape that callers destructure (see Surface Inventory). These shapes are the contract; the adapter must preserve them.
- Mobile's compression does an **iterative quality sweep to a byte target** (1MB for attachments, 150KB for avatars). The shared orchestrator has NO byte-target concept — it calls `platform.compress(file, opts)` once. So the sweep MUST live inside the adapter's `compress`.
- The avatar 150KB byte cap is **load-bearing**, not arbitrary: `imageAttachment.ts:448-451` documents that an uncompressed phone photo (5-30MB base64) **OOMs RN's okhttp HTTP layer** (it reads the whole response body into one byte array). Do NOT drop this cap.

## Surface inventory (verified, file:line)

| Surface | Entry fn | Input | Return shape (callers depend on this) | Current config | Format | Callers |
|---|---|---|---|---|---|---|
| Message attachment (chat) | `pickImage` `imageAttachment.ts:68` | picker asset (uri/w/h/mimeType/fileSize) | `ProcessedAttachment` (`.imageUrl` base64, `.thumbnailUrl`, `.width`, `.height`, `.isLargeGif`, `.localUri`, `.mimeType`) | inline `IMAGE_CONFIG` `:25-34` (1200, 1MB target, thumb 300) | JPEG | `SpaceChatArea.tsx:519`, `DMChatArea.tsx:307`, `FarcasterDirectMessageView.tsx:119` |
| Message attachment (+video) | `pickMedia` `imageAttachment.ts:373` | picker (images+video) | same `ProcessedAttachment`; **video branch must stay untouched** | same | JPEG | `CastComposeModal.tsx:65`, `SocialFeedModal.tsx:2281,6153` |
| Avatar (profile) | `compressAvatarImage` `imageAttachment.ts:462` | **URI string + (w,h)** — NOT a picker asset | `{ dataUri, width, height } \| null` | hardcoded MAX_DIM 512, MAX_BYTES 150KB, sweep 0.85→0.2 | JPEG | `ProfileModal.tsx:995`, `UnifiedProfileEditModal.tsx:110`, `SpaceSettingsModal.tsx:627`, `UnifiedProfileScreen.tsx:157` (remote URI!) |
| Space icon | `handlePickIcon` `SpaceSettingsModal.tsx:924` → `pickImage` | picker | reads only `.imageUrl` | reuses `IMAGE_CONFIG` (1200!) — **no icon config today** | JPEG | self |
| Space banner | `handlePickBanner` `SpaceSettingsModal.tsx:931` → `pickImage` | picker | reads only `.imageUrl` | reuses `IMAGE_CONFIG` (1200!) — **no banner config today** | JPEG | self; renders `SpaceBannerHeader.tsx:11,167` (full-width×180, `cover`) |
| Custom emoji | `pickEmoji` `customAssets.ts:122` | picker (base64:true) | `{ asset: { id, name, imgUrl } }` (`imgUrl` = base64 data URL) | inline `EMOJI_CONFIG` (128px, 100KB GIF, 5MB in) | **PNG** | `SpaceSettingsModal.tsx:979` |
| Custom sticker | `pickSticker` `customAssets.ts:157` | picker (base64:true) | `{ asset: { id, name, imgUrl } }` | inline `STICKER_CONFIG` (512px, 750KB GIF, 25MB in) | **PNG** | `SpaceSettingsModal.tsx:1074` |
| Onboarding avatar | `handlePickImage/Photo` `profile-setup.tsx:57,77` | picker | stores raw `result.assets[0].uri` — **NO compression** | none | n/a (raw) | self → `updateProfile({profileImageUri})` → broadcast as `userIcon` |
| Skin wallpaper/icons | inline `pickImage` `SkinEditor.tsx:151` | picker (quality:1) | `string \| null` (base64 JPEG data URL) | inline 2048px, q0.85; budget `theme/skins/validate.ts` MAX_SKIN_BYTES 2MB | JPEG | `SkinEditor.tsx:183,188` |

## ⚠️ OPEN DECISIONS — settle these BEFORE implementing

These are real choices, not mechanical. Each changes behavior. Recommendation given; lead/user to confirm.

### D1 — PNG vs JPEG output (the desktop-bug trap)
The shared `ImageConfig` has **no output-format field**. Mobile's emoji/sticker MUST stay **PNG** (transparency) — `customAssets.ts:99` uses `SaveFormat.PNG`. Desktop's draft PR forced JPEG and would have flattened alpha; we must NOT repeat that.
- **Option A (no shared change):** the mobile adapter's `compress` picks format from the surface/input — PNG for emoji+sticker (or when input mime is `image/png`), JPEG otherwise. Self-contained in mobile.
- **Option B (shared change):** add `outputFormat?: 'jpeg'|'png'` to shared `ImageConfig` (+ desktop adopts it). Cleaner/explicit, but needs another quorum-shared PR + publish + desktop update before mobile can land — re-introduces the publish gate.
- **Recommendation: Option A.** Keep format logic in the adapter; revisit Option B later if desktop wants the same explicitness. **Decide before coding.**

### D2 — Avatar: adopt 256 + keep the 150KB OOM cap?
Shared `avatar` = **256×256**, no byte target. Mobile today = **512×512 + 150KB sweep** (the 150KB cap prevents the okhttp OOM, `imageAttachment.ts:448`).
- Dimensions: adopt 256 (consistent w/ desktop; halves stored avatars) vs keep 512. The earlier canonical decision said 256 — but that was decided without the mobile-512-render-source context. **Confirm 256 is OK for mobile's avatar render, or override to 384/512 for mobile.**
- Byte cap: **non-negotiable — keep the 150KB sweep in the adapter regardless of dimension.** Shared config alone (quality 0.8, no byte target) would NOT guarantee <150KB and could reintroduce the OOM.
- **Recommendation: adopt 256 dims, KEEP the 150KB byte-target sweep inside the adapter.** Confirm the 256 dimension.

### D3 — Emoji: 96×96 square crop vs mobile's 128px aspect-preserving
Shared `emoji` = 96×96 `cropToFit` (square crop). Mobile today = 128px longest-axis, aspect-preserving (`customAssets.ts:96-100`), NOT cropped.
- Adopting shared = emoji become 96px AND square-cropped (non-square emoji get cropped). That's a visible behavior change.
- **Recommendation: adopt 96×96 to match desktop/canonical** (emoji are tiny + usually square), but FLAG that non-square emoji will now crop. Confirm, or override the adapter to keep aspect-preserving for emoji/sticker.

### D4 — Skin images: in or out of scope?
`SkinEditor` has its own inline pipeline (2048px, 2MB total budget via `validateSkin`) that's quite different from the per-asset surfaces. It's not in `IMAGE_CONFIGS`.
- **Recommendation: OUT of scope for this task.** Leave SkinEditor as-is (or just add `exif:false`). Folding skins into the shared config would need a new `skin` config entry (shared change) and careful budget reconciliation — separate task.

### D5 — Space icon/banner: switch to the real configs
Today both reuse the 1200px attachment path. After this task: icon → `spaceIcon` (256 crop), banner → `spaceBanner` (1600×900 fit). Callers only read `.imageUrl`, so no structural break, but output size/dims change. **Low risk, do it.**

## Adapter design (the core of the work)

Create `services/media/imagePlatform.ts` (new) exporting a mobile `ImagePlatform<MobileImageFile, MobileProcessedImage>`:

```ts
interface MobileImageFile { uri: string; width: number; height: number; size: number; type: string }
interface MobileProcessedImage { dataUri: string; width: number; height: number; uri: string }
```
- **`compress(file, opts)`** — the heavy one. Wraps `ImageManipulator.manipulateAsync`. Maps shared `opts` (maxWidth/Height, cropToFit→`resize:'cover'`-equivalent or aspect-fit, quality) to manipulate actions. Contains the **byte-target quality sweep** (per-surface target — see D2; pass target via an adapter-level lookup or extended opts, since shared opts has no byte target). Picks **format per D1**. Returns base64 + dims + temp uri.
- **`passthroughGif(file, config)`** — `FileSystem.readAsStringAsync(uri,{encoding:'base64'})` → `data:image/gif;base64,...`. Mirrors current `processImageAsset` GIF path (`imageAttachment.ts:237`).
- **`getDimensions(file)`** — returns `{width: file.width, height: file.height}` (already known from picker). Edge case: `compressAvatarImage`'s remote-URI path (`UnifiedProfileScreen.tsx:157`) has no picker dims — fetch via `FileSystem.downloadAsync` then read from the manipulate result, or `Image.getSize`.

Then refactor each surface to: build a `MobileImageFile` from the picker asset → call shared `processImageWithConfig(file, '<type>', platform)` (or `processAttachmentWithConfig` for messages) → **map the `MobileProcessedImage` back into that surface's existing return shape** (`ProcessedAttachment` / `{dataUri,...}` / `{asset:{imgUrl}}`). The mapping layer is what keeps callers working unchanged.

### Gotchas the adapter must handle (verified)
- **`fileSize` can be `undefined`** from the picker (esp. simulator). Shared `ImageInput.size` is required → fill via `FileSystem.getInfoAsync(uri)` when missing, else size-validation silently never rejects.
- **`localUri` + `mimeType`** on `ProcessedAttachment` feed the Farcaster `uploadImageForCast` path (`CastComposeModal`, `SocialFeedModal`) — must survive into the mapped result; they're NOT in shared `AttachmentResult<R>` (mobile-specific, add in the mapping layer).
- **GIF thumbnail**: mobile has no real poster-frame extraction today (uses the GIF as its own thumbnail). The injected `generateGifThumbnail` for `processAttachmentWithConfig` should match current behavior (passthrough), not attempt frame extraction (would need a native module — separate task if desired).
- **`expo-image-manipulator` version**: confirm installed version still supports `manipulateAsync(uri, actions, {compress, format, base64})` (it does today).

## Mobile bugs to fix while here (verified)
1. **`IMAGE_CONFIG.maxFileSizeMB: 25` is DEAD** (`imageAttachment.ts:31`, single unreferenced occurrence). Input size is currently never enforced. Routing through shared `processImageWithConfig` adds `validateInputFileSize` (uses `FILE_SIZE_LIMITS.MAX_INPUT_SIZE`) — this fixes it for free. Remove the dead field.
2. **Onboarding avatar uncompressed** (`profile-setup.tsx:73,92`): stores the raw picker URI; `handleContinue` passes it to `updateProfile`, it becomes `user.profileImage` and can broadcast as `userIcon` — a full multi-MP photo. Route it through the avatar path (`compressAvatarImage` or the new adapter w/ the `avatar` config + 150KB cap). **This also closes a real OOM/bandwidth risk, not just consistency.**
3. **`exif:false` missing** on these pickers — add while touching them: `ProfileModal.tsx:985`, `UnifiedProfileEditModal.tsx:97-106`, `SpaceSettingsModal.tsx:618-624` (space avatar), `SkinEditor.tsx:157-160`. (The chat/emoji/sticker/onboarding pickers already have it — verified.)

## Suggested implementation order (incremental, each independently verifiable)
1. Build `imagePlatform.ts` adapter + a thin `MobileImageFile` builder; unit-reason about it. No surface changes yet.
2. Migrate ONE simple surface first (space **icon** — caller only reads `.imageUrl`, lowest blast radius) to prove the adapter end-to-end on device.
3. Migrate emoji + sticker (validate **PNG transparency** preserved — the D1 trap).
4. Migrate message attachment via `processAttachmentWithConfig` (highest blast radius — `.thumbnailUrl`/`.isLargeGif`/`.localUri` must survive; test send on space + DM + Farcaster).
5. Migrate avatars (keep 150KB cap) + fix onboarding avatar.
6. Migrate space banner.
7. Add the missing `exif:false`. Remove dead `maxFileSizeMB`.
8. Delete the now-unused inline `IMAGE_CONFIG`/`EMOJI_CONFIG`/`STICKER_CONFIG`.

## Acceptance
- Every per-asset surface (avatar, space icon, banner, emoji, sticker, message attachment + onboarding avatar) routes through shared `IMAGE_CONFIGS` + the orchestrator; inline `IMAGE_CONFIG`/`EMOJI_CONFIG`/`STICKER_CONFIG` removed. (Skins out of scope per D4.)
- Canonical dims applied per the D2/D3/D5 decisions.
- **PNG transparency preserved** for emoji/sticker (the D1 check — verify on a transparent PNG emoji).
- **Avatar 150KB byte cap preserved** (verify a large camera photo doesn't OOM / produces a small base64).
- Onboarding avatar compressed; dead `maxFileSizeMB` removed; `exif:false` on all pickers.
- All caller return-shapes intact (no destructure breaks): chat send (space/DM/Farcaster) with thumbnail + large-GIF; Farcaster cast image upload via `localUri`; profile/space-avatar/space-icon/banner upload; emoji+sticker add.
- Video path in `pickMedia` unchanged.
- **Verified on a real build/device** (not just typecheck) — the impedance-mismatch risks (base64/URI, undefined fileSize, thumbnail, GIF) only surface at runtime.
- Update the feature doc's "Mobile" section in quorum-desktop `.agents/docs/features/messages/client-side-image-compression.md` to "implemented via shared". (Mobile `.agents/` is gitignored — no separate mobile doc.)

## Notes
- Shared `2.1.0-33` is published WITH the image modules + already bumped on mobile `master` (commit `8ade56a`, 2026-06-24). No further publish needed.
- The shared orchestrator deliberately delegates the actual compress (incl. any byte-target sweep + format choice) to the injected adapter — mobile's sweep + PNG logic live there, not in shared.
- Risk ranking (most likely to break): (1) `ProcessedAttachment` shape coupling on the chat send path; (2) PNG→JPEG alpha loss on emoji/sticker (D1); (3) avatar OOM if the 150KB cap is dropped (D2); (4) `undefined` fileSize from the simulator; (5) GIF thumbnail/passthrough.

*Last updated: 2026-06-25*
