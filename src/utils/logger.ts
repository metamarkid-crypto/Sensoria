import * as Sentry from '@sentry/react-native';

export const logger = {
  /**
   * Dipanggil setelah Zustand Hydration (RoleSelectionScreen atau Dashboard)
   * untuk melampirkan identitas pengguna ke crash report
   */
  setUserContext: (role: string, pairingCode: string) => {
    Sentry.setUser({
      id: pairingCode,
      segment: role
    });
  },

  /**
   * Untuk menangkap Non-Fatal Exceptions dengan Custom Tags
   */
  logError: (error: any, context: { action: string; role?: string; [key: string]: any }) => {
    Sentry.withScope((scope) => {
      scope.setTags(context);
      Sentry.captureException(error);
    });
    console.error(`[Sentry - ${context.action}]`, error);
  },

  /**
   * Untuk mencatat informasi penting (Breadcrumbs/Info)
   */
  logInfo: (message: string, context?: any) => {
    Sentry.captureMessage(message, { tags: context });
  }
};
