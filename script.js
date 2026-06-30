/* ================================================================
   RELATIONSHIP OS — script.js  v2.0
   ----------------------------------------------------------------
   KEYBOARD SHORTCUTS:
     ↑ / ↓         → navigate cards
     N             → new contact modal
     C             → connect modal
     F             → toggle favorite
     Escape        → close modals
     Ctrl + Enter  → submit modal form

   TOUCH:
     Swipe up/down on card → navigate

   REAL-TIME MODES:
     1. FIREBASE MODE  — Full cross-device sync (configure below)
     2. LOCAL DEMO MODE — Same-device tab sync via localStorage events
        (works out-of-the-box without any Firebase config!)

   FEATURES:
     • Connect Code P2P system
     • Live location sharing (Leaflet + OpenStreetMap)
     • Real-time chat with typing indicators & read receipts
     • Relationship health score algorithm
     • Ping / check-in system
     • Shared memories timeline
     • Birthday alerts (7-day early warning)
     • Mood & live status sync
     • Push notifications (Service Worker)
================================================================ */

/* ================================================================
   ⦿  FIREBASE CONFIG
   ----------------------------------------------------------------
   Project:     relationshipos-42290
   Region:      asia-southeast1 (Singapore)
   DB URL:      https://relationshipos-42290-default-rtdb.asia-southeast1.firebasedatabase.app
   Rules:       Test mode (open read/write — tighten before production)
================================================================ */
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBk6I7G3AO3dAAzPj4C206q_GdlXCKLpjA',
  authDomain:        'relationshipos-42290.firebaseapp.com',
  databaseURL:       'https://relationshipos-42290-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId:         'relationshipos-42290',
  storageBucket:     'relationshipos-42290.firebasestorage.app',
  messagingSenderId: '27909586971',
  appId:             '1:27909586971:web:daa9b7805980f69e0478be'
};

// Runtime Firebase state — set to true only after db.ref() is confirmed
let isFirebaseLive = false;

// Firebase database reference (set in initFirebase)
let db = null;

// Rate limiting state
let lastMessageTime = 0;
let lastPingTime    = 0;
const MSG_RATE_MS   = 800;    // min ms between chat messages
const PING_COOLDOWN = 30000;  // min ms between pings

// Connection code TTL: 24 hours
const CODE_TTL_MS = 24 * 60 * 60 * 1000;

// Active Firebase listener refs — kept so we can detach them
const _fbListeners = {}; // key → {ref, cb}

// ── WebRTC calling state variables ──
let localStream = null;
let rtcPeerConn  = null;
let callRef      = null;
let callListener = null;
let isIncomingCallActive = false;
let callActiveRoomId = '';
const iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const activeCallListeners = {};
let activeLocationRef = null;

// ── User profile state ──
let myProfile = {
  name: '',
  username: '',
  bio: '',
  birthday: '',
  emergencyContact: '',
  favColor: '#f97316',
  photoUrl: ''
};

// ── Image downscaling helper (saves local base64/RTDB space under 10KB) ──
function downscaleImage(file, maxWidth, maxHeight, callback) {
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;
      if (width > height) {
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width = Math.round((width * maxHeight) / height);
          height = maxHeight;
        }
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      callback(dataUrl);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}



/* ================================================================
   1. DEFAULT CONTACTS  — EMPTY (no demo data)
   The app starts with zero contacts. Users add real people.
================================================================ */
// No default contacts — intentionally empty
// Keeping this comment block to preserve section numbering
const _PLACEHOLDER_REMOVED = true;

/*
    id: 3,
    name: 'Sara Chen',
    city: 'Toronto',
    mood: '😄',
    score: 91,
    birthday: 'Dec 3',
    lastTalk: 'Yesterday',
    lastTalkTimestamp: Date.now() - 864e5,
    category: 'Family',
    memory: "Sister's best friend, loves baking, studying medicine",
    note: 'Send her the recipe we talked about',
    reminder: 'Birthday next month — buy gift!',
    avatarColor: '#2dd4bf',
    imageUrl: '',
    isFavorite: false,
    linkedUid: null,
    checkIns: 5
  }
*/

/* ================================================================
   2. STATE
================================================================ */
let contacts      = [];
let currentIndex  = 0;
let isAnimating   = false;
let accentColor   = '#f97316';
let mediaRecorder = null;
let audioChunks   = [];
let isRecording   = false;
let recordingStream = null;
let recordingTimer  = null;
let recordingStartTime = 0;
const MAX_VOICE_MS    = 60000;
const MAX_VOICE_BYTES = 400000;

// New v2 state
let myUid         = '';          // persistent user ID
let myCode        = '';          // 6-char connect code
let myMood        = '😊';
let myStatus      = '';
let connections   = {};          // { uid: { code, name, online, mood, status } }
let locationInterval = null;     // setInterval handle for location updates
let isSharingLocation = false;
let leafletMapInstance = null;
let myMarker      = null;
let friendMarker  = null;
let isFollowingFriend = false;
let showPathHistory   = false;
let friendHistoryPolyline = null;
let myHistoryPolyline = null;
let lastUploadedLat   = null;
let lastUploadedLng   = null;
let lastUploadedTime  = 0;
let friendSavedPlacesMarkers = [];
let myLastPosition    = null; // For geotagging memories
let chatListeners = {};          // Firebase/demo listeners per roomId
let activeRoomId  = '';          // currently open chat room
let presenceListeners = {};      // Firebase presence listeners
let locationListeners = {};        // Firebase/demo location listeners

// Walkie-Talkie state
let walkieStream      = null;  // MediaStream for mic
let walkie_pc         = null;  // RTCPeerConnection
let walkieSendRef     = null;  // Firebase signaling ref (outgoing)
let walkieRecvRef     = null;  // Firebase signaling ref (incoming)
let walkieActive      = false;
let walkieAudioElem   = null;  // <audio> for received stream

// Chat unread badge
let chatUnreadCount   = 0;


/* ================================================================
   3. DOM REFERENCES
================================================================ */
// Card elements
const profileCard  = document.getElementById('profile-card');
const cardBack1    = document.getElementById('card-back-1');
const cardBack2    = document.getElementById('card-back-2');

// Profile card fields
const cardAvatar      = document.getElementById('card-avatar');
const cardName        = document.getElementById('card-name');
const cardCity        = document.getElementById('card-city');
const cardMood        = document.getElementById('card-mood');
const scoreNumber     = document.getElementById('score-number');
const scoreBarFill    = document.getElementById('score-bar-fill');
const cardBirthday    = document.getElementById('card-birthday');
const cardLastTalk    = document.getElementById('card-last-talk');
const cardCategory    = document.getElementById('card-category');
const cardMemory      = document.getElementById('card-memory');
const cardNote        = document.getElementById('card-note');
const cardReminder    = document.getElementById('card-reminder');
const onlineDot       = document.getElementById('online-dot');
const friendStatusText = document.getElementById('friend-status-text');
const birthdayBanner  = document.getElementById('birthday-banner');

// Control buttons
const btnAdd      = document.getElementById('btn-add');
const btnUp       = document.getElementById('btn-up');
const btnDown     = document.getElementById('btn-down');
const btnFavorite = document.getElementById('btn-favorite');
const btnMessage  = document.getElementById('btn-message');
const btnRemind   = document.getElementById('btn-remind');
const btnVoice    = document.getElementById('btn-voice');
const btnVoiceIcon = document.getElementById('btn-voice-icon');
const voiceRecordingBanner = document.getElementById('voice-recording-banner');
const locationShareBanner  = document.getElementById('location-share-banner');
const btnConnect  = document.getElementById('btn-connect');
const btnWalkie   = document.getElementById('btn-walkie');
const chatUnreadBadge = document.getElementById('chat-unread-badge');

// Connect modal variables
const connectModalOverlay  = document.getElementById('connect-modal-overlay');
const btnCloseConnectModal = document.getElementById('btn-close-connect-modal');
const inputFriendCode      = document.getElementById('input-friend-code');
const btnDoConnect         = document.getElementById('btn-do-connect');

// Live feature buttons
const btnLocation = document.getElementById('btn-location');
const btnPing     = document.getElementById('btn-ping');
const btnMemories = document.getElementById('btn-memories');

// Existing modal
const modalOverlay  = document.getElementById('modal-overlay');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnCreateNote = document.getElementById('btn-create-note');
const inputImageUrl = document.getElementById('input-image-url');
const inputFullName = document.getElementById('input-full-name');
const inputHomeTown = document.getElementById('input-home-town');
const inputPurpose  = document.getElementById('input-purpose');
const inputBirthdayModal = document.getElementById('input-birthday-modal');
const chkEmergency  = document.getElementById('chk-emergency');
const chkImportant  = document.getElementById('chk-important');
const chkUrgent     = document.getElementById('chk-urgent');
const chkNoRush     = document.getElementById('chk-no-rush');

// Swatches
const allSwatches = document.querySelectorAll('.swatch');

// My code pill & Profile
const myCodeValue    = document.getElementById('my-code-value');
const myCodeCopyBtn  = document.getElementById('my-code-copy-btn');
const btnCopyBigCode = document.getElementById('btn-copy-big-code');
const btnSaveMood    = document.getElementById('btn-save-mood');
const connectCodeBig = document.getElementById('connect-code-big');
const inputStatusText = document.getElementById('input-status-text');
const connectionsList = document.getElementById('connections-list');
// Chat drawer
const chatOverlay       = document.getElementById('chat-overlay');
const chatDrawer        = document.getElementById('chat-drawer');
const btnCloseChat      = document.getElementById('btn-close-chat');
const chatAvatarMini    = document.getElementById('chat-avatar-mini');
const chatContactName   = document.getElementById('chat-contact-name');
const chatTypingLine    = document.getElementById('chat-typing-line');
const chatMessagesArea  = document.getElementById('chat-messages-area');
const chatInputField    = document.getElementById('chat-input-field');
const btnSendMsg        = document.getElementById('btn-send-msg');

// Location modal
const locationModalOverlay = document.getElementById('location-modal-overlay');
const btnCloseLocationX    = document.getElementById('btn-close-location-x');
const btnCloseLocationModal = document.getElementById('btn-close-location-modal');
const shareDurationSelect  = document.getElementById('share-duration-select');
const btnShareLocation     = document.getElementById('btn-share-location');
const btnStopSharing       = document.getElementById('btn-stop-sharing');
const friendLocText        = document.getElementById('friend-loc-text');
const friendLastSeenRow    = document.getElementById('friend-last-seen-row');
const friendLastSeenText   = document.getElementById('friend-last-seen-text');
const mySharingRow         = document.getElementById('my-sharing-row');
const sharingUntilText     = document.getElementById('sharing-until-text');

// Redesigned Location Modal Elements
const btnMapMyLoc          = document.getElementById('btn-map-my-loc');
const btnMapFriendLoc      = document.getElementById('btn-map-friend-loc');
const btnMapFitBoth        = document.getElementById('btn-map-fit-both');
const btnMapFollow         = document.getElementById('btn-map-follow');
const btnMapHistory        = document.getElementById('btn-map-history');
const mapStatusBanner      = document.getElementById('map-status-banner');
const mapBottomSheet       = document.getElementById('map-bottom-sheet');
const bottomSheetHandle    = document.getElementById('bottom-sheet-handle');
const bottomSheetHeader    = document.getElementById('bottom-sheet-header');
const btnSheetNav          = document.getElementById('btn-sheet-nav');
const btnSheetCall         = document.getElementById('btn-sheet-call');
const btnSheetChat         = document.getElementById('btn-sheet-chat');
const btnSheetFollowToggle = document.getElementById('btn-sheet-follow-toggle');
const btnSheetFollowText   = document.getElementById('btn-sheet-follow-text');
const btnSheetProfile      = document.getElementById('btn-sheet-profile');
const btnSaveCurrentPlace  = document.getElementById('btn-save-current-place');
const savedPlacesList      = document.getElementById('saved-places-list');
const nearbyMemoriesList   = document.getElementById('nearby-memories-list');
const savePlaceModalOverlay= document.getElementById('save-place-modal-overlay');
const btnCancelSavePlace   = document.getElementById('btn-cancel-save-place');
const btnConfirmSavePlace  = document.getElementById('btn-confirm-save-place');
const inputPlaceName       = document.getElementById('input-place-name');
const selectPlaceType      = document.getElementById('select-place-type');

// Memories modal
const memoriesModalOverlay = document.getElementById('memories-modal-overlay');
const btnCloseMemoriesX    = document.getElementById('btn-close-memories-x');
const btnCloseMemoriesModal = document.getElementById('btn-close-memories-modal');
const inputNewMemory       = document.getElementById('input-new-memory');
const btnAddMemory         = document.getElementById('btn-add-memory');
const memoriesScroll       = document.getElementById('memories-scroll');


/* ================================================================
   4. UTILITY HELPERS
================================================================ */

const sleep = ms => new Promise(res => setTimeout(res, ms));

function wrap(index, len) {
  return ((index % len) + len) % len;
}

function getCheckedCategory() {
  if (chkEmergency.checked) return 'Emergency';
  if (chkImportant.checked) return 'Important';
  if (chkUrgent.checked)    return 'Urgent';
  if (chkNoRush.checked)    return 'No Rush';
  return 'General';
}

function popAnimation(el, scale = 1.08) {
  el.style.transition = 'transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)';
  el.style.transform  = `scale(${scale})`;
  setTimeout(() => {
    el.style.transform = 'scale(1)';
    setTimeout(() => { el.style.transition = ''; }, 280);
  }, 280);
}

/** Generate a random 6-char uppercase alphanumeric string */
function generateCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < len; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/** Generate a UUID v4 (persistent user ID) */
function generateUid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/** Sort two strings and join them to form a stable room ID */
function makeRoomId(uid1, uid2) {
  return [uid1, uid2].sort().join('__');
}

/** Format a Unix timestamp as a human-readable "time ago" string */
function timeAgo(ts) {
  if (!ts) return '—';
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 30)  return 'just now';
  if (secs < 60)  return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Format a timestamp as HH:MM */
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Check if a birthday string is within N days from today */
function isBirthdayWithinDays(birthdayStr, days) {
  if (!birthdayStr || birthdayStr === '—') return false;
  const months = {
    jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
    jul:6, aug:7, sep:8, oct:9, nov:10, dec:11
  };
  const lower = birthdayStr.toLowerCase();
  const monthKey = Object.keys(months).find(m => lower.includes(m));
  if (!monthKey) return false;
  const day = parseInt(birthdayStr.replace(/[^0-9]/g, ''));
  if (!day) return false;

  const today    = new Date();
  const thisYear = today.getFullYear();
  let bday       = new Date(thisYear, months[monthKey], day);
  // If already passed this year, check next year
  if (bday < today) bday.setFullYear(thisYear + 1);
  const diff = (bday - today) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= days;
}

/** Days until birthday (returns null if no birthday set) */
function daysUntilBirthday(birthdayStr) {
  if (!birthdayStr || birthdayStr === '—') return null;
  const months = {
    jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
    jul:6, aug:7, sep:8, oct:9, nov:10, dec:11
  };
  const lower = birthdayStr.toLowerCase();
  const monthKey = Object.keys(months).find(m => lower.includes(m));
  if (!monthKey) return null;
  const day = parseInt(birthdayStr.replace(/[^0-9]/g, ''));
  if (!day) return null;

  const today    = new Date();
  const thisYear = today.getFullYear();
  let bday       = new Date(thisYear, months[monthKey], day);
  if (bday < today) bday.setFullYear(thisYear + 1);
  return Math.ceil((bday - today) / (1000 * 60 * 60 * 24));
}

/** Reverse geocode lat/lng → human-readable address via OSM Nominatim (free, no key) */
async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const data = await res.json();
    const a    = data.address || {};
    const place = a.city || a.town || a.village || a.suburb || a.county;
    const country = a.country;
    if (place && country) return `${place}, ${country}`;
    return (data.display_name || '').split(',').slice(0, 2).join(',').trim()
           || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}


/* ================================================================
   5. LOCAL STORAGE — save & load contacts
================================================================ */
function saveContacts() {
  try {
    localStorage.setItem('ros_contacts', JSON.stringify(contacts));
    localStorage.setItem('ros_index', String(currentIndex));
  } catch (e) {
    console.warn('Could not save to localStorage:', e);
  }
}

function loadContacts() {
  try {
    const stored = localStorage.getItem('ros_contacts');
    contacts = stored ? JSON.parse(stored) : [];
    // Migrate existing contacts that lack new fields
    contacts.forEach(c => {
      if (c.linkedUid === undefined) c.linkedUid = null;
      if (c.checkIns  === undefined) c.checkIns  = 0;
      if (!c.lastTalkTimestamp)      c.lastTalkTimestamp = Date.now() - 2 * 864e5;
      if (!c.id) c.id = Date.now() + Math.random();
    });
    const savedIndex = parseInt(localStorage.getItem('ros_index') || '0', 10);
    currentIndex = contacts.length > 0 ? wrap(savedIndex, contacts.length) : 0;
  } catch (e) {
    console.warn('loadContacts failed, starting empty:', e);
    contacts = [];
    currentIndex = 0;
  }
}

function deleteCurrentContact() {
  if (contacts.length === 0) return;
  const c = contacts[currentIndex];
  if (!c) return;
  
  if (confirm(`🗑️ Delete contact card for "${c.name || 'this contact'}"? This will remove them from your list.`)) {
    contacts.splice(currentIndex, 1);
    saveContacts();
    
    // Adjust index
    if (contacts.length === 0) {
      currentIndex = 0;
    } else {
      currentIndex = wrap(currentIndex, contacts.length);
    }
    
    renderCard(contacts[currentIndex] || null);
    renderBackCards();
    showToast('🗑️ Card deleted', 'info');
  }
}

function createNewContact() {
  const name = prompt("Enter contact name:");
  if (!name || !name.trim()) return;

  const newContact = {
    id:               Date.now() + Math.random(),
    name:             name.trim(),
    city:             'Unknown Town',
    mood:             '😊',
    score:            50,
    birthday:         '—',
    lastTalk:         'Never',
    lastTalkTimestamp: 0,
    category:         'Friend',
    memory:           'No memory added yet.',
    note:             'No notes yet.',
    reminder:         'No reminder set.',
    avatarColor:      '#f97316',
    imageUrl:         '',
    isFavorite:       false,
    linkedUid:        null,
    checkIns:         0
  };

  contacts.push(newContact);
  saveContacts();
  currentIndex = contacts.length - 1;
  renderCard(contacts[currentIndex]);
  renderBackCards();
  showToast(`➕ Contact "${name.trim()}" created!`, 'success');
}



/* ================================================================
   6. RENDER FUNCTIONS
================================================================ */

function renderCard(contact) {
  if (!contact) {
    // Show empty-state on the card
    cardName.textContent     = '—';
    cardCity.textContent     = '📍 No contact';
    cardMood.textContent     = '😐';
    cardBirthday.textContent = '—';
    cardLastTalk.textContent = '—';
    cardCategory.textContent = '—';
    cardMemory.textContent   = 'Add your first contact with the + button';
    cardNote.textContent     = '';
    cardReminder.textContent = '';
    scoreNumber.textContent  = '—';
    scoreBarFill.style.width = '0%';
    birthdayBanner.style.display = 'none';
    cardAvatar.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 12c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0 2c-3.33 0-10 1.67-10 5v2h20v-2c0-3.33-6.67-5-10-5z"/></svg>`;
    cardAvatar.style.backgroundColor = '#d1d5db';
    return;
  }

  // ── Avatar ──
  if (contact.imageUrl) {
    cardAvatar.innerHTML = `<img
      src="${contact.imageUrl}"
      alt="${contact.name}"
      onerror="this.outerHTML='<span style=\\'font-size:22px;\\'>👤</span>'"
    />`;
  } else {
    cardAvatar.innerHTML = `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 12c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0 2c-3.33 0-10 1.67-10 5v2h20v-2c0-3.33-6.67-5-10-5z"/>
      </svg>`;
  }
  cardAvatar.style.backgroundColor = contact.avatarColor || '#f97316';

  // ── Text fields ──
  cardName.textContent     = contact.name     || '—';
  cardCity.textContent     = '📍 ' + (contact.city || 'Unknown');
  cardMood.textContent     = contact.mood     || '😐';
  cardBirthday.textContent = contact.birthday || '—';
  cardLastTalk.textContent = contact.lastTalk || '—';
  cardCategory.textContent = contact.category || '—';
  cardMemory.textContent   = contact.memory   || 'No memory added yet.';
  cardNote.textContent     = contact.note     || 'No notes yet.';
  cardReminder.textContent = contact.reminder || 'No reminder set.';

  // ── Score (health algorithm) ──
  const computedScore = calculateHealthScore(contact);
  contact.score = computedScore;
  const score = Math.min(100, Math.max(0, computedScore));
  scoreNumber.textContent  = score;
  scoreBarFill.style.width = '0%';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scoreBarFill.style.width = score + '%';
    });
  });

  const col = contact.avatarColor || '#f97316';
  scoreBarFill.style.background = `linear-gradient(90deg, ${col}, #f59e0b)`;

  // ── Favorite ──
  btnFavorite.textContent = contact.isFavorite ? '⭐' : '☆';
  btnFavorite.classList.toggle('active', !!contact.isFavorite);

  // ── Birthday alert banner ──
  const daysLeft = daysUntilBirthday(contact.birthday);
  if (daysLeft !== null && daysLeft <= 7) {
    birthdayBanner.style.display = 'block';
    birthdayBanner.textContent   = daysLeft === 0
      ? `🎉 Today is ${contact.name.split(' ')[0]}'s Birthday! Don't forget to wish them!`
      : `🎂 ${contact.name.split(' ')[0]}'s birthday is in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}!`;
  } else {
    birthdayBanner.style.display = 'none';
  }

  // ── Online status dot & friend live status ──
  refreshPresenceUI(contact);

  // Update chat drawer avatar color if open
  if (chatOverlay.classList.contains('active')) {
    chatAvatarMini.style.background = contact.avatarColor || '#f97316';
  }
}

