// Jest setup file for React Native/Expo
// This file runs before jest-expo's setup

// Fix for jest-expo bug: ensure UIManager exists before jest-expo tries to use it
// jest-expo's setup.js requires 'react-native/Libraries/BatchedBridge/NativeModules'
// and tries to define properties on mockNativeModules.UIManager, but UIManager doesn't exist

// Pre-require NativeModules and ensure UIManager exists
// This must happen synchronously before jest-expo's setup runs
const NativeModules = require('react-native/Libraries/BatchedBridge/NativeModules');

// Ensure UIManager exists as an object (jest-expo will try to define properties on it)
if (!NativeModules.UIManager || typeof NativeModules.UIManager !== 'object') {
  Object.defineProperty(NativeModules, 'UIManager', {
    value: {},
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

// Ensure NativeUnimoduleProxy.viewManagersMetadata exists (jest-expo iterates over this)
if (!NativeModules.NativeUnimoduleProxy) {
  Object.defineProperty(NativeModules, 'NativeUnimoduleProxy', {
    value: { viewManagersMetadata: {} },
    writable: true,
    configurable: true,
    enumerable: true,
  });
} else if (!NativeModules.NativeUnimoduleProxy.viewManagersMetadata) {
  NativeModules.NativeUnimoduleProxy.viewManagersMetadata = {};
}

// Ensure global objects exist for expo-modules-core
if (typeof globalThis !== 'undefined') {
  if (!globalThis.expo) {
    globalThis.expo = {};
  }
  if (!globalThis.expo.EventEmitter) {
    // Mock EventEmitter for expo-modules-core
    globalThis.expo.EventEmitter = class EventEmitter {
      constructor() {}
      addListener() { return this; }
      removeListener() { return this; }
      removeAllListeners() { return this; }
      emit() { return false; }
    };
  }
}
