/**
 * kamus-art.js — SVG character art for the offline AAC dictionary.
 *
 * Generates chibi boy ('pria') / girl ('wanita') illustrations for every
 * word that needs a human character (verb / emotion / social categories),
 * styled after the reference art: big head, dark-brown hair, gray shirt
 * for the boy, white shirt + pink overall with side ponytail for the girl.
 *
 * Exported: renderSVG(wordKey, gender) -> full <svg> string, 150x220 viewBox.
 */
'use strict';

// ---------- palette ----------
const SKIN = '#FBD7B0';
const SKIN_SH = '#EDB98A';
const HAIR_B = '#4A3626';
const HAIR_B_D = '#3B2A1D';
const HAIR_G = '#5B4132';
const HAIR_G_D = '#493526';
const PINK = '#EC4899';
const SHIRT_B = '#ECEFF4';
const SHIRT_G = '#FFFFFF';
const PANTS = '#6B7A99';
const SHOE_B = '#4A5568';
const SHOE_G = '#F472B6';
const BLUSH = '#F8A8A0';
const IRIS = '#5D4037';
const MOUTH = '#8C4A3C';
const MOUTH_LN = '#B4552D';
const GRAY = '#94A3B8';

const BOY_WORDS = [
  'pergi', 'lihat', 'dengar', 'bicara', 'kasih', 'buka', 'tutup', 'mandi',
  'jelek', 'senang', 'sedih', 'marah', 'panas', 'dingin', 'besar', 'kecil',
  'lapar', 'haus', 'capek', 'terima_kasih', 'maaf', 'halo', 'dadah', 'tunggu',
  'duduk', 'berdiri', 'lari', 'jalan', 'lompat', 'menangis', 'tertawa',
  'menulis', 'membaca', 'menyanyi', 'menari', 'takut', 'kaget', 'malu',
  'bosan', 'tenang', 'cepat', 'lambat', 'tinggi', 'pendek', 'baru',
  'selamat', 'hati-hati', 'boleh', 'jangan', 'bantu',
];

// ---------- pose table ----------
// arms: variant key | legs: variant key | expr: face key
// tilt: head rotation deg | shift: body translate Y | scale: body scale
// extras: prop keys | torso: 'bath' for shirtless+towel
const POSES = {
  pergi:        { arms: 'swing',     legs: 'walk',   expr: 'neutral' },
  lihat:        { arms: 'brow',      legs: 'stand',  expr: 'neutral', tilt: 4, pupil: 'asideR' },
  dengar:       { arms: 'ear',       legs: 'stand',  expr: 'neutral', tilt: -3 },
  bicara:       { arms: 'forward',   legs: 'stand',  expr: 'openSmile', extras: ['bubble'] },
  kasih:        { arms: 'heartOffer', legs: 'stand', expr: 'happy', extras: ['gift'] },
  buka:         { arms: 'forward',   legs: 'stand',  expr: 'surprised', extras: ['boxOpen'] },
  tutup:        { arms: 'forward',   legs: 'stand',  expr: 'neutral', extras: ['boxClosed'] },
  mandi:        { arms: 'wash',      legs: 'stand',  expr: 'happy', torso: 'bath', extras: ['bubbles'] },
  jelek:        { arms: 'thumbsDown', legs: 'stand', expr: 'flat' },
  senang:       { arms: 'up',        legs: 'stand',  expr: 'bigSmile', extras: ['sparkle'] },
  sedih:        { arms: 'down',      legs: 'stand',  expr: 'cry', tilt: -3, extras: ['tear'] },
  marah:        { arms: 'down',      legs: 'stand',  expr: 'angry', extras: ['anger'] },
  panas:        { arms: 'wave',      legs: 'stand',  expr: 'tired', extras: ['heat'] },
  dingin:       { arms: 'hug',       legs: 'stand',  expr: 'worried', extras: ['snow'] },
  besar:        { arms: 'spread',    legs: 'stand',  expr: 'happy' },
  kecil:        { arms: 'tummyBoth', legs: 'crouch', expr: 'neutral', scale: 0.92, extras: ['shrink'] },
  lapar:        { arms: 'belly',     legs: 'stand',  expr: 'openSmile', extras: ['apple'] },
  haus:         { arms: 'cup',       legs: 'stand',  expr: 'happy', extras: ['cup'] },
  capek:        { arms: 'down',      legs: 'stand',  expr: 'tired', tilt: 6, extras: ['zzz'] },
  terima_kasih: { arms: 'handsMeet', legs: 'stand',  expr: 'happy', tilt: 4, extras: ['heartSmall'] },
  maaf:         { arms: 'handsMeet', legs: 'stand',  expr: 'worried', tilt: 6, extras: ['sweat'] },
  halo:         { arms: 'wave',      legs: 'stand',  expr: 'bigSmile', extras: ['waveLines'] },
  dadah:        { arms: 'bothWave',  legs: 'stand',  expr: 'bigSmile', extras: ['waveLines', 'heartSmall'] },
  tunggu:       { arms: 'palmStop',  legs: 'stand',  expr: 'neutral' },
  duduk:        { arms: 'down',      legs: 'sit',    expr: 'neutral', shift: 6 },
  berdiri:      { arms: 'down',      legs: 'stand',  expr: 'happy', extras: ['sparkle'] },
  lari:         { arms: 'pumpRun',   legs: 'run',    expr: 'openSmile', extras: ['speed'] },
  jalan:        { arms: 'swing',     legs: 'walk',   expr: 'happy' },
  lompat:       { arms: 'up',        legs: 'jump',   expr: 'bigSmile', shift: -5, extras: ['bounce'] },
  menangis:     { arms: 'eyesRub',   legs: 'stand',  expr: 'cry', tilt: -4, extras: ['tearsFall'] },
  tertawa:      { arms: 'tummyBoth', legs: 'stand',  expr: 'laugh', tilt: -4 },
  menulis:      { arms: 'write',     legs: 'stand',  expr: 'neutral', tilt: 4, extras: ['paper', 'pencil'] },
  membaca:      { arms: 'read',      legs: 'stand',  expr: 'neutral', pupil: 'down' },
  menyanyi:     { arms: 'sing',      legs: 'stand',  expr: 'bigSmile', extras: ['mic', 'notes'] },
  menari:       { arms: 'bothWave',  legs: 'walk',   expr: 'bigSmile', tilt: 5, extras: ['notes'] },
  takut:        { arms: 'hug',       legs: 'crouch', expr: 'surprised', scale: 0.96, extras: ['sweat'] },
  kaget:        { arms: 'cheeks',    legs: 'stand',  expr: 'surprised', shift: -3, extras: ['shock'] },
  malu:         { arms: 'cheeks',    legs: 'stand',  expr: 'shy', tilt: 4, extras: ['blushBig'] },
  bosan:        { arms: 'down',      legs: 'stand',  expr: 'bored', tilt: 8, extras: ['dots'] },
  tenang:       { arms: 'down',      legs: 'stand',  expr: 'calm', extras: ['breathe'] },
  cepat:        { arms: 'pumpRun',   legs: 'run',    expr: 'neutral', extras: ['speed', 'speed2'] },
  lambat:       { arms: 'swing',     legs: 'walk',   expr: 'bored', extras: ['dots'] },
  tinggi:       { arms: 'reachUp',   legs: 'tiptoe', expr: 'happy', extras: ['arrowUp'] },
  pendek:       { arms: 'down',      legs: 'crouch', expr: 'neutral', scale: 0.9, extras: ['arrowDown'] },
  baru:         { arms: 'up',        legs: 'stand',  expr: 'bigSmile', extras: ['star'] },
  selamat:      { arms: 'up',        legs: 'stand',  expr: 'bigSmile', extras: ['confetti'] },
  'hati-hati':  { arms: 'palmStop',  legs: 'stand',  expr: 'worried', extras: ['warning'] },
  boleh:        { arms: 'thumbsUp',  legs: 'stand',  expr: 'happy', extras: ['check'] },
  jangan:       { arms: 'cross',     legs: 'stand',  expr: 'angry', extras: ['noSign'] },
  bantu:        { arms: 'offer',     legs: 'stand',  expr: 'happy', extras: ['heart'] },
};

