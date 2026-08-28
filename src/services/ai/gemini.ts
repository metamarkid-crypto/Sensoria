import { GoogleGenAI } from '@google/genai';
import { logger } from '../../utils/logger';
import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';

const apiKeys = [
  process.env.EXPO_PUBLIC_GEMINI_API_KEY,
  process.env.EXPO_PUBLIC_GEMINI_API_KEY_2,
  process.env.EXPO_PUBLIC_GEMINI_API_KEY_3,
].filter(Boolean) as string[];

let currentKeyIndex = 0;

/**
 * Creates a new GoogleGenAI instance using the current active API key.
 */
const getActiveClient = (): GoogleGenAI => {
  return new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] || '' });
};

/**
 * Wrapper for Gemini API calls. If an API key is exhausted (ResourceExhausted),
 * it automatically rotates to the next available API key and retries.
 */
const executeWithFallback = async <T>(
  operation: (ai: GoogleGenAI) => Promise<T>,
  retries = apiKeys.length
): Promise<T> => {
  if (apiKeys.length === 0) {
    throw new Error('Gemini API Key is missing. Cannot perform operation.');
  }

  let attempts = 0;
  let lastError: any = null;

  while (attempts < retries) {
    try {
      const ai = getActiveClient();
      return await operation(ai); // If successful, return the result
    } catch (error: any) {
      lastError = error;
      const status = error?.status || error?.response?.status;
      
      // Typical error statuses for limits: 429 (Rate Limit), 403 (Quota/Forbidden)
      if (status === 429 || status === 403 || error?.message?.includes('429') || error?.message?.includes('403')) {
        console.warn(`[Gemini API] Key ${currentKeyIndex + 1}/${apiKeys.length} failed or hit limit. Rotating key...`);
        // Rotate to the next key
        currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
        attempts++;
      } else {
        // If it's a structural error (e.g., bad request 400), don't retry, just throw
        console.error('[Gemini API] Non-retryable error encountered:', error);
        throw error;
      }
    }
  }

  throw new Error(`[Gemini API] All ${apiKeys.length} API keys have been exhausted or failed. Last Error: ${lastError?.message}`);
};

export const transcribeAudio = async (audioUri: string): Promise<string> => {
  const fileInfo = await FileSystem.getInfoAsync(audioUri);
  if (!fileInfo.exists) {
    throw new Error('Audio file does not exist');
  }

  // Read the audio file as base64 string
  const base64Data = await FileSystem.readAsStringAsync(audioUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return executeWithFallback(async (ai) => {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: 'audio/m4a', // Assuming m4a from expo-av high quality preset
              },
            },
            {
              text: 'Transcribe the following audio accurately.',
            },
          ],
        },
      ],
    });

    return response.text || 'No transcription available.';
  });
};

export const tagImageWithBilingualNames = async (imageUri: string): Promise<{ id: string, zh: string }> => {
  const base64Data = await FileSystem.readAsStringAsync(imageUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return executeWithFallback(async (ai) => {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: 'image/jpeg',
              },
            },
            {
              text: 'Identify the main object in this image with a single, simple word suitable for a child. Return ONLY a JSON object in this exact format, with no markdown formatting or backticks: {"id": "word in indonesian", "zh": "word in mandarin"}',
            },
          ],
        },
      ],
    });

    try {
      const result = JSON.parse(response.text || '{}');
      if (result.id && result.zh) {
        return result;
      }
      return { id: 'Benda', zh: '东西' };
    } catch (error) {
      console.error('Error parsing Gemini Vision response', error);
      logger.logError(error, { 
        action: 'ai_image_tagging',
      });
      return { id: 'Benda', zh: '东西' };
    }
  });
};
