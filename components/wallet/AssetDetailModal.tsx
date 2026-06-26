/**
 * AssetDetailModal - Display asset price chart and details
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { AggregatedAsset } from '@/hooks/useWallet';
import {
  fetchPriceHistory,
  fetchOHLCData,
  formatBalance,
  formatUsdValue,
  PriceHistoryResult,
  PricePoint,
  PriceTimeframe,
  CandleData,
  OHLCResult,
} from '@/services/wallet/balanceService';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { ActivityIndicator, Dimensions, RefreshControl, ScrollView, StyleSheet, Text, View, PanResponder, GestureResponderEvent } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import Svg, { Path, Defs, LinearGradient, Stop, Circle, Line, Rect } from 'react-native-svg';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import * as Skin from '@/theme/skins/geometry';

interface AssetDetailModalProps {
  visible: boolean;
  onClose: () => void;
  asset: AggregatedAsset | null;
  onSend?: (asset: AggregatedAsset) => void;
  onReceive?: () => void;
  onSwap?: (asset: AggregatedAsset) => void;
}

const TIMEFRAMES: { key: PriceTimeframe; label: string }[] = [
  { key: '1h', label: '1H' },
  { key: '4h', label: '4H' },
  { key: '1d', label: '1D' },
  { key: '1w', label: '1W' },
  { key: '1M', label: '1M' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'ALL' },
];

const CHART_WIDTH = Dimensions.get('window').width - 32;
const CHART_HEIGHT = 220;
const Y_AXIS_WIDTH = 56; // Space for Y-axis labels
const X_AXIS_HEIGHT = 24; // Space for X-axis labels
const CHART_PADDING_TOP = 12;
const CHART_PADDING_RIGHT = 4;

type ChartType = 'line' | 'candle';

// Format price for axis labels - adapts precision based on price range
function formatAxisPrice(price: number, priceRange?: number): string {
  // If we have a small range relative to price, show more precision
  if (priceRange !== undefined && priceRange > 0) {
    let decimals: number;
    if (priceRange < 0.001) decimals = 6;
    else if (priceRange < 0.01) decimals = 5;
    else if (priceRange < 0.1) decimals = 4;
    else if (priceRange < 1) decimals = 3;
    else if (priceRange < 10) decimals = 2;
    else if (priceRange < 100) decimals = 1;
    else decimals = 0;

    // For large prices with small ranges, show full price
    if (price >= 1000 && priceRange < 500) {
      return '$' + price.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    }
  }

  // Default compact formatting for large ranges
  if (price >= 1000) {
    return '$' + (price / 1000).toFixed(1) + 'k';
  } else if (price >= 1) {
    return '$' + price.toFixed(2);
  } else if (price >= 0.01) {
    return '$' + price.toFixed(4);
  } else {
    return '$' + price.toFixed(6);
  }
}

// Format OHLC price with enough precision to show small deviations
// Always shows full price (no "k" abbreviation) for accuracy
function formatOHLCPrice(price: number, priceRange: number): string {
  // Show enough decimals so the range has meaningful differences
  let decimals: number;
  if (priceRange < 0.0001) decimals = 8;
  else if (priceRange < 0.001) decimals = 6;
  else if (priceRange < 0.01) decimals = 5;
  else if (priceRange < 0.1) decimals = 4;
  else if (priceRange < 1) decimals = 3;
  else if (priceRange < 10) decimals = 2;
  else if (priceRange < 100) decimals = 1;
  else decimals = 0;

  return '$' + price.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Format timestamp for axis labels
function formatAxisTime(timestamp: number, timeframe: PriceTimeframe): string {
  const date = new Date(timestamp);
  switch (timeframe) {
    case '1h':
    case '4h':
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    case '1d':
      return date.toLocaleTimeString('en-US', { hour: 'numeric' });
    case '1w':
    case '1M':
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    case '1y':
    case 'all':
      return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    default:
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
}

function PriceChart({
  data,
  isPositive,
  theme,
  timeframe,
  onPriceSelect,
}: {
  data: PricePoint[];
  isPositive: boolean;
  theme: AppTheme;
  timeframe: PriceTimeframe;
  onPriceSelect?: (point: PricePoint | null) => void;
}) {
  const [touchX, setTouchX] = useState<number | null>(null);
  const chartRef = useRef<View>(null);

  if (data.length < 2) {
    return (
      <View style={[styles.chartPlaceholder, { height: CHART_HEIGHT }]}>
        <Text style={{ color: theme.colors.textMuted }}>No chart data available</Text>
      </View>
    );
  }

  const prices = data.map(p => p.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice || 1;

  // Add some padding to price range for visual breathing room
  const paddedMin = minPrice - priceRange * 0.05;
  const paddedMax = maxPrice + priceRange * 0.05;
  const paddedRange = paddedMax - paddedMin;

  // Calculate chart dimensions (excluding axis space)
  const chartWidth = CHART_WIDTH - Y_AXIS_WIDTH - CHART_PADDING_RIGHT;
  const chartHeight = CHART_HEIGHT - X_AXIS_HEIGHT - CHART_PADDING_TOP;

  // Helper to get point coordinates
  const getPointCoords = (index: number) => {
    const point = data[index];
    const x = Y_AXIS_WIDTH + (index / (data.length - 1)) * chartWidth;
    const y =
      CHART_PADDING_TOP +
      chartHeight -
      ((point.price - paddedMin) / paddedRange) * chartHeight;
    return { x, y, point };
  };

  // Generate path
  const pathData = data
    .map((point, index) => {
      const { x, y } = getPointCoords(index);
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');

  // Generate gradient fill path (closed polygon)
  const fillPathData =
    pathData +
    ` L ${CHART_WIDTH - CHART_PADDING_RIGHT} ${CHART_PADDING_TOP + chartHeight}` +
    ` L ${Y_AXIS_WIDTH} ${CHART_PADDING_TOP + chartHeight} Z`;

  const lineColor = isPositive ? '#22C55E' : '#EF4444';
  const gradientId = isPositive ? 'greenGradient' : 'redGradient';

  // Last point for the indicator dot
  const { x: lastX, y: lastY } = getPointCoords(data.length - 1);

  // Y-axis labels (4 labels: max, 2/3, 1/3, min)
  const yLabels = [
    { price: paddedMax, y: CHART_PADDING_TOP },
    { price: paddedMin + paddedRange * 0.67, y: CHART_PADDING_TOP + chartHeight * 0.33 },
    { price: paddedMin + paddedRange * 0.33, y: CHART_PADDING_TOP + chartHeight * 0.67 },
    { price: paddedMin, y: CHART_PADDING_TOP + chartHeight },
  ];

  // X-axis labels (start, middle, end)
  const xLabels = [
    { timestamp: data[0].timestamp, x: Y_AXIS_WIDTH },
    { timestamp: data[Math.floor(data.length / 2)].timestamp, x: Y_AXIS_WIDTH + chartWidth / 2 },
    { timestamp: data[data.length - 1].timestamp, x: CHART_WIDTH - CHART_PADDING_RIGHT },
  ];

  // Calculate selected point based on touch position
  const getSelectedPoint = (x: number) => {
    // Convert touch X to data index
    const chartX = x - Y_AXIS_WIDTH;
    if (chartX < 0 || chartX > chartWidth) return null;

    const index = Math.round((chartX / chartWidth) * (data.length - 1));
    const clampedIndex = Math.max(0, Math.min(data.length - 1, index));
    return { index: clampedIndex, ...getPointCoords(clampedIndex) };
  };

  const selectedPoint = touchX !== null ? getSelectedPoint(touchX) : null;

  // Touch handlers
  const handleTouchStart = (e: GestureResponderEvent) => {
    const x = e.nativeEvent.locationX;
    setTouchX(x);
    const point = getSelectedPoint(x);
    if (point && onPriceSelect) {
      onPriceSelect(point.point);
    }
  };

  const handleTouchMove = (e: GestureResponderEvent) => {
    const x = e.nativeEvent.locationX;
    setTouchX(x);
    const point = getSelectedPoint(x);
    if (point && onPriceSelect) {
      onPriceSelect(point.point);
    }
  };

  const handleTouchEnd = () => {
    setTouchX(null);
    if (onPriceSelect) {
      onPriceSelect(null);
    }
  };

  return (
    <View
      ref={chartRef}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onStartShouldSetResponderCapture={() => true}
      onMoveShouldSetResponderCapture={() => true}
      onResponderGrant={handleTouchStart}
      onResponderMove={handleTouchMove}
      onResponderRelease={handleTouchEnd}
      onResponderTerminate={handleTouchEnd}
    >
      <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={lineColor} stopOpacity={0.2} />
            <Stop offset="1" stopColor={lineColor} stopOpacity={0.0} />
          </LinearGradient>
        </Defs>
        {/* Gradient fill */}
        <Path d={fillPathData} fill={`url(#${gradientId})`} />
        {/* Line */}
        <Path d={pathData} stroke={lineColor} strokeWidth={2} fill="none" />
        {/* Current price dot (only show when not touching) */}
        {!selectedPoint && (
          <Circle cx={lastX} cy={lastY} r={4} fill={lineColor} />
        )}

        {/* Crosshairs when touching */}
        {selectedPoint && (
          <>
            {/* Vertical line */}
            <Line
              x1={selectedPoint.x}
              y1={CHART_PADDING_TOP}
              x2={selectedPoint.x}
              y2={CHART_PADDING_TOP + chartHeight}
              stroke={theme.colors.textMuted}
              strokeWidth={1}
              strokeDasharray="4,4"
            />
            {/* Horizontal line */}
            <Line
              x1={Y_AXIS_WIDTH}
              y1={selectedPoint.y}
              x2={CHART_WIDTH - CHART_PADDING_RIGHT}
              y2={selectedPoint.y}
              stroke={theme.colors.textMuted}
              strokeWidth={1}
              strokeDasharray="4,4"
            />
            {/* Selected point dot */}
            <Circle cx={selectedPoint.x} cy={selectedPoint.y} r={6} fill={lineColor} />
            <Circle cx={selectedPoint.x} cy={selectedPoint.y} r={3} fill="#FFFFFF" />
          </>
        )}
      </Svg>

      {/* Price label when touching */}
      {selectedPoint && (
        <View
          style={{
            position: 'absolute',
            left: Math.min(Math.max(selectedPoint.x - 40, 0), CHART_WIDTH - 80),
            top: Math.max(selectedPoint.y - 36, 0),
            backgroundColor: theme.colors.card,
            paddingHorizontal: Skin.space(8),
            paddingVertical: Skin.space(4),
            borderRadius: Skin.radius(6),
            borderWidth: Skin.border(1),
            borderColor: lineColor,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.2,
            shadowRadius: 4,
            elevation: 4,
          }}
        >
          <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(12), fontWeight: '600', textAlign: 'center' }}>
            {formatAxisPrice(selectedPoint.point.price)}
          </Text>
          <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(9), textAlign: 'center' }}>
            {formatAxisTime(selectedPoint.point.timestamp, timeframe)}
          </Text>
        </View>
      )}

      {/* Y-axis labels */}
      {yLabels.map((label, index) => (
        <Text
          key={`y-${index}`}
          numberOfLines={1}
          style={{
            position: 'absolute',
            left: 0,
            top: label.y - 8,
            width: Y_AXIS_WIDTH - 4,
            fontSize: Skin.font(10),
            color: theme.colors.textMuted,
            textAlign: 'right',
          }}
        >
          {formatAxisPrice(label.price, priceRange)}
        </Text>
      ))}

      {/* X-axis labels */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingLeft: Y_AXIS_WIDTH - 20, paddingRight: CHART_PADDING_RIGHT }}>
        {xLabels.map((label, index) => (
          <Text
            key={`x-${index}`}
            style={{
              fontSize: Skin.font(10),
              color: theme.colors.textMuted,
              textAlign: index === 0 ? 'left' : index === 2 ? 'right' : 'center',
            }}
          >
            {formatAxisTime(label.timestamp, timeframe)}
          </Text>
        ))}
      </View>
    </View>
  );
}

