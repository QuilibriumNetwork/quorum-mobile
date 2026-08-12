export { IdentityScopeProvider, useIdentityContext } from './identityProvider';
// RootIdentityScope is deliberately NOT re-exported here. It is mounted
// exactly once, at the app root (app/_layout.tsx imports it from
// './RootIdentityScope' directly) — none of the ~26 name-resolution call
// sites this barrel exists for ever need it. Keeping it out matters because
// this barrel evaluates eagerly: `import { MemberName } from '@/identity'`
// would otherwise execute RootIdentityScope's full module graph too (real
// AuthContext/StorageContext, down to a native crypto module jest cannot
// satisfy — see identityBarrelSafety.test.tsx), breaking every one of those
// call sites' render tests for a component they never asked for.
export {
  identityFromMaps,
  selfLocalNameEntry,
  EMPTY_LOCAL_NAMES,
  EMPTY_ROSTERS_BY_SPACE,
} from './identityFromMaps';
export type { RosterNameRow, IdentitySources } from './identityFromMaps';
export { MemberName } from './MemberName';
export {
  useResolvedName,
  useResolvedMemberName,
  useMemberIdentity,
} from './useResolvedName';
export type { ResolvedMemberName, UseResolvedNameOptions } from './useResolvedName';
export { useNameResolver } from './useNameResolver';
export type { NameResolver } from './useNameResolver';
export type { MemberIdentity, IdentityScope } from '@quilibrium/quorum-shared';
