import React, { useCallback, useRef, useState } from 'react';
import { ConfirmDialog, ConfirmDialogProps } from '@/components/shared';

/**
 * Options for an imperative confirm() call. Mirrors ConfirmDialog's props minus
 * the wiring the hook owns (visible / onConfirm / onCancel).
 */
export type ConfirmOptions = Pick<
  ConfirmDialogProps,
  'title' | 'message' | 'confirmLabel' | 'cancelLabel' | 'variant' | 'testID'
>;

/**
 * useConfirmDialog — promise-based confirmation for destructive actions.
 *
 * Turns a center-anchored {@link ConfirmDialog} into a near-1:1 replacement for
 * `Alert.alert`, so migrating call sites stays mechanical:
 *
 *   const { confirm, confirmDialog } = useConfirmDialog();
 *   ...
 *   const ok = await confirm({ title, message, confirmLabel, variant: 'danger' });
 *   if (!ok) return;
 *   // do the destructive thing
 *   ...
 *   return (<>{...your tree...}{confirmDialog}</>);
 *
 * `confirmDialog` is a rendered ELEMENT (not a component), so toggling it
 * re-renders the same `ConfirmDialog`/`CenterModal` instance — the close
 * animation plays instead of the Modal being torn down and rebuilt each time.
 *
 * The back-button / backdrop = cancel safety lives once in CenterModal (which
 * ConfirmDialog wraps): both resolve the promise to `false`, never `true`.
 */
export function useConfirmDialog() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [visible, setVisible] = useState(false);
  // Holds the pending promise's resolver between open and the user's choice.
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    setOptions(opts);
    setVisible(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  // settle() resolves the pending promise exactly once and hides the dialog.
  const settle = useCallback((confirmed: boolean) => {
    setVisible(false);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(confirmed);
  }, []);

  const handleConfirm = useCallback(() => settle(true), [settle]);
  const handleCancel = useCallback(() => settle(false), [settle]);

  // A rendered element of a stable type (ConfirmDialog). Rendered as
  // `{confirmDialog}` it reconciles in place — no unmount/remount churn — so the
  // fade-out animation plays on close. Null until the first confirm() supplies
  // copy.
  const confirmDialog = options ? (
    <ConfirmDialog
      visible={visible}
      title={options.title}
      message={options.message}
      confirmLabel={options.confirmLabel}
      cancelLabel={options.cancelLabel}
      variant={options.variant}
      testID={options.testID}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  ) : null;

  return { confirm, confirmDialog };
}

export default useConfirmDialog;