function refreshPresenceUI(contact) {
  if (!contact) return;

  const locBtn = document.getElementById('btn-location');
  const locLabel = locBtn?.querySelector('.live-btn-label');

  if (contact.linkedUid) {
    const conn = connections[contact.linkedUid];
    if (conn) {
      onlineDot.classList.add('visible');
      if (conn.online) {
        onlineDot.classList.add('is-online');
        onlineDot.classList.remove('is-offline');
        onlineDot.title = 'Online';
      } else {
        onlineDot.classList.add('is-offline');
        onlineDot.classList.remove('is-online');
        onlineDot.title = 'Offline';
      }

      const parts = [];
      if (conn.onCall) {
        parts.push('📞 In a call');
      }
      if (conn.location && conn.location.sharing) {
        parts.push('📍 Sharing live location');
      }
      if (conn.mood)   parts.push(conn.mood);
      if (conn.status) parts.push(conn.status);
      if (parts.length) {
        friendStatusText.textContent = parts.join(' · ');
        friendStatusText.classList.add('visible');
      } else {
        friendStatusText.textContent = '';
        friendStatusText.classList.remove('visible');
      }

      const friendSharing = !!(conn.location && conn.location.sharing);

      if (locBtn) {
        if (friendSharing) {
          locBtn.classList.add('location-active');
          locBtn.title = `${contact.name.split(' ')[0]} is sharing live location — tap to view`;
          if (locLabel) locLabel.textContent = 'Live!';
        } else if (!isSharingLocation) {
          locBtn.classList.remove('location-active');
          locBtn.title = 'Live Location';
          if (locLabel) locLabel.textContent = 'Location';
        }
      }

      if (locationShareBanner) {
        if (friendSharing) {
          const firstName = contact.name.split(' ')[0];
          locationShareBanner.style.display = 'block';
          locationShareBanner.innerHTML = `📍 <b>${firstName}</b> is sharing live location — tap <b>Live!</b> to view`;
        } else {
          locationShareBanner.style.display = 'none';
        }
      }
    } else {
      onlineDot.classList.remove('visible', 'is-online', 'is-offline');
      friendStatusText.textContent = '';
      if (locBtn && !isSharingLocation) {
        locBtn.classList.remove('location-active');
        locBtn.title = 'Live Location';
        if (locLabel) locLabel.textContent = 'Location';
      }
      if (locationShareBanner) locationShareBanner.style.display = 'none';
    }
  } else {
    onlineDot.classList.remove('visible', 'is-online', 'is-offline');
    friendStatusText.textContent = '';
    if (locBtn && !isSharingLocation) {
      locBtn.classList.remove('location-active');
      locBtn.title = 'Live Location';
      if (locLabel) locLabel.textContent = 'Location';
    }
    if (locationShareBanner) locationShareBanner.style.display = 'none';
  }
}

function renderBackCards() {
  const total = contacts.length;
  if (total < 2) {
    cardBack1.style.opacity = '0';
    cardBack1.style.pointerEvents = 'none';
    cardBack2.style.opacity = '0';
    cardBack2.style.pointerEvents = 'none';
    return;
  }

  const next1 = contacts[wrap(currentIndex + 1, total)];
  cardBack1.style.opacity = '1';
  cardBack1.style.pointerEvents = 'auto';
  cardBack1.style.background = hexToSoft(next1?.avatarColor || '#e0e0e0');

  if (total > 2) {
    const next2 = contacts[wrap(currentIndex + 2, total)];
    cardBack2.style.opacity = '1';
    cardBack2.style.pointerEvents = 'auto';
    cardBack2.style.background = hexToSoft(next2?.avatarColor || '#d0d0d0');
  } else {
    cardBack2.style.opacity = '0';
    cardBack2.style.pointerEvents = 'none';
  }
}

function hexToSoft(hex) {
  try {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const mix = c => Math.round(c + (255 - c) * 0.60);
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  } catch {
    return '#e0e0e0';
  }
}


/* ================================================================
   7. NAVIGATION  (↑ ↓ buttons)
================================================================ */
async function navigate(direction) {
  if (isAnimating || contacts.length === 0) return;
  isAnimating = true;

  profileCard.classList.add('card-flipping-out');
  await sleep(200);

  currentIndex = direction === 'next'
    ? wrap(currentIndex + 1, contacts.length)
    : wrap(currentIndex - 1, contacts.length);

  saveContacts();
  renderCard(contacts[currentIndex]);
  renderBackCards();

  profileCard.classList.remove('card-flipping-out');
  profileCard.classList.add('card-flipping-in');
  await sleep(400);

  profileCard.classList.remove('card-flipping-in');
  isAnimating = false;
}


/* ================================================================
   8. WALLET SWAP  (clicking back card brings it to front)
================================================================ */
async function walletSwap(clickedCard, stepsForward) {
  if (isAnimating || contacts.length < 2) return;
  isAnimating = true;

  const EASE     = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';
  const DURATION = 350;
  const t = `transform ${DURATION}ms ${EASE}, background ${DURATION}ms ease, box-shadow ${DURATION}ms ease`;

  clickedCard.style.transition = t;
  clickedCard.style.transform  = 'translateY(-20px) scale(1.05) rotateY(15deg)';
  clickedCard.style.zIndex     = '10';

  profileCard.style.transition = t;
  profileCard.style.transform  = 'translateY(20px) scale(0.9) rotateY(-15deg)';
  profileCard.style.zIndex     = '1';

  await sleep(DURATION + 50);

  currentIndex = wrap(currentIndex + stepsForward, contacts.length);
  saveContacts();

  [profileCard, cardBack1, cardBack2].forEach(el => { el.style.cssText = ''; });

  renderCard(contacts[currentIndex]);
  renderBackCards();

  profileCard.classList.add('card-flipping-in');
  await sleep(400);
  profileCard.classList.remove('card-flipping-in');

  isAnimating = false;
}


/* ================================================================
   9. MY PROFILE MODAL — load / save / edit profile
================================================================ */
function loadMyProfile() {
  try {
    const saved = localStorage.getItem('ros_my_profile');
    if (saved) {
      myProfile = JSON.parse(saved);
    }
  } catch (e) {
    console.warn('Failed to load profile:', e);
  }
}

function saveMyProfile() {
  localStorage.setItem('ros_my_profile', JSON.stringify(myProfile));
  
  // Update accent color from profile theme
  if (myProfile.favColor) {
    accentColor = myProfile.favColor;
  }

  // Write profile details to Firebase
  if (db && isFirebaseLive) {
    db.ref(`users/${myUid}`).update({
      name:             myProfile.name || '',
      username:         myProfile.username || '',
      bio:              myProfile.bio || '',
      birthday:         myProfile.birthday || '',
      emergencyContact: myProfile.emergencyContact || '',
      favColor:         myProfile.favColor || '#f97316',
      photoUrl:         myProfile.photoUrl || ''
    }).then(() => {
      console.log('✅ My Profile synced to Firebase');
    }).catch(err => {
      console.error('❌ Profile sync failed:', err);
    });
  }
}

function openProfileModal() {
  loadMyProfile();
  
  // Set form fields
  inputFullName.value = myProfile.name || '';
  document.getElementById('input-username').value = myProfile.username || '';
  document.getElementById('input-bio').value = myProfile.bio || '';
  inputBirthdayModal.value = myProfile.birthday || '';
  document.getElementById('input-emergency-contact').value = myProfile.emergencyContact || '';
  document.getElementById('input-fav-color').value = myProfile.favColor || '#f97316';
  inputImageUrl.value = myProfile.photoUrl || '';
  
  // Update circular preview container
  updateProfilePhotoPreview(myProfile.photoUrl);
  
  document.getElementById('profile-modal-overlay').classList.add('active');
  setTimeout(() => inputFullName.focus(), 80);
}

function closeProfileModal() {
  document.getElementById('profile-modal-overlay').classList.remove('active');
}

function submitProfile() {
  myProfile.name             = inputFullName.value.trim();
  myProfile.username         = document.getElementById('input-username').value.trim();
  myProfile.bio              = document.getElementById('input-bio').value.trim();
  myProfile.birthday         = inputBirthdayModal.value.trim();
  myProfile.emergencyContact = document.getElementById('input-emergency-contact').value.trim();
  myProfile.favColor         = document.getElementById('input-fav-color').value;
  myProfile.photoUrl         = inputImageUrl.value.trim();
  
  saveMyProfile();
  closeProfileModal();
  showToast('✅ Profile saved & synced!', 'success');
}

function updateProfilePhotoPreview(url) {
  const preview = document.getElementById('profile-photo-preview');
  if (!preview) return;
  if (url) {
    preview.innerHTML = '';
    preview.style.backgroundImage = `url(${url})`;
    preview.style.backgroundSize = 'cover';
    preview.style.backgroundPosition = 'center';
    preview.style.borderStyle = 'solid';
  } else {
    preview.innerHTML = '👤';
    preview.style.backgroundImage = '';
    preview.style.borderStyle = 'dashed';
  }
}

/** Updates a local contact card dynamically when a connected friend changes their profile */
function updateContactCardFromFriendData(friendUid, data) {
  const c = contacts.find(contact => contact.linkedUid === friendUid);
  if (c) {
    let changed = false;
    if (data.name && c.name !== data.name) { c.name = data.name; changed = true; }
    if (data.photoUrl && c.imageUrl !== data.photoUrl) { c.imageUrl = data.photoUrl; changed = true; }
    if (data.bio && c.city !== data.bio) { c.city = data.bio; changed = true; }
    if (data.mood && c.mood !== data.mood) { c.mood = data.mood; changed = true; }
    if (data.birthday && c.birthday !== data.birthday) { c.birthday = data.birthday; changed = true; }
    if (data.favColor && c.avatarColor !== data.favColor) { c.avatarColor = data.favColor; changed = true; }
    if (data.emergencyContact) {
      const em = 'Emergency: ' + data.emergencyContact;
      if (c.reminder !== em) { c.reminder = em; changed = true; }
    }
    
    if (changed) {
      saveContacts();
      if (contacts[currentIndex] && contacts[currentIndex].linkedUid === friendUid) {
        renderCard(contacts[currentIndex]);
      }
      renderBackCards();
    }
  }
}



/* ================================================================
   10. FAVORITE TOGGLE
================================================================ */
function toggleFavorite() {
  const c = contacts[currentIndex];
  if (!c) return;
  c.isFavorite = !c.isFavorite;
  btnFavorite.textContent = c.isFavorite ? '⭐' : '☆';
  btnFavorite.classList.toggle('active', c.isFavorite);
  popAnimation(btnFavorite, 1.45);
  saveContacts();
}


/* ================================================================
   11. COLOR SWATCHES
================================================================ */
function applySwatchColor(swatchEl) {
  const rgb = getComputedStyle(swatchEl).backgroundColor.match(/\d+/g);
  if (!rgb) return;
  const hex = '#' + rgb.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
  accentColor = hex;

  const c = contacts[currentIndex];
  if (c) {
    c.avatarColor = hex;
    cardAvatar.style.backgroundColor = hex;
    scoreBarFill.style.background = `linear-gradient(90deg, ${hex}, #f59e0b)`;
    saveContacts();
    renderBackCards();
  }

  allSwatches.forEach(s => {
    s.style.outline = 'none';
    s.style.outlineOffset = '';
    s.style.transform = '';
  });
  swatchEl.style.outline       = `2.5px solid ${hex}`;
  swatchEl.style.outlineOffset = '2.5px';
  swatchEl.style.transform     = 'scale(1.25)';
}


/* ================================================================
   12. WEBRTC VOICE CALL
================================================================ */
function handleCall() {
  const c = contacts[currentIndex];
  if (!c) return;

  if (!c.linkedUid) {
    showToast('💡 Link this contact first to call', 'info');
    return;
  }

  // Toggle call state
  if (callActiveRoomId) {
    endCurrentCall();
  } else {
    startOutgoingCall(c.linkedUid);
  }
}

function initCallSignalling(roomId) {
  if (!db || !isFirebaseLive) {
    showToast('⚠️ Firebase offline — WebRTC voice call requires live connection', 'warn');
    return;
  }

  callActiveRoomId = roomId;
  callRef = db.ref(`rooms/${roomId}/call`);
  
  // Listen to call status changes
  callListener = callRef.on('value', async snap => {
    const callData = snap.val();
    if (!callData) return;

    if (callData.status === 'ringing') {
      if (callData.callerUid !== myUid && !isIncomingCallActive) {
        // Incoming call!
        showIncomingCallOverlay(callData.callerName || 'Your friend', roomId);
      }
    } else if (callData.status === 'connected') {
      // Remote accepted the call!
      if (callData.callerUid === myUid && rtcPeerConn) {
        // Set remote SDP answer if we're the caller
        if (callData.answer && rtcPeerConn.signalingState !== 'stable') {
          try {
            await rtcPeerConn.setRemoteDescription(new RTCSessionDescription(callData.answer));
            console.log('✅ WebRTC: Remote description (answer) set successfully');
          } catch (e) {
            console.error('Failed to set remote answer:', e);
          }
        }
      }
      updateCallUI('connected');
    } else if (callData.status === 'ended') {
      cleanupCall();
    }
  });

  // Listen to candidates
  db.ref(`rooms/${roomId}/call/candidates`).on('child_added', snap => {
    const candidate = snap.val();
    if (candidate && rtcPeerConn && candidate.senderUid !== myUid) {
      rtcPeerConn.addIceCandidate(new RTCIceCandidate(candidate.ice))
        .catch(e => console.warn('Failed to add ICE candidate:', e));
    }
  });
}

function showIncomingCallOverlay(callerName, roomId) {
  isIncomingCallActive = true;
  document.getElementById('call-subtitle-incoming').textContent = `${callerName} is calling you...`;
  document.getElementById('incoming-call-overlay').style.display = 'flex';
  
  // Play ringtone
  const ringtone = document.getElementById('ringtone-audio');
  if (ringtone) {
    ringtone.play().catch(() => {});
  }
}

function hideIncomingCallOverlay() {
  isIncomingCallActive = false;
  document.getElementById('incoming-call-overlay').style.display = 'none';
  const ringtone = document.getElementById('ringtone-audio');
  if (ringtone) {
    ringtone.pause();
    ringtone.currentTime = 0;
  }
}

async function acceptCall() {
  hideIncomingCallOverlay();
  showToast('📞 Connecting WebRTC...', 'info');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Create RTCPeerConnection
    rtcPeerConn = new RTCPeerConnection(iceConfig);
    localStream.getTracks().forEach(track => rtcPeerConn.addTrack(track, localStream));

    // Handle remote track
    rtcPeerConn.ontrack = e => {
      const remoteAudio = document.getElementById('remote-audio');
      if (remoteAudio) remoteAudio.srcObject = e.streams[0];
    };

    // Candidate handling
    rtcPeerConn.onicecandidate = e => {
      if (e.candidate && db && isFirebaseLive && callActiveRoomId) {
        db.ref(`rooms/${callActiveRoomId}/call/candidates`).push({
          senderUid: myUid,
          ice: e.candidate.toJSON()
        });
      }
    };

    // Set offer
    const snap = await db.ref(`rooms/${callActiveRoomId}/call/offer`).once('value');
    const offer = snap.val();
    await rtcPeerConn.setRemoteDescription(new RTCSessionDescription(offer));

    // Create answer
    const answer = await rtcPeerConn.createAnswer();
    await rtcPeerConn.setLocalDescription(answer);

    // Write answer & update status
    await db.ref(`rooms/${callActiveRoomId}/call`).update({
      answer: { sdp: answer.sdp, type: answer.type },
      status: 'connected'
    });

    updateCallUI('connected');

  } catch (err) {
    console.error('Failed to accept call:', err);
    declineCall();
  }
}

async function declineCall() {
  hideIncomingCallOverlay();
  if (db && isFirebaseLive && callActiveRoomId) {
    db.ref(`rooms/${callActiveRoomId}/call`).update({ status: 'ended' });
  }
  cleanupCall();
}

async function startOutgoingCall(friendUid) {
  const roomId = makeRoomId(myUid, friendUid);
  callActiveRoomId = roomId;
  
  showToast('📞 Initiating voice call...', 'info');
  updateCallUI('ringing');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    rtcPeerConn = new RTCPeerConnection(iceConfig);
    localStream.getTracks().forEach(track => rtcPeerConn.addTrack(track, localStream));

    rtcPeerConn.ontrack = e => {
      const remoteAudio = document.getElementById('remote-audio');
      if (remoteAudio) remoteAudio.srcObject = e.streams[0];
    };

    rtcPeerConn.onicecandidate = e => {
      if (e.candidate && db && isFirebaseLive) {
        db.ref(`rooms/${roomId}/call/candidates`).push({
          senderUid: myUid,
          ice: e.candidate.toJSON()
        });
      }
    };

    // Create offer
    const offer = await rtcPeerConn.createOffer();
    await rtcPeerConn.setLocalDescription(offer);

    // Initialise call node in database
    await db.ref(`rooms/${roomId}/call`).set({
      offer: { sdp: offer.sdp, type: offer.type },
      status: 'ringing',
      callerUid: myUid,
      callerName: myProfile.name || myCode,
      timestamp: Date.now()
    });

    // Start listening
    initCallSignalling(roomId);

  } catch (err) {
    console.error('Failed to start call:', err);
    showToast('❌ Call failed: Microphones permissions denied', 'error');
    cleanupCall();
  }
}

function endCurrentCall() {
  if (db && isFirebaseLive && callActiveRoomId) {
    db.ref(`rooms/${callActiveRoomId}/call`).update({ status: 'ended' });
  }
  cleanupCall();
}

function cleanupCall() {
  updateCallUI('idle');
  hideIncomingCallOverlay();
  
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (rtcPeerConn) {
    rtcPeerConn.close();
    rtcPeerConn = null;
  }
  if (callRef) {
    callRef.off();
    callRef = null;
  }
  if (callActiveRoomId && db && isFirebaseLive) {
    db.ref(`rooms/${callActiveRoomId}/call/candidates`).off();
    // Clean up call database node
    db.ref(`rooms/${callActiveRoomId}/call`).remove();
  }
  callActiveRoomId = '';
  
  const remoteAudio = document.getElementById('remote-audio');
  if (remoteAudio) remoteAudio.srcObject = null;
}

function updateCallUI(state) {
  const callBtn = document.getElementById('btn-call-contact');
  if (!callBtn) return;

  // Preserve base classes, only toggle state modifiers
  callBtn.classList.remove('ringing-state', 'active-state');

  const toyIcon = callBtn.querySelector('.action-icon-toy');
  const btnLabel = callBtn.querySelector('span');

  if (state === 'ringing') {
    callBtn.classList.add('ringing-state');
    if (toyIcon) toyIcon.textContent = '🔔';
    if (btnLabel) btnLabel.textContent = 'Ringing…';
    if (db && isFirebaseLive) {
      db.ref(`users/${myUid}`).update({ onCall: true }).catch(() => {});
    }
  } else if (state === 'connected') {
    callBtn.classList.add('active-state');
    if (toyIcon) toyIcon.textContent = '📞';
    if (btnLabel) btnLabel.textContent = 'In Call';
    if (db && isFirebaseLive) {
      db.ref(`users/${myUid}`).update({ onCall: true }).catch(() => {});
    }
  } else {
    if (toyIcon) {
      toyIcon.textContent = '📞';
    } else {
      callBtn.innerHTML = `<div class="action-icon-toy action-toy-green">📞</div><span>Call</span>`;
      return;
    }
    if (btnLabel) btnLabel.textContent = 'Call';
    if (db && isFirebaseLive) {
      db.ref(`users/${myUid}`).update({ onCall: false }).catch(() => {});
    }
  }
}