// ---------- arm variants: hand x/y + curve control ----------
const ARMS = {
  down:      { L: [45, 170, 40, 152], R: [105, 170, 110, 152] },
  up:        { L: [34, 112, 38, 124], R: [116, 112, 112, 124] },
  wave:      { L: [45, 170, 40, 152], R: [121, 104, 116, 122] },
  bothWave:  { L: [29, 104, 34, 122], R: [121, 104, 116, 122] },
  forward:   { L: [58, 158, 46, 150], R: [92, 158, 104, 150], big: true },
  offer:     { L: [55, 152, 44, 148], R: [95, 152, 106, 148], big: true },
  heartOffer:{ L: [66, 152, 48, 146], R: [84, 152, 102, 146] },
  handsMeet: { L: [68, 148, 46, 140], R: [82, 148, 104, 140] },
  cross:     { L: [86, 148, 52, 146], R: [64, 148, 98, 146] },
  belly:     { L: [45, 170, 40, 152], R: [74, 156, 104, 148] },
  cheeks:    { L: [49, 98, 38, 116],  R: [101, 98, 112, 116] },
  eyesRub:   { L: [56, 86, 40, 112],  R: [94, 86, 110, 112] },
  ear:       { L: [45, 170, 40, 152], R: [112, 90, 114, 112] },
  brow:      { L: [45, 170, 40, 152], R: [106, 72, 114, 102] },
  pumpRun:   { L: [38, 142, 38, 130], R: [112, 148, 108, 132] },
  hug:       { L: [84, 154, 42, 150], R: [66, 154, 108, 150] },
  spread:    { L: [26, 136, 38, 130], R: [124, 136, 112, 130] },
  tummyBoth: { L: [66, 158, 44, 150], R: [84, 158, 106, 150] },
  wash:      { L: [50, 66, 40, 100],  R: [100, 66, 110, 100] },
  cup:       { L: [45, 170, 40, 152], R: [97, 106, 112, 120] },
  thumbsUp:  { L: [45, 170, 40, 152], R: [106, 142, 112, 150], thumb: 'up' },
  thumbsDown:{ L: [45, 170, 40, 152], R: [106, 148, 112, 142], thumb: 'down' },
  palmStop:  { L: [45, 170, 40, 152], R: [100, 138, 112, 146], palm: true },
  reachUp:   { L: [45, 170, 40, 152], R: [114, 98, 116, 116] },
  sing:      { L: [44, 150, 40, 148], R: [90, 104, 110, 118] },
  write:     { L: [45, 170, 40, 152], R: [94, 152, 110, 146] },
  read:      { L: [58, 150, 44, 148], R: [92, 150, 106, 148] },
  swing:     { L: [54, 146, 42, 150], R: [100, 160, 110, 152] },
};

