/**
 * Read-only OpenStreetMap embed for EMERGENCY child tracking.
 *
 * Zero API key, zero SDK, zero telemetry of its own — a plain <iframe> to
 * openstreetmap.org's static export. The parent app (react-native-maps) owns
 * the rich map; the dashboard only needs "where is the child RIGHT NOW".
 *
 * Raw coordinates live here for the emergency window only — see the privacy
 * contract in lib/lookup.ts (getEmergencyLocation is the sole producer).
 */

export function osmEmbedUrl(lat: number, lng: number): string {
  // ~±0.004° ≈ a 400 m window around the fix.
  const d = 0.004;
  const bbox = [lng - d, lat - d, lng + d, lat + d]
    .map((n) => n.toFixed(6))
    .join("%2C");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(6)}%2C${lng.toFixed(6)}`;
}

export function osmExternalUrl(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lng.toFixed(6)}#map=17/${lat.toFixed(6)}/${lng.toFixed(6)}`;
}

export default function DeviceMap({
  lat,
  lng,
  height = 288,
}: {
  lat: number;
  lng: number;
  height?: number;
}) {
  return (
    <iframe
      title="Child location map (read-only OpenStreetMap)"
      src={osmEmbedUrl(lat, lng)}
      loading="lazy"
      className="w-full rounded-xl border border-ink-line"
      style={{ height }}
    />
  );
}