function subscribeToCallSignalling(roomId) {
  if (activeCallListeners[roomId]) return;
  if (!db || !isFirebaseLive) return;

  const ref = db.ref(`rooms/${roomId}/call`);
  const cb = snap => {
    const callData = snap.val();
    if (!callData) {
      if (callActiveRoomId === roomId && isIncomingCallActive) {
        hideIncomingCallOverlay();
      }
      return;
    }

    if (callData.status === 'ringing') {
      if (callData.callerUid !== myUid && !isIncomingCallActive && !rtcPeerConn) {
        callActiveRoomId = roomId;
        showIncomingCallOverlay(callData.callerName || 'Your friend', roomId);
      }
    } else if (callData.status === 'connected') {
      if (callData.callerUid === myUid && rtcPeerConn) {
        if (callData.answer && rtcPeerConn.signalingState !== 'stable') {
          rtcPeerConn.setRemoteDescription(new RTCSessionDescription(callData.answer))
            .catch(e => console.error('Failed to set remote answer:', e));
        }
      }
      updateCallUI('connected');
    } else if (callData.status === 'ended') {
      if (callActiveRoomId === roomId) {
        cleanupCall();
      }
    }
  };

  ref.on('value', cb);
  activeCallListeners[roomId] = { ref, cb };

  // Listen to candidates
  const candRef = db.ref(`rooms/${roomId}/call/candidates`);
  const candCb = snap => {
    const candidate = snap.val();
    if (candidate && rtcPeerConn && candidate.senderUid !== myUid && callActiveRoomId === roomId) {
      rtcPeerConn.addIceCandidate(new RTCIceCandidate(candidate.ice))
        .catch(e => console.warn('Failed to add ICE candidate:', e));
    }
  };
  candRef.on('child_added', candCb);
  activeCallListeners[roomId + '_candidates'] = { ref: candRef, cb: candCb };
}



/* ================================================================
   13. MESSAGE — always opens in-app chat drawer
================================================================ */
function handleMessage() {
  const c = contacts[currentIndex];
  if (!c) return;
  openChatDrawer(c); // Always open in-app chat
}


/* ================================================================
   14. REMINDER
================================================================ */
function handleReminder() {
  const c = contacts[currentIndex];
  if (!c) return;
  // Open the custom CSS reminder modal instead of native prompts
  const overlay = document.getElementById('reminder-modal-overlay');
  if (!overlay) return;
  // Pre-fill existing reminder text
  const labelEl = document.getElementById('input-reminder-label');
  const autoEl  = document.getElementById('input-reminder-auto-send');
  const delayEl = document.getElementById('input-reminder-delay');
  if (labelEl) labelEl.value = (c.reminder && c.reminder !== 'No reminder set.') ? c.reminder : '';
  if (autoEl)  autoEl.value  = '';
  if (delayEl) delayEl.value = '5';
  overlay.classList.add('active');
  if (window._navStack) window._navStack.push('reminder-modal-overlay');
  history.pushState({ modal: 'reminder-modal-overlay' }, '');
}

function _applyReminderFromModal() {
  const c = contacts[currentIndex];
  if (!c) return;
  const overlay  = document.getElementById('reminder-modal-overlay');
  const labelEl  = document.getElementById('input-reminder-label');
  const autoEl   = document.getElementById('input-reminder-auto-send');
  const delayEl  = document.getElementById('input-reminder-delay');

  const reminderText  = (labelEl && labelEl.value.trim()) || '';
  const autoSendText  = (autoEl  && autoEl.value.trim())  || '';
  const delayStr      = (delayEl && delayEl.value.trim()) || '5';

  if (!reminderText) {
    showToast('Please enter a reminder label', 'warn', 2000);
    return;
  }

  let triggerAt = 0;
  if (delayStr.includes(':')) {
    const [h, m] = delayStr.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    triggerAt = d.getTime();
  } else {
    const mins = parseFloat(delayStr) || 5;
    triggerAt = Date.now() + mins * 60 * 1000;
  }

  c.reminder = reminderText || 'No reminder set.';
  if (cardReminder) cardReminder.textContent = c.reminder;

  if (autoSendText) {
    c.scheduledMessage = { text: autoSendText, triggerAt, sent: false };
    const timeStr = new Date(triggerAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    showToast(`📅 Reminder & message scheduled for ${timeStr}!`, 'success');
  } else {
    c.scheduledMessage = null;
    showToast(`⏰ Reminder set!`, 'success');
  }

  saveContacts();

  if ('Notification' in window) {
    Notification.requestPermission().then(perm => {
      if (perm === 'granted') {
        new Notification('⏰ Relationship OS', {
          body: `Reminder set for ${c.name}: "${c.reminder}"`,
          icon: './icon-192.png'
        });
      }
    });
  }

  // Close modal
  if (overlay) overlay.classList.remove('active');
  if (history.state && history.state.modal === 'reminder-modal-overlay') history.back();
}

function sendScheduledMessage(contact, text) {
  const isLocal = !contact.linkedUid;
  const roomId = isLocal ? `local_${contact.id}` : makeRoomId(myUid, contact.linkedUid);
  const now = Date.now();
  const receiverId = isLocal ? '' : roomId.replace(myUid, '').replace('__', '');

  const msg = {
    id:         now.toString(),
    sender:     myUid,
    senderId:   myUid,
    receiverId: receiverId,
    type:       'reminder',
    text:       text,
    timestamp:  now,
    read:       false,
    status:     'sent'
  };

  if (!isLocal && db && isFirebaseLive) {
    db.ref(`rooms/${roomId}/messages/${msg.id}`).set(msg);
  } else {
    const key = `ros_chat_${roomId}`;
    const msgs = JSON.parse(localStorage.getItem(key) || '[]');
    msgs.push(msg);
    localStorage.setItem(key, JSON.stringify(msgs));
    if (activeRoomId === roomId && chatOverlay.classList.contains('active')) {
      appendChatMessage(msg);
    }
  }

  showToast(`🤖 Auto-sent message to ${contact.name}!`, 'success');

  contact.lastTalk = 'Just now';
  contact.lastTalkTimestamp = now;
  if (contacts[currentIndex] === contact) {
    cardLastTalk.textContent = 'Just now';
  }
}

function checkScheduledMessages() {
  const now = Date.now();
  let changed = false;

  contacts.forEach(c => {
    if (c.scheduledMessage && !c.scheduledMessage.sent && now >= c.scheduledMessage.triggerAt) {
      c.scheduledMessage.sent = true;
      changed = true;
      sendScheduledMessage(c, c.scheduledMessage.text);

      if (Notification.permission === 'granted') {
        new Notification('🤖 Scheduled Message Sent', {
          body: `Sent to ${c.name}: "${c.scheduledMessage.text}"`,
          icon: '📇'
        });
      }
    }
  });

  if (changed) {
    saveContacts();
    if (contacts[currentIndex]) renderCard(contacts[currentIndex]);
  }
}


/* ================================================================
   15. VOICE MESSAGE  (record → auto-send in chat)
================================================================ */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function resetVoiceButton() {
  btnVoice.classList.remove('voice-recording-active');
  if (btnVoiceIcon) btnVoiceIcon.textContent = '🎤';
  btnVoice.title = 'Record voice message';
  if (voiceRecordingBanner) voiceRecordingBanner.style.display = 'none';
}

function setVoiceRecordingUI(active) {
  if (active) {
    btnVoice.classList.add('voice-recording-active');
    if (btnVoiceIcon) btnVoiceIcon.textContent = '⏹';
    btnVoice.title = 'Stop & send recording';
    if (voiceRecordingBanner) voiceRecordingBanner.style.display = 'flex';
  } else {
    resetVoiceButton();
  }
}

async function sendVoiceChatMessage(blob) {
  const c = contacts[currentIndex];
  if (!c) {
    showToast('Select a contact first', 'warn');
    return;
  }

  if (blob.size > MAX_VOICE_BYTES) {
    showToast('Recording too long — keep it under ~30 seconds', 'error');
    return;
  }

  const isLocal = !c.linkedUid;
  const roomId = isLocal
    ? `local_${c.id}`
    : makeRoomId(myUid, c.linkedUid);

  if (!chatOverlay.classList.contains('active') || activeRoomId !== roomId) {
    openChatDrawer(c);
  }

  const now = Date.now();
  if (now - lastMessageTime < MSG_RATE_MS) {
    showToast('⚡ Slow down a little!', 'warn', 1500);
    return;
  }
  lastMessageTime = now;

  let audioData;
  try {
    audioData = await blobToDataUrl(blob);
  } catch (err) {
    console.error('Voice encode error:', err);
    showToast('Failed to process recording', 'error');
    return;
  }

  const receiverId = isLocal ? '' : roomId.replace(myUid, '').replace('__', '');
  // Calculate recording duration from stored start time
  const voiceDuration = recordingStartTime > 0 ? Math.round((now - recordingStartTime) / 1000) : 0;
  recordingStartTime = 0;
  const msg = {
    id:         now.toString(),
    sender:     myUid,
    senderId:   myUid,
    receiverId,
    type:       'voice',
    audio:      audioData,
    duration:   voiceDuration,
    text:       '🎤 Voice message',
    timestamp:  now,
    read:       false,
    status:     'sent'
  };

  if (!isLocal && db && isFirebaseLive) {
    db.ref(`rooms/${roomId}/messages`).push(msg)
      .then(() => showToast('🎤 Voice message sent!', 'success'))
      .catch(err => {
        console.error('Voice send failed:', err);
        showToast('Failed to send voice message', 'error');
        appendChatMessage({ ...msg, _failed: true });
      });
  } else {
    const key  = `ros_chat_${roomId}`;
    const msgs = JSON.parse(localStorage.getItem(key) || '[]');
    msgs.push(msg);
    if (msgs.length > 200) msgs.splice(0, msgs.length - 200);
    localStorage.setItem(key, JSON.stringify(msgs));
    appendChatMessage(msg);
    chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
    showToast(isLocal ? '🎤 Voice note saved in chat' : '🎤 Voice message sent!', 'success');
  }

  if (!isLocal && isFirebaseLive) broadcastTyping(roomId, false);

  c.lastTalk = 'Just now';
  c.lastTalkTimestamp = now;
  cardLastTalk.textContent = 'Just now';
  saveContacts();
}

async function toggleVoiceMemo() {
  if (isRecording) {
    clearTimeout(recordingTimer);
    mediaRecorder.stop();
    isRecording = false;
    resetVoiceButton();
    return;
  }

  const c = contacts[currentIndex];
  if (!c) {
    showToast('Add a contact first', 'warn');
    return;
  }

  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(recordingStream);

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      recordingStream.getTracks().forEach(t => t.stop());
      recordingStream = null;

      if (!audioChunks.length) return;

      const blob = new Blob(audioChunks, { type: audioChunks[0].type || 'audio/webm' });
      audioChunks = [];
      await sendVoiceChatMessage(blob);
    };

    mediaRecorder.start();
    isRecording = true;
    recordingStartTime = Date.now();
    setVoiceRecordingUI(true);

    recordingTimer = setTimeout(() => {
      if (isRecording) {
        showToast('Max recording length reached', 'info');
        toggleVoiceMemo();
      }
    }, MAX_VOICE_MS);

  } catch (err) {
    showToast('Microphone access denied', 'error');
    console.error('Voice record error:', err);
  }
}


/* ================================================================
   16. INLINE EDIT — click text fields to edit them live
================================================================ */
function makeEditable(el, field) {
  // Clear placeholder on edit start
  const defaultPlaceholders = {
    note: 'No notes yet.',
    memory: 'No memory added yet.',
    reminder: 'No reminder set.'
  };

  const currentVal = el.textContent.trim();
  if (Object.values(defaultPlaceholders).includes(currentVal)) {
    el.textContent = '';
  }

  el.contentEditable = 'true';
  el.style.outline   = '1px dashed var(--orange)';
  el.style.borderRadius = '6px';
  el.style.padding   = '2px 5px';
  el.focus();

  const range = document.createRange();
  range.selectNodeContents(el);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);

  function save() {
    el.contentEditable = 'false';
    el.style.outline   = '';
    el.style.borderRadius = '';
    el.style.padding   = '';
    
    let textVal = el.textContent.trim();
    
    // Restore placeholder if left blank
    if (!textVal && defaultPlaceholders[field]) {
      textVal = defaultPlaceholders[field];
      el.textContent = textVal;
    }

    const c = contacts[currentIndex];
    if (c) {
      c[field] = textVal;
      if (field === 'birthday') {
        const daysLeft = daysUntilBirthday(c.birthday);
        if (daysLeft !== null && daysLeft <= 7) {
          birthdayBanner.style.display = 'block';
          birthdayBanner.textContent   = `🎂 ${c.name.split(' ')[0]}'s birthday is in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}!`;
        }
      }
      saveContacts();
    }
  }

  el.addEventListener('blur',    save, { once: true });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { el.blur(); }
  });
}

// Category selection cycle
function cycleCategory(el) {
  const categories = ['Friend', 'Family', 'Partner', 'Work', 'Other'];
  let currentVal = el.textContent.trim();
  let nextIdx = (categories.indexOf(currentVal) + 1) % categories.length;
  if (nextIdx < 0) nextIdx = 0;
  const nextVal = categories[nextIdx];
  el.textContent = nextVal;

  const c = contacts[currentIndex];
  if (c) {
    c.category = nextVal;
    saveContacts();
    showToast(`🏷️ Category set to ${nextVal}`, 'success', 1500);
  }
}

// Attach inline-edit to card fields
const editableFields = [
  { el: cardName,     field: 'name'     },
  { el: cardCity,     field: 'city'     },
  { el: cardMemory,   field: 'memory'   },
  { el: cardNote,     field: 'note'     },
  { el: cardReminder, field: 'reminder' },
  { el: cardBirthday, field: 'birthday' },
];

editableFields.forEach(({ el, field }) => {
  if (el) {
    el.style.cursor = 'text';
    el.title = 'Click to edit';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      makeEditable(el, field);
    });
  }
});

// Category click event
if (cardCategory) {
  cardCategory.style.cursor = 'pointer';
  cardCategory.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleCategory(cardCategory);
  });
}

// Note tile click event triggers note edit
document.querySelector('.note-tile')?.addEventListener('click', (e) => {
  if (e.target !== cardNote && cardNote) {
    cardNote.click();
  }
});


/* ================================================================
   19. USER IDENTITY & CONNECT CODE
================================================================ */
function initUserIdentity() {
  // Load or generate persistent user ID
  myUid  = localStorage.getItem('ros_uid')  || generateUid();
  myCode = localStorage.getItem('ros_code') || generateCode(6);
  localStorage.setItem('ros_uid',  myUid);
  localStorage.setItem('ros_code', myCode);

  // Load saved mood/status
  myMood   = localStorage.getItem('ros_mood')   || '😊';
  myStatus = localStorage.getItem('ros_status') || '';

  // Load saved connections map
  try {
    const saved = localStorage.getItem('ros_connections');
    connections = saved ? JSON.parse(saved) : {};
  } catch { connections = {}; }

  // Display code in UI
  updateCodeDisplay();
  console.log(`🔗 Your connect code: ${myCode} | UID: ${myUid.slice(0, 8)}…`);
}

function updateCodeDisplay() {
  // Floating pill
  myCodeValue.textContent = myCode;
  // Connect modal
  connectCodeBig.textContent = myCode;
  // Status in connect modal
  inputStatusText.value = myStatus;
  // Highlight current mood in connect modal
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.mood === myMood);
  });
  // Highlight current mood in card quick bar
  document.querySelectorAll('#mood-mini-picker .mood-mini-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.mood === myMood);
  });
}

function saveConnections() {
  localStorage.setItem('ros_connections', JSON.stringify(connections));
}


/* ================================================================
   20. FIREBASE INITIALIZATION
================================================================ */
async function initFirebase() {
  // Guard: Firebase SDK must be loaded
  if (typeof firebase === 'undefined') {
    console.error('❌ Firebase SDK not loaded. Check CDN script tags in index.html.');
    showToast('❌ Firebase SDK missing — check console', 'error', 8000);
    initDemoMode();
    return;
  }

  try {
    // Initialize Firebase App exactly once
    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
      console.log('🔥 Firebase App initialized | project:', FIREBASE_CONFIG.projectId);
    }

    // Get database reference and verify it works with a connectivity check
    db = firebase.database();

    // Confirm the DB URL is reachable by reading a tiny public path
    await db.ref('.info/connected').once('value');

    isFirebaseLive = true;
    console.log('✅ Firebase Realtime Database connected!');
    console.log('   DB URL:', FIREBASE_CONFIG.databaseURL);

    // Core setup — order matters
    await registerSelfInFirebase();
    setupFirebasePresence();
    listenForPings();
    loadFirebaseConnections();
    listenForWalkieTalkie();

  } catch (err) {
    isFirebaseLive = false;
    db = null;
    console.error('❌ Firebase init failed:', err.code || err.message);
    console.error('   Full error:', err);
    console.error('   databaseURL used:', FIREBASE_CONFIG.databaseURL);

    if (err.code === 'PERMISSION_DENIED') {
      showToast('⚠️ Firebase: Permission denied. Check database rules.', 'error', 10000);
    } else if (err.message && err.message.includes('network')) {
      showToast('⚠️ Firebase: Network error. Are you online?', 'error', 8000);
    } else {
      showToast('⚠️ Firebase unavailable — running offline mode', 'warn', 6000);
    }

    initDemoMode();
  }
}

async function registerSelfInFirebase() {
  if (!db) { console.warn('registerSelfInFirebase: db is null'); return; }

  const userPayload = {
    code:     myCode,
    mood:     myMood,
    status:   myStatus,
    online:   true,
    lastSeen: firebase.database.ServerValue.TIMESTAMP
  };

  try {
    // Write user record
    await db.ref(`users/${myUid}`).update(userPayload);
    console.log('✅ users/' + myUid + ' written:', userPayload);

    // Write code → uid mapping with TTL timestamp
    await db.ref(`codes/${myCode}`).set({
      uid:       myUid,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      expiresAt: Date.now() + CODE_TTL_MS
    });
    console.log('✅ codes/' + myCode + ' written → uid:', myUid);

  } catch (err) {
    console.error('❌ registerSelfInFirebase failed:', err.code, err.message);
    showToast('❌ Firebase write failed: ' + (err.code || err.message), 'error', 8000);
    throw err; // Re-throw so initFirebase can handle
  }
}

function setupFirebasePresence() {
  if (!db) return;
  const presenceRef = db.ref(`users/${myUid}/online`);
  presenceRef.set(true);
  presenceRef.onDisconnect().set(false);
  db.ref(`users/${myUid}/lastSeen`).onDisconnect()
    .set(firebase.database.ServerValue.TIMESTAMP);
  db.ref(`users/${myUid}/onCall`).onDisconnect().set(false);
  db.ref(`users/${myUid}`).update({ onCall: false }).catch(() => {});
}
function loadFirebaseConnections() {
  if (!db) return;

  // Detach previous listener if any
  if (_fbListeners['myConnections']) {
    _fbListeners['myConnections'].ref.off('value', _fbListeners['myConnections'].cb);
  }

  const ref = db.ref(`userConnections/${myUid}`);
  const cb = snap => {
    const conns = snap.val() || {};

    // Add new connections
    Object.entries(conns).forEach(([friendUid, connData]) => {
      if (!connections[friendUid]) {
        connections[friendUid] = {
          uid:         friendUid,
          code:        connData.code || '',
          name:        connData.name || `Friend (${connData.code || friendUid.slice(0,6)})`,
          online:      false,
          mood:        '',
          status:      '',
          connectedAt: connData.connectedAt || Date.now()
        };
        // Auto-create a contact card for this friend
        autoCreateContactForFriend(friendUid, connections[friendUid]);
      }
      subscribeToPresence(friendUid);
      subscribeToCallSignalling(makeRoomId(myUid, friendUid));
    });

    // Remove connections that were deleted remotely
    Object.keys(connections).forEach(uid => {
      if (!conns[uid]) {
        unsubscribeFromPresence(uid);
        unsubscribeFromFriendLocation(uid);
        delete connections[uid];
      }
    });

    saveConnections();
    renderConnectionsList();
  };

  ref.on('value', cb);
  _fbListeners['myConnections'] = { ref, cb };
}

function subscribeToPresence(friendUid) {
  if (presenceListeners[friendUid]) return; // already subscribed

  if (db && isFirebaseLive) {
    const ref = db.ref(`users/${friendUid}`);
    const cb  = snap => {
      const data = snap.val();
      if (data && connections[friendUid]) {
        connections[friendUid].online = !!data.online;
        connections[friendUid].mood   = data.mood   || '';
        connections[friendUid].status = data.status || '';
        connections[friendUid].onCall = !!data.onCall;
        if (data.name) connections[friendUid].name = data.name;
        if (data.location) connections[friendUid].location = data.location;
        
        // Self-healing: link manual contact cards with matching name to friend UIDs
        if (data.name) {
          const manualMatch = contacts.find(c => !c.linkedUid && c.name.toLowerCase().trim() === data.name.toLowerCase().trim());
          if (manualMatch) {
            manualMatch.linkedUid = friendUid;
            saveContacts();
            console.log(`🔗 Auto-linked manual contact card "${manualMatch.name}" to connection UID ${friendUid}`);
          }
        }

        updateContactCardFromFriendData(friendUid, data);
      }
      saveConnections();
      renderConnectionsList();
      refreshPresenceUI(contacts[currentIndex]);
    };
    ref.on('value', cb);
    presenceListeners[friendUid] = { ref, cb };
  } else {
    const interval = setInterval(() => {
      const presence = JSON.parse(localStorage.getItem(`ros_presence_${friendUid}`) || '{}');
      if (connections[friendUid]) {
        connections[friendUid].online = Date.now() - (presence.ts || 0) < 20000 && !!presence.online;
        connections[friendUid].mood   = presence.mood   || '';
        connections[friendUid].status = presence.status || '';
      }
      refreshPresenceUI(contacts[currentIndex]);
    }, 5000);
    presenceListeners[friendUid] = { interval };
  }

  subscribeToFriendLocation(friendUid);
}

