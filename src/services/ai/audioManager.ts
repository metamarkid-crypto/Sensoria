import * as FileSystem from 'expo-file-system/legacy';
import * as Speech from 'expo-speech';
import { createAudioPlayer } from 'expo-audio';
import { localAudioMap } from '../../assets/audioMap';
import { useAACStore } from '../../store/useAACStore';
import { recordAudioAccess, getLRUAudioFiles, removeAudioMetadata } from '../db/sqlite';
import { logger } from '../../utils/logger';

const CACHE_DIR = FileSystem.cacheDirectory + 'fish_audio/';
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

export const clearAudioCache = async (text: string, language: 'id' | 'en' | 'zh', role: string) => {
  const store = useAACStore.getState();
  
  let voiceId = '';
  if (role === 'Child') {
    voiceId = store.childProfile?.gender === 'Boy' 
      ? process.env.EXPO_PUBLIC_VOICE_BOY || 'daniel' 
      : process.env.EXPO_PUBLIC_VOICE_GIRL || 'lily';
  } else {
    // Smart Role-to-Voice Mapping for Parents/Others
    const lowerRole = role.toLowerCase();
    const maleKeywords = ['ayah', 'papa', 'papi', 'abi', 'bapak', 'kakek', 'paman', 'om'];
    const femaleKeywords = ['ibu', 'mama', 'mami', 'bunda', 'nenek', 'tante', 'bibi'];
    
    if (maleKeywords.some(kw => lowerRole.includes(kw))) {
      voiceId = process.env.EXPO_PUBLIC_VOICE_DAD || 'james';
    } else if (femaleKeywords.some(kw => lowerRole.includes(kw))) {
      voiceId = process.env.EXPO_PUBLIC_VOICE_MOM || 'sarah';
    } else {
      // Fallback
      voiceId = process.env.EXPO_PUBLIC_VOICE_MOM || 'sarah';
    }
  }
  
  const safeText = text.replace(/[^a-zA-Z0-9]/g, '_');
  const fileName = `fish_${language}_${voiceId}_${store.speechRate}_${safeText}.mp3`;
  const fileUri = CACHE_DIR + fileName;
  
  const fileInfo = await FileSystem.getInfoAsync(fileUri);
  if (fileInfo.exists) {
    await FileSystem.deleteAsync(fileUri);
    console.log(`Deleted cached audio for: ${text}`);
  }
};

export const playTTS = async (text: string, language: 'id' | 'en' | 'zh', role: string) => {
  const store = useAACStore.getState();
  const { speechRate } = store;

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

  // 2. Tentukan Voice ID dari .env untuk Fish Audio
  const apiKey = process.env.EXPO_PUBLIC_FISH_AUDIO_API_KEY;
  
  let voiceId = '';
  let isMale = false;
  
  if (role === 'Child') {
    isMale = store.childProfile?.gender === 'Boy';
    voiceId = isMale
      ? process.env.EXPO_PUBLIC_VOICE_BOY || 'daniel'
      : process.env.EXPO_PUBLIC_VOICE_GIRL || 'lily';
  } else {
    // Smart Role-to-Voice Mapping for Parents/Others
    const lowerRole = role.toLowerCase();
    const maleKeywords = ['ayah', 'papa', 'papi', 'abi', 'bapak', 'kakek', 'paman', 'om'];
    const femaleKeywords = ['ibu', 'mama', 'mami', 'bunda', 'nenek', 'tante', 'bibi'];
    
    if (maleKeywords.some(kw => lowerRole.includes(kw))) {
      isMale = true;
      voiceId = process.env.EXPO_PUBLIC_VOICE_DAD || 'james';
    } else if (femaleKeywords.some(kw => lowerRole.includes(kw))) {
      isMale = false;
      voiceId = process.env.EXPO_PUBLIC_VOICE_MOM || 'sarah';
    } else {
      // Fallback
      isMale = false;
      voiceId = process.env.EXPO_PUBLIC_VOICE_MOM || 'sarah';
    }
  }

  // Jika API key LMNT tersedia, coba fetch
  if (apiKey) {
    try {
      await ensureCacheLimit();
      const safeText = text.replace(/[^a-zA-Z0-9]/g, '_');
      // Include speechRate in cache filename so different speeds trigger new downloads
      const fileName = `fish_${language}_${voiceId}_${speechRate}_${safeText}.mp3`;
      const fileUri = CACHE_DIR + fileName;

        // Modify text to sound more relaxed/suprasegmental (adding conversational pauses)
        const relaxedText = text.replace(/ /g, ', ');

        // 3. Cek Caching Lokal
        const fileInfo = await FileSystem.getInfoAsync(fileUri);
        
        if (!fileInfo.exists) {
          // Fetch dari Fish Audio REST API (POST request)
          console.log('Fetching from Fish Audio API...');
          
          const response = await fetch('https://api.fish.audio/v1/tts', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'model': 's2.1-pro-free'
            },
            body: JSON.stringify({
              text: relaxedText,
              reference_id: voiceId,
              format: 'mp3',
              latency: 'normal',
              prosody: {
                speed: speechRate,
                volume: 0,
                normalize_loudness: true
              }
            })
          });
          
          if (!response.ok) {
            throw new Error(`Fish Audio API failed: ${response.status} ${response.statusText}`);
          }
          
          // Convert binary Blob to Base64 and save to Cache
          const blob = await response.blob();
          const reader = new FileReader();
          reader.readAsDataURL(blob);
          
          await new Promise<void>((resolve, reject) => {
            reader.onloadend = async () => {
              try {
                const base64data = (reader.result as string).split(',')[1];
                await FileSystem.writeAsStringAsync(fileUri, base64data, { encoding: FileSystem.EncodingType.Base64 });
                resolve();
              } catch (err) {
                reject(err);
              }
            };
            reader.onerror = reject;
          });
          
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
      console.log('Fish Audio Error, fallback ke Offline TTS:', error);
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
    pitch = isMale ? 1.4 : 1.7;
  } else {
    pitch = isMale ? 0.7 : 1.2;
  }

  Speech.speak(text, { 
    language: language === 'id' ? 'id-ID' : language === 'en' ? 'en-US' : 'zh-CN',
    rate: speechRate,
    pitch: pitch
  });
};