// ---------- legs variants: foot x/y + curve control ----------
const LEGS = {
  stand:  { L: [63, 193, 60, 180], R: [87, 193, 90, 180] },
  walk:   { L: [52, 190, 56, 178], R: [94, 192, 90, 178] },
  run:    { L: [45, 184, 52, 176], R: [99, 188, 92, 176] },
  jump:   { L: [62, 186, 56, 178], R: [88, 186, 94, 178] },
  crouch: { L: [58, 193, 58, 178], R: [92, 193, 92, 178] },
  tiptoe: { L: [62, 190, 60, 178], R: [88, 190, 90, 178] },
  sit:    { L: [52, 188, 60, 180], R: [98, 188, 90, 180] },
};

// ---------- prop helpers ----------
const heartPath = (x, y, s) =>
  `M${x},${y + 3 * s} C${x - 6 * s},${y - 2 * s} ${x - 2 * s},${y - 6 * s} ${x},${y - 2.2 * s} ` +
  `C${x + 2 * s},${y - 6 * s} ${x + 6 * s},${y - 2 * s} ${x},${y + 3 * s} Z`;

const starPath = (cx, cy, r) => {
  let p = '';
  for (let i = 0; i < 8; i++) {
    const rad = (Math.PI / 4) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.45;
    p += `${i === 0 ? 'M' : 'L'}${(cx + rr * Math.cos(rad)).toFixed(1)},${(cy + rr * Math.sin(rad)).toFixed(1)} `;
  }
  return p + 'Z';
};