function subscribeToFriendLocation(friendUid) {
  if (locationListeners[friendUid]) return;

  const roomId = makeRoomId(myUid, friendUid);
  const applyLocation = (loc) => {
    if (!connections[friendUid]) return;

    const wasSharing = !!(connections[friendUid].location && connections[friendUid].location.sharing);
    connections[friendUid].location = loc || { sharing: false };
    saveConnections();

    const current = contacts[currentIndex];
    if (current && current.linkedUid === friendUid) {
      refreshPresenceUI(current);

      const nowSharing = !!(loc && loc.sharing);
      if (nowSharing && !wasSharing) {
        const name = connections[friendUid].name || current.name || 'Friend';
        showToast(`📍 ${name} started sharing live location!`, 'info', 4000);
        triggerPushNotification(`📍 ${name} started sharing`, 'Tap to open location map', 'location-start');
      } else if (!nowSharing && wasSharing) {
        // ✅ INSTANT: Friend stopped sharing — update card immediately
        const name = connections[friendUid].name || current.name || 'Friend';
        showToast(`📍 ${name} stopped sharing location`, 'info', 3000);
        // Immediately remove Live! label from location button
        const locBtn = document.getElementById('btn-location');
        const locLabel = locBtn?.querySelector('.live-btn-label');
        if (locBtn && !isSharingLocation) {
          locBtn.classList.remove('location-active');
          locBtn.title = 'Live Location';
        }
        if (locLabel) locLabel.textContent = 'Location';
        if (locationShareBanner) locationShareBanner.style.display = 'none';
      }
    }
  };

  if (db && isFirebaseLive) {
    const ref = db.ref(`rooms/${roomId}/location/${friendUid}`);
    const cb = snap => applyLocation(snap.val());
    ref.on('value', cb);
    locationListeners[friendUid] = { ref, cb };
  } else {
    const poll = () => {
      const locKey = `ros_location_${roomId}_${friendUid}`;
      const loc = JSON.parse(localStorage.getItem(locKey) || 'null');
      if (loc && loc.sharing && Date.now() - (loc.updatedAt || 0) > 300000) {
        applyLocation({ sharing: false });
      } else {
        applyLocation(loc);
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    locationListeners[friendUid] = { interval };
  }
}

function unsubscribeFromFriendLocation(friendUid) {
  const listener = locationListeners[friendUid];
  if (!listener) return;
  if (listener.ref && listener.cb) listener.ref.off('value', listener.cb);
  if (listener.interval) clearInterval(listener.interval);
  delete locationListeners[friendUid];
}

/** Detach a presence listener cleanly */
function unsubscribeFromPresence(friendUid) {
  const listener = presenceListeners[friendUid];
  if (!listener) return;
  if (listener.ref && listener.cb) {
    listener.ref.off('value', listener.cb);
  }
  if (listener.interval) {
    clearInterval(listener.interval);
  }
  delete presenceListeners[friendUid];
  unsubscribeFromFriendLocation(friendUid);
}

/**
 * When a connection is established, auto-create a contact card
 * for the friend so the user doesn't have to do it manually.
 */
function autoCreateContactForFriend(friendUid, conn) {
  // Don't create a duplicate
  if (contacts.some(c => c.linkedUid === friendUid)) return;

  const newContact = {
    id:               Date.now() + Math.random(),
    name:             conn.name || `Friend (${conn.code})`,
    city:             '',
    mood:             conn.mood || '😊',
    score:            50,
    birthday:         '',
    lastTalk:         'Just now',
    lastTalkTimestamp: Date.now(),
    category:         'Friend',
    memory:           '',
    note:             '',
    reminder:         '',
    avatarColor:      '#f97316',
    imageUrl:         '',
    isFavorite:       false,
    linkedUid:        friendUid,
    checkIns:         0
  };

  contacts.push(newContact);
  saveContacts();

  // Navigate to the new card
  currentIndex = contacts.length - 1;
  renderCard(contacts[currentIndex]);
  renderBackCards();

  console.log('✅ Auto-created contact card for', friendUid, '→', newContact.name);
}


/* ================================================================
   21. LOCAL DEMO MODE  (tab-to-tab sync via localStorage events)
================================================================ */
function initDemoMode() {
  broadcastPresence();
  setInterval(broadcastPresence, 10000);

  Object.keys(connections).forEach(uid => subscribeToPresence(uid));

  window.addEventListener('storage', handleDemoStorageEvent);

  console.log('📡 Demo mode: open another tab with this page and enter each other\'s codes!');
  showToast('💡 Demo Mode: Open another tab and connect via code!', 'info', 6000);
}

function broadcastPresence() {
  localStorage.setItem(`ros_presence_${myUid}`, JSON.stringify({
    uid:    myUid,
    code:   myCode,
    online: true,
    mood:   myMood,
    status: myStatus,
    ts:     Date.now()
  }));
}

function handleDemoStorageEvent(e) {
  // Handle chat messages
  if (e.key && e.key.startsWith('ros_chat_')) {
    const roomId = e.key.replace('ros_chat_', '');
    if (roomId === activeRoomId && e.newValue) {
      const msgs = JSON.parse(e.newValue);
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.senderId !== myUid && lastMsg.sender !== myUid) {
        appendChatMessage(lastMsg);
        const c = contacts[currentIndex];
        const preview = lastMsg.type === 'voice' ? '🎤 Voice message' : 'New message';
        if (!chatOverlay.classList.contains('active')) {
          showToast(`💬 ${preview} from ${c?.name || 'Friend'}`, 'info');
        }
      }
    }
  }

  // Handle typing indicator
  if (e.key && e.key.startsWith('ros_typing_')) {
    const roomId = e.key.replace('ros_typing_', '');
    if (roomId === activeRoomId && e.newValue) {
      const data = JSON.parse(e.newValue);
      if (data.uid !== myUid) {
        showTypingIndicator(data.typing);
      }
    }
  }

  // Handle location sharing updates (demo mode)
  if (e.key && e.key.startsWith('ros_location_')) {
    const friendUid = e.key.replace('ros_location_', '');
    if (friendUid !== myUid && connections[friendUid]) {
      const loc = e.newValue ? JSON.parse(e.newValue) : null;
      const wasSharing = !!(connections[friendUid].location && connections[friendUid].location.sharing);
      connections[friendUid].location = loc || { sharing: false };
      saveConnections();
      refreshPresenceUI(contacts[currentIndex]);
      if (loc && loc.sharing && !wasSharing && contacts[currentIndex]?.linkedUid === friendUid) {
        showToast(`📍 ${connections[friendUid].name || 'Friend'} started sharing live location!`, 'info', 4000);
      }
    }
  }

  // Handle pings
  if (e.key === `ros_ping_${myUid}` && e.newValue) {
    const ping = JSON.parse(e.newValue);
    if (Date.now() - ping.ts < 10000) {
      handleIncomingPing(ping);
    }
  }

  // Handle memories
  if (e.key && e.key.startsWith('ros_memories_') && e.newValue) {
    const roomId = e.key.replace('ros_memories_', '');
    if (roomId === activeRoomId && memoriesModalOverlay.classList.contains('active')) {
      renderMemoriesTimeline(roomId);
    }
  }

  // Handle connection requests
  if (e.key && e.key.startsWith('ros_connect_req_') && e.newValue) {
    const targetUid = e.key.replace('ros_connect_req_', '');
    if (targetUid === myUid) {
      const req = JSON.parse(e.newValue);
      if (req.ts && Date.now() - req.ts < 15000) {
        handleIncomingConnectionRequest(req);
      }
    }
  }
}


/* ================================================================
   22. CONNECT CODE SYSTEM
================================================================ */
function openConnectModal() {
  updateCodeDisplay();
  renderConnectionsList();
  connectModalOverlay.classList.add('active');
  setTimeout(() => inputFriendCode.focus(), 80);
}

function closeConnectModal() {
  connectModalOverlay.classList.remove('active');
}

async function doConnect() {
  const rawCode = inputFriendCode.value.trim().toUpperCase();

  // Validate format: exactly 6 alphanumeric chars from our alphabet
  if (!/^[A-Z0-9]{6}$/.test(rawCode)) {
    showToast('❌ Enter a valid 6-character code', 'error');
    return;
  }
  if (rawCode === myCode) {
    showToast('😅 That is your own code!', 'warn');
    return;
  }

  // Prevent button spam
  btnDoConnect.disabled = true;
  showToast('🔍 Looking up code…', 'info', 3000);

  try {
    let friendUid = null;

    if (db && isFirebaseLive) {
      // ── Firebase lookup: code → uid ──
      console.log('🔍 Looking up code in Firebase: codes/' + rawCode);
      const snap = await db.ref(`codes/${rawCode}`).once('value');
      const codeData = snap.val();
      console.log('   codes/' + rawCode + ' =', codeData);

      if (!codeData) {
        showToast('❌ Code not found. Ask the other person to open the app.', 'error', 5000);
        return;
      }

      // Handle both old format (plain uid string) and new format ({uid, createdAt, expiresAt})
      if (typeof codeData === 'string') {
        friendUid = codeData;
      } else if (codeData && codeData.uid) {
        // Check expiry
        if (codeData.expiresAt && Date.now() > codeData.expiresAt) {
          showToast('❌ This code has expired. Ask them to reload the app for a new code.', 'error', 6000);
          return;
        }
        friendUid = codeData.uid;
      }

    } else {
      // ── Demo mode: scan localStorage for matching code ──
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('ros_presence_')) {
          try {
            const data = JSON.parse(localStorage.getItem(key));
            if (data && data.code === rawCode && Date.now() - data.ts < 60000) {
              friendUid = data.uid;
              break;
            }
          } catch { /* skip */ }
        }
      }
    }

    if (!friendUid) {
      showToast('❌ Code not found. Make sure the other person has the app open.', 'error', 5000);
      return;
    }

    // Prevent self-connection via uid
    if (friendUid === myUid) {
      showToast('😅 That is your own device!', 'warn');
      return;
    }

    // Already connected?
    if (connections[friendUid]) {
      showToast('✅ Already connected!', 'success');
      inputFriendCode.value = '';
      return;
    }

    if (db && isFirebaseLive) {
      // ── Atomic multi-path write: both sides simultaneously ──
      const multiUpdate = {};
      multiUpdate[`userConnections/${myUid}/${friendUid}`] = {
        code:        rawCode,
        name:        rawCode,
        connectedAt: firebase.database.ServerValue.TIMESTAMP
      };
      multiUpdate[`userConnections/${friendUid}/${myUid}`] = {
        code:        myCode,
        name:        myCode,
        connectedAt: firebase.database.ServerValue.TIMESTAMP
      };

      console.log('✍️ Writing connection (multi-path):', multiUpdate);
      await db.ref('/').update(multiUpdate);
      console.log('✅ Connection written to Firebase!');

    } else {
      // Demo mode: notify other tab
      localStorage.setItem(`ros_connect_req_${friendUid}`, JSON.stringify({
        fromUid:  myUid,
        fromCode: myCode,
        ts:       Date.now()
      }));
      setTimeout(() => localStorage.removeItem(`ros_connect_req_${friendUid}`), 5000);

      // Optimistically add to local state
      connections[friendUid] = {
        uid:         friendUid,
        code:        rawCode,
        name:        `Friend (${rawCode})`,
        online:      false,
        mood:        '',
        status:      '',
        connectedAt: Date.now()
      };
      saveConnections();
      autoCreateContactForFriend(friendUid, connections[friendUid]);
    }

    // In Firebase mode, loadFirebaseConnections listener will update state automatically.
    // Associate the connection UID with our selected card if it has no link yet
    const currentCard = contacts[currentIndex];
    if (currentCard && !currentCard.linkedUid) {
      currentCard.linkedUid = friendUid;
      saveContacts();
      renderCard(currentCard);
      console.log(`🔗 Manual linking applied: Card "${currentCard.name}" → UID: ${friendUid}`);
    }

    // Just start listening for this friend's presence.
    subscribeToPresence(friendUid);
    renderConnectionsList();
    inputFriendCode.value = '';
    showToast(`🎉 Connected with ${rawCode}!`, 'success');
  } catch (err) {
    console.error('❌ doConnect error:', err.code, err.message, err);
    showToast('❌ Connection failed: ' + (err.message || 'unknown error'), 'error', 6000);
  } finally {
    btnDoConnect.disabled = false;
  }
}

function handleIncomingConnectionRequest(req) {
  const { fromUid, fromCode } = req;
  if (!connections[fromUid]) {
    connections[fromUid] = {
      uid: fromUid,
      code: fromCode,
      name: `Friend (${fromCode})`,
      online: true,
      mood: '',
      status: '',
      connectedAt: Date.now()
    };
    saveConnections();
    subscribeToPresence(fromUid);
    renderConnectionsList();
    updateLinkedContacts();
    showToast(`🔗 ${fromCode} connected with you!`, 'success');
  }
}

function disconnect(friendUid) {
  if (!confirm('Disconnect from this person?')) return;

  // Detach presence listener first
  unsubscribeFromPresence(friendUid);

  delete connections[friendUid];
  saveConnections();

  // Remove link from contacts (but keep the contact card)
  contacts.forEach(c => {
    if (c.linkedUid === friendUid) c.linkedUid = null;
  });
  saveContacts();

  if (db && isFirebaseLive) {
    db.ref(`userConnections/${myUid}/${friendUid}`).remove().catch(console.error);
  }

  renderConnectionsList();
  renderCard(contacts[currentIndex]);
  showToast('🔗 Disconnected', 'info');
}

/** Link a connected friend UID to a contact card */
function updateLinkedContacts() {
  // Auto-link if contact name roughly matches (demo behavior)
  // Users can also manually assign via the connections list
  renderConnectionsList();
}

function renderConnectionsList() {
  if (!Object.keys(connections).length) {
    connectionsList.innerHTML = '<p class="no-conn-msg">No connections yet. Share your code!</p>';
    return;
  }

  connectionsList.innerHTML = '';
  Object.entries(connections).forEach(([uid, conn]) => {
    const item = document.createElement('div');
    item.className = 'connection-item';
    item.innerHTML = `
      <div class="connection-item-left">
        <span class="connection-item-dot ${conn.online ? 'online' : ''}"></span>
        <div>
          <div style="font-size:13px;font-weight:600;color:#111">${conn.name}</div>
          <div class="connection-item-code">${conn.code} ${conn.online ? '· Online' : '· Offline'}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="btn-disconnect" data-uid="${uid}">Disconnect</button>
        <button class="btn-copy-code" style="padding:4px 10px;font-size:11px" data-link-uid="${uid}">Link to card</button>
      </div>
    `;
    item.querySelector('.btn-disconnect').addEventListener('click', () => disconnect(uid));
    item.querySelector('[data-link-uid]').addEventListener('click', () => {
      linkConnectionToCurrentCard(uid, conn);
    });
    connectionsList.appendChild(item);
  });
}

function linkConnectionToCurrentCard(uid, conn) {
  const c = contacts[currentIndex];
  if (!c) return;
  c.linkedUid = uid;
  saveContacts();
  renderCard(c);
  showToast(`🔗 Linked to ${c.name}!`, 'success');
  closeConnectModal();
}

function hexToRGBA(hex, alpha) {
  try {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  } catch {
    return `rgba(249, 115, 22, ${alpha})`;
  }
}

