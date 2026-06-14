/**
 * useRoleManagement - Hooks for managing space roles
 *
 * Provides:
 * - useRoles: Query to get roles for a space
 * - useAddRole: Mutation to add a new role
 * - useUpdateRole: Mutation to update role properties
 * - useDeleteRole: Mutation to delete a role
 * - useAssignRole: Mutation to assign a user to a role
 * - useRemoveFromRole: Mutation to remove a user from a role
 *
 * All mutations that modify roles also broadcast the updated space manifest
 * to all members via the API and hub WebSocket.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context';
import { useWebSocket } from '@/context/WebSocketContext';
import { getSpace, saveSpace } from '@/services/config/spaceStorage';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import { broadcastSpaceUpdate } from '@/services/space/broadcastSpaceUpdate';
import type { Space, Role, Permission } from '@quilibrium/quorum-shared';
import { toggleRolePermission } from '@quilibrium/quorum-shared';

/**
 * Generate a UUID v4 using crypto.getRandomValues
 * (crypto is polyfilled by react-native-get-random-values)
 */
function generateUUID(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  // Set version (4) and variant (RFC4122)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Get roles for a space
 */
export function useRoles(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['roles', spaceId],
    queryFn: async (): Promise<Role[]> => {
      if (!spaceId) return [];
      const space = getSpace(spaceId);
      return space?.roles ?? [];
    },
    enabled: !!spaceId,
  });
}

/**
 * Check if a user has a specific permission in a space
 */
export function useHasPermission(
  spaceId: string | undefined,
  userAddress: string | undefined,
  permission: Permission
): boolean {
  const { data: roles } = useRoles(spaceId);

  if (!roles || !userAddress) return false;

  // Check if user is in any role that has the permission
  for (const role of roles) {
    if (role.members.includes(userAddress) && role.permissions.includes(permission)) {
      return true;
    }
  }

  return false;
}

/**
 * Get all permissions a user has in a space
 */
export function useUserPermissions(
  spaceId: string | undefined,
  userAddress: string | undefined
): Permission[] {
  const { data: roles } = useRoles(spaceId);

  if (!roles || !userAddress) return [];

  const permissions = new Set<Permission>();

  for (const role of roles) {
    if (role.members.includes(userAddress)) {
      for (const perm of role.permissions) {
        permissions.add(perm);
      }
    }
  }

  return Array.from(permissions);
}

/**
 * Get all roles a user has in a space
 */
export function useUserRoles(
  spaceId: string | undefined,
  userAddress: string | undefined
): Role[] {
  const { data: roles } = useRoles(spaceId);

  if (!roles || !userAddress) return [];

  return roles.filter(role => role.members.includes(userAddress));
}

interface AddRoleParams {
  spaceId: string;
  displayName: string;
  roleTag: string;
  color: string;
  permissions?: Permission[];
  isPublic?: boolean;
}

/**
 * Add a new role to a space
 */
