import * as FileSystem from 'expo-file-system/legacy';
import * as Speech from 'expo-speech';
import { createAudioPlayer } from 'expo-audio';
import { localAudioMap } from '../../assets/audioMap';
import { useAACStore } from '../../store/useAACStore';
import { recordAudioAccess, getLRUAudioFiles, removeAudioMetadata } from '../db/sqlite';
import { logger } from '../../utils/logger';

const CACHE_DIR = FileSystem.cacheDirectory + 'lmnt_audio/';
const MAX_CACHE_SIZE_MB = parseInt(process.env.EXPO_PUBLIC_MAX_AUDIO_CACHE_MB || '50', 10);

// Ensure cache directory exists and respect max size limit
const ensureCacheLimit = async () => {
  const dirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
    return;
  }

  try {
    const files = await FileSystem.readDirectoryAsync(CACHE_DIR);
    let totalSize = 0;
    const fileStats = [];

    // Get stats for all files
    for (const file of files) {
      const uri = CACHE_DIR + file;
      const stat = await FileSystem.getInfoAsync(uri);
      if (stat.exists && !stat.isDirectory) {
        totalSize += stat.size || 0;
        fileStats.push({ uri, size: stat.size || 0, modificationTime: stat.modificationTime || 0 });
      }
    }

    const maxBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;
    
    // If over limit, use SQLite LRU to find oldest accessed files
    if (totalSize > maxBytes) {
      console.log(`Cache size (${(totalSize/1024/1024).toFixed(2)}MB) exceeds limit (${MAX_CACHE_SIZE_MB}MB). Cleaning up LRU...`);
      
      const targetSize = maxBytes * 0.8; // Target 80% capacity
      let currentSize = totalSize;
      let deleteCount = 0;
      
      // Get batch of 50 oldest files from DB
      const lruFiles = await getLRUAudioFiles(50);

      for (const file of lruFiles) {
        if (currentSize <= targetSize) break;
        
        try {
          await FileSystem.deleteAsync(file.file_uri, { idempotent: true });
        } catch (e) {
          // File might already be gone
        }
        
        await removeAudioMetadata(file.file_uri);
        currentSize -= file.file_size;
        deleteCount++;
      }
      console.log(`Auto-Cleaned ${deleteCount} old audio files via LRU. New size: ${(currentSize/1024/1024).toFixed(2)}MB`);
    }
  } catch (err) {
    console.error('Error during auto-clean cache:', err);
  }
};

export const clearAudioCache = async (text: string, language: 'id' | 'zh', role: 'Child' | 'Parent') => {
  const store = useAACStore.getState();
  const { childVoiceGender, parentVoiceGender } = store;
  let voiceId = '';
  if (role === 'Child') {
    voiceId = childVoiceGender === 'Boy' 
      ? process.env.EXPO_PUBLIC_VOICE_BOY || 'daniel' 
      : process.env.EXPO_PUBLIC_VOICE_GIRL || 'lily';
  } else {
    voiceId = parentVoiceGender === 'Dad'
      ? process.env.EXPO_PUBLIC_VOICE_DAD || 'james'
      : process.env.EXPO_PUBLIC_VOICE_MOM || 'sarah';
  }
  
  const safeText = text.replace(/[^a-zA-Z0-9]/g, '_');
  const fileName = `lmnt_${language}_${voiceId}_${store.speechRate}_${safeText}.mp3`;
  const fileUri = CACHE_DIR + fileName;
  
  const fileInfo = await FileSystem.getInfoAsync(fileUri);
  if (fileInfo.exists) {
    await FileSystem.deleteAsync(fileUri);
    console.log(`Deleted cached audio for: ${text}`);
  }
};

export const playTTS = async (text: string, language: 'id' | 'zh', role: 'Child' | 'Parent') => {
  const store = useAACStore.getState();
  const { speechRate, childVoiceGender, parentVoiceGender } = store;

  // 1. Cek Local Audio Map
  if (localAudioMap[text]) {
    try {
      const player = createAudioPlayer(localAudioMap[text]);
      player.play();
      return;
    } catch (e) {
      console.log('Gagal memutar audio lokal', e);
    }
  }

  // 2. Tentukan Voice ID dari .env untuk LMNT
  const apiKey = process.env.EXPO_PUBLIC_LMNT_API_KEY;
  
  let voiceId = '';
  if (role === 'Child') {
    voiceId = childVoiceGender === 'Boy' 
      ? process.env.EXPO_PUBLIC_VOICE_BOY || 'daniel' // Default fallback
      : process.env.EXPO_PUBLIC_VOICE_GIRL || 'lily';
  } else {
    voiceId = parentVoiceGender === 'Dad'
      ? process.env.EXPO_PUBLIC_VOICE_DAD || 'james'
      : process.env.EXPO_PUBLIC_VOICE_MOM || 'sarah';
  }

  // Jika API key LMNT tersedia, coba fetch
  if (apiKey) {
    try {
      await ensureCacheLimit();
      const safeText = text.replace(/[^a-zA-Z0-9]/g, '_');
      // Include speechRate in cache filename so different speeds trigger new downloads
      const fileName = `lmnt_${language}_${voiceId}_${speechRate}_${safeText}.mp3`;
      const fileUri = CACHE_DIR + fileName;

        // Modify text to sound more relaxed/suprasegmental (adding conversational pauses)
        const relaxedText = text.replace(/ /g, ', ');

        // 3. Cek Caching Lokal
        const fileInfo = await FileSystem.getInfoAsync(fileUri);
        
        if (!fileInfo.exists) {
          // Fetch dari LMNT REST API (Streaming buffer)
          console.log('Fetching from LMNT API...');
          
          // Construct query params
          // Adding 'language' parameter to force correct accent (e.g. 'id' or 'zh')
          const lmntLang = language === 'id' ? 'id' : 'zh';
          
          const downloadRes = await FileSystem.downloadAsync(
            `https://api.lmnt.com/v1/ai/speech?voice=${voiceId}&format=mp3&text=${encodeURIComponent(relaxedText)}&speed=${speechRate}&language=${lmntLang}`,
            fileUri,
            {
              headers: {
                'X-API-Key': apiKey
              }
            }
          );
          
          if (downloadRes.status !== 200) {
             throw new Error('Download failed');
          }
          
          // Record access and size in SQLite LRU cache metadata
          const newFileInfo = await FileSystem.getInfoAsync(fileUri);
          if (newFileInfo.exists && !newFileInfo.isDirectory) {
            await recordAudioAccess(fileUri, newFileInfo.size || 0);
          }
        } else if (!fileInfo.isDirectory) {
          // Existing file, just update access time
          await recordAudioAccess(fileUri, fileInfo.size || 0);
        }

      // Play cached/downloaded file
      const player = createAudioPlayer(fileUri);
      player.play();
      return;

    } catch (error) {
      console.log('LMNT Error, fallback ke Offline TTS:', error);
      logger.logError(error, { 
        action: 'ai_voice_generation', 
        role, 
        text, 
        language,
        voiceId 
      });
    }
  }

  // 4. FALLBACK: Auditory Verbal Therapy (Offline Speech)
  // Manipulasi Pitch & Rate
  let pitch = 1.0;
  if (role === 'Child') {
    pitch = childVoiceGender === 'Boy' ? 1.4 : 1.7;
  } else {
    pitch = parentVoiceGender === 'Dad' ? 0.7 : 1.2;
  }

  Speech.speak(text, { 
    language: language === 'id' ? 'id-ID' : 'zh-CN',
    rate: speechRate,
    pitch: pitch
  });
};
