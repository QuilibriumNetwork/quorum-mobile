// Ambient types for @tabler/icons-react-native deep-import subpaths, e.g.
//   import IconFlag from '@tabler/icons-react-native/IconFlag';
//
// The package ships per-icon declaration files under its "./*" export
// condition, but this project's moduleResolution doesn't pick them up, so we
// declare the wildcard subpath here. See components/ui/tablerIconRegistry.ts
// for why we deep-import instead of using the package barrel.
declare module '@tabler/icons-react-native/*' {
  import type { ComponentType } from 'react';
  const Icon: ComponentType<Record<string, unknown>>;
  export default Icon;
}