function formatAudioTime(secs) {
  if (!secs || isNaN(secs) || !isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/* ================================================================
   23. REAL-TIME CHAT
================================================================ */
function openChatDrawer(contact) {
  clearChatUnreadBadge();
  // Local contacts (no linkedUid) → private notes journal mode
  // Connected contacts (linkedUid set) → real-time Firebase/demo chat
  const isLocal = !contact.linkedUid;
  activeRoomId  = isLocal
    ? `local_${contact.id}`
    : makeRoomId(myUid, contact.linkedUid);

  chatContactName.textContent = contact.name;
  if (contact.imageUrl) {
    chatAvatarMini.innerHTML = `<img src="${contact.imageUrl}" alt="${contact.name}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;" onerror="this.outerHTML='<span style=\\'font-size:14px;\\'>👤</span>'">`;
  } else {
    chatAvatarMini.innerHTML = `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width: 16px; height: 16px; fill: rgba(255,255,255,0.85);">
        <path d="M12 12c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0 2c-3.33 0-10 1.67-10 5v2h20v-2c0-3.33-6.67-5-10-5z"/>
      </svg>`;
  }
  chatAvatarMini.style.backgroundColor = contact.avatarColor || '#f97316';

  const themeHex = contact.avatarColor || '#f97316';
  chatOverlay.style.setProperty('--theme-accent', themeHex);
  chatOverlay.style.setProperty('--theme-accent-soft', hexToSoft(themeHex));
  chatOverlay.style.setProperty('--theme-accent-glow', hexToRGBA(themeHex, 0.22));
  chatOverlay.style.setProperty('--theme-accent-gradient', `linear-gradient(135deg, ${hexToSoft(themeHex)}, ${themeHex})`);

  // Clear messages area
  chatMessagesArea.innerHTML = '';

  // Local mode banner
  if (isLocal) {
    const banner = document.createElement('div');
    banner.className = 'local-chat-banner';
    banner.innerHTML = `
      <span>📝 Private notes mode</span>
      <small>Connect this person via <b>🔗 Connect</b> for live real-time chat</small>`;
    chatMessagesArea.appendChild(banner);
  }

  // Load chat history
  loadChatHistory(activeRoomId);

  chatOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  // No autofocus — prevents keyboard auto-opening on mobile PWA (disrupts UX)

  // Update last talk
  contact.lastTalk = 'Just now';
  contact.lastTalkTimestamp = Date.now();
  cardLastTalk.textContent = 'Just now';
  saveContacts();
}

function closeChatDrawer() {
  chatOverlay.classList.remove('active');
  document.body.style.overflow = '';

  // Stop typing indicator
  if (activeRoomId) broadcastTyping(activeRoomId, false);

  // ── Detach Firebase chat listeners to prevent memory leaks ──
  if (chatListeners[activeRoomId]) {
    const { msgsRef, typingRef } = chatListeners[activeRoomId];
    if (msgsRef)   msgsRef.off();
    if (typingRef) typingRef.off();
    delete chatListeners[activeRoomId];
    console.log('🧹 Detached chat listeners for room:', activeRoomId);
  }

  activeRoomId = '';
}

function loadChatHistory(roomId) {
  const isLocalRoom = roomId.startsWith('local_');

  // Always detach any existing listener for this room before re-attaching
  if (chatListeners[roomId]) {
    const { msgsRef, typingRef } = chatListeners[roomId];
    if (msgsRef)   msgsRef.off();
    if (typingRef) typingRef.off();
    delete chatListeners[roomId];
  }

  if (!isLocalRoom && db && isFirebaseLive) {
    // ── Firebase: real-time listener ──
    const msgsRef   = db.ref(`rooms/${roomId}/messages`).orderByChild('timestamp').limitToLast(100);
    const typingRef = db.ref(`rooms/${roomId}/typing`);

    chatListeners[roomId] = { msgsRef, typingRef };

    msgsRef.on('value', snap => {
      // Preserve local-chat-banner if present
      const banner = chatMessagesArea.querySelector('.local-chat-banner');
      chatMessagesArea.innerHTML = '';
      if (banner) chatMessagesArea.appendChild(banner);

      const msgs = [];
      snap.forEach(child => {
        const m = child.val();
        if (m && typeof m === 'object') {
          // Recover missing properties dynamically from key/attributes
          m.id = m.id || child.key;
          m.senderId = m.senderId || m.sender || '';
          m.text = m.text || m.message || m.content || '';
          m.timestamp = m.timestamp || m.time || m.ts || parseInt(child.key, 10) || Date.now();
          msgs.push(m);
        }
      });

      if (msgs.length === 0) {
        renderChatEmpty();
      } else {
        msgs.forEach(msg => appendChatMessage(msg));
      }
      chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
    });

    typingRef.on('value', snap => {
      const typingData = snap.val() || {};
      const someoneElseTyping = Object.entries(typingData)
        .some(([uid, val]) => uid !== myUid && val === true);
      showTypingIndicator(someoneElseTyping);
    });

  } else {
    // ── localStorage: local / demo rooms ──
    const key  = `ros_chat_${roomId}`;
    const msgs = JSON.parse(localStorage.getItem(key) || '[]');
    if (msgs.length === 0) {
      if (!isLocalRoom) renderChatEmpty();
    } else {
      msgs.forEach(msg => appendChatMessage(msg));
      chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
    }
  }
}

function renderChatEmpty() {
  chatMessagesArea.innerHTML = `
    <div class="chat-empty-state">
      <div class="chat-empty-icon">💬</div>
      <p>Start the conversation!</p>
      <small>Messages sync in real-time when connected via code.<br>
      ${isFirebaseLive ? '🔥 Firebase active — cross-device sync!' : '💡 Demo mode — tab-to-tab sync.'}</small>
    </div>`;
}
function sendChatMessage() {
  const text = chatInputField.value.trim();
  if (!text || !activeRoomId) return;

  // Rate limiting
  const now = Date.now();
  if (now - lastMessageTime < MSG_RATE_MS) {
    showToast('⚡ Slow down a little!', 'warn', 1500);
    return;
  }
  lastMessageTime = now;

  // Sanitise length
  const safeText = text.slice(0, 1000);
  
  const isLocalRoom = activeRoomId.startsWith('local_');
  const receiverId = isLocalRoom ? '' : activeRoomId.replace(myUid, '').replace('__', '');

  const msg = {
    id:         now.toString(),
    sender:     myUid,
    senderId:   myUid,
    receiverId: receiverId,
    text:       safeText,
    timestamp:  now,
    read:       false,
    status:     'sent'
  };

  chatInputField.value = '';

  if (!isLocalRoom && db && isFirebaseLive) {
    // ── Firebase: write directly using set under msg.id to ensure matching keys ──
    db.ref(`rooms/${activeRoomId}/messages/${msg.id}`).set(msg)
      .then(() => {
        console.log('✅ Message sent to Firebase room:', activeRoomId);
      })
      .catch(err => {
        console.error('❌ Message send failed:', err.code, err.message);
        showToast('❌ Message failed to send: ' + (err.code || err.message), 'error', 5000);
        // Append locally so user doesn't lose the message
        appendChatMessage({ ...msg, _failed: true });
      });
  } else {
    // ── Local / demo: persist in localStorage ──
    const key  = `ros_chat_${activeRoomId}`;
    const msgs = JSON.parse(localStorage.getItem(key) || '[]');
    msgs.push(msg);
    if (msgs.length > 200) msgs.splice(0, msgs.length - 200);
    localStorage.setItem(key, JSON.stringify(msgs));
    appendChatMessage(msg);
    chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
  }

  if (!isLocalRoom && isFirebaseLive) broadcastTyping(activeRoomId, false);

  // Update contact's last talk
  const c = contacts[currentIndex];
  if (c) {
    c.lastTalk = 'Just now';
    c.lastTalkTimestamp = Date.now();
    cardLastTalk.textContent = 'Just now';
    saveContacts();
  }
}

function appendChatMessage(msg) {
  // Guard clause against empty metadata/status updates or loop triggers
  if (!msg || !msg.id || msg.id === 'undefined') return;
  const text = msg.text || msg.message || msg.content || '';
  if (!text && !msg.audio) return;

  // Remove empty state if present
  const emptyState = chatMessagesArea.querySelector('.chat-empty-state');
  if (emptyState) emptyState.remove();

  const senderId = msg.senderId || msg.sender;
  const isMine = senderId === myUid;
  const isRead = msg.read || msg.status === 'read';

  const div = document.createElement('div');
  div.className = `chat-msg ${isMine ? 'mine' : 'theirs'}`;
  div.dataset.msgId = msg.id;

  const bubble = document.createElement('div');
  bubble.className = 'chat-msg-bubble';

  if (msg.type === 'reminder') {
    bubble.classList.add('chat-msg-reminder');
    bubble.innerHTML = `
      <div class="reminder-msg-badge">⏰ Reminder</div>
      <div class="reminder-msg-text">${escapeHtml(text)}</div>
    `;
  } else if (msg.type === 'voice' && msg.audio) {
    const playerDiv = document.createElement('div');
    playerDiv.className = 'custom-voice-player';
    
    const audio = document.createElement('audio');
    audio.src = msg.audio;
    audio.preload = 'metadata';
    audio.style.display = 'none';
    
    const playBtn = document.createElement('button');
    playBtn.className = 'voice-play-btn';
    playBtn.innerHTML = `
      <svg class="play-icon" viewBox="0 0 24 24" width="18" height="18"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
      <svg class="pause-icon" viewBox="0 0 24 24" width="18" height="18" style="display:none;"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/></svg>
    `;
    
    const waveformWrapper = document.createElement('div');
    waveformWrapper.className = 'voice-waveform-wrapper';
    
    const waveContainer = document.createElement('div');
    waveContainer.className = 'voice-wave-bars';
    const barCount = 18;
    for (let i = 0; i < barCount; i++) {
      const bar = document.createElement('div');
      bar.className = 'voice-wave-bar';
      const heightVal = Math.floor(Math.random() * 14) + 6;
      bar.style.height = `${heightVal}px`;
      waveContainer.appendChild(bar);
    }
    
    const timeRow = document.createElement('div');
    timeRow.className = 'voice-time-row';
    const curTime = document.createElement('span');
    curTime.className = 'voice-time-curr';
    curTime.textContent = '0:00';
    const durTime = document.createElement('span');
    durTime.className = 'voice-time-dur';
    durTime.textContent = '0:00';
    
    timeRow.appendChild(curTime);
    timeRow.appendChild(durTime);
    
    waveformWrapper.appendChild(waveContainer);
    waveformWrapper.appendChild(timeRow);
    
    playerDiv.appendChild(audio);
    playerDiv.appendChild(playBtn);
    playerDiv.appendChild(waveformWrapper);
    bubble.appendChild(playerDiv);
    
    // Show duration from stored payload immediately, then update from metadata
    if (msg.duration && msg.duration > 0) {
      durTime.textContent = formatAudioTime(msg.duration);
    }
    audio.addEventListener('loadedmetadata', () => {
      if (isFinite(audio.duration) && audio.duration > 0) {
        durTime.textContent = formatAudioTime(audio.duration);
      } else if (msg.duration && msg.duration > 0) {
        durTime.textContent = formatAudioTime(msg.duration);
      }
    });
    audio.addEventListener('durationchange', () => {
      if (isFinite(audio.duration) && audio.duration > 0) {
        durTime.textContent = formatAudioTime(audio.duration);
      }
    });
    
    audio.addEventListener('timeupdate', () => {
      curTime.textContent = formatAudioTime(audio.currentTime);
      const progress = audio.currentTime / (audio.duration || 1);
      const activeBarIndex = Math.floor(progress * barCount);
      const bars = waveContainer.querySelectorAll('.voice-wave-bar');
      bars.forEach((b, idx) => {
        if (idx <= activeBarIndex) {
          b.classList.add('active');
        } else {
          b.classList.remove('active');
        }
      });
    });
    
    audio.addEventListener('ended', () => {
      audio.currentTime = 0;
      playBtn.querySelector('.play-icon').style.display = 'block';
      playBtn.querySelector('.pause-icon').style.display = 'none';
      waveContainer.querySelectorAll('.voice-wave-bar').forEach(b => b.classList.remove('active'));
    });
    
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('audio').forEach(otherAudio => {
        if (otherAudio !== audio && !otherAudio.paused) {
          otherAudio.pause();
          const otherPlayBtn = otherAudio.nextSibling;
          if (otherPlayBtn && otherPlayBtn.classList.contains('voice-play-btn')) {
            otherPlayBtn.querySelector('.play-icon').style.display = 'block';
            otherPlayBtn.querySelector('.pause-icon').style.display = 'none';
          }
        }
      });
      
      if (audio.paused) {
        audio.play().then(() => {
          playBtn.querySelector('.play-icon').style.display = 'none';
          playBtn.querySelector('.pause-icon').style.display = 'block';
        }).catch(err => console.log('Audio play failed:', err));
      } else {
        audio.pause();
        playBtn.querySelector('.play-icon').style.display = 'block';
        playBtn.querySelector('.pause-icon').style.display = 'none';
      }
    });

    waveContainer.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = waveContainer.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, clickX / rect.width));
      if (audio.duration) {
        audio.currentTime = pct * audio.duration;
      }
    });
  } else {
    bubble.textContent = text;
  }

  const meta = document.createElement('div');
  meta.className = 'chat-msg-meta';
  meta.innerHTML = `
    <span>${formatTime(msg.timestamp || Date.now())}</span>
    ${isMine ? `<span class="read-receipt">${isRead ? '✓✓' : '✓'}</span>` : ''}
  `;

  div.appendChild(bubble);
  div.appendChild(meta);

  chatMessagesArea.appendChild(div);
  chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;

  // Mark as read if it's from the other person and drawer is open
  if (!isMine && activeRoomId && chatOverlay.classList.contains('active')) {
    markMessageRead(msg.id);
  } else if (!isMine && !chatOverlay.classList.contains('active')) {
    // ✅ Increment unread badge when chat is NOT open
    chatUnreadCount++;
    if (chatUnreadBadge) {
      chatUnreadBadge.textContent = chatUnreadCount > 9 ? '9+' : chatUnreadCount;
      chatUnreadBadge.style.display = 'flex';
    }
    const senderName = msg.senderName || 'Friend';
    triggerPushNotification(`💬 ${senderName}`, msg.text?.slice(0, 80) || 'Sent a voice message', 'chat');
  }
}

