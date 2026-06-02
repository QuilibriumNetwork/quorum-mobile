import React from 'react';
import { Animated, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  detailsExpanded: boolean;
}

/**
 * Error Boundary component that catches JavaScript errors in child components
 * and displays a fallback UI instead of crashing the entire app.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private animatedHeight = new Animated.Value(0);

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      detailsExpanded: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ errorInfo });

    // Log error for debugging
    // Call optional error handler
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      detailsExpanded: false,
    });
    this.animatedHeight.setValue(0);
  };

  toggleDetails = (): void => {
    const expanding = !this.state.detailsExpanded;
    this.setState({ detailsExpanded: expanding });
    Animated.timing(this.animatedHeight, {
      toValue: expanding ? 1 : 0,
      duration: 250,
      useNativeDriver: false,
    }).start();
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      // Render custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const maxHeight = this.animatedHeight.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 300],
      });

      const chevronRotation = this.animatedHeight.interpolate({
        inputRange: [0, 1],
        outputRange: ['0deg', '90deg'],
      });

      // Default fallback UI
      return (
        <View style={styles.container}>
          <View style={styles.content}>
            <Text style={styles.title}>Something went wrong</Text>
            <Text style={styles.message}>
              The app encountered an unexpected error. You can try again or restart the app.
            </Text>

            {this.state.error && (
              <View style={styles.detailsWrapper}>
                <TouchableOpacity
                  style={styles.detailsToggle}
                  onPress={this.toggleDetails}
                  activeOpacity={0.7}
                >
                  <Animated.Text
                    style={[
                      styles.chevron,
                      { transform: [{ rotate: chevronRotation }] },
                    ]}
                  >
                    {'\u25B6'}
                  </Animated.Text>
                  <Text style={styles.detailsToggleText}>More info</Text>
                </TouchableOpacity>
                <Animated.View style={[styles.detailsContainer, { maxHeight }]}>
                  <ScrollView
                    style={styles.errorScroll}
                    nestedScrollEnabled
                  >
                    <Text style={styles.errorTitle}>Error:</Text>
                    <Text style={styles.errorText}>
                      {this.state.error.toString()}
                    </Text>
                    {this.state.errorInfo?.componentStack && (
                      <>
                        <Text style={styles.errorTitle}>Component Stack:</Text>
                        <Text style={styles.errorText}>
                          {this.state.errorInfo.componentStack}
                        </Text>
                      </>
                    )}
                  </ScrollView>
                </Animated.View>
              </View>
            )}

            <TouchableOpacity style={styles.button} onPress={this.handleRetry}>
              <Text style={styles.buttonText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = createSkinnable(() => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0b',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Skin.space(20),
  },
  content: {
    maxWidth: 400,
    alignItems: 'center',
  },
  title: {
    fontSize: Skin.font(24),
    fontWeight: '600',
    color: '#ffffff',
    marginBottom: Skin.space(12),
    textAlign: 'center',
  },
  message: {
    fontSize: Skin.font(16),
    color: '#888888',
    textAlign: 'center',
    marginBottom: Skin.space(24),
    lineHeight: Skin.font(22),
  },
  detailsWrapper: {
    width: '100%',
    marginBottom: Skin.space(24),
  },
  detailsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Skin.space(8),
    alignSelf: 'center',
  },
  chevron: {
    color: '#666666',
    fontSize: Skin.font(10),
    marginRight: Skin.space(6),
  },
  detailsToggleText: {
    color: '#666666',
    fontSize: Skin.font(14),
  },
  detailsContainer: {
    overflow: 'hidden',
  },
  errorScroll: {
    backgroundColor: '#1a1a1b',
    borderRadius: Skin.radius(8),
    padding: Skin.space(12),
    maxHeight: 280,
  },
  errorTitle: {
    fontSize: Skin.font(12),
    fontWeight: '600',
    color: '#ff6b6b',
    marginBottom: Skin.space(4),
    marginTop: Skin.space(8),
  },
  errorText: {
    fontSize: Skin.font(11),
    color: '#cccccc',
    fontFamily: 'monospace',
  },
  button: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: Skin.space(24),
    paddingVertical: Skin.space(12),
    borderRadius: Skin.radius(8),
  },
  buttonText: {
    color: '#ffffff',
    fontSize: Skin.font(16),
    fontWeight: '600',
  },
}));

/**
 * Hook-friendly wrapper for using error boundary with functional components.
 * Use this to wrap specific sections of your app that might fail.
 */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  fallback?: React.ReactNode
): React.FC<P> {
  return function WrappedComponent(props: P) {
    return (
      <ErrorBoundary fallback={fallback}>
        <Component {...props} />
      </ErrorBoundary>
    );
  };
}
