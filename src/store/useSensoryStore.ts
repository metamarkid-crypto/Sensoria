import { create } from 'zustand';

export type ProfileType = 'None' | 'Blind' | 'Deaf' | 'Mute';

interface SensoryState {
  profile: ProfileType;
  setProfile: (profile: ProfileType) => void;
  resetProfile: () => void;
}

export const useSensoryStore = create<SensoryState>((set) => ({
  profile: 'None',
  setProfile: (profile) => set({ profile }),
  resetProfile: () => set({ profile: 'None' }),
}));
