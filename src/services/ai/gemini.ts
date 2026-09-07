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

/** Categories a custom card can belong to (mirrors the Child tab bar ids). */
export type ImageTagCategory = 'pronoun' | 'verb' | 'noun' | 'emotion' | 'social';

export type ImageTagResult = { id: string; en: string; zh: string; category: ImageTagCategory };

const VALID_TAG_CATEGORIES: readonly string[] = ['pronoun', 'verb', 'noun', 'emotion', 'social'];

/**
 * Returned when the model answer cannot be trusted (parse failure / missing
 * fields). Callers MUST treat this exact pair as "no confidence" and fall
 * back to the manual form instead of saving it as a real card name.
 */
const NO_CONFIDENCE_TAG: ImageTagResult = { id: 'Benda', en: 'Thing', zh: '东西', category: 'noun' };

const isNoConfidenceTag = (t: ImageTagResult): boolean =>
  t.id === 'Benda' && t.en === 'Thing' && t.zh === '东西';

export const tagImageWithBilingualNames = async (imageUri: string): Promise<ImageTagResult> => {
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
              text: 'Identify the main object in this image with a single, simple word suitable for a child. Give the word in Indonesian, English, and Mandarin, and classify it into exactly one AAC category. Return ONLY a JSON object in this exact format, with no markdown formatting or backticks: {"id": "word in indonesian", "en": "word in english", "zh": "word in mandarin", "category": "pronoun|verb|noun|emotion|social"}',
            },
          ],
        },
      ],
    });

    try {
      const result = JSON.parse(response.text || '{}');
      if (result.id && result.zh) {
        return {
          id: result.id,
          en: result.en || result.id,
          zh: result.zh,
          category: VALID_TAG_CATEGORIES.includes(result.category)
            ? (result.category as ImageTagCategory)
            : 'noun',
        };
      }
      return NO_CONFIDENCE_TAG;
    } catch (error) {
      console.error('Error parsing Gemini Vision response', error);
      logger.logError(error, { 
        action: 'ai_image_tagging',
      });
      return NO_CONFIDENCE_TAG;
    }
  });
};

export { isNoConfidenceTag };

/**
 * Background one-shot translation used by the frictionless trilingual flow:
 * after a manual fallback save (all three labels = the user's typed word),
 * this fills the two missing languages. Fire-and-forget — NEVER awaited by
 * the UI path. `from` is the language the user actually typed.
 */
export const translateWordBilingual = async (
  word: string,
  from: 'id' | 'en' | 'zh'
): Promise<{ id: string; en: string; zh: string }> => {
  return executeWithFallback(async (ai) => {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Translate the word "${word}" (it is written in ${from === 'id' ? 'Indonesian' : from === 'en' ? 'English' : 'Mandarin'}) into the other two languages. Use a single, simple, child-friendly word for each. Return ONLY a JSON object in this exact format, with no markdown formatting or backticks: {"id": "indonesian", "en": "english", "zh": "mandarin"}`,
            },
          ],
        },
      ],
    });

    try {
      const result = JSON.parse(response.text || '{}');
      if (result.id && result.en && result.zh) {
        return { id: result.id, en: result.en, zh: result.zh };
      }
      throw new Error('Translation response missing fields');
    } catch (error) {
      logger.logError(error, { action: 'ai_background_translation' });
      throw error;
    }
  });
};
