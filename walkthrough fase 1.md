Walkthrough: Sensoria Phase 1 (MVP)
Fase 1 dari aplikasi Sensoria telah berhasil diinisialisasi dan diimplementasikan. Berikut adalah ringkasan dari semua komponen dan fitur yang telah dikerjakan:

Arsitektur & Lingkungan
Proyek React Native berhasil dibuat menggunakan Expo Development Build (blank-typescript template).
Dependensi utama telah dipasang: @react-navigation/native, zustand, expo-av (untuk audio), expo-haptics, dan axios (untuk API).
File template konfigurasi API .env.example dan .env telah disiapkan. Penting: Anda harus memasukkan EXPO_PUBLIC_OPENAI_API_KEY milik Anda pada file .env sebelum menggunakan fitur Speech-to-Text (STT) dan Text-to-Speech (TTS).
Modul Buffer (npm install buffer) telah diinstal untuk mengonversi array buffer audio menjadi base64 di layanan TTS.
State Management (Zustand)
Store useSensoryStore.ts telah dibuat untuk mengelola Sensory Profile secara global. Store ini menentukan apakah aplikasi berjalan pada Mode None (Layar Onboarding), Mode Blind, atau Mode Deaf/Mute.
Navigasi Dinamis
AppNavigator.tsx dibuat dengan mengimplementasikan rute berbasis kondisi (Conditional Routing). Saat aplikasi pertama dibuka dan profile belum dipilih ('None'), OnboardingScreen akan muncul. Setelah dipilih, rute langsung diarahkan secara otomatis tanpa harus memanggil navigation.navigate.
Layar yang Diimplementasikan
1. OnboardingScreen
Desain bersih dan sederhana, mengutamakan kejelasan.
Terdiri dari 3 tombol dengan warna-warna pembeda (Kontras Hitam/Kuning untuk Blind, Pastel untuk Deaf/Mute).
Sepenuhnya didukung oleh accessibilityLabel, accessibilityRole, dan accessibilityHint untuk Screen Reader.
2. BlindDashboardScreen
Extreme Dark Mode: Latar belakang hitam pekat (#000000) dengan teks berwarna kuning cerah (#FFD700) untuk kontras tingkat tertinggi (standar WCAG tinggi).
Haptic Feedback: Semua interaksi pada layar ini terhubung dengan Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy) untuk memberikan sensasi taktil yang jelas setiap kali tombol ditekan.
Tombol yang berukuran sangat besar untuk memudahkan sentuhan.
3. DeafMuteDashboardScreen
Soft Pastel Theme: Warna hijau/mint lembut (#E8F8F5) untuk meminimalkan beban kognitif visual, dipadukan dengan tombol berwarna dominan (Ocean Blue & Sunset Orange).
Fitur A (Visualizer STT): Memanfaatkan expo-av untuk merekam suara dan Whisper API (melalui src/services/ai/openai.ts) untuk melakukan transkripsi, dengan teks berukuran besar (fontSize: 32, extra bold).
Fitur B (Voice Proxy TTS): Input teks yang saat ditekan akan mengirim teks ke OpenAI TTS (model: tts-1, voice: nova). File audio akan diunduh, dikonversi, disimpan sementara, dan langsung diputar.
TIP

Anda dapat menjalankan proyek ini dengan membuka terminal di folder Sensoria dan menjalankan npx expo start. Karena kita menggunakan Development Build dan dependensi native (seperti expo-haptics & expo-av), disarankan menggunakan iOS Simulator, Android Emulator, atau mem-build aplikasi langsung (Prebuild) di masa mendatang.