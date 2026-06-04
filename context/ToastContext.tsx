/**
 * ToastContext - App-wide toast notifications
 */

import { Toast } from '@/components/ui/Toast';
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

interface ToastData {
  type: 'success' | 'error' | 'info';
  title: string;
  message?: string;
  txHash?: string;
  explorerUrl?: string;
  duration?: number;
}

interface ToastContextValue {
  showToast: (data: ToastData) => void;
  hideToast: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastData & { visible: boolean }>({
    visible: false,
    type: 'success',
    title: '',
  });

  const showToast = useCallback((data: ToastData) => {
    setToast({ ...data, visible: true });
  }, []);

  const hideToast = useCallback(() => {
    setToast(prev => ({ ...prev, visible: false }));
  }, []);

  // Memoized (callbacks are stable) so showing/hiding a toast doesn't
  // re-render every useToast() consumer across the app.
  const value = useMemo(() => ({ showToast, hideToast }), [showToast, hideToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast.visible && (
        <View style={styles.toastContainer} pointerEvents="box-none">
          <Toast
            visible={true}
            type={toast.type}
            title={toast.title}
            message={toast.message}
            txHash={toast.txHash}
            explorerUrl={toast.explorerUrl}
            onClose={hideToast}
            duration={toast.duration}
          />
        </View>
      )}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  toastContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 99999,
    elevation: 99999,
  },
});

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
