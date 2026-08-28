Tujuan Proyek (Sensoria Phase 1 MVP)
Membangun fondasi dan Fase 1 (MVP) dari "Sensoria", sebuah aplikasi edukasi multi-sensori berbasis AI untuk anak-anak dengan disabilitas sensorik (Tunanetra, Tunarungu, dan Tunawicara). Aplikasi ini menggunakan filosofi "Shape-Shifting UI" di mana antarmuka dan fitur beradaptasi secara dinamis berdasarkan "Sensory Profile" yang dipilih saat orientasi (onboarding).

Persetujuan Pengguna Diperlukan (User Review Required)
IMPORTANT

Pilihan Workflow React Native: Saya merencanakan penggunaan Expo Development Build (Expo dengan dukungan native module penuh) karena memungkinkan pengembangan yang lebih cepat dan kompatibilitas yang sangat baik dengan library seperti react-native-vision-camera dan react-native-haptic-feedback dibandingkan dengan Bare Workflow tradisional. Apakah Anda setuju dengan pendekatan Expo ini?

WARNING

API Keys: Untuk fitur Speech-to-Text (STT) dan Text-to-Speech (TTS), kita akan menggunakan OpenAI API. Saya akan menyiapkan kerangka .env, namun Anda perlu menyediakan API Key OpenAI Anda nantinya untuk menguji fitur secara langsung.

Pertanyaan Terbuka (Open Questions)
TIP

Apakah ada preferensi warna atau tema khusus yang ingin Anda gunakan untuk UI anak-anak? Jika tidak, saya akan menggunakan palet warna modern, cerah (namun ramah sensorik), dengan tipografi besar.
Untuk Phase 1, apakah simulasi STT/TTS dapat menggunakan library Expo/React Native bawaan sementara jika koneksi OpenAI membutuhkan waktu, atau kita harus langsung mengintegrasikan OpenAI Whisper dan TTS?
Perubahan yang Diusulkan (Proposed Changes)
Kita akan membangun arsitektur termodularisasi menggunakan TypeScript, Zustand (State Management), dan React Navigation.

1. Inisiasi Proyek & Struktur Dasar
Inisialisasi proyek Expo React Native dengan TypeScript.
Menyiapkan struktur folder: src/assets, src/components/common, src/components/sensory, src/store (untuk Zustand), src/navigation, src/screens, src/services/ai, dan src/utils/haptics.
2. State Management & Navigasi
Membuat store Zustand global untuk menyimpan "Sensory Profile" (Blind, Deaf, Mute).
Membuat Stack Navigation dinamis yang mengubah rute utama setelah pengguna memilih profil di Onboarding.
3. Layar Onboarding (Onboarding Screen)
Membuat OnboardingScreen yang interaktif bagi orang tua untuk memilih Sensory Profile anak.
Mengimplementasikan aksesibilitas (a11y) pada setiap komponen UI.
4. Modul Tunarungu/Tunawicara (Deaf/Mute Module)
Membuat DeafMuteDashboardScreen.
Fitur A (Visualizer): Integrasi modul Speech-to-Text (menangkap audio dan menampilkan teks berukuran besar dengan UI yang mudah dibaca).
Fitur B (Voice Proxy): Integrasi input teks dan tombol "Bicara" yang memicu Text-to-Speech dengan suara AI seperti anak-anak.
5. Inti Aksesibilitas (Accessibility Core)
Menerapkan accessibilityLabel, accessibilityRole, dan accessibilityHint pada semua komponen UI (common dan sensory).
Rencana Verifikasi (Verification Plan)
Verifikasi Manual
Menjalankan aplikasi secara lokal (Simulator/Emulator atau Expo Go/Dev Build).
Menguji alur: Memilih profil di layar Onboarding dan diarahkan ke Dashboard yang sesuai.
Menguji aksesibilitas: Memastikan screen reader (VoiceOver/TalkBack) dapat membaca elemen UI dengan benar.
Menguji fungsi Voice Proxy (Teks ke Suara) dan Visualizer (Suara ke Teks) pada Modul Tunarungu/Tunawicara menggunakan API OpenAI (jika kunci tersedia) atau mock data.