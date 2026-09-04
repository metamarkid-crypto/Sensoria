import React, { useState } from 'react';
import { View, Image, StyleSheet } from 'react-native';

/**
 * AvatarPin — Android-safe custom MapView marker (the "blank blue circle" fix).
 *
 * The blank marker bug on Android comes from three classic mistakes, all
 * avoided here:
 *   1. Percentage / implicit sizes inside a marker View → every element uses
 *      EXPLICIT pixel dimensions (Image.getSize isn't needed because the
 *      avatar is a bundled require with a known layout).
 *   2. elevation/shadow on marker children → shadows inside markers render as
 *      a blue blob on some Android devices, so NO elevation/shadow here; the
 *      white ring provides the separation.
 *   3. tracksViewChanges left true → the marker re-renders every frame and
 *      flickers/blank-frames. The parent flips `tracksViewChanges` off via
 *      `onReady` the instant the image has actually painted.
 *
 * Anchor the Marker at { x: 0.5, y: 1 } so the pin tip sits on the coordinate.
 */
interface Props {
  source: any;
  /** Avatar diameter in px (the pin body is derived from it). */
  size?: number;
  /** Fired when the avatar image has painted — flip tracksViewChanges off. */
  onReady?: () => void;
}

export default function AvatarPin({ source, size = 44, onReady }: Props) {
  const [loaded, setLoaded] = useState(false);

  const ringWidth = 3;
  const tailSize = 16;
  const tailOverlap = Math.round(tailSize * 0.55); // how deep the circle buries the tail
  const pinHeight = size + (tailSize - tailOverlap) + 2;

  return (
    <View style={{ width: size + ringWidth * 2, height: pinHeight, alignItems: 'center' }}>
      {/* Tail first so the circle (rendered after) overlaps its top half. */}
      <View
        style={{
          position: 'absolute',
          bottom: 2,
          width: tailSize,
          height: tailSize,
          borderRadius: 4,
          backgroundColor: '#FFFFFF',
          borderWidth: ringWidth,
          borderColor: '#FFFFFF',
          transform: [{ rotate: '45deg' }],
        }}
      />
      {/* Circle body: explicit px, overflow hidden, NO elevation/shadow. */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: ringWidth,
          borderColor: '#FFFFFF',
          backgroundColor: '#F1F5F9',
          overflow: 'hidden',
        }}
      >
        <Image
          source={source}
          style={{ width: size, height: size, resizeMode: 'cover' }}
          onLoadEnd={() => {
            setLoaded(true);
            if (!loaded && onReady) onReady();
          }}
        />
      </View>
    </View>
  );
}