function markMessageRead(msgId) {
  if (!msgId || msgId === 'undefined') return;
  if (db && isFirebaseLive && activeRoomId) {
    db.ref(`rooms/${activeRoomId}/messages/${msgId}`).update({
      read: true,
      status: 'read'
    }).catch(() => {});
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

// Typing indicator broadcast
let typingTimeout = null;

function handleChatInputTyping() {
  if (!activeRoomId) return;
  broadcastTyping(activeRoomId, true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => broadcastTyping(activeRoomId, false), 2500);
}

function broadcastTyping(roomId, isTyping) {
  if (!roomId || roomId.startsWith('local_')) return;
  if (db && isFirebaseLive) {
    const ref = db.ref(`rooms/${roomId}/typing/${myUid}`);
    ref.set(isTyping).catch(() => {});
    if (isTyping) ref.onDisconnect().set(false);
  } else {
    const key = `ros_typing_${roomId}`;
    localStorage.setItem(key, JSON.stringify({ uid: myUid, typing: isTyping, ts: Date.now() }));
    setTimeout(() => localStorage.removeItem(key), 100);
  }
}

function showTypingIndicator(isTyping) {
  if (isTyping) {
    chatTypingLine.innerHTML = `typing <span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>`;
  } else {
    chatTypingLine.textContent = '';
  }
}


/* ================================================================
   24. HEALTH SCORE ALGORITHM
================================================================ */
function calculateHealthScore(contact) {
  let score = 40; // base

  // Recency factor (days since last contact)
  const lastTs = contact.lastTalkTimestamp || (Date.now() - 30 * 864e5);
  const daysSince = (Date.now() - lastTs) / 864e5;

  if (daysSince < 0.5)  score += 30;
  else if (daysSince < 1)   score += 25;
  else if (daysSince < 3)   score += 18;
  else if (daysSince < 7)   score += 10;
  else if (daysSince < 14)  score += 4;
  else {
    const weeksOver = Math.floor((daysSince - 14) / 7);
    score = Math.max(5, score - weeksOver * 3);
  }

  // Chats count (bonus)
  const roomId = contact.linkedUid ? makeRoomId(myUid, contact.linkedUid) : `local_${contact.id}`;
  let msgs = [];
  try {
    msgs = JSON.parse(localStorage.getItem(`ros_chat_${roomId}`) || '[]');
  } catch {}
  score += Math.min(15, msgs.length * 0.5);

  // Memories count
  let mems = [];
  try {
    mems = JSON.parse(localStorage.getItem(`ros_memories_${roomId}`) || '[]');
  } catch {}
  score += Math.min(15, mems.length * 2);

  // Check-ins / Pings count
  score += Math.min(10, (contact.checkIns || 0) * 1.5);

  // Birthday nearby bonus
  if (isBirthdayWithinDays(contact.birthday, 14)) score += 5;

  // Favorite bonus
  if (contact.isFavorite) score += 5;

  return Math.min(100, Math.max(0, Math.round(score)));
}


/* ================================================================
   25. LOCATION SHARING & LEAFLET MAP
================================================================ */
let activeSavedPlacesRef = null;
let friendLocationRef = null;

// Offline banners handlers
function handleMapOffline() {
  if (mapStatusBanner) {
    mapStatusBanner.style.display = 'flex';
    mapStatusBanner.innerHTML = '⚠️ Offline. Waiting to reconnect...';
    mapStatusBanner.style.background = 'rgba(239, 68, 68, 0.9)';
  }
}

function handleMapOnline() {
  if (mapStatusBanner) {
    mapStatusBanner.style.display = 'none';
  }
}

function openLocationModal() {
  const c = contacts[currentIndex];
  if (!c) return;

  locationModalOverlay.classList.add('active');
  mapBottomSheet.classList.remove('expanded');

  // Load profile images
  const summaryAvatar = document.getElementById('sheet-summary-avatar');
  const profileAvatarImg = document.getElementById('sheet-profile-avatar-img');
  const profileAvatarFallback = document.getElementById('sheet-profile-avatar-fallback');
  const profileName = document.getElementById('sheet-profile-name');

  profileName.textContent = c.name;
  if (c.imageUrl) {
    summaryAvatar.innerHTML = `<img src="${c.imageUrl}" alt="${c.name}">`;
    profileAvatarImg.src = c.imageUrl;
    profileAvatarImg.style.display = 'block';
    profileAvatarFallback.style.display = 'none';
  } else {
    summaryAvatar.innerHTML = `<span class="sheet-avatar-placeholder">${c.name.charAt(0)}</span>`;
    profileAvatarImg.style.display = 'none';
    profileAvatarFallback.style.display = 'flex';
    profileAvatarFallback.textContent = c.name.charAt(0);
  }

  // Initialize Leaflet Map
  setTimeout(() => initLeafletMap(c), 100);

  // Load friend live updates
  if (c.linkedUid) {
    loadFriendLocation(c.linkedUid);
    loadSavedPlaces(c.linkedUid);
  }

  // Show our sharing state
  updateSharingUI();

  // Setup offline listeners
  if (!navigator.onLine) handleMapOffline();
  window.addEventListener('offline', handleMapOffline);
  window.addEventListener('online', handleMapOnline);

  // Setup bottom sheet drag & expand toggles
  setupBottomSheetEvents();
  setupMapControlButtons(c);
}

function closeLocationModal() {
  locationModalOverlay.classList.remove('active');

  if (activeLocationRef) {
    activeLocationRef.off();
    activeLocationRef = null;
  }
  if (activeSavedPlacesRef) {
    activeSavedPlacesRef.off();
    activeSavedPlacesRef = null;
  }
  if (friendLocationRef) {
    friendLocationRef.off();
    friendLocationRef = null;
  }

  window.removeEventListener('offline', handleMapOffline);
  window.removeEventListener('online', handleMapOnline);

  // Remove markers & polyline instances
  if (friendHistoryPolyline) {
    friendHistoryPolyline.remove();
    friendHistoryPolyline = null;
  }
  if (myHistoryPolyline) {
    myHistoryPolyline.remove();
    myHistoryPolyline = null;
  }
  friendSavedPlacesMarkers.forEach(m => m.remove());
  friendSavedPlacesMarkers = [];
  
  if (myMarker) {
    myMarker.remove();
    myMarker = null;
  }
  if (friendMarker) {
    friendMarker.remove();
    friendMarker = null;
  }

  if (leafletMapInstance) {
    leafletMapInstance.remove();
    leafletMapInstance = null;
  }
}

function initLeafletMap(contact) {
  const mapEl = document.getElementById('leaflet-map');
  if (!mapEl) return;

  if (leafletMapInstance) {
    leafletMapInstance.remove();
    leafletMapInstance = null;
  }

  leafletMapInstance = L.map('leaflet-map', { zoomControl: false }).setView([20, 0], 2);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(leafletMapInstance);

  // Handle map manual DRAG to turn off Follow Mode (dragstart won't fire on programmatic panTo)
  leafletMapInstance.on('dragstart', () => {
    if (isFollowingFriend) {
      setFollowMode(false);
    }
  });
}

function createCustomMarkerHTML(imageUrl, borderColour, isOnline) {
  const statusDotClass = isOnline ? 'marker-status-dot' : 'marker-status-dot offline';
  
  if (imageUrl) {
    return `
      <div class="custom-map-avatar-marker" style="--marker-color: ${borderColour}; --marker-color-alpha: ${hexToRGBA(borderColour, 0.15)}; --marker-color-alpha-border: ${hexToRGBA(borderColour, 0.35)}">
        <img src="${imageUrl}" alt="Avatar">
        <span class="${statusDotClass}"></span>
      </div>
    `;
  } else {
    return `
      <div class="custom-map-avatar-marker" style="--marker-color: ${borderColour}; --marker-color-alpha: ${hexToRGBA(borderColour, 0.15)}; --marker-color-alpha-border: ${hexToRGBA(borderColour, 0.35)}">
        <div class="custom-map-avatar-fallback">👤</div>
        <span class="${statusDotClass}"></span>
      </div>
    `;
  }
}

function animateMarker(marker, startLatLng, endLatLng, duration = 800) {
  if (!marker) return;
  const startLat = startLatLng.lat || startLatLng[0];
  const startLng = startLatLng.lng || startLatLng[1];
  const endLat = endLatLng[0];
  const endLng = endLatLng[1];

  if (startLat === endLat && startLng === endLng) return;

  const startTime = performance.now();

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    
    // Easing: easeOutQuad
    const t = progress * (2 - progress);

    const currentLat = startLat + (endLat - startLat) * t;
    const currentLng = startLng + (endLng - startLng) * t;

    marker.setLatLng([currentLat, currentLng]);

    if (progress < 1) {
      requestAnimationFrame(step);
    }
  }
  requestAnimationFrame(step);
}

function loadFriendLocation(friendUid) {
  const roomId = makeRoomId(myUid, friendUid);
  const c = contacts[currentIndex];

  if (db && isFirebaseLive) {
    friendLocationRef = db.ref(`rooms/${roomId}/location/${friendUid}`);
    friendLocationRef.on('value', snap => {
      const loc = snap.val();
      handleFriendLocationUpdate(loc, c);
    });
  } else {
    // Demo Mode
    const locKey = `ros_location_${roomId}_friend`;
    const loc = JSON.parse(localStorage.getItem(locKey) || 'null');
    handleFriendLocationUpdate(loc, c);
  }
}

function handleFriendLocationUpdate(loc, contact) {
  const summarySubtitle = document.getElementById('sheet-summary-subtitle');
  const profileStatusDot = document.getElementById('sheet-profile-status-dot');
  const profileMood = document.getElementById('sheet-profile-mood');
  const profileEta = document.getElementById('sheet-profile-eta');
  const profileUpdated = document.getElementById('sheet-profile-updated');

  if (loc && loc.sharing) {
    const timeSinceUpdate = Date.now() - loc.updatedAt;
    const isOnline = timeSinceUpdate < 60000; // Active within last minute
    
    // Update Online dot in sheet
    if (profileStatusDot) {
      if (isOnline) profileStatusDot.classList.remove('offline');
      else profileStatusDot.classList.add('offline');
    }

    // Update Status string
    const statusText = loc.status || 'Active';
    summarySubtitle.textContent = `🟢 ${statusText} • Live`;

    if (profileMood) {
      profileMood.textContent = `Live Mood: ${contact?.mood || 'Unknown'} ${contact?.statusText ? '("' + contact.statusText + '")' : ''}`;
    }

    // Update Marker
    const friendColor = contact?.avatarColor || '#a855f7';
    const friendIcon = L.divIcon({
      html: createCustomMarkerHTML(contact?.imageUrl, friendColor, isOnline),
      iconSize: [44, 44],
      iconAnchor: [22, 22],
      className: ''
    });

    if (leafletMapInstance) {
      leafletMapInstance._friendIcon = friendIcon;
    }

    const prevLatLng = friendMarker ? friendMarker.getLatLng() : null;

    if (friendMarker) {
      if (prevLatLng) {
        animateMarker(friendMarker, prevLatLng, [loc.lat, loc.lng]);
      } else {
        friendMarker.setLatLng([loc.lat, loc.lng]);
      }
    } else if (leafletMapInstance) {
      friendMarker = L.marker([loc.lat, loc.lng], { icon: friendIcon })
        .addTo(leafletMapInstance);
      
      friendMarker.on('click', () => {
        setBottomSheetExpanded(true);
      });
    }

    // Calculate Distance & ETAs
    let distText = 'Calculating...';
    let etaText = '';
    if (myLastPosition) {
      const distanceMetres = getDistance(myLastPosition.lat, myLastPosition.lng, loc.lat, loc.lng);
      
      // Proximity check for Saved Spot (50 meters)
      if (distanceMetres <= 50) {
        btnSaveCurrentPlace.disabled = false;
        btnSaveCurrentPlace.title = "Save this Place";
      } else {
        btnSaveCurrentPlace.disabled = true;
        btnSaveCurrentPlace.title = "Get within 50m to Save Place";
      }

      if (distanceMetres < 1000) {
        distText = `${Math.round(distanceMetres)}m away`;
        etaText = `🚶 ${Math.ceil(distanceMetres / 80)} mins walking`;
      } else {
        const km = distanceMetres / 1000;
        distText = `${km.toFixed(1)} km away`;
        const walkTime = Math.ceil((km / 5) * 60);
        const driveTime = Math.ceil((km / 40) * 60);
        etaText = `🚗 ${driveTime} mins driving • 🚶 ${walkTime} mins walking`;
      }
    }

    summarySubtitle.textContent = `🟢 ${statusText} • ${distText}`;
    if (profileEta) profileEta.innerHTML = `<b>Distance:</b> ${distText}<br>${etaText}`;
    if (profileUpdated) profileUpdated.textContent = `Updated ${timeAgo(loc.updatedAt)}`;

    // Follow Mode Camera Pan
    if (isFollowingFriend && leafletMapInstance) {
      leafletMapInstance.panTo([loc.lat, loc.lng], { animate: true, duration: 0.5 });
    }

    // Proximity Notification (within 200m)
    if (myLastPosition) {
      const dist = getDistance(myLastPosition.lat, myLastPosition.lng, loc.lat, loc.lng);
      const contactName = contact?.name?.split(' ')[0] || 'Friend';
      const lastProximityKey = `ros_prox_notif_${contact?.linkedUid}`;
      const lastNotif = parseInt(localStorage.getItem(lastProximityKey) || '0');
      if (dist <= 200 && Date.now() - lastNotif > 120000) {
        showToast(`📍 You\'re near ${contactName}! (${Math.round(dist)}m away)`, 'info', 5000);
        triggerPushNotification(`📍 Near ${contactName}!`, `You're within ${Math.round(dist)}m of each other`, 'proximity');
        localStorage.setItem(lastProximityKey, Date.now().toString());
      }
    }

    // Load Nearby Memories
    loadNearbyMemories(loc.lat, loc.lng);

    // History Polyline Drawing
    if (showPathHistory) {
      drawHistoryPath(contact.linkedUid);
    }

    // Fit bounds initially if first load
    if (!prevLatLng) {
      fitMapBounds();
    }

  } else {
    // Friend is not sharing
    summarySubtitle.textContent = 'Not sharing location';
    if (profileStatusDot) profileStatusDot.classList.add('offline');
    if (profileEta) profileEta.textContent = 'Location not shared';
    if (profileUpdated) profileUpdated.textContent = '';
    
    if (friendMarker) {
      friendMarker.remove();
      friendMarker = null;
    }
    if (friendHistoryPolyline) {
      friendHistoryPolyline.remove();
      friendHistoryPolyline = null;
    }

    btnSaveCurrentPlace.disabled = true;
  }
}

function updateMyMarker(lat, lng) {
  if (!leafletMapInstance) return;

  const myColor = myProfile?.favColor || '#2563eb';
  const myIcon = L.divIcon({
    html: createCustomMarkerHTML(myProfile?.photoUrl, myColor, true),
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    className: ''
  });

  leafletMapInstance._myIcon = myIcon;

  if (myMarker) {
    myMarker.setLatLng([lat, lng]);
  } else {
    myMarker = L.marker([lat, lng], { icon: myIcon }).addTo(leafletMapInstance);
    myMarker.on('click', () => {
      leafletMapInstance.setView([lat, lng], 16);
    });
  }
}

function fitMapBounds() {
  if (!leafletMapInstance) return;
  const markers = [myMarker, friendMarker].filter(Boolean);
  if (markers.length === 2) {
    const group = L.featureGroup(markers);
    leafletMapInstance.fitBounds(group.getBounds().pad(0.35));
  } else if (markers.length === 1) {
    leafletMapInstance.setView(markers[0].getLatLng(), 15);
  }
}

// Recenter triggers
function recenterOnMe() {
  if (myLastPosition && leafletMapInstance) {
    leafletMapInstance.setView([myLastPosition.lat, myLastPosition.lng], 16);
  } else {
    showToast('📡 Geolocation not ready', 'info');
  }
}

function recenterOnFriend() {
  if (friendMarker && leafletMapInstance) {
    leafletMapInstance.setView(friendMarker.getLatLng(), 16);
  } else {
    showToast('👥 Friend is not currently sharing location', 'info');
  }
}

function setFollowMode(active) {
  isFollowingFriend = active;
  if (active) {
    btnMapFollow.classList.add('active');
    btnSheetFollowText.textContent = 'Following';
    showToast('🔒 Follow Mode Enabled (Keeping friend centered)', 'info');
    if (friendMarker && leafletMapInstance) {
      leafletMapInstance.panTo(friendMarker.getLatLng());
    }
  } else {
    btnMapFollow.classList.remove('active');
    btnSheetFollowText.textContent = 'Follow';
    showToast('🔓 Follow Mode Disabled', 'info');
  }
}

function toggleFollowMode() {
  setFollowMode(!isFollowingFriend);
}

function toggleHistoryMode(contactUid) {
  showPathHistory = !showPathHistory;
  if (showPathHistory) {
    btnMapHistory.classList.add('active');
    showToast('⏳ Today\'s path history enabled', 'info');
    drawHistoryPath(contactUid);
  } else {
    btnMapHistory.classList.remove('active');
    if (friendHistoryPolyline) {
      friendHistoryPolyline.remove();
      friendHistoryPolyline = null;
    }
    showToast('⏳ Path history hidden', 'info');
  }
}

// Geolocation Sharing Loop
let geoWatchId = null;

async function startSharingLocation() {
  if (!navigator.geolocation) {
    showToast('❌ Geolocation not supported by this browser', 'error');
    return;
  }

  const c = contacts[currentIndex];
  if (!c || !c.linkedUid) {
    showToast('💡 Link this contact to a connection first', 'info', 4000);
    return;
  }

  const roomId = makeRoomId(myUid, c.linkedUid);
  const durationMs = parseInt(shareDurationSelect.value, 10);
  const sharingUntil = durationMs > 0 ? Date.now() + durationMs : 0;

  showToast('📡 Locating connection satellites...', 'info', 2000);

  const writeLocation = async (lat, lng, speed, status, reverseAddress) => {
    const payload = { 
      lat, 
      lng, 
      speed: speed || 0,
      status: status || 'Stopped',
      address: reverseAddress || '',
      sharing: true, 
      updatedAt: Date.now() 
    };

    if (db && isFirebaseLive) {
      const locRef = db.ref(`rooms/${roomId}/location/${myUid}`);
      // Set onDisconnect so Firebase auto-clears sharing flag if the app goes offline
      locRef.onDisconnect().set({ sharing: false, updatedAt: Date.now() });
      await locRef.set(payload);
    } else {
      localStorage.setItem(`ros_location_${roomId}_my`, JSON.stringify(payload));
    }
  };

  isSharingLocation = true;
  updateSharingUI(sharingUntil);

  geoWatchId = navigator.geolocation.watchPosition(async position => {
    if (sharingUntil > 0 && Date.now() > sharingUntil) {
      stopSharingLocation();
      return;
    }

    const { latitude: lat, longitude: lng, speed: mpsSpeed } = position.coords;
    myLastPosition = { lat, lng };

    updateMyMarker(lat, lng);

    const speedKmh = mpsSpeed ? mpsSpeed * 3.6 : 0;
    let status = 'Stopped';
    if (speedKmh >= 12) {
      status = 'Driving';
    } else if (speedKmh > 1.5) {
      status = 'Walking';
    } else if (mpsSpeed && mpsSpeed > 0.2) {
      status = 'Moving';
    }

    const timeSinceLastWrite = Date.now() - lastUploadedTime;
    let distanceMoved = 999;
    if (lastUploadedLat !== null) {
      distanceMoved = getDistance(lastUploadedLat, lastUploadedLng, lat, lng);
    }

    if (distanceMoved > 10 || timeSinceLastWrite > 10000) {
      let address = '';
      if (distanceMoved > 60 || timeSinceLastWrite > 30000) {
        address = await reverseGeocode(lat, lng);
      } else {
        address = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      }

      await writeLocation(lat, lng, speedKmh, status, address);

      const historyPoint = { lat, lng, ts: Date.now() };
      if (db && isFirebaseLive) {
        db.ref(`rooms/${roomId}/locationHistory/${myUid}/${Date.now()}`).set(historyPoint);
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        db.ref(`rooms/${roomId}/locationHistory/${myUid}`).orderByChild('ts').endAt(cutoff).once('value', snap => {
          const oldPoints = snap.val();
          if (oldPoints) {
            Object.keys(oldPoints).forEach(key => {
              db.ref(`rooms/${roomId}/locationHistory/${myUid}/${key}`).remove();
            });
          }
        });
      } else {
        const histKey = `ros_history_${roomId}_my`;
        let history = JSON.parse(localStorage.getItem(histKey) || '[]');
        history.push(historyPoint);
        history = history.filter(p => p.ts > Date.now() - 24 * 60 * 60 * 1000);
        localStorage.setItem(histKey, JSON.stringify(history));
      }

      lastUploadedLat = lat;
      lastUploadedLng = lng;
      lastUploadedTime = Date.now();
    }

  }, err => {
    console.error('watchPosition error:', err);
    if (err.code === err.PERMISSION_DENIED) {
      showToast('❌ Location permission denied. Please allow GPS.', 'error', 4000);
      stopSharingLocation();
    } else {
      mapStatusBanner.style.display = 'flex';
      mapStatusBanner.textContent = '⚠️ GPS signal weak or unavailable...';
    }
  }, {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 0
  });
}

function stopSharingLocation() {
  isSharingLocation = false;
  if (geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }

  const c = contacts[currentIndex];
  if (!c) return;
  const roomId = c.linkedUid ? makeRoomId(myUid, c.linkedUid) : `local_${c.id}`;

  const payload = { sharing: false, updatedAt: Date.now() };
  if (db && isFirebaseLive && c.linkedUid) {
    const locRef = db.ref(`rooms/${roomId}/location/${myUid}`);
    // Cancel the onDisconnect handler so it doesn't fire again, then write stopped state
    locRef.onDisconnect().cancel();
    locRef.set(payload).catch(console.error);
  } else {
    localStorage.setItem(`ros_location_${roomId}_my`, JSON.stringify(payload));
  }

  if (myMarker) {
    myMarker.remove();
    myMarker = null;
  }

  updateSharingUI();
  showToast('⏹ Stopped sharing location', 'info');
}

function updateSharingUI(sharingUntil = 0) {
  const locLabel = btnLocation?.querySelector('.live-btn-label');

  if (isSharingLocation) {
    btnShareLocation.style.display = 'none';
    btnStopSharing.style.display   = 'block';
    mySharingRow.style.display     = 'flex';
    sharingUntilText.textContent   = sharingUntil > 0
      ? new Date(sharingUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'Until stopped';
    
    btnLocation.classList.add('location-active');
    btnLocation.title = 'You are sharing live location';
    if (locLabel) locLabel.textContent = 'Sharing';
  } else {
    btnShareLocation.style.display = 'block';
    btnStopSharing.style.display   = 'none';
    mySharingRow.style.display     = 'none';

    const c = contacts[currentIndex];
    const friendSharing = c?.linkedUid && connections[c.linkedUid]?.location?.sharing;
    if (!friendSharing) {
      btnLocation.classList.remove('location-active');
      btnLocation.title = 'Live Location';
      if (locLabel) locLabel.textContent = 'Location';
    }
  }
}

// Polyline drawing for history path
function drawHistoryPath(contactUid) {
  if (!leafletMapInstance) return;
  const roomId = makeRoomId(myUid, contactUid);

  const renderPolyline = (points) => {
    if (friendHistoryPolyline) {
      friendHistoryPolyline.remove();
      friendHistoryPolyline = null;
    }
    if (!points || points.length < 2) return;

    const latlngs = points.map(p => [p.lat, p.lng]);
    const friendColor = contacts[currentIndex]?.avatarColor || '#a855f7';

    friendHistoryPolyline = L.polyline(latlngs, {
      color: friendColor,
      weight: 4,
      opacity: 0.65,
      dashArray: '8, 12'
    }).addTo(leafletMapInstance);
  };

  if (db && isFirebaseLive) {
    db.ref(`rooms/${roomId}/locationHistory/${contactUid}`)
      .orderByChild('ts')
      .startAt(Date.now() - 24 * 60 * 60 * 1000)
      .once('value', snap => {
        const val = snap.val();
        if (val) {
          const list = Object.values(val).sort((a, b) => a.ts - b.ts);
          renderPolyline(list);
        }
      });
  } else {
    const histKey = `ros_history_${roomId}_friend`;
    const list = JSON.parse(localStorage.getItem(histKey) || '[]')
      .filter(p => p.ts > Date.now() - 24 * 60 * 60 * 1000)
      .sort((a, b) => a.ts - b.ts);
    renderPolyline(list);
  }
}

// Relationship Saved Places
function loadSavedPlaces(friendUid) {
  const roomId = makeRoomId(myUid, friendUid);

  const applyPlaces = (places) => {
    friendSavedPlacesMarkers.forEach(m => m.remove());
    friendSavedPlacesMarkers = [];

    savedPlacesList.innerHTML = '';

    if (!places || Object.keys(places).length === 0) {
      savedPlacesList.innerHTML = '<div class="places-empty-state" style="font-size: 12px; color: var(--ink-3); text-align: center; padding: 10px;">No saved spots yet. Stand together to save one!</div>';
      return;
    }

    const list = Object.values(places).sort((a, b) => b.ts - a.ts);
    
    list.forEach(p => {
      const heartIcon = L.divIcon({
        html: `<div class="heart-spot-marker" title="${p.name}">❤️</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        className: ''
      });

      if (leafletMapInstance) {
        const marker = L.marker([p.lat, p.lng], { icon: heartIcon })
          .addTo(leafletMapInstance)
          .bindPopup(`<b>❤️ ${p.name}</b><br>${p.type.toUpperCase()}<br>Saved ${new Date(p.ts).toLocaleDateString()}`);
        friendSavedPlacesMarkers.push(marker);
      }

      const placeItem = document.createElement('div');
      placeItem.className = 'saved-place-item';
      
      const emojiMap = { cafe: '☕', restaurant: '🍕', nature: '🌳', monument: '🏛️', home: '🏠', other: '❤️' };
      const iconEmoji = emojiMap[p.type] || '📍';

      placeItem.innerHTML = `
        <div class="place-item-icon">${iconEmoji}</div>
        <div class="place-item-details">
          <div class="place-item-name">${p.name}</div>
          <div class="place-item-meta">${p.type} • ${new Date(p.ts).toLocaleDateString()}</div>
        </div>
      `;

      placeItem.addEventListener('click', () => {
        if (leafletMapInstance) {
          leafletMapInstance.setView([p.lat, p.lng], 17);
        }
      });

      savedPlacesList.appendChild(placeItem);
    });
  };

  if (db && isFirebaseLive) {
    activeSavedPlacesRef = db.ref(`rooms/${roomId}/savedPlaces`);
    activeSavedPlacesRef.on('value', snap => {
      applyPlaces(snap.val());
    });
  } else {
    const key = `ros_places_${roomId}`;
    const places = JSON.parse(localStorage.getItem(key) || '{}');
    applyPlaces(places);
  }
}

// Saved Spot triggers
function openSavePlaceDialog() {
  savePlaceModalOverlay.classList.add('active');
  inputPlaceName.value = '';
}

function closeSavePlaceDialog() {
  savePlaceModalOverlay.classList.remove('active');
}

function confirmSavePlace() {
  const name = inputPlaceName.value.trim();
  const type = selectPlaceType.value;
  if (!name) {
    showToast('❌ Please specify a place name', 'error');
    return;
  }

  const c = contacts[currentIndex];
  if (!c || !c.linkedUid) return;

  const roomId = makeRoomId(myUid, c.linkedUid);
  
  if (!myLastPosition) {
    showToast('❌ GPS coordinates unavailable', 'error');
    return;
  }

  const newPlace = {
    id: Date.now().toString(),
    name: name,
    type: type,
    lat: myLastPosition.lat,
    lng: myLastPosition.lng,
    ts: Date.now()
  };

  if (db && isFirebaseLive) {
    db.ref(`rooms/${roomId}/savedPlaces/${newPlace.id}`).set(newPlace)
      .then(() => {
        closeSavePlaceDialog();
        showToast('❤️ Saved Spot to relationship timeline!', 'success');
      })
      .catch(console.error);
  } else {
    const key = `ros_places_${roomId}`;
    const places = JSON.parse(localStorage.getItem(key) || '{}');
    places[newPlace.id] = newPlace;
    localStorage.setItem(key, JSON.stringify(places));
    closeSavePlaceDialog();
    loadSavedPlaces(c.linkedUid);
    showToast('❤️ Saved Spot to relationship timeline!', 'success');
  }
}

// Load geotagged memories nearby
function loadNearbyMemories(friendLat, friendLng) {
  const c = contacts[currentIndex];
  if (!c) return;
  const roomId = c.linkedUid ? makeRoomId(myUid, c.linkedUid) : `local_${c.id}`;

  const applyNearby = (memoriesListArray) => {
    nearbyMemoriesList.innerHTML = '';
    
    const nearby = memoriesListArray.filter(m => {
      if (m.lat && m.lng) {
        const dist = getDistance(friendLat, friendLng, m.lat, m.lng);
        return dist <= 500;
      }
      return false;
    });

    if (nearby.length === 0) {
      nearbyMemoriesList.innerHTML = '<div class="memories-empty-state" style="font-size: 12px; color: var(--ink-3); text-align: center; padding: 10px;">No memories geotagged near friend\'s position.</div>';
      return;
    }

    nearby.forEach(m => {
      const memItem = document.createElement('div');
      memItem.className = 'nearby-memory-item';
      memItem.innerHTML = `
        <div class="memory-item-icon">📸</div>
        <div class="memory-item-details">
          <div class="memory-item-text">${m.text}</div>
          <div class="memory-item-meta">${m.category || 'General'} • ${new Date(m.timestamp).toLocaleDateString()}</div>
        </div>
      `;
      memItem.addEventListener('click', () => {
        if (leafletMapInstance) {
          leafletMapInstance.setView([m.lat, m.lng], 17);
        }
      });
      nearbyMemoriesList.appendChild(memItem);
    });
  };

  if (db && isFirebaseLive && c.linkedUid) {
    db.ref(`rooms/${roomId}/memories`).once('value', snap => {
      const val = snap.val();
      if (val) {
        const arr = Object.values(val);
        applyNearby(arr);
      }
    });
  } else {
    const key = `ros_memories_${roomId}`;
    const mems = JSON.parse(localStorage.getItem(key) || '[]');
    applyNearby(mems);
  }
}

// Distance Helper (Haversine)
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c; // in metres
}

// Bottom Sheet dragging / toggling mechanics
function setBottomSheetExpanded(expand) {
  if (expand) {
    mapBottomSheet.classList.add('expanded');
  } else {
    mapBottomSheet.classList.remove('expanded');
  }
}

function setupBottomSheetEvents() {
  bottomSheetHeader.onclick = (e) => {
    if (e.target.closest('button') || e.target.closest('select')) return;
    const isExpanded = mapBottomSheet.classList.contains('expanded');
    setBottomSheetExpanded(!isExpanded);
  };

  let startY = 0;

  bottomSheetHandle.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    mapBottomSheet.style.transition = 'none';
  });

  bottomSheetHandle.addEventListener('touchmove', (e) => {
    const currentY = e.touches[0].clientY;
    const deltaY = currentY - startY;
    
    const isExpanded = mapBottomSheet.classList.contains('expanded');
    let currentTranslate = isExpanded ? 0 : mapBottomSheet.offsetHeight - 76;
    let newTranslate = currentTranslate + deltaY;

    newTranslate = Math.max(0, Math.min(newTranslate, mapBottomSheet.offsetHeight - 76));
    mapBottomSheet.style.transform = `translateY(${newTranslate}px)`;
  });

  bottomSheetHandle.addEventListener('touchend', (e) => {
    mapBottomSheet.style.transition = '';
    const endY = e.changedTouches[0].clientY;
    const deltaY = endY - startY;

    if (deltaY < -40) {
      setBottomSheetExpanded(true);
    } else if (deltaY > 40) {
      setBottomSheetExpanded(false);
    } else {
      const isExpanded = mapBottomSheet.classList.contains('expanded');
      setBottomSheetExpanded(isExpanded);
    }
  });
}

function setupMapControlButtons(contact) {
  btnMapMyLoc.onclick = recenterOnMe;
  btnMapFriendLoc.onclick = recenterOnFriend;
  btnMapFitBoth.onclick = fitMapBounds;
  
  btnMapFollow.onclick = toggleFollowMode;
  btnSheetFollowToggle.onclick = toggleFollowMode;

  btnMapHistory.onclick = () => toggleHistoryMode(contact.linkedUid);

  btnSheetNav.onclick = () => {
    if (friendMarker) {
      const latlng = friendMarker.getLatLng();
      const originParam = myLastPosition ? `&origin=${myLastPosition.lat},${myLastPosition.lng}` : '';
      window.open(`https://www.google.com/maps/dir/?api=1${originParam}&destination=${latlng.lat},${latlng.lng}`, '_blank');
    } else {
      showToast('❌ Friend is not sharing coordinates', 'error');
    }
  };

  btnSheetCall.onclick = () => {
    closeLocationModal();
    handleCall();
  };

  btnSheetChat.onclick = () => {
    closeLocationModal();
    openChatDrawer(contact);
  };

  btnSheetProfile.onclick = () => {
    closeLocationModal();
  };

  btnSaveCurrentPlace.onclick = openSavePlaceDialog;
  btnCancelSavePlace.onclick = closeSavePlaceDialog;
  btnConfirmSavePlace.onclick = confirmSavePlace;
}


/* ================================================================
   26. PING / CHECK-IN SYSTEM
================================================================ */
function sendPing() {
  const c = contacts[currentIndex];
  if (!c) return;

  if (!c.linkedUid) {
    showToast('💡 Link this contact to a connection first via 🔗', 'info', 4000);
    return;
  }

  // Rate limit pings
  const now = Date.now();
  if (now - lastPingTime < PING_COOLDOWN) {
    const secs = Math.ceil((PING_COOLDOWN - (now - lastPingTime)) / 1000);
    showToast(`⏳ Wait ${secs}s before pinging again`, 'warn', 2500);
    return;
  }
  lastPingTime = now;

  const ping = {
    fromUid:  myUid,
    fromCode: myCode,
    fromName: myProfile.name || myProfile.username || 'Someone',
    ts:       Date.now()
  };

  if (db && isFirebaseLive) {
    db.ref(`pings/${c.linkedUid}`).set(ping)
      .then(() => console.log('✅ Ping sent to:', c.linkedUid))
      .catch(err => console.error('❌ Ping failed:', err));
    setTimeout(() => db.ref(`pings/${c.linkedUid}`).remove().catch(() => {}), 5000);
  } else {
    // Demo mode
    localStorage.setItem(`ros_ping_${c.linkedUid}`, JSON.stringify(ping));
    setTimeout(() => localStorage.removeItem(`ros_ping_${c.linkedUid}`), 5000);
  }

  // Update check-in count
  c.checkIns = (c.checkIns || 0) + 1;
  saveContacts();

  // Ping animation on button
  btnPing.classList.add('pinging');
  setTimeout(() => btnPing.classList.remove('pinging'), 3000);

  showToast(`👋 Pinged ${c.name.split(' ')[0]}!`, 'ping');
  popAnimation(btnPing, 1.3);
}

function listenForPings() {
  if (!db || !isFirebaseLive) return;

  const ref = db.ref(`pings/${myUid}`);
  ref.on('value', snap => {
    const ping = snap.val();
    if (ping && typeof ping.ts === 'number' && Date.now() - ping.ts < 15000) {
      showToast(`👋 ${ping.fromName || 'A friend'} just checked in with you!`, 'ping');
    }
  });
}
    /* ================================================================
   27. MEMORIES & TIME CAPSULES
================================================================ */
function openMemoriesModal() {
  const c = contacts[currentIndex];
  if (!c) return;

  const roomId = c.linkedUid ? makeRoomId(myUid, c.linkedUid) : `local_${c.id}`;
  activeRoomId = roomId;

  // Reset inputs
  document.getElementById('input-new-memory').value = '';
  document.getElementById('memory-category-select').value = 'General';
  document.getElementById('chk-memory-star').checked = false;
  document.getElementById('input-capsule-text').value = '';
  document.getElementById('input-capsule-date').value = '';

  // Show active tab
  switchMemoriesTab('memories');

  memoriesModalOverlay.classList.add('active');
  renderMemoriesTimeline(roomId);
  renderCapsulesTimeline(roomId);
}

function closeMemoriesModal() {
  memoriesModalOverlay.classList.remove('active');
  inputNewMemory.value = '';
}

function switchMemoriesTab(tab) {
  const btnMems = document.getElementById('tab-btn-memories');
  const btnCaps = document.getElementById('tab-btn-capsule');
  const paneMems = document.getElementById('tab-content-memories');
  const paneCaps = document.getElementById('tab-content-capsule');

  if (tab === 'memories') {
    btnMems?.classList.add('active');
    btnCaps?.classList.remove('active');
    paneMems?.classList.add('active');
    paneCaps?.classList.remove('active');
  } else {
    btnCaps?.classList.add('active');
    btnMems?.classList.remove('active');
    paneCaps?.classList.add('active');
    paneMems?.classList.remove('active');
  }
}

function calculateStreak(mems) {
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const thisMonthMems = mems.filter(m => {
    const d = new Date(m.timestamp);
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  });

  const streakVal = document.querySelector('#memory-streak-pill b');
  if (streakVal) {
    streakVal.textContent = thisMonthMems.length;
  }
}

function addMemory() {
  const text = inputNewMemory.value.trim();
  if (!text) return;

  const c = contacts[currentIndex];
  const roomId = c?.linkedUid ? makeRoomId(myUid, c?.linkedUid) : `local_${c?.id}`;

  const category = document.getElementById('memory-category-select')?.value || 'General';
  const isStarred = document.getElementById('chk-memory-star')?.checked || false;

  const memory = {
    id:        Date.now().toString(),
    text:      text,
    author:    myProfile.name || myCode,
    authorUid: myUid,
    category:  category,
    starred:   isStarred,
    timestamp: Date.now()
  };
  if (myLastPosition) {
    memory.lat = myLastPosition.lat;
    memory.lng = myLastPosition.lng;
  }

  if (db && c?.linkedUid) {
    db.ref(`rooms/${roomId}/memories`).push(memory).catch(console.error);
  } else {
    const key = `ros_memories_${roomId}`;
    const mems = JSON.parse(localStorage.getItem(key) || '[]');
    mems.unshift(memory);
    localStorage.setItem(key, JSON.stringify(mems));
    renderMemoriesTimeline(roomId);
  }

  inputNewMemory.value = '';
  document.getElementById('chk-memory-star').checked = false;
  document.getElementById('memory-category-select').value = 'General';
  showToast('📸 Memory saved!', 'success');
  popAnimation(btnAddMemory, 1.05);

  // Update card display memory tile immediately
  if (c) {
    c.memory = text;
    saveContacts();
    renderCard(c);
  }
}

function renderMemoriesTimeline(roomId) {
  if (db && !roomId.startsWith('local_')) {
    db.ref(`rooms/${roomId}/memories`).orderByChild('timestamp').limitToLast(100)
      .once('value', snap => {
        const mems = [];
        snap.forEach(child => {
          const m = child.val();
          m.id = m.id || child.key;
          mems.push(m);
        });
        displayMemories(mems.reverse());
      });
  } else {
    const key  = `ros_memories_${roomId}`;
    const mems = JSON.parse(localStorage.getItem(key) || '[]');
    displayMemories(mems);
  }
}

function displayMemories(mems) {
  calculateStreak(mems);

  if (!mems.length) {
    memoriesScroll.innerHTML = `
      <div class="chat-empty-state">
        <div class="chat-empty-icon">📸</div>
        <p>No memories yet</p>
        <small>Add moments, milestones, and notes you share together</small>
      </div>`;
    return;
  }

  memoriesScroll.innerHTML = '';
  mems.forEach((mem) => {
    const item = document.createElement('div');
    item.className = `memory-item ${mem.starred ? 'starred-moment' : ''}`;
    
    const catEmojis = {
      General: '🏷️',
      Milestone: '🎯',
      Trip: '✈️',
      Funny: '😂',
      'Deep Talk': '💬',
      Gift: '🎁'
    };
    const emoji = catEmojis[mem.category || 'General'] || '🌟';

    item.innerHTML = `
      <div class="memory-item-dot">${emoji}</div>
      <div class="memory-item-body">
        <div class="memory-item-text">
          ${mem.starred ? '<span class="star-badge">⭐ Top Moment</span> ' : ''}
          ${escapeHtml(mem.text)}
        </div>
        <div class="memory-item-meta">
          <span class="memory-item-tag cat-${(mem.category || 'General').toLowerCase().replace(' ', '')}">${mem.category || 'General'}</span>
          <span>·</span>
          <span class="memory-item-author">${mem.author || 'You'}</span>
          <span>·</span>
          <span>${new Date(mem.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
        </div>
      </div>`;
    memoriesScroll.appendChild(item);
  });
}

/* ⏳ Time Capsule Functions */
function addCapsule() {
  const text = document.getElementById('input-capsule-text').value.trim();
  const dateVal = document.getElementById('input-capsule-date').value;

  if (!text) {
    showToast('Write a capsule message first', 'warn');
    return;
  }
  if (!dateVal) {
    showToast('Choose an unlock date in the future', 'warn');
    return;
  }

  const unlockTime = new Date(dateVal).getTime();
  if (unlockTime <= Date.now()) {
    showToast('Unlock date must be in the future', 'warn');
    return;
  }

  const c = contacts[currentIndex];
  const roomId = c?.linkedUid ? makeRoomId(myUid, c?.linkedUid) : `local_${c?.id}`;

  const capsule = {
    id:         Date.now().toString(),
    text:       text,
    unlockDate: unlockTime,
    author:     myProfile.name || myCode,
    authorUid:  myUid,
    timestamp:  Date.now()
  };

  if (db && c?.linkedUid) {
    db.ref(`rooms/${roomId}/capsules`).push(capsule).catch(console.error);
  } else {
    const key = `ros_capsules_${roomId}`;
    const caps = JSON.parse(localStorage.getItem(key) || '[]');
    caps.unshift(capsule);
    localStorage.setItem(key, JSON.stringify(caps));
    renderCapsulesTimeline(roomId);
  }

  document.getElementById('input-capsule-text').value = '';
  document.getElementById('input-capsule-date').value = '';
  showToast('🔒 Time Capsule sealed & locked!', 'success');
  popAnimation(document.getElementById('btn-add-capsule'), 1.05);
}

function renderCapsulesTimeline(roomId) {
  if (db && !roomId.startsWith('local_')) {
    db.ref(`rooms/${roomId}/capsules`).orderByChild('timestamp').limitToLast(50)
      .once('value', snap => {
        const caps = [];
        snap.forEach(child => {
          const c = child.val();
          c.id = c.id || child.key;
          caps.push(c);
        });
        displayCapsules(caps.reverse());
      });
  } else {
    const key  = `ros_capsules_${roomId}`;
    const caps = JSON.parse(localStorage.getItem(key) || '[]');
    displayCapsules(caps);
  }
}

function displayCapsules(caps) {
  const scroll = document.getElementById('capsules-scroll');
  if (!scroll) return;

  if (!caps.length) {
    scroll.innerHTML = `
      <div class="chat-empty-state">
        <div class="chat-empty-icon">🔒</div>
        <p>No capsules sealed yet</p>
        <small>Surprise your future selves with delayed messages</small>
      </div>`;
    return;
  }

  scroll.innerHTML = '';
  const now = Date.now();

  caps.forEach((cap) => {
    const isUnlocked = now >= cap.unlockDate;
    const item = document.createElement('div');
    item.className = `capsule-item ${isUnlocked ? 'unlocked' : 'locked'}`;

    const unlockStr = new Date(cap.unlockDate).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

    if (isUnlocked) {
      item.style.cursor = 'pointer';
      item.innerHTML = `
        <div class="capsule-icon">🔓</div>
        <div class="capsule-body">
          <div class="capsule-text">${escapeHtml(cap.text)}</div>
          <div class="capsule-meta">
            <span>Opened capsule from ${cap.author || 'You'}</span>
            <span>·</span>
            <span>Sealed ${new Date(cap.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
          </div>
        </div>`;
    } else {
      const daysLeft = Math.ceil((cap.unlockDate - now) / 864e5);
      item.innerHTML = `
        <div class="capsule-icon">🔒</div>
        <div class="capsule-body">
          <div class="capsule-text locked-text">Message sealed inside...</div>
          <div class="capsule-meta">
            <span class="lock-pill">Unlocks in ${daysLeft} day${daysLeft !== 1 ? 's' : ''} (${unlockStr})</span>
            <span>·</span>
            <span>Sealed by ${cap.author || 'You'}</span>
          </div>
        </div>`;
    }
    scroll.appendChild(item);
  });
}

// ── Bond Timeline Modal ──
function openTimelineModal() {
  const c = contacts[currentIndex];
  if (!c) return;

  loadTimeline(c);
  document.getElementById('timeline-modal-overlay').classList.add('active');
}

function closeTimelineModal() {
  document.getElementById('timeline-modal-overlay').classList.remove('active');
}

function loadTimeline(contact) {
  const scroll = document.getElementById('timeline-scroll');
  scroll.innerHTML = '';

  const friendName = contact.name || 'Friend';
  const myName = myProfile.name || 'You';

  // Update Storybook Cover Names
  const storyNames = document.getElementById('storybook-names');
  if (storyNames) {
    storyNames.innerHTML = `${myName.split(' ')[0]} <span style="color:var(--orange)">❤</span> ${friendName.split(' ')[0]}`;
  }

  const entries = [];
  const roomId = contact.linkedUid ? makeRoomId(myUid, contact.linkedUid) : `local_${contact.id}`;

  // 1. Connection Event
  if (contact.linkedUid && connections[contact.linkedUid]) {
    const conn = connections[contact.linkedUid];
    if (conn.connectedAt) {
      entries.push({
        icon: '❤️',
        title: 'Connected via Code',
        desc: `Shared connect codes and linked profiles!`,
        ts: conn.connectedAt
      });
    }
  }

  // 2. Chat History (First message & total counts)
  const chatKey = `ros_chat_${roomId}`;
  let msgs = [];
  try {
    msgs = JSON.parse(localStorage.getItem(chatKey) || '[]');
  } catch {}

  if (msgs.length > 0) {
    entries.push({
      icon: '💬',
      title: 'First Word',
      desc: `You started chatting! First message: "${msgs[0].text ? msgs[0].text.slice(0, 45) : '🎤 Voice message'}..."`,
      ts: msgs[0].timestamp
    });
  }

  // 3. Shared Memories & Time Capsules
  const memKey = `ros_memories_${roomId}`;
  let mems = [];
  try {
    mems = JSON.parse(localStorage.getItem(memKey) || '[]');
  } catch {}
  mems.forEach(m => {
    const isStarred = m.starred ? ' ⭐ Highlight Moment!' : '';
    entries.push({
      icon: m.starred ? '⭐' : '📸',
      title: `${m.category || 'Memory'}`,
      desc: `${m.text}${isStarred}`,
      ts: m.timestamp
    });
  });

  // Locked/Unlocked Time Capsules
  const capsKey = `ros_capsules_${roomId}`;
  let capsules = [];
  try {
    capsules = JSON.parse(localStorage.getItem(capsKey) || '[]');
  } catch {}
  capsules.forEach(cap => {
    const isUnlocked = Date.now() >= cap.unlockDate;
    entries.push({
      icon: isUnlocked ? '🔓' : '🔒',
      title: isUnlocked ? 'Unlocked Time Capsule' : 'Sealed Time Capsule',
      desc: isUnlocked ? cap.text : `Sealed message. Unlocks in the future.`,
      ts: cap.timestamp
    });
  });

  // Sort timeline by timestamp ascending
  entries.sort((a, b) => a.ts - b.ts);

  // Update quick stats counters
  const scoreVal = document.getElementById('story-stat-score');
  const memsVal = document.getElementById('story-stat-mems');
  const pingsVal = document.getElementById('story-stat-pings');

  if (scoreVal) scoreVal.textContent = calculateHealthScore(contact);
  if (memsVal) memsVal.textContent = mems.length + capsules.length;
  if (pingsVal) pingsVal.textContent = contact.checkIns || 0;

  if (entries.length === 0) {
    scroll.innerHTML = `
      <div class="chat-empty-state" style="margin:20px 0;">
        <div class="chat-empty-icon">📖</div>
        <p>Your storybook is blank</p>
        <small>Start chatting, sealing capsules, or saving memories to write your first page!</small>
      </div>`;
    return;
  }

  entries.forEach(e => {
    const item = document.createElement('div');
    item.className = 'timeline-item';
    item.innerHTML = `
      <div class="timeline-item-dot">${e.icon}</div>
      <div class="timeline-item-body">
        <div class="timeline-item-title">${e.title}</div>
        <div class="timeline-item-desc">${escapeHtml(e.desc)}</div>
        <div class="timeline-item-date">${new Date(e.ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>
      </div>
    `;
    scroll.appendChild(item);
  });
}



/* ================================================================
   28. BIRTHDAY DETECTION
================================================================ */
function checkBirthdaysOnLoad() {
  const alerts = [];
  contacts.forEach(c => {
    const days = daysUntilBirthday(c.birthday);
    if (days !== null && days <= 7) {
      if (days === 0) alerts.push(`🎉 Today is ${c.name}'s birthday!`);
      else alerts.push(`🎂 ${c.name}'s birthday in ${days} day${days !== 1 ? 's' : ''}!`);
    }
  });

  // Show top alert as toast
  if (alerts.length) {
    showToast(alerts[0], 'warn', 7000);
    if (Notification.permission === 'granted' && alerts.length) {
      new Notification('🎂 Relationship OS', {
        body: alerts.join('\n'),
        icon: '📇'
      });
    }
  }
}


/* ================================================================
   29. TOAST NOTIFICATIONS
================================================================ */
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.classList.add('toast-show');
    });
  });

  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 400);
  }, duration);
}


