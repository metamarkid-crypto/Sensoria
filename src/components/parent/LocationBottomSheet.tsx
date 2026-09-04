import React, { useRef, useState } from 'react';
import { Animated, PanResponder, View, StyleSheet } from 'react-native';

/**
 * LocationBottomSheet — custom PanResponder sheet (Roadmap #3 UI overhaul).
 *
 * Deliberately NOT @gorhom/bottom-sheet: that stack pulls in react-native-
 * reanimated + gesture-handler, which is a heavy native addition on top of the
 * exact Android map-surface instability this project has been fighting. This
 * sheet is ~120 lines of core-RN Animated + PanResponder and ships the same UX:
 *   • two snap points (default 25% / 50% of the map area),
 *   • spring settle on release (velocity-aware),
 *   • native-driver transform only (no re-render churn),
 *   • dragging via the grab area (handle + header), so the inner ScrollView
 *     keeps its own gestures with zero conflict.
 *
 * The sheet is sized `maxFrac * viewportHeight` and slides via translateY —
 * the height never animates, so the map surface behind never invalidates.
 */
interface Props {
  /** Fractions of viewportHeight to snap to, smallest first. */
  snapFractions: [number, number];
  /** Measured height of the map area the sheet floats over (px). */
  viewportHeight: number;
  /** Distance from the screen bottom the sheet floats above (tab bar…). */
  bottomOffset?: number;
  /** Sticky content rendered inside the draggable grab area (title row…). */
  header?: React.ReactNode;
  /** Scrollable body below the grab area (the Safe Zone list…). */
  children: React.ReactNode;
}

export default function LocationBottomSheet({
  snapFractions = [0.25, 0.5],
  viewportHeight,
  bottomOffset = 0,
  header,
  children,
}: Props) {
  const [minFrac, maxFrac] = snapFractions;
  const sheetHeight = Math.max(0, viewportHeight * maxFrac);
  const collapsedOffset = Math.max(0, (maxFrac - minFrac) * viewportHeight);

  const translateY = useRef(new Animated.Value(collapsedOffset)).current;
  const offsetRef = useRef(collapsedOffset); // current settled offset (px)
  const startOffsetRef = useRef(collapsedOffset); // offset at gesture start
  const [isExpanded, setIsExpanded] = useState(false);

  const settle = (expanded: boolean) => {
    const target = expanded ? 0 : collapsedOffset;
    offsetRef.current = target;
    setIsExpanded(expanded);
    Animated.spring(translateY, {
      toValue: target,
      useNativeDriver: true,
      bounciness: 0,
      speed: 18,
    }).start();
  };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => {
        startOffsetRef.current = offsetRef.current;
      },
      onPanResponderMove: (_, g) => {
        const next = startOffsetRef.current - g.dy;
        translateY.setValue(Math.max(0, Math.min(collapsedOffset, next)));
      },
      onPanResponderRelease: (_, g) => {
        const current = startOffsetRef.current - g.dy;
        const shouldExpand =
          g.vy < -0.6 ||
          (Math.abs(g.vy) <= 0.6 && current < collapsedOffset / 2);
        settle(shouldExpand);
      },
      onPanResponderTerminate: () => settle(isExpanded),
    }),
  ).current;

  // Before the area is measured the sheet stays invisible to avoid a 1-frame
  // jump at the wrong height.
  if (viewportHeight <= 0) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.sheet,
        {
          height: sheetHeight,
          bottom: bottomOffset,
          transform: [{ translateY }],
        },
      ]}
    >
      <View style={styles.grabArea} {...panResponder.panHandlers}>
        <View style={styles.handleBar} />
        {header}
      </View>
      <View style={styles.body}>{children}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#F8FAFC',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
    // Deliberately NO elevation/shadow: the sheet floats over the Android map
    // surface, and boundary shadows are the artifact class that blanked the
    // map before (Layout A discipline). Rounded corners + contrast carry it.
  },
  grabArea: {
    alignItems: 'center',
    paddingTop: 8,
  },
  handleBar: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#CBD5E1',
    marginBottom: 6,
  },
  body: {
    flex: 1,
  },
});