function extrasSVG(keys, gender) {
  const out = [];
  for (const k of keys || []) {
    switch (k) {
      case 'gift':
        out.push(`<g><rect x="63" y="136" width="24" height="18" rx="3" fill="#EF4444"/><rect x="63" y="136" width="24" height="6" rx="2" fill="#F87171"/><rect x="72.5" y="136" width="5" height="18" fill="#FDE68A"/><path d="M75,136 C69,128 63,132 68,136 Z M75,136 C81,128 87,132 82,136 Z" fill="#FCA5A5" stroke="#EF4444" stroke-width="1"/></g>`);
        break;
      case 'boxOpen':
        out.push(`<g><rect x="57" y="156" width="36" height="22" rx="3" fill="#F59E0B"/><rect x="66" y="156" width="18" height="22" fill="#FBBF24"/><path d="M52,148 L60,156 L96,156 L98,142 Z" fill="#FCD34D" stroke="#D97706" stroke-width="1.5"/></g>`);
        break;
      case 'boxClosed':
        out.push(`<g><rect x="57" y="152" width="36" height="24" rx="3" fill="#F59E0B"/><rect x="54" y="146" width="42" height="8" rx="2" fill="#FBBF24"/><rect x="72" y="146" width="6" height="30" fill="#FDE68A"/></g>`);
        break;
      case 'bubbles':
        out.push(`<g fill="#BFE3F7" opacity="0.9"><circle cx="34" cy="52" r="7"/><circle cx="120" cy="40" r="9"/><circle cx="128" cy="70" r="5"/><circle cx="26" cy="84" r="4"/><circle cx="112" cy="22" r="4.5"/></g><g fill="#FFFFFF" opacity="0.9"><circle cx="32" cy="50" r="2"/><circle cx="118" cy="38" r="2.5"/><circle cx="126" cy="68" r="1.5"/></g>`);
        break;
      case 'sparkle':
        out.push(`<path d="${starPath(118, 52, 9)}" fill="#FBBF24"/><path d="${starPath(30, 70, 6)}" fill="#FCD34D"/>`);
        break;
      case 'tear':
        out.push(`<path d="M56,92 C53,97 53,101 56,102.5 C59,101 59,97 56,92 Z" fill="#7DD3FC"/>`);
        break;
      case 'tearsFall':
        out.push(`<g fill="#7DD3FC"><rect x="53" y="92" width="4.5" height="16" rx="2.2"/><rect x="92" y="92" width="4.5" height="16" rx="2.2"/><ellipse cx="55" cy="114" rx="3" ry="4"/><ellipse cx="94" cy="114" rx="3" ry="4"/></g>`);
        break;
      case 'anger':
        out.push(`<g stroke="#EF4444" stroke-width="3" stroke-linecap="round" fill="none"><path d="M112,54 L120,46 M120,54 L112,46 M116,44 L116,56"/></g>`);
        break;
      case 'heat':
        out.push(`<g stroke="#F87171" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.85"><path d="M46,40 Q49,34 46,28 Q43,24 46,20"/><path d="M60,36 Q63,30 60,24"/><path d="M104,36 Q101,30 104,24"/></g>`);
        break;
      case 'snow':
        out.push(`<g stroke="#60A5FA" stroke-width="2.2" stroke-linecap="round"><path d="M120,52 L120,68 M112,56 L128,64 M128,56 L112,64 M120,52 L117,55 M120,52 L123,55 M120,68 L117,65 M120,68 L123,65"/></g>`);
        break;
      case 'shrink':
        out.push(`<g stroke="{GRAY}" stroke-width="2.5" stroke-linecap="round" fill="none"><path d="M20,120 L32,126 M20,120 L24,112 M20,120 L28,118"/><path d="M130,120 L118,126 M130,120 L126,112 M130,120 L122,118"/></g>`.replace('{GRAY}', GRAY));
        break;
      case 'apple':
        out.push(`<g><circle cx="116" cy="62" r="9" fill="#EF4444"/><path d="M116,53 C116,49 118,47 121,46" stroke="#7A4A21" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M117,51 C122,48 126,50 126,53 C122,55 118,54 117,51 Z" fill="#4ADE80"/></g>`);
        break;
      case 'cup':
        out.push(`<g><path d="M91,94 L107,94 L105,110 L93,110 Z" fill="#BFE3F7" stroke="#7DD3FC" stroke-width="1.6"/><path d="M100,94 L106,80" stroke="#EF4444" stroke-width="2.4" stroke-linecap="round"/></g>`);
        break;
      case 'zzz':
        out.push(`<g stroke="{Z}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M112,46 L122,46 L112,56 L122,56"/><path d="M126,32 L132,32 L126,38 L132,38"/><path d="M134,22 L138,22 L134,26 L138,26"/></g>`.replace('{Z}', GRAY));
        break;
      case 'sweat':
        out.push(`<path d="M110,60 C106,67 106,72 110,74 C114,72 114,67 110,60 Z" fill="#7DD3FC"/>`);
        break;
      case 'waveLines':
        out.push(`<g stroke="{W}" stroke-width="2.4" stroke-linecap="round" fill="none"><path d="M128,96 Q133,101 130,108"/><path d="M133,90 Q140,98 135,108"/></g>`.replace('{W}', GRAY));
        break;
      case 'heartSmall':
        out.push(`<path d="${heartPath(116, 58, 1.4)}" fill="#F472B6"/>`);
        break;
      case 'heart':
        out.push(`<path d="${heartPath(114, 60, 2.1)}" fill="#F472B6" stroke="#EC4899" stroke-width="1"/>`);
        break;
      case 'bubble':
        out.push(`<g><rect x="18" y="38" width="38" height="24" rx="9" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1.6"/><path d="M40,62 L46,72 L50,61 Z" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1.6"/><g fill="{G}"><circle cx="30" cy="50" r="2.2"/><circle cx="37" cy="50" r="2.2"/><circle cx="44" cy="50" r="2.2"/></g></g>`.replace('{G}', GRAY));
        break;
      case 'speed':
        out.push(`<g stroke="{G}" stroke-width="3" stroke-linecap="round"><path d="M8,140 L26,140 M4,154 L22,154 M10,168 L26,168"/></g>`.replace('{G}', GRAY));
        break;
      case 'speed2':
        out.push(`<g stroke="{G}" stroke-width="2.4" stroke-linecap="round" opacity="0.7"><path d="M16,126 L30,126 M12,180 L28,180"/></g>`.replace('{G}', GRAY));
        break;
      case 'bounce':
        out.push(`<g stroke="{G}" stroke-width="2.6" stroke-linecap="round" fill="none"><path d="M48,200 Q62,190 76,200"/><path d="M74,200 Q88,190 102,200"/></g>`.replace('{G}', GRAY));
        break;
      case 'paper':
        out.push(`<g transform="rotate(-8 92 172)"><rect x="76" y="160" width="34" height="24" rx="3" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1.6"/><g stroke="{G}" stroke-width="1.8" stroke-linecap="round"><path d="M82,168 L104,168 M82,174 L100,174 M82,180 L96,180"/></g></g>`.replace('{G}', GRAY));
        break;
      case 'pencil':
        out.push(`<g transform="rotate(-40 96 148)"><rect x="92" y="128" width="8" height="30" rx="2" fill="#FBBF24"/><rect x="92" y="124" width="8" height="6" rx="2" fill="#F472B6"/><path d="M92,158 L100,158 L96,166 Z" fill="#FDE68A"/><path d="M94.5,162.5 L97.5,162.5 L96,166 Z" fill="#3B2A1D"/></g>`);
        break;
      case 'book':
        out.push(`<g><path d="M75,146 L46,140 L46,166 L75,172 Z" fill="#FFFFFF" stroke="#94A3B8" stroke-width="1.8"/><path d="M75,146 L104,140 L104,166 L75,172 Z" fill="#F8FAFC" stroke="#94A3B8" stroke-width="1.8"/><g stroke="{G}" stroke-width="1.6" stroke-linecap="round"><path d="M52,149 L69,152 M52,155 L69,158 M52,161 L66,164"/><path d="M81,152 L98,149 M81,158 L98,155 M81,164 L94,161"/></g></g>`.replace('{G}', GRAY));
        break;
      case 'mic':
        out.push(`<g><circle cx="92" cy="96" r="6.5" fill="#9CA3AF"/><circle cx="92" cy="96" r="6.5" fill="none" stroke="#6B7280" stroke-width="1.4"/><path d="M96,101 L104,112" stroke="#6B7280" stroke-width="3.6" stroke-linecap="round"/></g>`);
        break;
      case 'notes':
        out.push(`<g fill="#7C3AED"><circle cx="120" cy="46" r="3.6"/><rect x="122.4" y="30" width="2.4" height="16" rx="1"/><path d="M122,30 Q130,32 128,40 Q126,34 122,34 Z"/><circle cx="30" cy="58" r="3.2"/><rect x="32.2" y="44" width="2.2" height="14" rx="1"/></g>`);
        break;
      case 'shock':
        out.push(`<g><rect x="114" y="42" width="7" height="16" rx="3.5" fill="#EF4444"/><circle cx="117.5" cy="64" r="3.6" fill="#EF4444"/><g stroke="{G}" stroke-width="2.2" stroke-linecap="round"><path d="M28,44 L34,50 M34,44 L28,50"/></g></g>`.replace('{G}', GRAY));
        break;
      case 'blushBig':
        out.push(`<g fill="#F87171" opacity="0.5"><ellipse cx="46" cy="94" rx="9" ry="5.5"/><ellipse cx="104" cy="94" rx="9" ry="5.5"/></g>`);
        break;
      case 'dots':
        out.push(`<g fill="{G}"><circle cx="112" cy="52" r="2.6"/><circle cx="120" cy="48" r="2.6"/><circle cx="128" cy="44" r="2.6"/></g>`.replace('{G}', GRAY));
        break;
      case 'breathe':
        out.push(`<g stroke="#7DD3FC" stroke-width="2.2" stroke-linecap="round" fill="none" opacity="0.8"><path d="M108,148 Q113,154 108,160"/><path d="M115,144 Q122,154 115,164"/></g>`);
        break;
      case 'star':
        out.push(`<path d="${starPath(116, 56, 14)}" fill="#FBBF24"/><path d="${starPath(116, 56, 7)}" fill="#FDE68A"/>`);
        break;
      case 'confetti':
        out.push(`<g><rect x="26" y="34" width="7" height="4" rx="1.5" fill="#F87171" transform="rotate(20 29 36)"/><rect x="118" y="28" width="7" height="4" rx="1.5" fill="#60A5FA" transform="rotate(-15 121 30)"/><rect x="42" y="22" width="6" height="4" rx="1.5" fill="#4ADE80" transform="rotate(-30 45 24)"/><rect x="104" y="16" width="6" height="4" rx="1.5" fill="#FBBF24" transform="rotate(25 107 18)"/><circle cx="88" cy="18" r="3" fill="#F472B6"/><circle cx="60" cy="16" r="2.6" fill="#A78BFA"/></g>`);
        break;
      case 'warning':
        out.push(`<g transform="rotate(-6 120 54)"><path d="M120,40 L133,64 L107,64 Z" fill="#FDE047" stroke="#F59E0B" stroke-width="2" stroke-linejoin="round"/><rect x="118" y="48" width="4" height="8" rx="2" fill="#713F12"/><circle cx="120" cy="60" r="2" fill="#713F12"/></g>`);
        break;
      case 'check':
        out.push(`<g><circle cx="120" cy="54" r="11" fill="#22C55E"/><path d="M114,54 L119,59 L127,49" stroke="#FFFFFF" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`);
        break;
      case 'noSign':
        out.push(`<g stroke="#EF4444" stroke-width="3.6" stroke-linecap="round"><circle cx="120" cy="54" r="12" fill="#FFFFFF" fill-opacity="0.85"/><path d="M112,46 L128,62 M128,46 L112,62"/></g>`);
        break;
      case 'arrowUp':
        out.push(`<g stroke="#10B981" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M124,80 L124,50 M124,50 L116,60 M124,50 L132,60"/></g>`);
        break;
      case 'arrowDown':
        out.push(`<g stroke="#EF4444" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M126,92 L126,122 M126,122 L118,112 M126,122 L134,112"/></g>`);
        break;
      default:
        break;
    }
  }
  return out.join('\n');
}

