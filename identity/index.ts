export { IdentityScopeProvider, useIdentityContext } from './identityProvider';
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
