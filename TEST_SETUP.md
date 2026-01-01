# Test Setup Notes

## Known Issue: jest-expo UIManager Error

There's a known issue with `jest-expo` version 52.0.0 where it tries to define properties on `mockNativeModules.UIManager` which doesn't exist, causing:

```
TypeError: Object.defineProperty called on non-object
```

### Solution Options

#### Option 1: Use patch-package (Recommended)

1. Install patch-package:
```bash
yarn add -D patch-package postinstall-postinstall
```

2. Apply the patch manually by editing `node_modules/jest-expo/src/preset/setup.js`:
   - Find line 120 (around `Object.keys(mockNativeModules.NativeUnimoduleProxy.viewManagersMetadata).forEach`)
   - Add this code BEFORE that line:
   ```javascript
   // Ensure UIManager exists before trying to define properties on it
   if (!mockNativeModules.UIManager || typeof mockNativeModules.UIManager !== 'object') {
     mockNativeModules.UIManager = {};
   }
   ```

3. Create the patch:
```bash
npx patch-package jest-expo
```

4. Add to package.json scripts:
```json
"postinstall": "patch-package"
```

#### Option 2: Update jest-expo

Try updating to the latest version of jest-expo:
```bash
yarn add -D jest-expo@latest
```

#### Option 3: Manual Fix

Manually edit `node_modules/jest-expo/src/preset/setup.js` and add the UIManager check before line 120. This fix will be lost on `yarn install`, so Option 1 is recommended.