function CandleChart({
  data,
  theme,
  timeframe,
  onPriceSelect,
}: {
  data: CandleData[];
  theme: AppTheme;
  timeframe: PriceTimeframe;
  onPriceSelect?: (point: { timestamp: number; price: number } | null) => void;
}) {
  const [touchX, setTouchX] = useState<number | null>(null);
  const chartRef = useRef<View>(null);

  if (data.length < 2) {
    return (
      <View style={[styles.chartPlaceholder, { height: CHART_HEIGHT }]}>
        <Text style={{ color: theme.colors.textMuted }}>No candle data available</Text>
      </View>
    );
  }

  // Calculate price range from all candles
  const allPrices = data.flatMap(c => [c.high, c.low]);
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const priceRange = maxPrice - minPrice || 1;

  // Add padding to price range
  const paddedMin = minPrice - priceRange * 0.05;
  const paddedMax = maxPrice + priceRange * 0.05;
  const paddedRange = paddedMax - paddedMin;

  // Calculate chart dimensions
  const chartWidth = CHART_WIDTH - Y_AXIS_WIDTH - CHART_PADDING_RIGHT;
  const chartHeight = CHART_HEIGHT - X_AXIS_HEIGHT - CHART_PADDING_TOP;

  // Calculate candle width with gap
  const candleGap = 2;
  const totalCandleSpace = chartWidth / data.length;
  const candleWidth = Math.max(2, Math.min(12, totalCandleSpace - candleGap));

  // Helper to convert price to Y coordinate
  const priceToY = (price: number) => {
    return CHART_PADDING_TOP + chartHeight - ((price - paddedMin) / paddedRange) * chartHeight;
  };

  // Y-axis labels
  const yLabels = [
    { price: paddedMax, y: CHART_PADDING_TOP },
    { price: paddedMin + paddedRange * 0.67, y: CHART_PADDING_TOP + chartHeight * 0.33 },
    { price: paddedMin + paddedRange * 0.33, y: CHART_PADDING_TOP + chartHeight * 0.67 },
    { price: paddedMin, y: CHART_PADDING_TOP + chartHeight },
  ];

  // X-axis labels
  const xLabels = [
    { timestamp: data[0].timestamp, x: Y_AXIS_WIDTH },
    { timestamp: data[Math.floor(data.length / 2)].timestamp, x: Y_AXIS_WIDTH + chartWidth / 2 },
    { timestamp: data[data.length - 1].timestamp, x: CHART_WIDTH - CHART_PADDING_RIGHT },
  ];

  // Get selected candle based on touch position
  const getSelectedCandle = (x: number) => {
    const chartX = x - Y_AXIS_WIDTH;
    if (chartX < 0 || chartX > chartWidth) return null;

    const index = Math.floor((chartX / chartWidth) * data.length);
    const clampedIndex = Math.max(0, Math.min(data.length - 1, index));
    const candle = data[clampedIndex];
    const candleX = Y_AXIS_WIDTH + (clampedIndex + 0.5) * totalCandleSpace;
    return { index: clampedIndex, candle, x: candleX };
  };

  const selectedCandle = touchX !== null ? getSelectedCandle(touchX) : null;

  // Touch handlers
  const handleTouchStart = (e: GestureResponderEvent) => {
    const x = e.nativeEvent.locationX;
    setTouchX(x);
    const selected = getSelectedCandle(x);
    if (selected && onPriceSelect) {
      onPriceSelect({ timestamp: selected.candle.timestamp, price: selected.candle.close });
    }
  };

  const handleTouchMove = (e: GestureResponderEvent) => {
    const x = e.nativeEvent.locationX;
    setTouchX(x);
    const selected = getSelectedCandle(x);
    if (selected && onPriceSelect) {
      onPriceSelect({ timestamp: selected.candle.timestamp, price: selected.candle.close });
    }
  };

  const handleTouchEnd = () => {
    setTouchX(null);
    if (onPriceSelect) {
      onPriceSelect(null);
    }
  };

  return (
    <View
      ref={chartRef}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onStartShouldSetResponderCapture={() => true}
      onMoveShouldSetResponderCapture={() => true}
      onResponderGrant={handleTouchStart}
      onResponderMove={handleTouchMove}
      onResponderRelease={handleTouchEnd}
      onResponderTerminate={handleTouchEnd}
    >
      <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
        {data.map((candle, index) => {
          const isGreen = candle.close >= candle.open;
          const color = isGreen ? '#22C55E' : '#EF4444';
          const x = Y_AXIS_WIDTH + index * totalCandleSpace + (totalCandleSpace - candleWidth) / 2;
          const centerX = x + candleWidth / 2;

          // Wick (high to low line)
          const wickTop = priceToY(candle.high);
          const wickBottom = priceToY(candle.low);

          // Body (open to close rect)
          const bodyTop = priceToY(Math.max(candle.open, candle.close));
          const bodyBottom = priceToY(Math.min(candle.open, candle.close));
          const bodyHeight = Math.max(1, bodyBottom - bodyTop);

          return (
            <React.Fragment key={index}>
              {/* Wick */}
              <Line
                x1={centerX}
                y1={wickTop}
                x2={centerX}
                y2={wickBottom}
                stroke={color}
                strokeWidth={1}
              />
              {/* Body */}
              <Rect
                x={x}
                y={bodyTop}
                width={candleWidth}
                height={bodyHeight}
                fill={color}
              />
            </React.Fragment>
          );
        })}

        {/* Crosshairs when touching */}
        {selectedCandle && (
          <>
            {/* Vertical line */}
            <Line
              x1={selectedCandle.x}
              y1={CHART_PADDING_TOP}
              x2={selectedCandle.x}
              y2={CHART_PADDING_TOP + chartHeight}
              stroke={theme.colors.textMuted}
              strokeWidth={1}
              strokeDasharray="4,4"
            />
            {/* Horizontal line at close price */}
            <Line
              x1={Y_AXIS_WIDTH}
              y1={priceToY(selectedCandle.candle.close)}
              x2={CHART_WIDTH - CHART_PADDING_RIGHT}
              y2={priceToY(selectedCandle.candle.close)}
              stroke={theme.colors.textMuted}
              strokeWidth={1}
              strokeDasharray="4,4"
            />
          </>
        )}
      </Svg>

      {/* OHLC tooltip when touching */}
      {selectedCandle && (
        <View
          style={{
            position: 'absolute',
            left: Math.min(Math.max(selectedCandle.x - 50, 0), CHART_WIDTH - 100),
            top: Math.max(priceToY(selectedCandle.candle.high) - 70, 0),
            backgroundColor: theme.colors.card,
            paddingHorizontal: Skin.space(8),
            paddingVertical: Skin.space(6),
            borderRadius: Skin.radius(6),
            borderWidth: Skin.border(1),
            borderColor: selectedCandle.candle.close >= selectedCandle.candle.open ? '#22C55E' : '#EF4444',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.2,
            shadowRadius: 4,
            elevation: 4,
          }}
        >
          <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(9), marginBottom: Skin.space(2) }}>
            {formatAxisTime(selectedCandle.candle.timestamp, timeframe)}
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: Skin.space(8) }}>
            <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(9) }}>O</Text>
            <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(10), fontWeight: '500' }}>
              {formatOHLCPrice(selectedCandle.candle.open, priceRange)}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: Skin.space(8) }}>
            <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(9) }}>H</Text>
            <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(10), fontWeight: '500' }}>
              {formatOHLCPrice(selectedCandle.candle.high, priceRange)}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: Skin.space(8) }}>
            <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(9) }}>L</Text>
            <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(10), fontWeight: '500' }}>
              {formatOHLCPrice(selectedCandle.candle.low, priceRange)}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: Skin.space(8) }}>
            <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(9) }}>C</Text>
            <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(10), fontWeight: '500' }}>
              {formatOHLCPrice(selectedCandle.candle.close, priceRange)}
            </Text>
          </View>
        </View>
      )}

      {/* Y-axis labels */}
      {yLabels.map((label, index) => (
        <Text
          key={`y-${index}`}
          numberOfLines={1}
          style={{
            position: 'absolute',
            left: 0,
            top: label.y - 8,
            width: Y_AXIS_WIDTH - 4,
            fontSize: Skin.font(10),
            color: theme.colors.textMuted,
            textAlign: 'right',
          }}
        >
          {formatAxisPrice(label.price, priceRange)}
        </Text>
      ))}

      {/* X-axis labels */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingLeft: Y_AXIS_WIDTH - 20, paddingRight: CHART_PADDING_RIGHT }}>
        {xLabels.map((label, index) => (
          <Text
            key={`x-${index}`}
            style={{
              fontSize: Skin.font(10),
              color: theme.colors.textMuted,
              textAlign: index === 0 ? 'left' : index === 2 ? 'right' : 'center',
            }}
          >
            {formatAxisTime(label.timestamp, timeframe)}
          </Text>
        ))}
      </View>
    </View>
  );
}

