import { registerRootComponent } from 'expo';

// WAJIB di entry: task headless push harus sudah terdefinisi saat proses JS
// dibangunkan OS (app ditutup total). Impor di dalam komponen React terlalu
// lambat / tidak dievaluasi sama sekali pada cold start headless.
import './src/services/notifications/pushTask';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
