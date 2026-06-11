import { Image } from 'react-native';

/**
 * Bundled icons for tokens whose logos ship with the app, keyed by
 * lowercase contract address. Used ahead of any remote metadata so these
 * tokens always show the official artwork.
 */
const LOCAL_TOKEN_ICONS: Record<string, number> = {
  // wQUIL on Ethereum
  '0x8143182a775c54578c8b7b3ef77982498866945d': require('../../assets/images/qlogo.png'),
  // SNAP (Hypersnap) on Ethereum
  '0x49b5a631f54927c0007232844f06fe18cbf69786': require('../../assets/images/snap.png'),
};

/**
 * Resolve a bundled token icon to a URI usable with `Image source={{ uri }}`.
 * Returns undefined when the token has no bundled icon.
 */
export function getLocalTokenIconUri(contractAddress?: string | null): string | undefined {
  if (!contractAddress) return undefined;
  const asset = LOCAL_TOKEN_ICONS[contractAddress.toLowerCase()];
  if (!asset) return undefined;
  return Image.resolveAssetSource(asset)?.uri;
}