export default function AssetDetailModal({
  visible,
  onClose,
  asset,
  onSend,
  onReceive,
  onSwap,
}: AssetDetailModalProps) {
  const { theme, isDark } = useTheme();
  const [selectedTimeframe, setSelectedTimeframe] = useState<PriceTimeframe>('1d');
  const [chartType, setChartType] = useState<ChartType>('line');
  const [priceData, setPriceData] = useState<PriceHistoryResult | null>(null);
  const [ohlcData, setOhlcData] = useState<OHLCResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touchedPrice, setTouchedPrice] = useState<PricePoint | null>(null);

  const styles = createStyles(theme, isDark);

  // Load data function - used by both initial load and refresh
  const loadData = useCallback(async (showLoading = true) => {
    if (!asset) return;

    if (showLoading) setIsLoading(true);
    setError(null);

    try {
      if (chartType === 'candle') {
        const data = await fetchOHLCData(
          asset.symbol,
          selectedTimeframe,
          asset.contractAddress,
          asset.chain
        );
        setOhlcData(data);
        setPriceData(null);
        if (!data) {
          setError('Candle data unavailable');
        }
      } else {
        const data = await fetchPriceHistory(
          asset.symbol,
          selectedTimeframe,
          asset.contractAddress,
          asset.chain
        );
        setPriceData(data);
        setOhlcData(null);
        if (!data) {
          setError('Price data unavailable');
        }
      }
    } catch (e) {
      setError('Failed to load chart data');
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [asset, chartType, selectedTimeframe]);

  // Handle pull-to-refresh
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    loadData(false);
  }, [loadData]);

  // Fetch price data when asset, timeframe, or chart type changes
  useEffect(() => {
    if (!visible || !asset) return;
    loadData();
  }, [visible, asset?.symbol, asset?.contractAddress, asset?.chain, selectedTimeframe, chartType]);

  // Reset state when modal closes
  useEffect(() => {
    if (!visible) {
      setPriceData(null);
      setOhlcData(null);
      setError(null);
      setSelectedTimeframe('1d');
      setChartType('line');
    }
  }, [visible]);

  if (!asset) return null;

  const chartData = chartType === 'candle' ? ohlcData : priceData;

  // Use current price from chart data if available (most accurate), otherwise fall back to asset data
  // Prefer the current chart type's data, but use the other if it's available to prevent flicker
  const currentPrice = (() => {
    if (ohlcData?.candles?.length) {
      return ohlcData.candles[ohlcData.candles.length - 1].close;
    }
    if (priceData?.prices?.length) {
      return priceData.prices[priceData.prices.length - 1].price;
    }
    return asset.usdValue ? asset.usdValue / parseFloat(asset.balance) : null;
  })();

  // Use whichever chart data is available for stats, preferring current type
  const statsData = chartData ?? ohlcData ?? priceData;
  const isPositive = statsData ? statsData.priceChangePercent >= 0 : (asset.priceChange24h ?? 0) >= 0;
  const changePercent = statsData?.priceChangePercent ?? asset.priceChange24h ?? 0;

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.85}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary}
            progressViewOffset={20}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.assetInfo}>
            {asset.iconUrl ? (
              <CachedAvatar
                source={{ uri: asset.iconUrl }}
                style={styles.assetIcon}
              />
            ) : (
              <View style={[styles.assetIconPlaceholder, { backgroundColor: theme.colors.surface0 }]}>
                <Text style={[styles.assetIconText, { color: theme.colors.textMain }]}>
                  {asset.symbol.slice(0, 2)}
                </Text>
              </View>
            )}
            <View style={styles.assetTitleContainer}>
              <Text style={styles.assetName}>{asset.name}</Text>
              <Text style={styles.assetSymbol}>{asset.symbol}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Current Price (or touched price when dragging) */}
        <View style={styles.priceSection}>
          {touchedPrice ? (
            // Show touched price while user is dragging on chart
            <>
              <Text style={styles.currentPrice}>
                ${touchedPrice.price.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: touchedPrice.price < 1 ? 6 : 2,
                })}
              </Text>
              <Text style={styles.timeframeLabel}>
                {formatAxisTime(touchedPrice.timestamp, selectedTimeframe)}
              </Text>
            </>
          ) : currentPrice !== null ? (
            <>
              <Text style={styles.currentPrice}>
                ${currentPrice.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: currentPrice < 1 ? 6 : 2,
                })}
              </Text>
              <View style={styles.priceChangeRow}>
                <Text
                  style={[
                    styles.priceChange,
                    isPositive ? styles.priceChangePositive : styles.priceChangeNegative,
                  ]}
                >
                  {isPositive ? '+' : ''}
                  {changePercent.toFixed(2)}%
                </Text>
                <Text style={styles.timeframeLabel}>
                  {selectedTimeframe === 'all' ? 'All Time' : selectedTimeframe.toUpperCase()}
                </Text>
              </View>
            </>
          ) : (
            <Text style={styles.noPriceText}>Price unavailable</Text>
          )}
        </View>

        {/* Chart Type Toggle */}
        <View style={styles.chartTypeToggle}>
          <TouchableOpacity
            style={[
              styles.chartTypeButton,
              chartType === 'line' && styles.chartTypeButtonActive,
            ]}
            onPress={() => setChartType('line')}
          >
            <IconSymbol
              name="chart.xyaxis.line"
              size={16}
              color={chartType === 'line' ? '#FFFFFF' : theme.colors.textMuted}
            />
            <Text
              style={[
                styles.chartTypeText,
                chartType === 'line' && styles.chartTypeTextActive,
              ]}
            >
              Line
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.chartTypeButton,
              chartType === 'candle' && styles.chartTypeButtonActive,
            ]}
            onPress={() => setChartType('candle')}
          >
            <IconSymbol
              name="chart.bar.fill"
              size={16}
              color={chartType === 'candle' ? '#FFFFFF' : theme.colors.textMuted}
            />
            <Text
              style={[
                styles.chartTypeText,
                chartType === 'candle' && styles.chartTypeTextActive,
              ]}
            >
              Candles
            </Text>
          </TouchableOpacity>
        </View>

        {/* Chart */}
        <View style={styles.chartContainer}>
          {isLoading ? (
            <View style={[styles.chartPlaceholder, { height: CHART_HEIGHT }]}>
              <ActivityIndicator color={theme.colors.primary} />
            </View>
          ) : error ? (
            <View style={[styles.chartPlaceholder, { height: CHART_HEIGHT }]}>
              <Text style={{ color: theme.colors.textMuted }}>{error}</Text>
            </View>
          ) : chartType === 'line' && priceData ? (
            <PriceChart
              data={priceData.prices}
              isPositive={isPositive}
              theme={theme}
              timeframe={selectedTimeframe}
              onPriceSelect={setTouchedPrice}
            />
          ) : chartType === 'candle' && ohlcData ? (
            <CandleChart
              data={ohlcData.candles}
              theme={theme}
              timeframe={selectedTimeframe}
              onPriceSelect={setTouchedPrice}
            />
          ) : (
            <View style={[styles.chartPlaceholder, { height: CHART_HEIGHT }]}>
              <Text style={{ color: theme.colors.textMuted }}>No chart data</Text>
            </View>
          )}
        </View>

        {/* Timeframe Selector */}
        <View style={styles.timeframeSelector}>
          {TIMEFRAMES.map(({ key, label }) => (
            <TouchableOpacity
              key={key}
              style={[
                styles.timeframeButton,
                selectedTimeframe === key && styles.timeframeButtonActive,
              ]}
              onPress={() => setSelectedTimeframe(key)}
            >
              <Text
                style={[
                  styles.timeframeButtonText,
                  selectedTimeframe === key && styles.timeframeButtonTextActive,
                ]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Action Buttons */}
        <View style={styles.actionButtonsRow}>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => {
              if (asset && onSend) {
                onClose();
                onSend(asset);
              }
            }}
          >
            <View style={[styles.actionButtonIcon, { backgroundColor: theme.colors.primary + '20' }]}>
              <IconSymbol name="arrow.up.right" size={20} color={theme.colors.primary} />
            </View>
            <Text style={styles.actionButtonText}>Send</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => {
              if (onReceive) {
                onClose();
                onReceive();
              }
            }}
          >
            <View style={[styles.actionButtonIcon, { backgroundColor: '#22C55E20' }]}>
              <IconSymbol name="arrow.down.left" size={20} color="#22C55E" />
            </View>
            <Text style={styles.actionButtonText}>Receive</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => {
              if (asset && onSwap) {
                onClose();
                onSwap(asset);
              }
            }}
          >
            <View style={[styles.actionButtonIcon, { backgroundColor: '#8B5CF620' }]}>
              <IconSymbol name="arrow.triangle.2.circlepath" size={20} color="#8B5CF6" />
            </View>
            <Text style={styles.actionButtonText}>Swap</Text>
          </TouchableOpacity>
        </View>

        {/* Balance Section */}
        <View style={styles.balanceSection}>
          <Text style={styles.sectionTitle}>Your Balance</Text>
          <View style={styles.balanceCard}>
            <View style={styles.balanceRow}>
              <Text style={styles.balanceLabel}>Amount</Text>
              <Text style={styles.balanceValue}>
                {formatBalance(asset.balance, asset.symbol === 'BTC' ? 8 : 4)} {asset.symbol}
              </Text>
            </View>
            {asset.usdValue !== undefined && asset.usdValue > 0 && (
              <View style={styles.balanceRow}>
                <Text style={styles.balanceLabel}>Value</Text>
                <Text style={styles.balanceValue}>
                  {formatUsdValue(asset.usdValue.toString())}
                </Text>
              </View>
            )}
            {asset.pendingBalance && parseFloat(asset.pendingBalance) !== 0 && (
              <View style={styles.balanceRow}>
                <Text style={styles.balanceLabel}>Pending</Text>
                <Text style={[styles.balanceValue, styles.pendingValue]}>
                  {parseFloat(asset.pendingBalance) > 0 ? '+' : ''}
                  {formatBalance(asset.pendingBalance, asset.symbol === 'BTC' ? 8 : 4)} {asset.symbol}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Price Stats */}
        {statsData && (
          <View style={styles.statsSection}>
            <Text style={styles.sectionTitle}>Price Stats ({selectedTimeframe.toUpperCase()})</Text>
            <View style={styles.statsCard}>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>High</Text>
                <Text style={styles.statValue}>
                  ${statsData.maxPrice.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: statsData.maxPrice < 1 ? 6 : 2,
                  })}
                </Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Low</Text>
                <Text style={styles.statValue}>
                  ${statsData.minPrice.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: statsData.minPrice < 1 ? 6 : 2,
                  })}
                </Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Change</Text>
                <Text
                  style={[
                    styles.statValue,
                    isPositive ? styles.priceChangePositive : styles.priceChangeNegative,
                  ]}
                >
                  {statsData.priceChange >= 0 ? '+' : ''}$
                  {Math.abs(statsData.priceChange).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Chain Info */}
        <View style={styles.chainSection}>
          <Text style={styles.sectionTitle}>Network</Text>
          <View style={styles.chainCard}>
            <Text style={styles.chainName}>{asset.chainName}</Text>
            {asset.contractAddress && (
              <Text style={styles.contractAddress} numberOfLines={1}>
                {asset.contractAddress.slice(0, 10)}...{asset.contractAddress.slice(-8)}
              </Text>
            )}
          </View>
        </View>
      </ScrollView>
    </BaseModal>
  );
}