// ---------- face ----------
function faceSVG(expr, pupil, gender) {
  const lash = gender === 'wanita'
    ? `<g stroke="{I}" stroke-width="1.6" stroke-linecap="round"><path d="M66,76 L69,73"/><path d="M84,76 L81,73"/></g>`.replace('{I}', IRIS)
    : '';
  const eye = (ex, pOffset) => {
    const po = pOffset || { dx: 0, dy: 0 };
    return `<g><ellipse cx="${ex}" cy="82" rx="7.2" ry="8.6" fill="#FFFFFF"/><ellipse cx="${ex + po.dx}" cy="${83.4 + po.dy}" rx="4.4" ry="5.2" fill="${IRIS}"/><circle cx="${ex + po.dx + 0.3}" cy="${84 + po.dy}" r="2" fill="#241A12"/><circle cx="${ex - 1.9 + po.dx}" cy="${79.8 + po.dy}" r="2" fill="#FFFFFF"/><circle cx="${ex + 2.2 + po.dx}" cy="${86 + po.dy}" r="1" fill="#FFFFFF" opacity="0.9"/></g>`;
  };
  const pupilOff =
    pupil === 'asideR' ? { dx: 2.4, dy: 0.6 } :
    pupil === 'down' ? { dx: 0.6, dy: 2.6 } : { dx: 0, dy: 0 };

  let eyes, brows, mouth, extra = '';
  const browBoy = (d) => `<path d="${d}" stroke="${HAIR_B}" stroke-width="2.6" stroke-linecap="round" fill="none"/>`;
  const browGirl = (d) => `<path d="${d}" stroke="${HAIR_G_D}" stroke-width="2" stroke-linecap="round" fill="none"/>`;
  const brow = gender === 'wanita' ? browGirl : browBoy;

  switch (expr) {
    case 'bigSmile':
      eyes = eye(60, pupilOff) + eye(90, pupilOff);
      brows = brow('M52,69 Q60,65 68,68') + brow('M82,68 Q90,65 98,69');
      mouth = `<path d="M66,95 Q75,108 84,95 Q75,99.5 66,95 Z" fill="${MOUTH}"/><ellipse cx="75" cy="103" rx="4.2" ry="2.4" fill="#E36C5D"/>`;
      break;
    case 'openSmile':
      eyes = eye(60, pupilOff) + eye(90, pupilOff);
      brows = brow('M52,69 Q60,65 68,68') + brow('M82,68 Q90,65 98,69');
      mouth = `<path d="M68,96 Q75,105 82,96 Q75,99 68,96 Z" fill="${MOUTH}"/>`;
      break;
    case 'happy':
      eyes = eye(60, pupilOff) + eye(90, pupilOff);
      brows = brow('M52,69 Q60,65 68,68') + brow('M82,68 Q90,65 98,69');
      mouth = `<path d="M67,97 Q75,104 83,97" stroke="${MOUTH_LN}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
      break;
    case 'neutral':
      eyes = eye(60, pupilOff) + eye(90, pupilOff);
      brows = brow('M53,68.5 Q60,66 67,68') + brow('M83,68 Q90,66 97,68.5');
      mouth = `<path d="M69,99 Q75,102.5 81,99" stroke="${MOUTH_LN}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
      break;
    case 'flat':
      eyes = eye(60, pupilOff) + eye(90, pupilOff);
      brows = brow('M53,68 Q60,66.5 67,68.5') + brow('M83,68.5 Q90,66.5 97,68');
      mouth = `<path d="M68,100 L82,100" stroke="${MOUTH_LN}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
      break;
    case 'cry':
      eyes = eye(60, { dx: 0, dy: 1.4 }) + eye(90, { dx: 0, dy: 1.4 });
      brows = brow('M52,68 Q60,64.5 68,64.5') + brow('M98,68 Q90,64.5 82,64.5');
      mouth = `<path d="M67,101 Q71,96 75,99 Q79,102 83,97" stroke="${MOUTH_LN}" stroke-width="2.3" fill="none" stroke-linecap="round"/>`;
      break;
    case 'angry':
      eyes = eye(60, { dx: 0, dy: 1.2 }) + eye(90, { dx: 0, dy: 1.2 });
      brows = `<path d="M52,66 L67,71" stroke="${gender === 'wanita' ? HAIR_G_D : HAIR_B}" stroke-width="3" stroke-linecap="round"/><path d="M98,66 L83,71" stroke="${gender === 'wanita' ? HAIR_G_D : HAIR_B}" stroke-width="3" stroke-linecap="round"/>`;
      mouth = `<path d="M67,100 Q75,94.5 83,100" stroke="${MOUTH_LN}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
      break;
    case 'surprised':
      eyes = `<g><ellipse cx="60" cy="82" rx="7.8" ry="9.2" fill="#FFFFFF"/><circle cx="60" cy="83" r="3" fill="${IRIS}"/><circle cx="59" cy="81.6" r="1.5" fill="#FFFFFF"/></g>` +
             `<g><ellipse cx="90" cy="82" rx="7.8" ry="9.2" fill="#FFFFFF"/><circle cx="90" cy="83" r="3" fill="${IRIS}"/><circle cx="89" cy="81.6" r="1.5" fill="#FFFFFF"/></g>`;
      brows = brow('M52,64 Q60,61 68,63.5') + brow('M82,63.5 Q90,61 98,64');
      mouth = `<ellipse cx="75" cy="100" rx="4.4" ry="5.6" fill="${MOUTH}"/>`;
      break;
    case 'tired':
      eyes = `<path d="M53,82 Q60,88 67,82" stroke="${IRIS}" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M83,82 Q90,88 97,82" stroke="${IRIS}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
      brows = brow('M53,71 Q60,68.5 67,70') + brow('M83,70 Q90,68.5 97,71');
      mouth = `<ellipse cx="75" cy="100" rx="3.2" ry="3.8" fill="${MOUTH}"/>`;
      extra = `<path d="M108,64 C104,71 104,76 108,78 C112,76 112,71 108,64 Z" fill="#7DD3FC"/>`;
      break;
    case 'shy':
      eyes = eye(60, { dx: 2, dy: 1 }) + eye(90, { dx: 2, dy: 1 });
      brows = brow('M53,69 Q60,66 67,68.5') + brow('M83,68.5 Q90,66 97,69');
      mouth = `<path d="M70,100 Q75,103.5 80,100" stroke="${MOUTH_LN}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
      break;
    case 'bored':
      eyes = `<g><ellipse cx="60" cy="82" rx="7.2" ry="8.6" fill="#FFFFFF"/><path d="M53.5,79 Q60,76.5 66.5,79 L66.5,82 Q60,79.5 53.5,82 Z" fill="${SKIN}"/></g>` +
             `<g><ellipse cx="90" cy="82" rx="7.2" ry="8.6" fill="#FFFFFF"/><path d="M83.5,79 Q90,76.5 96.5,79 L96.5,82 Q90,79.5 83.5,82 Z" fill="${SKIN}"/></g>`;
      brows = brow('M54,71 Q60,69.5 66,71') + brow('M84,71 Q90,69.5 96,71');
      mouth = `<path d="M69,100 L81,100" stroke="${MOUTH_LN}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
      break;
    case 'calm':
      eyes = `<path d="M53,81 Q60,75.5 67,81" stroke="${IRIS}" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M83,81 Q90,75.5 97,81" stroke="${IRIS}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
      brows = brow('M53,69 Q60,66 67,68.5') + brow('M83,68.5 Q90,66 97,69');
      mouth = `<path d="M69,99 Q75,103.5 81,99" stroke="${MOUTH_LN}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
      break;
    case 'laugh':
      eyes = `<path d="M53,81 Q60,74 67,81" stroke="${IRIS}" stroke-width="2.8" fill="none" stroke-linecap="round"/><path d="M83,81 Q90,74 97,81" stroke="${IRIS}" stroke-width="2.8" fill="none" stroke-linecap="round"/>`;
      brows = brow('M52,67 Q60,63.5 68,66') + brow('M82,66 Q90,63.5 98,67');
      mouth = `<path d="M64,94 Q75,110 86,94 Q75,99 64,94 Z" fill="${MOUTH}"/><ellipse cx="75" cy="103.5" rx="5" ry="2.6" fill="#E36C5D"/>`;
      break;
    case 'worried':
    default:
      eyes = eye(60, pupilOff) + eye(90, pupilOff);
      brows = brow('M52,69 Q60,64.5 68,65.5') + brow('M98,69 Q90,64.5 82,65.5');
      mouth = `<path d="M67,100 Q70,97 73,99.5 Q76,102 79,99.5 Q82,97 83,99" stroke="${MOUTH_LN}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
      break;
  }

  const blush = `<g fill="${BLUSH}" opacity="0.5"><ellipse cx="46" cy="93" rx="6.6" ry="4.2"/><ellipse cx="104" cy="93" rx="6.6" ry="4.2"/></g>`;
  return `${eyes}${lash}${brows}${blush}
  <path d="M74,89.5 Q76.2,91.5 74.2,93" stroke="${SKIN_SH}" stroke-width="1.8" fill="none" stroke-linecap="round"/>
  ${mouth}${extra}`;
}