/* ================================================================
   30. MOOD & STATUS SYSTEM
================================================================ */
function saveMoodStatus() {
  const statusText = inputStatusText.value.trim().slice(0, 120);
  myStatus = statusText;
  localStorage.setItem('ros_mood',   myMood);
  localStorage.setItem('ros_status', myStatus);

  if (db && isFirebaseLive) {
    db.ref(`users/${myUid}`).update({ mood: myMood, status: myStatus })
      .then(() => console.log('✅ Mood/status synced to Firebase'))
      .catch(err => console.error('❌ Mood update failed:', err));
  } else {
    broadcastPresence();
  }

  showToast('✅ Status updated!', 'success');
}

function broadcastMood(mood) {
  myMood = mood;
  localStorage.setItem('ros_mood', myMood);

  // Sync selection active states
  document.querySelectorAll('#mood-mini-picker .mood-mini-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.mood === myMood);
  });
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.mood === myMood);
  });

  if (db && isFirebaseLive) {
    db.ref(`users/${myUid}`).update({ mood: myMood })
      .then(() => console.log('✅ Mood broadcasted!'))
      .catch(err => console.error('❌ Mood broadcast failed:', err));
  } else {
    broadcastPresence();
  }

  showToast(`✅ Mood set to ${mood}`, 'success', 2000);
}

// Mood button selection (Connect Modal)
document.querySelectorAll('.mood-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    myMood = btn.dataset.mood;
    popAnimation(btn, 1.3);
    
    // Also sync mini picker
    document.querySelectorAll('#mood-mini-picker .mood-mini-btn').forEach(mini => {
      mini.classList.toggle('selected', mini.dataset.mood === myMood);
    });
  });
});

// Card Live Mood Button selection (Broadcast Mood Selector Bar)
document.querySelectorAll('#mood-mini-picker .mood-mini-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    broadcastMood(btn.dataset.mood);
    popAnimation(btn, 1.35);
  });
});



/* ================================================================
   31. EVENT LISTENERS
================================================================ */

// ── Navigation ──
document.getElementById('btn-profile').addEventListener('click', openProfileModal);
btnUp.addEventListener('click',   () => navigate('prev'));
btnDown.addEventListener('click', () => navigate('next'));
btnConnect.addEventListener('click', openConnectModal);
if (btnAdd) {
  btnAdd.addEventListener('click', createNewContact);
}

// ── Wallet back cards ──
cardBack1.addEventListener('click', () => walletSwap(cardBack1, 1));
cardBack2.addEventListener('click', () => walletSwap(cardBack2, 2));

// ── Card action buttons ──
btnFavorite.addEventListener('click', toggleFavorite);
document.getElementById('btn-delete-card').addEventListener('click', deleteCurrentContact);
btnMessage.addEventListener('click',  handleMessage);
btnRemind.addEventListener('click',   handleReminder);
btnVoice.addEventListener('click',    toggleVoiceMemo);
document.getElementById('btn-call-contact').addEventListener('click', handleCall);

// ── Reminder modal ──
document.getElementById('btn-save-reminder')?.addEventListener('click', _applyReminderFromModal);
document.getElementById('btn-cancel-reminder')?.addEventListener('click', () => {
  const overlay = document.getElementById('reminder-modal-overlay');
  if (overlay) overlay.classList.remove('active');
  if (history.state && history.state.modal === 'reminder-modal-overlay') history.back();
});
document.getElementById('btn-close-reminder-modal-x')?.addEventListener('click', () => {
  const overlay = document.getElementById('reminder-modal-overlay');
  if (overlay) overlay.classList.remove('active');
  if (history.state && history.state.modal === 'reminder-modal-overlay') history.back();
});
document.getElementById('reminder-modal-overlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('reminder-modal-overlay')) {
    document.getElementById('reminder-modal-overlay').classList.remove('active');
    if (history.state && history.state.modal === 'reminder-modal-overlay') history.back();
  }
});

// Walkie-Talkie events
if (btnWalkie) {
  btnWalkie.addEventListener('mousedown',  startWalkieTalkie);
  btnWalkie.addEventListener('mouseup',    stopWalkieTalkie);
  btnWalkie.addEventListener('mouseleave', stopWalkieTalkie);
  btnWalkie.addEventListener('touchstart', e => {
    e.preventDefault();
    startWalkieTalkie();
  }, { passive: false });
  btnWalkie.addEventListener('touchend', e => {
    e.preventDefault();
    stopWalkieTalkie();
  }, { passive: false });
}

