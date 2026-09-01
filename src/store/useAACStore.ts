import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type UserRole = 'None' | 'Child' | 'Parent';
export type AppLanguage = 'id' | 'en' | 'zh';
export type ChildProfile = { 
  device_id?: string;
  fullName?: string; 
  full_name?: string;
  nickname: string; 
  gender?: 'Boy' | 'Girl';
  settings?: any;
} | null;

export interface AACWord {
  id: string;
  word_id: string; // Indonesian
  word_zh: string; // Mandarin
  imageUrl?: string;
  categoryId: string;
  isCustom?: boolean;
}

export interface AboutContent {
  description: string;
  contactEmail: string;
  version: string;
  privacyPolicyUrl: string;
}

export interface AACState {
  hasSeenOnboarding: boolean;
  role: UserRole;
  language: AppLanguage;
  childProfile: ChildProfile;
  deviceId: string | null;
  pairingCode: string | null;
  currentSentence: AACWord[];
  // Voice Settings
  speechRate: number;
  volume: number;
  selectedVoice: string; // LMNT voice id
  speakOnTap: boolean;
  soundFeedback: boolean;
  
  // Appearance Settings
  cardSize: 'S' | 'M' | 'L' | 'XL';
  textSize: 'A-' | 'A' | 'A+';
  cardSpacing: number;
  enableCategoryColors: boolean;
  highContrast: boolean;

  // Accessibility Settings
  holdDuration: number;
  ignoreRepeat: boolean;
  releaseToSpeak: boolean;

  // App Content (Offline-First)
  aboutContent: AboutContent | null;

  // Custom Quick Replies
  customQuickReplies: string[];
  
  // Ephemeral Real-Time Status
  childStatus: { 
    isOnline: boolean; 
    lastSeen: string | null;
    lat: number | null;
    lng: number | null;
    lastAddress: string | null;
  };
  
  // Parent Identity
  localParentName: string;

  // Actions
  setHasSeenOnboarding: (status: boolean) => void;
  setRole: (role: UserRole) => void;
  setLanguage: (lang: AppLanguage) => void;
  setChildProfile: (profile: ChildProfile) => void;
  setDeviceId: (id: string) => void;
  setPairingCode: (code: string) => void;
  addToSentence: (word: AACWord) => void;
  removeFromSentence: (index: number) => void;
  clearSentence: () => void;
  setSpeechRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  setSelectedVoice: (voice: string) => void;
  setSpeakOnTap: (status: boolean) => void;
  setSoundFeedback: (status: boolean) => void;
  setCardSize: (size: 'S' | 'M' | 'L' | 'XL') => void;
  setTextSize: (size: 'A-' | 'A' | 'A+') => void;
  setCardSpacing: (spacing: number) => void;
  setEnableCategoryColors: (status: boolean) => void;
  setHighContrast: (status: boolean) => void;
  setHoldDuration: (duration: number) => void;
  setIgnoreRepeat: (status: boolean) => void;
  setReleaseToSpeak: (status: boolean) => void;
  
  setAboutContent: (content: AboutContent) => void;
  addCustomQuickReply: (text: string) => void;
  removeCustomQuickReply: (text: string) => void;
  
  setChildStatus: (status: Partial<AACState['childStatus']>) => void;
  setLocalParentName: (name: string) => void;
}

export const useAACStore = create<AACState>()(
  persist(
    (set) => ({
      hasSeenOnboarding: false,
      role: 'None',
      language: 'id',
      childProfile: null,
      deviceId: null,
      pairingCode: null,
      currentSentence: [],
      speechRate: 1.0,
      volume: 1.0,
      selectedVoice: 'id-female-1',
      speakOnTap: true,
      soundFeedback: true,
      cardSize: 'L',
      textSize: 'A',
      cardSpacing: 10,
      enableCategoryColors: false,
      highContrast: false,
      holdDuration: 0,
      ignoreRepeat: false,
      releaseToSpeak: false,
      
      aboutContent: null,
      customQuickReplies: ['❤️ Mama di sini', '⏳ Tunggu sebentar ya', '🍎 Makan dulu yuk'],
      childStatus: { isOnline: false, lastSeen: null, lat: null, lng: null, lastAddress: null },
      localParentName: 'Orang Tua',
      
      setHasSeenOnboarding: (status) => set({ hasSeenOnboarding: status }),
      setRole: (role) => set({ role }),
      setLanguage: (language) => set({ language }),
      setChildProfile: (childProfile) => set({ childProfile }),
      setDeviceId: (deviceId) => set({ deviceId }),
      setPairingCode: (pairingCode) => set({ pairingCode }),
      addToSentence: (word) => set((state) => ({ currentSentence: [...state.currentSentence, word] })),
      removeFromSentence: (index) => set((state) => ({
        currentSentence: state.currentSentence.filter((_, i) => i !== index)
      })),
      clearSentence: () => set({ currentSentence: [] }),
      setSpeechRate: (rate) => set({ speechRate: rate }),
      setVolume: (volume) => set({ volume }),
      setSelectedVoice: (voice) => set({ selectedVoice: voice }),
      setSpeakOnTap: (status) => set({ speakOnTap: status }),
      setSoundFeedback: (status) => set({ soundFeedback: status }),
      setCardSize: (size) => set({ cardSize: size }),
      setTextSize: (size) => set({ textSize: size }),
      setCardSpacing: (spacing) => set({ cardSpacing: spacing }),
      setEnableCategoryColors: (status) => set({ enableCategoryColors: status }),
      setHighContrast: (status) => set({ highContrast: status }),
      setHoldDuration: (duration) => set({ holdDuration: duration }),
      setIgnoreRepeat: (status) => set({ ignoreRepeat: status }),
      setReleaseToSpeak: (status) => set({ releaseToSpeak: status }),
      
      setAboutContent: (content) => set({ aboutContent: content }),
      addCustomQuickReply: (text) => set((state) => ({ 
        customQuickReplies: [...state.customQuickReplies, text] 
      })),
      removeCustomQuickReply: (text) => set((state) => ({
        customQuickReplies: state.customQuickReplies.filter(reply => reply !== text)
      })),
      setChildStatus: (status) => set((state) => ({ 
        childStatus: { ...state.childStatus, ...status } 
      })),
      setLocalParentName: (name) => set({ localParentName: name }),
    }),
    { 
      name: 'aac-storage',
      storage: createJSONStorage(() => AsyncStorage)
    }
  )
);