// ---------- head ----------
function headSVG(gender, tilt, expr, pupil) {
  const isBoy = gender !== 'wanita';
  const hairColor = isBoy ? HAIR_B : HAIR_G;
  const hairDark = isBoy ? HAIR_B_D : HAIR_G_D;
  const ear = (x) => `<circle cx="${x}" cy="86" r="7" fill="${SKIN}"/><circle cx="${x}" cy="86" r="2.8" fill="${SKIN_SH}"/>`;

  const hairBack = isBoy
    ? `<path d="M32,84 C29,42 50,26 75,26 C100,26 121,42 118,84 C118,62 102,48 75,48 C48,48 32,62 32,84 Z" fill="${hairColor}"/>` +
      `<path d="M40,58 C46,40 66,34 84,38 C98,41 106,50 108,60 C96,50 84,50 74,55 C62,61 50,62 40,58 Z" fill="${hairDark}"/>`
    : `<path d="M30,86 C27,38 50,22 75,22 C100,22 123,38 120,86 C118,60 102,46 75,46 C48,46 32,60 30,86 Z" fill="${hairColor}"/>` +
      `<path d="M38,54 C44,36 66,30 86,36 C98,40 106,48 108,58 C94,48 80,48 68,54 C56,60 46,62 38,54 Z" fill="${hairDark}"/>` +
      `<circle cx="108" cy="56" r="6.2" fill="${PINK}"/>` +
      `<path d="M108,54 C124,62 130,92 122,124 C118,140 106,142 108,126 C112,100 108,74 98,60 Z" fill="${hairDark}"/>`;

  return `<g transform="rotate(${tilt || 0} 75 80)">
    ${ear(36)}${ear(114)}
    <ellipse cx="75" cy="80" rx="40" ry="38" fill="${SKIN}"/>
    ${faceSVG(expr, pupil, gender)}
    ${hairBack}
  </g>`;
}

