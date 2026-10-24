import { existsSync } from 'node:fs';
import { join } from 'node:path';

export default ({ config }) => {
  // FCM untuk push (pesan tetap masuk saat app ditutup). File ini disediakan
  // CI dari secret GOOGLE_SERVICES_JSON; build lokal tanpa file tetap jalan
  // (push nonaktif, Realtime tetap hidup).
  const googleServicesFile = join(process.cwd(), 'google-services.json');

  return {
    ...config,
    android: {
      ...config.android,
      ...(existsSync(googleServicesFile) ? { googleServicesFile } : {}),
      config: {
        ...config.android?.config,
        googleMaps: {
          apiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || ""
        }
      }
    }
  };
};
