---
type: bug
title: "sendStickerMessage passes sealHubEnvelope args 3/4 swapped (pre-existing; matches baseline tsc error)"
status: done
created: 2026-07-19
severity: medium (space sticker sends likely broken or mis-sealed)
platforms: quorum-mobile
---

# sendStickerMessage sealHubEnvelope argument swap

`services/space/spaceMessageService.ts` (~line 395, `sendStickerMessage`)
calls:

```ts
sealHubEnvelope(hubKey.address, hubKeypair,
  configKey?.publicKey ? hexToNumberArray(configKey.publicKey) : undefined,
  hubMessagePayload)
```

but the provider signature is `(hubAddress, hubKeypair, message: string,
configKey?)` — arguments 3 and 4 are swapped. Every OTHER send path
(`sendSpaceMessage`, `sendGenericMessage`) calls it correctly with the payload
third and the config keypair object fourth.

This is the long-standing baseline tsc error
(`error TS2345: Argument of type 'number[] | undefined' is not assignable to
parameter of type 'string'`) — it predates the 2026-07-19 auth/signing work
(verified present on master via stashed-baseline tsc). Spotted by independent
review of the signing-key branch.

Also note the third arg is wrong even accounting for the swap: other callers
pass `{publicKey: number[], privateKey: number[]}` for configKey, not a bare
public-key array.

**To fix (separate PR):** make the call match `sendGenericMessage`'s shape,
then manually verify a sticker send lands cross-device (it may have been
silently broken — check whether space stickers currently deliver at all).

*Last updated: 2026-07-19*