// ── Live feature buttons ──
btnLocation.addEventListener('click', openLocationModal);
if (locationShareBanner) {
  locationShareBanner.addEventListener('click', openLocationModal);
}
btnPing.addEventListener('click',     sendPing);
btnMemories.addEventListener('click', openMemoriesModal);
document.getElementById('btn-timeline').addEventListener('click', openTimelineModal);

// ── Profile modal ──
document.getElementById('btn-upload-trigger').addEventListener('click', () => {
  document.getElementById('profile-photo-input').click();
});
document.getElementById('profile-photo-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  showToast('📸 Downscaling photo...', 'info', 2000);
  downscaleImage(file, 256, 256, dataUrl => {
    inputImageUrl.value = dataUrl;
    updateProfilePhotoPreview(dataUrl);
    showToast('✅ Photo prepared! Save profile to sync.', 'success');
  });
});
inputImageUrl.addEventListener('input', e => {
  updateProfilePhotoPreview(e.target.value.trim());
});
document.getElementById('btn-save-profile').addEventListener('click', submitProfile);
document.getElementById('btn-close-profile-modal').addEventListener('click', closeProfileModal);
document.getElementById('profile-modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('profile-modal-overlay')) closeProfileModal();
});

// ── WebRTC calling overlays ──
document.getElementById('btn-accept-call').addEventListener('click', acceptCall);
document.getElementById('btn-decline-call').addEventListener('click', declineCall);

// ── Connect modal ──
btnCloseConnectModal.addEventListener('click', closeConnectModal);
connectModalOverlay.addEventListener('click', e => {
  if (e.target === connectModalOverlay) closeConnectModal();
});
btnDoConnect.addEventListener('click', doConnect);
inputFriendCode.addEventListener('keydown', e => {
  if (e.key === 'Enter') doConnect();
});
inputFriendCode.addEventListener('input', () => {
  inputFriendCode.value = inputFriendCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
btnCopyBigCode.addEventListener('click', () => {
  navigator.clipboard.writeText(myCode).then(() => showToast('📋 Code copied!', 'success'));
});
btnSaveMood.addEventListener('click', saveMoodStatus);

// ── My code pill copy ──
myCodeCopyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(myCode).then(() => showToast('📋 Code copied!', 'success'));
});

// ── Chat drawer ──
btnCloseChat.addEventListener('click', closeChatDrawer);
chatOverlay.addEventListener('click', e => { if (e.target === chatOverlay) closeChatDrawer(); });
btnSendMsg.addEventListener('click', sendChatMessage);
chatInputField.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
});
chatInputField.addEventListener('input', handleChatInputTyping);

// ── Location modal ──
btnCloseLocationX?.addEventListener('click',    closeLocationModal);
btnCloseLocationModal?.addEventListener('click', closeLocationModal);
locationModalOverlay.addEventListener('click', e => {
  if (e.target === locationModalOverlay) closeLocationModal();
});
btnShareLocation.addEventListener('click', startSharingLocation);
btnStopSharing.addEventListener('click',   stopSharingLocation);

// ── Memories modal ──
btnCloseMemoriesX.addEventListener('click',    closeMemoriesModal);
btnCloseMemoriesModal.addEventListener('click', closeMemoriesModal);
memoriesModalOverlay.addEventListener('click', e => {
  if (e.target === memoriesModalOverlay) closeMemoriesModal();
});
btnAddMemory.addEventListener('click', addMemory);
inputNewMemory.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.ctrlKey) addMemory();
});

// Tab switching events
document.getElementById('tab-btn-memories')?.addEventListener('click', () => switchMemoriesTab('memories'));
document.getElementById('tab-btn-capsule')?.addEventListener('click', () => switchMemoriesTab('capsules'));

// Capsule seal button event
document.getElementById('btn-add-capsule')?.addEventListener('click', addCapsule);

// ── Timeline & Storybook modal ──
document.getElementById('btn-close-timeline-x').addEventListener('click', closeTimelineModal);
document.getElementById('btn-close-timeline-modal').addEventListener('click', closeTimelineModal);
document.getElementById('timeline-modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('timeline-modal-overlay')) closeTimelineModal();
});

// Export storybook event
document.getElementById('btn-export-storybook')?.addEventListener('click', () => {
  const c = contacts[currentIndex];
  if (!c) return;

  const myName = myProfile.name || 'User';
  const friendName = c.name || 'Friend';
  const score = calculateHealthScore(c);

  let content = `==================================================\n`;
  content += `        📖 B O N D O S   S T O R Y B O O K        \n`;
  content += `        Relationship chapter: ${myName} & ${friendName} \n`;
  content += `==================================================\n\n`;
  content += `⚡ Relationship Health Score: ${score}/100\n`;
  content += `⭐ Total check-ins to date: ${c.checkIns || 0}\n\n`;
  content += `----------------- OUR TIMELINE -----------------\n`;

  const items = document.querySelectorAll('#timeline-scroll .timeline-item');
  items.forEach(item => {
    const title = item.querySelector('.timeline-item-title')?.textContent || '';
    const desc = item.querySelector('.timeline-item-desc')?.textContent || '';
    const date = item.querySelector('.timeline-item-date')?.textContent || '';
    content += `[${date}] ${title.toUpperCase()}\n    "${desc}"\n\n`;
  });

  content += `==================================================\n`;
  content += `   "Relationships aren't static. Nurture them."\n`;
  content += `==================================================\n`;

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `storybook_${myName.toLowerCase().replace(/\s+/g,'')}_${friendName.toLowerCase().replace(/\s+/g,'')}.txt`;
  link.click();

  showToast('📖 Storybook page exported as text file!', 'success');
});

/* ================================================================
   History / Back-Button Navigation Stack
   Pushes a state every time a modal opens so the browser back button
   closes the modal instead of exiting the PWA.
================================================================ */
window._navStack = [];

function _pushModalState(modalId) {
  window._navStack.push(modalId);
  history.pushState({ modal: modalId }, '');
}

function _closeActiveModal() {
  const profileModal  = document.getElementById('profile-modal-overlay');
  const timelineModal = document.getElementById('timeline-modal-overlay');
  const reminderModal = document.getElementById('reminder-modal-overlay');
  const allModals = [
    { el: chatOverlay,           close: closeChatDrawer },
    { el: locationModalOverlay,  close: closeLocationModal },
    { el: memoriesModalOverlay,  close: closeMemoriesModal },
    { el: connectModalOverlay,   close: closeConnectModal },
    { el: profileModal,          close: closeProfileModal },
    { el: timelineModal,         close: closeTimelineModal },
    { el: reminderModal,         close: () => reminderModal && reminderModal.classList.remove('active') }
  ];
  for (const { el, close } of allModals) {
    if (el && el.classList.contains('active')) { close(); return true; }
  }
  return false;
}

window.addEventListener('popstate', (e) => {
  // If a modal is open, close it; this prevents the app from navigating away
  const closed = _closeActiveModal();
  if (!closed) {
    // No modal was open — push a blank state to keep the app alive
    history.pushState({}, '');
  }
});

// Push an initial state so the very first back press hits popstate
if (history.state === null) {
  history.pushState({ root: true }, '');
}

// Patch modal open functions to also push history state
const _origOpenChat      = openChatDrawer;
openChatDrawer = function(contact) { _origOpenChat(contact); history.pushState({ modal: 'chat-overlay' }, ''); };
const _origOpenLocation  = openLocationModal;
openLocationModal = function() { _origOpenLocation(); history.pushState({ modal: 'location-modal-overlay' }, ''); };
const _origOpenMemories  = openMemoriesModal;
openMemoriesModal = function() { _origOpenMemories(); history.pushState({ modal: 'memories-modal-overlay' }, ''); };
const _origOpenConnect   = openConnectModal;
openConnectModal = function() { _origOpenConnect(); history.pushState({ modal: 'connect-modal-overlay' }, ''); };
const _origOpenProfile   = openProfileModal;
openProfileModal = function() { _origOpenProfile(); history.pushState({ modal: 'profile-modal-overlay' }, ''); };
const _origOpenTimeline  = openTimelineModal;
openTimelineModal = function() { _origOpenTimeline(); history.pushState({ modal: 'timeline-modal-overlay' }, ''); };

// ── Keyboard shortcuts ──
document.addEventListener('keydown', e => {
  const profileModal  = document.getElementById('profile-modal-overlay');
  const timelineModal = document.getElementById('timeline-modal-overlay');
  const reminderModal = document.getElementById('reminder-modal-overlay');
  const anyModalOpen  = [profileModal, connectModalOverlay, locationModalOverlay,
                         memoriesModalOverlay, timelineModal, reminderModal]
    .some(m => m && m.classList.contains('active'));
  const chatOpen = chatOverlay.classList.contains('active');

  if (e.key === 'Escape') {
    const closed = _closeActiveModal();
    if (closed && history.state && history.state.modal) history.back();
    return;
  }

  if (anyModalOpen || chatOpen) {
    if (e.key === 'Enter' && e.ctrlKey) {
      if (profileModal && profileModal.classList.contains('active')) submitProfile();
    }
    return;
  }

  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowRight': navigate('next'); break;
    case 'ArrowUp':
    case 'ArrowLeft':  navigate('prev'); break;
    case 'p': case 'P': openProfileModal(); break;
    case 'c': case 'C': openConnectModal(); break;
    case 'f': case 'F': toggleFavorite();   break;
  }
});


// ── Touch / swipe on the card ──
let touchStartY = 0;
profileCard.addEventListener('touchstart', e => {
  touchStartY = e.changedTouches[0].clientY;
}, { passive: true });

profileCard.addEventListener('touchend', e => {
  const deltaY = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(deltaY) > 45) {
    deltaY < 0 ? navigate('next') : navigate('prev');
  }
}, { passive: true });


/* ================================================================
   31b. PUSH NOTIFICATION HELPER
================================================================ */
function triggerPushNotification(title, body, tag) {
  tag = tag || 'ros-notif';
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SHOW_NOTIFICATION', title: title, body: body, tag: tag });
  } else {
    new Notification(title, { body: body, icon: './icon-192.png', tag: tag });
  }
}

/* ================================================================
   31c. WALKIE-TALKIE — Push-to-Talk (WebRTC with corrected signalling paths)
   Signalling structure:
     walkie_signal/{receiverUid}/{senderUid}/offer          ← sender writes offer
     walkie_signal/{receiverUid}/{senderUid}/offerCandidates ← sender writes ICE candidates
     walkie_signal/{receiverUid}/{senderUid}/answer         ← receiver writes answer
     walkie_signal/{receiverUid}/{senderUid}/answerCandidates ← receiver writes ICE candidates
================================================================ */
async function startWalkieTalkie() {
  var c = contacts[currentIndex];
  if (!c || !c.linkedUid) { showToast('Link this contact to use Walkie-Talkie', 'error'); return; }
  if (!db || !isFirebaseLive) { showToast('Walkie-Talkie needs Firebase connection', 'warn'); return; }
  if (walkieActive) return; // already active
  try {
    walkieStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) { showToast('Microphone access denied — check browser permissions', 'error'); return; }

  walkieActive = true;
  if (btnWalkie) btnWalkie.classList.add('walkie-active');
  showToast('🎙️ Broadcasting... release to stop', 'info', 2000);

  var sigBase = 'walkie_signal/' + c.linkedUid + '/' + myUid;

  // Clean up any stale signalling data first
  await db.ref(sigBase).remove();

  walkie_pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });

  walkieStream.getTracks().forEach(function(t) { walkie_pc.addTrack(t, walkieStream); });

  walkie_pc.onicecandidate = function(ev) {
    if (ev.candidate) {
      db.ref(sigBase + '/offerCandidates').push(ev.candidate.toJSON());
    }
  };

  var offer = await walkie_pc.createOffer();
  await walkie_pc.setLocalDescription(offer);
  await db.ref(sigBase + '/offer').set({ sdp: offer.sdp, type: offer.type });

  // Listen for answer
  walkieSendRef = db.ref(sigBase + '/answer');
  walkieSendRef.on('value', async function(snap) {
    var ans = snap.val();
    if (ans && walkie_pc && walkie_pc.currentRemoteDescription === null) {
      try {
        await walkie_pc.setRemoteDescription(new RTCSessionDescription(ans));
      } catch(e) { console.warn('Walkie answer error:', e); }
    }
  });

  // Listen for receiver's ICE candidates
  walkieRecvRef = db.ref(sigBase + '/answerCandidates');
  walkieRecvRef.on('child_added', async function(cs) {
    var cand = cs.val();
    if (cand && walkie_pc) {
      try {
        await walkie_pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch(e) {}
    }
  });

  // Mark as active for the receiver to detect
  db.ref('walkie/' + c.linkedUid + '/from_' + myUid).set({ active: true, ts: Date.now() });
}

function stopWalkieTalkie() {
  if (!walkieActive) return;
  walkieActive = false;
  if (btnWalkie) btnWalkie.classList.remove('walkie-active');
  if (walkieStream) { walkieStream.getTracks().forEach(function(t) { t.stop(); }); walkieStream = null; }
  if (walkie_pc) { walkie_pc.close(); walkie_pc = null; }
  if (walkieSendRef) { walkieSendRef.off(); walkieSendRef = null; }
  if (walkieRecvRef) { walkieRecvRef.off(); walkieRecvRef = null; }
  var c = contacts[currentIndex];
  if (c && c.linkedUid && db && isFirebaseLive) {
    var sigBase = 'walkie_signal/' + c.linkedUid + '/' + myUid;
    db.ref('walkie/' + c.linkedUid + '/from_' + myUid).remove();
    db.ref(sigBase).remove();
  }
  showToast('Walkie-Talkie off', 'info', 1500);
}

function listenForWalkieTalkie() {
  if (!db || !isFirebaseLive || !myUid) return;
  db.ref('walkie/' + myUid).on('child_added', async function(snap) {
    var data = snap.val();
    if (!data || !data.active) return;
    var fromUid = snap.key.replace('from_', '');
    var senderName = (contacts.find(function(ct) { return ct.linkedUid === fromUid; }) || {}).name || 'Friend';
    showToast('🎙️ ' + senderName + ' is talking!', 'info', 3000);
    triggerPushNotification(senderName + ' is on Walkie-Talkie', 'Open app to listen', 'walkie');

    var sigBase = 'walkie_signal/' + myUid + '/' + fromUid;

    var recv_pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    recv_pc.ontrack = function(ev) {
      if (!walkieAudioElem) {
        walkieAudioElem = document.createElement('audio');
        walkieAudioElem.autoplay = true;
        walkieAudioElem.style.display = 'none';
        document.body.appendChild(walkieAudioElem);
      }
      walkieAudioElem.srcObject = ev.streams[0];
    };

    recv_pc.onicecandidate = function(ev) {
      if (ev.candidate) {
        db.ref(sigBase + '/answerCandidates').push(ev.candidate.toJSON());
      }
    };

    // Wait for offer to appear (poll with a short retry)
    var offerData = null;
    for (var attempt = 0; attempt < 15 && !offerData; attempt++) {
      var offerSnap = await db.ref(sigBase + '/offer').once('value');
      offerData = offerSnap.val();
      if (!offerData) await new Promise(r => setTimeout(r, 400));
    }
    if (!offerData) { console.warn('Walkie: no offer received'); recv_pc.close(); return; }

    await recv_pc.setRemoteDescription(new RTCSessionDescription(offerData));
    var answer = await recv_pc.createAnswer();
    await recv_pc.setLocalDescription(answer);
    await db.ref(sigBase + '/answer').set({ sdp: answer.sdp, type: answer.type });

    // Apply sender's ICE candidates
    db.ref(sigBase + '/offerCandidates').on('child_added', async function(cs) {
      var cand = cs.val();
      if (cand) {
        try { await recv_pc.addIceCandidate(new RTCIceCandidate(cand)); } catch(e) {}
      }
    });

    // Clean up when sender stops
    db.ref('walkie/' + myUid + '/' + snap.key).on('value', function(sv) {
      if (!sv.val() || !sv.val().active) {
        recv_pc.close();
        db.ref(sigBase + '/offerCandidates').off();
        if (walkieAudioElem) { walkieAudioElem.srcObject = null; }
        db.ref('walkie/' + myUid + '/' + snap.key).off();
        showToast('🔇 ' + senderName + ' stopped broadcasting', 'info', 2000);
      }
    });
  });
}

function clearChatUnreadBadge() {
  chatUnreadCount = 0;
  if (chatUnreadBadge) chatUnreadBadge.style.display = 'none';
}

function initBackgroundLocator() {
  if (navigator.geolocation) {
    navigator.geolocation.watchPosition(position => {
      myLastPosition = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
      };
    }, err => {
      console.warn('Background locator error:', err);
    }, {
      enableHighAccuracy: true,
      maximumAge: 10000,
      timeout: 10000
    });
  }
}

// Firebase ping listener is registered asynchronously in initFirebase() once connection is established.


/* ================================================================
   32. INIT — runs once on page load
================================================================ */
async function init() {
  // Start background location watcher immediately for navigation accuracy
  initBackgroundLocator();

  // 1. Load profile details first
  loadMyProfile();
  if (myProfile.favColor) {
    accentColor = myProfile.favColor;
  }

  // 2. Load contacts from localStorage (starts empty on fresh install)
  loadContacts();

  // 3. Render initial card (handles empty state gracefully)
  renderCard(contacts[currentIndex] || null);
  renderBackCards();

  // 4. User identity & connect code
  initUserIdentity();

  // 5. Firebase (always try; falls back to demo mode on error)
  await initFirebase();

  // 5. Register PWA Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(reg => {
        console.log('📱 Service Worker registered:', reg.scope);
        reg.addEventListener('updatefound', () => {
          showToast('🔄 App update available — reload to apply', 'info', 8000);
        });
      })
      .catch(err => console.warn('📱 SW registration failed:', err));
  }

  // 6. Request notification permission (deferred — must follow user gesture ideally)
  if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(() => Notification.requestPermission(), 4000);
  }

  // 7. Birthday checks
  setTimeout(checkBirthdaysOnLoad, 1200);

  // 8. Periodic refresh — keep health scores + Firebase presence fresh
  setInterval(() => {
    saveContacts();
    if (contacts[currentIndex]) renderCard(contacts[currentIndex]);
    if (!isFirebaseLive) broadcastPresence(); // demo mode only
  }, 60000);

  // 8.1. Scheduled messages background checker — run immediately and then every 5s
  checkScheduledMessages();
  setInterval(checkScheduledMessages, 5000);

  // 9. PWA install prompt
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    showToast('📥 Install Relationship OS as an app!', 'info', 6000);
    const installBtn = document.getElementById('pwa-install-btn');
    if (installBtn) {
      installBtn.style.display = 'flex';
      installBtn.addEventListener('click', () => {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt = null;
        installBtn.style.display = 'none';
      }, { once: true });
    }
  });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Relationship OS v2.1 | ${contacts.length} contact(s)`);
  console.log(`🔗 Code: ${myCode}  |  UID: ${myUid.slice(0,8)}…`);
  console.log(`🔥 Firebase: ${isFirebaseLive ? 'LIVE ✅' : 'OFFLINE (demo mode) ⚠️'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// Open Memories modal and switch to tab
function openMemoriesModalTab(tabName) {
  openMemoriesModal();
  switchMemoriesTab(tabName);
}

// Open unlocked capsule modal
function openUnlockedCapsule(cap) {
  const overlay = document.getElementById('capsule-open-overlay');
  const msgEl = document.getElementById('capsule-open-message');
  const metaEl = document.getElementById('capsule-open-meta');
  if (!overlay || !msgEl || !metaEl) return;

  msgEl.textContent = cap.text;
  const sealDate = new Date(cap.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  metaEl.textContent = `Sealed by ${cap.author || 'Someone'} on ${sealDate}`;
  overlay.classList.add('active');
  triggerConfetti();
}

// Confetti animation
function triggerConfetti() {
  const colors = ['#f97316', '#3b82f6', '#10b981', '#a855f7', '#ec4899', '#eab308'];
  const container = document.body;
  for (let i = 0; i < 50; i++) {
    const confetti = document.createElement('div');
    confetti.style.left = Math.random() * 100 + 'vw';
    confetti.style.top = -20 + 'px';
    confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    confetti.style.width = Math.random() * 8 + 6 + 'px';
    confetti.style.height = Math.random() * 14 + 8 + 'px';
    confetti.style.position = 'fixed';
    confetti.style.zIndex = '1000000';
    confetti.style.opacity = Math.random() * 0.6 + 0.4;
    confetti.style.borderRadius = '2px';
    confetti.style.transform = `rotate(${Math.random() * 360}deg)`;
    container.appendChild(confetti);

    const duration = Math.random() * 2 + 1.5;
    const drift = (Math.random() - 0.5) * 120;

    confetti.animate([
      { transform: `translateY(0) rotate(0deg)`, opacity: 1 },
      { transform: `translateY(105vh) translateX(${drift}px) rotate(${Math.random() * 720}deg)`, opacity: 0 }
    ], {
      duration: duration * 1000,
      easing: 'cubic-bezier(0.1, 0.8, 0.3, 1)'
    });

    setTimeout(() => confetti.remove(), duration * 1000);
  }
}

document.getElementById('btn-close-capsule-open')?.addEventListener('click', () => {
  document.getElementById('capsule-open-overlay').classList.remove('active');
});

init();