export function useAddRole() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: AddRoleParams): Promise<Role> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      const newRole: Role = {
        roleId: generateUUID(),
        displayName: params.displayName,
        roleTag: params.roleTag,
        color: params.color,
        members: [],
        permissions: params.permissions ?? [],
        isPublic: params.isPublic ?? true,
      };

      const updatedSpace: Space = {
        ...space,
        roles: [...space.roles, newRole],
        modifiedDate: Date.now(),
      };

      // Save to both storages
      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });

      return newRole;
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['roles', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

interface UpdateRoleParams {
  spaceId: string;
  roleId: string;
  displayName?: string;
  roleTag?: string;
  color?: string;
  permissions?: Permission[];
  isPublic?: boolean;
}

/**
 * Update an existing role
 */
export function useUpdateRole() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: UpdateRoleParams): Promise<Role> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      const roleIndex = space.roles.findIndex(r => r.roleId === params.roleId);
      if (roleIndex === -1) {
        throw new Error('Role not found');
      }

      const existingRole = space.roles[roleIndex];
      const updatedRole: Role = {
        ...existingRole,
        displayName: params.displayName ?? existingRole.displayName,
        roleTag: params.roleTag ?? existingRole.roleTag,
        color: params.color ?? existingRole.color,
        permissions: params.permissions ?? existingRole.permissions,
        isPublic: params.isPublic ?? existingRole.isPublic,
      };

      const updatedRoles = [...space.roles];
      updatedRoles[roleIndex] = updatedRole;

      const updatedSpace: Space = {
        ...space,
        roles: updatedRoles,
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });

      return updatedRole;
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['roles', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

interface DeleteRoleParams {
  spaceId: string;
  roleId: string;
}

/**
 * Delete a role from a space
 */
export function useDeleteRole() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: DeleteRoleParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      const updatedSpace: Space = {
        ...space,
        roles: space.roles.filter(r => r.roleId !== params.roleId),
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['roles', params.spaceId] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

interface AssignRoleParams {
  spaceId: string;
  roleId: string;
  userAddress: string;
}

/**
 * Assign a user to a role
 */
export function useAssignRole() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: AssignRoleParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      const roleIndex = space.roles.findIndex(r => r.roleId === params.roleId);
      if (roleIndex === -1) {
        throw new Error('Role not found');
      }

      const existingRole = space.roles[roleIndex];
      if (existingRole.members.includes(params.userAddress)) {
        return; // Already assigned
      }

      const updatedRole: Role = {
        ...existingRole,
        members: [...existingRole.members, params.userAddress],
      };

      const updatedRoles = [...space.roles];
      updatedRoles[roleIndex] = updatedRole;

      const updatedSpace: Space = {
        ...space,
        roles: updatedRoles,
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['roles', params.spaceId] });
    },
  });
}

/**
 * Remove a user from a role
 */
export function useRemoveFromRole() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: AssignRoleParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      const roleIndex = space.roles.findIndex(r => r.roleId === params.roleId);
      if (roleIndex === -1) {
        throw new Error('Role not found');
      }

      const existingRole = space.roles[roleIndex];
      const updatedRole: Role = {
        ...existingRole,
        members: existingRole.members.filter(m => m !== params.userAddress),
      };

      const updatedRoles = [...space.roles];
      updatedRoles[roleIndex] = updatedRole;

      const updatedSpace: Space = {
        ...space,
        roles: updatedRoles,
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['roles', params.spaceId] });
    },
  });
}

interface TogglePermissionParams {
  spaceId: string;
  roleId: string;
  permission: Permission;
}

/**
 * Toggle a permission on a role
 */
export function useToggleRolePermission() {
  const queryClient = useQueryClient();
  const { enqueueOutbound } = useWebSocket();

  return useMutation({
    mutationFn: async (params: TogglePermissionParams): Promise<void> => {
      const space = getSpace(params.spaceId);
      if (!space) {
        throw new Error('Space not found');
      }

      const roleIndex = space.roles.findIndex(r => r.roleId === params.roleId);
      if (roleIndex === -1) {
        throw new Error('Role not found');
      }

      const existingRole = space.roles[roleIndex];
      const updatedRole = toggleRolePermission(existingRole, params.permission);

      const updatedRoles = [...space.roles];
      updatedRoles[roleIndex] = updatedRole;

      const updatedSpace: Space = {
        ...space,
        roles: updatedRoles,
        modifiedDate: Date.now(),
      };

      saveSpace(updatedSpace);
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(updatedSpace);

      // Broadcast to all members
      enqueueOutbound(async () => {
        const result = await broadcastSpaceUpdate(updatedSpace);
        return result ? [result.wsEnvelope] : [];
      });
    },
    onSuccess: (_, params) => {
      queryClient.invalidateQueries({ queryKey: ['roles', params.spaceId] });
    },
  });
}