const styles = StyleSheet.create({
  chartPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

const createStyles = (theme: AppTheme, isDark: boolean) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    contentContainer: {
      paddingHorizontal: Skin.space(16),
      paddingBottom: Skin.space(32),
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: Skin.space(16),
    },
    assetInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
    },
    assetIcon: {
      width: 48,
      height: 48,
      borderRadius: Skin.radius(24),
    },
    assetIconPlaceholder: {
      width: 48,
      height: 48,
      borderRadius: Skin.radius(24),
      alignItems: 'center',
      justifyContent: 'center',
    },
    assetIconText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
    },
    assetTitleContainer: {
      marginLeft: Skin.space(12),
    },
    assetName: {
      ...theme.textStyles.title3,
      color: theme.colors.textMain,
    },
    assetSymbol: {
      ...theme.textStyles.subheadline,
      color: theme.colors.textSubtle, // secondary text → subtle (muted is unreadable in light)
      marginTop: Skin.space(2),
    },
    closeButton: {
      padding: Skin.space(8),
    },
    priceSection: {
      paddingVertical: Skin.space(8),
    },
    currentPrice: {
      ...theme.textStyles.largeTitle,
      color: theme.colors.textMain,
    },
    priceChangeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: Skin.space(4),
    },
    priceChange: {
      ...theme.textStyles.callout,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    priceChangePositive: {
      color: theme.colors.success,
    },
    priceChangeNegative: {
      color: theme.colors.danger,
    },
    timeframeLabel: {
      ...theme.textStyles.subheadline,
      color: theme.colors.textSubtle,
      marginLeft: Skin.space(8),
    },
    noPriceText: {
      fontSize: Skin.font(24),
      color: theme.colors.textSubtle,
    },
    chartTypeToggle: {
      flexDirection: 'row',
      alignSelf: 'flex-start',
      backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
      borderRadius: Skin.radius(8),
      padding: Skin.space(3),
      marginBottom: Skin.space(8),
    },
    chartTypeButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(6),
      gap: Skin.space(4),
    },
    chartTypeButtonActive: {
      backgroundColor: theme.colors.primary,
    },
    chartTypeText: {
      fontSize: Skin.font(12),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    chartTypeTextActive: {
      color: '#FFFFFF',
    },
    chartContainer: {
      marginVertical: Skin.space(16),
    },
    chartPlaceholder: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionButtonsRow: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      marginBottom: Skin.space(24),
      paddingVertical: Skin.space(8),
    },
    actionButton: {
      alignItems: 'center',
      gap: Skin.space(6),
    },
    actionButtonIcon: {
      width: 48,
      height: 48,
      borderRadius: Skin.radius(24),
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionButtonText: {
      fontSize: Skin.font(12),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    timeframeSelector: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: Skin.space(24),
    },
    timeframeButton: {
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(8),
      borderRadius: Skin.radius(8),
      backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    },
    timeframeButtonActive: {
      backgroundColor: theme.colors.primary,
    },
    timeframeButtonText: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    timeframeButtonTextActive: {
      color: '#FFFFFF',
    },
    balanceSection: {
      marginBottom: Skin.space(20),
    },
    sectionTitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      marginBottom: Skin.space(8),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    balanceCard: {
      backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
    },
    balanceRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: Skin.space(8),
    },
    balanceLabel: {
      fontSize: Skin.font(15),
      color: theme.colors.textSubtle,
    },
    balanceValue: {
      fontSize: Skin.font(15),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    pendingValue: {
      color: theme.colors.warning,
    },
    statsSection: {
      marginBottom: Skin.space(20),
    },
    statsCard: {
      backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
    },
    statRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: Skin.space(8),
    },
    statLabel: {
      fontSize: Skin.font(15),
      color: theme.colors.textSubtle,
    },
    statValue: {
      fontSize: Skin.font(15),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    chainSection: {
      marginBottom: Skin.space(20),
    },
    chainCard: {
      backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
    },
    chainName: {
      fontSize: Skin.font(15),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    contractAddress: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
      marginTop: Skin.space(4),
    },
  });
