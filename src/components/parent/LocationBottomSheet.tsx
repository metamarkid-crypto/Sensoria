import React, { useLayoutEffect, useRef, useState } from 'react';
import { Animated, PanResponder, View, StyleSheet, LayoutChangeEvent } from 'react-native';

/**
 * LocationBottomSheet — custom PanResponder sheet (Roadmap #3 UI overhaul).
 *
 * Deliberately NOT @gorhom/bottom-sheet: that stack pulls in react-native-
 * reanimated + gesture-handler, which is a heavy native addition on top of the
 * exact Android map-surface instability this project has been fighting. This
 * sheet is ~140 lines of core-RN Animated + PanResponder and ships the same UX:
 *   • collapsed snap AUTO-FITS the sticky grab content (handle + child info
 *     card + zone header) measured via onLayout — never clipped on any device
 *     or font scale,
 *   • expanded snap = `expandedFraction` of the map area,
 *   • spring settle on release (velocity-aware),
 *   • native-driver transform only (no re-render churn),
 *   • dragging via the grab area (handle + header), so the inner ScrollView
 *     keeps its own gestures with zero conflict.
 *
 * The sheet is sized `expandedFraction * viewportHeight` and slides via
 * translateY — the height never animates, so the map surface behind never
 * invalidates.
 *
 * STALE-CLOSURE NOTE: PanResponder.create runs ONCE at mount, when
 * viewportHeight is still 0. Any geometry the handlers need at gesture time
 * is therefore funneled through refs (collapsedOffsetRef / settleRef /
 * isExpandedRef) refreshed after every render. The previous version captured
 * collapsedOffset = 0 from the first render, which clamped every drag to 0
 * and froze the sheet fully expanded.
 */
interface Props {
  /** Fraction of viewportHeight the sheet occupies when fully expanded. */
  expandedFraction?: number;
  /** Measured height of the map area the sheet floats over (px). */
  viewportHeight: number;
  /** Distance from the screen bottom the sheet floats above (tab bar…). */
  bottomOffset?: number;
  /** Sticky content rendered inside the draggable grab area (child info card + title row…). */
  header?: React.ReactNode;
  /** Scrollable body below the grab area (the Safe Zone list…). */
  children: React.ReactNode;
}

/**
 * Pre-measurement estimate of the grab area (handle + card + zone header).
 * Deliberately biased HIGH: this value only drives the 1–2 frames before
 * onLayout reports the real height. Undershooting clips the child card
 * during that window (font-scale 1.3 ≈ 268px, 1.5 ≈ 305px); overshooting
 * merely leaves a few px of slack that the measurement instantly corrects.
 */
const GRAB_HEIGHT_ESTIMATE = 320;

export default function LocationBottomSheet({
  expandedFraction = 0.5,
  viewportHeight,
  bottomOffset = 0,
  header,
  children,
}: Props) {
  const sheetHeight = Math.max(0, viewportHeight * expandedFraction);

  // Measured height of the sticky grab content → collapsed snap offset.
  const [grabHeight, setGrabHeight] = useState(0);
  const collapsedOffset = Math.max(
    0,
    sheetHeight - (grabHeight > 0 ? grabHeight : GRAB_HEIGHT_ESTIMATE),
  );

  const translateY = useRef(new Animated.Value(0)).current;
  const offsetRef = useRef(0); // current settled offset (px)
  const startOffsetRef = useRef(0); // offset at gesture start
  const isExpandedRef = useRef(false);
  const draggingRef = useRef(false);
  const collapsedOffsetRef = useRef(collapsedOffset);

  const settle = (expanded: boolean) => {
    const target = expanded ? 0 : collapsedOffsetRef.current;
    offsetRef.current = target;
    isExpandedRef.current = expanded;
    Animated.spring(translateY, {
      toValue: target,
      useNativeDriver: true,
      bounciness: 0,
      speed: 18,
    }).start();
  };

  // Latest-ref bridge, refreshed after every render: geometry changes
  // (measurement arriving, font scale, language reflow) re-snap instantly —
  // but never fight an in-flight drag.
  const settleRef = useRef(settle);
  useLayoutEffect(() => {
    collapsedOffsetRef.current = collapsedOffset;
    settleRef.current = settle;
    if (!draggingRef.current) {
      const target = isExpandedRef.current ? 0 : collapsedOffset;
      if (target !== offsetRef.current) {
        offsetRef.current = target;
        translateY.setValue(target);
      }
    }
  });

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => {
        draggingRef.current = true;
        startOffsetRef.current = offsetRef.current;
      },
      onPanResponderMove: (_, g) => {
        const next = startOffsetRef.current - g.dy;
        translateY.setValue(Math.max(0, Math.min(collapsedOffsetRef.current, next)));
      },
      onPanResponderRelease: (_, g) => {
        draggingRef.current = false;
        const current = startOffsetRef.current - g.dy;
        const shouldExpand =
          g.vy < -0.6 ||
          (Math.abs(g.vy) <= 0.6 && current < collapsedOffsetRef.current / 2);
        settleRef.current(shouldExpand);
      },
      onPanResponderTerminate: () => {
        draggingRef.current = false;
        settleRef.current(isExpandedRef.current);
      },
    }),
  ).current;

  const onGrabLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0 && h !== grabHeight) setGrabHeight(h);
  };

  // Before the map area is measured the sheet stays invisible to avoid a
  // 1-frame jump at the wrong height.
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
      <View style={styles.grabArea} onLayout={onGrabLayout} {...panResponder.panHandlers}>
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
    alignItems: 'stretch',
    paddingTop: 8,
  },
  handleBar: {
    alignSelf: 'center',
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