// ---------- body ----------
function bodySVG(gender, pose, armsV, legsV) {
  const isBoy = gender !== 'wanita';
  const sleeve = pose.torso === 'bath' ? SKIN : (isBoy ? SHIRT_B : SHIRT_G);
  const pants = isBoy ? PANTS : PANTS;
  const shoe = isBoy ? SHOE_B : SHOE_G;

  // legs behind torso
  const leg = (v, side) => {
    const [fx, fy, cx, cy] = v[side];
    const hipX = side === 'L' ? 65 : 85;
    return `<path d="M${hipX},164 Q${cx},${cy} ${fx},${fy}" stroke="${pants}" stroke-width="15" fill="none" stroke-linecap="round"/>` +
      `<ellipse cx="${fx + 2}" cy="${fy + 4}" rx="11" ry="6.5" fill="${shoe}"/><ellipse cx="${fx + 2}" cy="${fy + 6.5}" rx="11" ry="2.6" fill="#FFFFFF" opacity="0.75"/>`;
  };
  let legs = '';
  if (legsV === 'sit') {
    legs = `<path d="M62,166 Q58,182 66,190" stroke="${pants}" stroke-width="15" fill="none" stroke-linecap="round"/>` +
      `<path d="M88,166 Q92,182 84,190" stroke="${pants}" stroke-width="15" fill="none" stroke-linecap="round"/>` +
      `<ellipse cx="66" cy="192" rx="11" ry="6.5" fill="${shoe}"/><ellipse cx="84" cy="192" rx="11" ry="6.5" fill="${shoe}"/>`;
  } else {
    legs = leg(LEGS[legsV], 'L') + leg(LEGS[legsV], 'R');
  }
  if (legsV === 'tiptoe') {
    legs += `<g stroke="${GRAY}" stroke-width="2" stroke-linecap="round"><path d="M52,200 L58,197 M92,200 L98,197"/></g>`;
  }

  // torso
  let torso = '';
  if (pose.torso === 'bath') {
    const towel = isBoy ? '#7DD3FC' : '#F9A8D4';
    const towelD = isBoy ? '#38BDF8' : '#F472B6';
    torso = `<rect x="52" y="122" width="46" height="50" rx="16" fill="${SKIN}"/>` +
      `<path d="M48,146 L102,146 L100,170 L50,170 Z" fill="${towel}"/>` +
      `<path d="M48,152 L101,152" stroke="${towelD}" stroke-width="2" opacity="0.7"/>`;
  } else if (isBoy) {
    torso = `<rect x="50" y="120" width="50" height="52" rx="16" fill="${SHIRT_B}" stroke="#C6CDD9" stroke-width="1.6"/>` +
      `<path d="M67,121 L75,130 L83,121" stroke="#D3D9E3" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  } else {
    torso = `<rect x="50" y="120" width="50" height="52" rx="16" fill="${SHIRT_G}" stroke="#D9DCE3" stroke-width="1.6"/>` +
      `<path d="M63,124 L69,140 M87,124 L81,140" stroke="${PINK}" stroke-width="5" stroke-linecap="round"/>` +
      `<rect x="60" y="138" width="30" height="34" rx="7" fill="${PINK}"/>` +
      `<circle cx="66" cy="144" r="2.2" fill="#FBCFE8"/><circle cx="84" cy="144" r="2.2" fill="#FBCFE8"/>`;
  }

  // arms + hands
  const armDef = ARMS[armsV] || ARMS.down;
  const handR = armDef.big ? 7 : 6.2;
  const outlineC = pose.torso === 'bath' ? 'none' : (isBoy ? '#C6CDD9' : '#D9DCE3');
  const arm = (side) => {
    const [hx, hy, cx, cy] = armDef[side];
    const sx = side === 'L' ? 52 : 98;
    const sleeve = pose.torso === 'bath' ? SKIN : (isBoy ? SHIRT_B : SHIRT_G);
    if (outlineC === 'none') {
      return `<path d="M${sx},130 Q${cx},${cy} ${hx},${hy}" stroke="${sleeve}" stroke-width="13" fill="none" stroke-linecap="round"/>` +
        `<circle cx="${hx}" cy="${hy}" r="${handR}" fill="${SKIN}"/>`;
    }
    return `<path d="M${sx},130 Q${cx},${cy} ${hx},${hy}" stroke="${outlineC}" stroke-width="15.4" fill="none" stroke-linecap="round"/>` +
      `<path d="M${sx},130 Q${cx},${cy} ${hx},${hy}" stroke="${sleeve}" stroke-width="12.4" fill="none" stroke-linecap="round"/>` +
      `<circle cx="${hx}" cy="${hy}" r="${handR + 0.8}" fill="${outlineC}"/><circle cx="${hx}" cy="${hy}" r="${handR}" fill="${SKIN}"/>`;
  };
  let arms = arm('L') + arm('R');
  if (armDef.thumb === 'up') {
    arms += `<rect x="101" y="126" width="9" height="17" rx="4.5" fill="${SKIN}" transform="rotate(-14 105 134)"/>`;
  } else if (armDef.thumb === 'down') {
    arms += `<rect x="101" y="147" width="9" height="17" rx="4.5" fill="${SKIN}" transform="rotate(14 105 155)"/>`;
  } else if (armDef.palm) {
    const [hx, hy] = armDef.R;
    arms += `<g stroke="${SKIN_SH}" stroke-width="1.6" stroke-linecap="round"><path d="M${hx - 3},${hy - 4} L${hx - 3},${hy + 3}"/><path d="M${hx},${hy - 5} L${hx},${hy + 4}"/><path d="M${hx + 3},${hy - 4} L${hx + 3},${hy + 3}"/></g>`;
  }

  return `${legs}${torso}${arms}`;
}

// ---------- top-level ----------
function renderSVG(wordKey, gender) {
  const pose = POSES[wordKey];
  if (!pose) throw new Error(`No pose for word: ${wordKey}`);
  const scale = pose.scale || 1;
  const shift = pose.shift || 0;
  const transform = `translate(75 ${shift}) scale(${scale}) translate(-75 0)`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 220" width="150" height="220">
<g transform="${transform}">
${bodySVG(gender, pose, pose.arms, pose.legs)}
<rect x="68" y="110" width="14" height="16" rx="5" fill="${SKIN}"/>
${headSVG(gender, pose.tilt, pose.expr, pose.pupil)}
${extrasSVG(pose.extras, gender)}
</g>
</svg>`;
}

module.exports = { renderSVG, POSES, BOY_WORDS };
