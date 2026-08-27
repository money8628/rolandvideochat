/*
  rolandvideochat
  Copyright (c) 2026 rolandvideochat. All rights reserved.
*/

/* =========================================================================
   FIREBASE SETUP
   -------------------------------------------------------------------------
   1. Go to https://console.firebase.google.com â†’ create a project.
   2. Build > Realtime Database > Create database.
   3. Project settings > General > Your apps > Web app â†’ copy the config
      object and paste it in place of the one below.
   4. Paste the security rules provided alongside this app into the
      Rules tab of your Realtime Database.
   ========================================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyDKtOdU4PmUQE8_vwaz6k_w_BjRe466dyg",
  authDomain: "data-b61c7.firebaseapp.com",
  databaseURL: "https://data-b61c7-default-rtdb.firebaseio.com",
  projectId: "data-b61c7",
  storageBucket: "data-b61c7.firebasestorage.app",
  messagingSenderId: "570416012500",
  appId: "1:570416012500:web:66921eb421f776b01d2f41",
  measurementId: "G-XN0PPCPW42"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const MAX_PARTICIPANTS = 4;
const myId = (crypto.randomUUID ? crypto.randomUUID() : 'u-' + Date.now() + '-' + Math.random().toString(16).slice(2));

/* =========================================================================
   STATE
   ========================================================================= */
let localStream = null;
let roomCode = null;
let roomRef = null;
let participantsRef = null;
let pairsRef = null;
let messagesRef = null;
let micOn = true, camOn = true;
let joinedAt = 0;

const peers = {};        // remoteId -> { pc, pendingCandidates: [], pairKey, isCaller }
const participants = {}; // remoteId -> { joinedAt, micOn, camOn }  (everyone EXCEPT me)
const tileEls = {};      // id -> { wrap, video, tag }

const rtcConfig = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    // TURN relay â€” needed when a participant is behind a symmetric NAT,
    // CGNAT (common on mobile carriers), or a restrictive firewall, since
    // STUN alone can't establish a path for those. Free/rate-limited Open
    // Relay Project service; swap in your own TURN credentials (Twilio,
    // Xirsys, Cloudflare, or self-hosted coturn) for real-world traffic.
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

/* =========================================================================
   DOM
   ========================================================================= */
const landing = document.getElementById('landing');
const meetingScreen = document.getElementById('meetingScreen');
const camNote = document.getElementById('camNote');

const tabCreate = document.getElementById('tabCreate');
const tabJoin = document.getElementById('tabJoin');
const panelCreate = document.getElementById('panelCreate');
const panelJoin = document.getElementById('panelJoin');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const joinCodeInput = document.getElementById('joinCodeInput');
const createError = document.getElementById('createError');
const joinError = document.getElementById('joinError');
const publicRoomToggle = document.getElementById('publicRoomToggle');
const publicRoomFields = document.getElementById('publicRoomFields');
const roomDescription = document.getElementById('roomDescription');

const tileGrid = document.getElementById('tileGrid');
const waitingBanner = document.getElementById('waitingBanner');
const waitingBannerText = document.getElementById('waitingBannerText');
const statusText = document.getElementById('statusText');
const statusLabel = document.getElementById('statusLabel');
const roomCodeChip = document.getElementById('roomCodeChip');
const copyCodeBtn = document.getElementById('copyCodeBtn');
const participantCount = document.getElementById('participantCount');

const micBtn = document.getElementById('micBtn');
const camBtn = document.getElementById('camBtn');
const leaveBtn = document.getElementById('leaveBtn');
const reportBtn = document.getElementById('reportBtn');

const chatToggleBtn = document.getElementById('chatToggleBtn');
const chatPanel = document.getElementById('chatPanel');
const chatPanelClose = document.getElementById('chatPanelClose');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

const onlineCountLanding = document.getElementById('onlineCountLanding');

/* =========================================================================
   ONLINE PRESENCE COUNTER (site-wide, just a live-ness signal)
   ========================================================================= */
const onlineRef = db.ref('onlineUsers');
const myOnlineRef = onlineRef.push(true);
myOnlineRef.onDisconnect().remove();
onlineRef.on('value', snap => { onlineCountLanding.textContent = snap.numChildren(); });

/* =========================================================================
   LANDING â€” tabs
   ========================================================================= */
tabCreate.onclick = () => { tabCreate.classList.add('active'); tabJoin.classList.remove('active'); panelCreate.classList.add('active'); panelJoin.classList.remove('active'); };
tabJoin.onclick = () => { tabJoin.classList.add('active'); tabCreate.classList.remove('active'); panelJoin.classList.add('active'); panelCreate.classList.remove('active'); };

publicRoomToggle.onchange = () => {
  publicRoomFields.hidden = !publicRoomToggle.checked;
  if (!publicRoomToggle.checked) roomDescription.value = '';
  roomDescription.removeAttribute('aria-invalid');
};
publicRoomFields.hidden = true;

roomDescription.addEventListener('input', () => {
  if (roomDescription.value.trim()) roomDescription.removeAttribute('aria-invalid');
});

const requestedRoom = new URLSearchParams(window.location.search).get('room');
if (requestedRoom) {
  const normalizedRoom = requestedRoom.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (normalizedRoom.length === 6) {
    tabJoin.click();
    joinCodeInput.value = normalizedRoom;
  }
}

joinCodeInput.addEventListener('input', () => {
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

function showError(el, msg){ el.textContent = msg; el.classList.add('show'); }
function clearError(el){ el.textContent = ''; el.classList.remove('show'); }

/* =========================================================================
   ROOM CODE GENERATION
   ========================================================================= */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid ambiguity
function randomCode(){
  let c = '';
  for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

async function generateUniqueCode(){
  for (let attempt = 0; attempt < 8; attempt++){
    const code = randomCode();
    const snap = await db.ref('rooms/' + code + '/meta').once('value');
    if (!snap.exists()) return code;
  }
  throw new Error('Could not allocate a room code, please try again.');
}

/* =========================================================================
   MEDIA + ENTRY POINTS
   ========================================================================= */
async function ensureMedia(){
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  return localStream;
}

createBtn.onclick = async () => {
  clearError(createError);
  createBtn.disabled = true;
  camNote.textContent = 'Requesting camera & microphone';
  try{
    const isPublic = publicRoomToggle.checked;
    const description = roomDescription.value.trim();
    if (isPublic && !description){
      roomDescription.setAttribute('aria-invalid', 'true');
      showError(createError, 'Add a description for public rooms.');
      return;
    }
    await ensureMedia();
    const code = await generateUniqueCode();
    await db.ref('rooms/' + code + '/meta').set({
      createdAt: Date.now(),
      visibility: isPublic ? 'public' : 'private',
      description: isPublic ? description : ''
    });
    await enterRoom(code);
  }catch(err){
    console.error(err);
    showError(createError, err && err.name === 'NotAllowedError'
      ? 'Camera/microphone access is required. Please allow it and try again.'
      : (err.message || 'Something went wrong creating the room.'));
  }finally{
    createBtn.disabled = false;
    camNote.textContent = "We'll ask for camera & microphone access to connect you.";
  }
};

joinBtn.onclick = async () => {
  clearError(joinError);
  const code = joinCodeInput.value.trim().toUpperCase();
  if (code.length !== 6){ showError(joinError, 'Enter the 6-character room code.'); return; }
  joinBtn.disabled = true;
  camNote.textContent = 'Requesting camera & microphone';
  try{
    const metaSnap = await db.ref('rooms/' + code + '/meta').once('value');
    if (!metaSnap.exists()){ showError(joinError, "That room code doesn't exist."); return; }
    const partsSnap = await db.ref('rooms/' + code + '/participants').once('value');
    if (partsSnap.numChildren() >= MAX_PARTICIPANTS){ showError(joinError, 'That room is full (max 4 people).'); return; }
    await ensureMedia();
    await enterRoom(code);
  }catch(err){
    console.error(err);
    showError(joinError, err && err.name === 'NotAllowedError'
      ? 'Camera/microphone access is required. Please allow it and try again.'
      : (err.message || 'Something went wrong joining the room.'));
  }finally{
    joinBtn.disabled = false;
    camNote.textContent = "We'll ask for camera & microphone access to connect you.";
  }
};

/* =========================================================================
   ENTER ROOM
   ========================================================================= */
async function enterRoom(code){
  roomCode = code;
  joinedAt = Date.now();
  roomRef = db.ref('rooms/' + code);
  participantsRef = roomRef.child('participants');
  pairsRef = roomRef.child('pairs');
  messagesRef = roomRef.child('messages');

  landing.style.display = 'none';
  meetingScreen.style.display = 'flex';
  roomCodeChip.textContent = code;
  chatMessages.innerHTML = '';
  tileGrid.innerHTML = '';
  Object.keys(tileEls).forEach(k => delete tileEls[k]);
  setStatus('Waiting for others to join', false);

  addTile(myId, 'You', true, localStream);

  // Read who is already here BEFORE registering myself, so I know exactly
  // who I need to initiate a connection to (I connect out to everyone
  // already present; every future joiner will do the same to me).
  const existingSnap = await participantsRef.once('value');
  const existingIds = [];
  existingSnap.forEach(child => { existingIds.push(child.key); return false; });

  const myRef = participantsRef.child(myId);
  await myRef.set({ joinedAt, micOn, camOn });
  myRef.onDisconnect().remove();

  existingIds.forEach(otherId => startConnection(otherId, true));

  // Passive side: watch for pairs where I'm the callee (someone joining
  // later than me will initiate to me this way).
  pairsRef.on('child_added', snap => {
    const val = snap.val();
    if (!val || val.calleeId !== myId) return;
    if (peers[val.callerId]) return; // already handling this pair
    startConnection(val.callerId, false, snap.key, val);
  });

  participantsRef.on('child_added', snap => {
    const id = snap.key;
    if (id === myId) return;
    participants[id] = snap.val();
    applyParticipantState(id);
    updateParticipantCount();
    updateAloneGuard();
  });
  participantsRef.on('child_changed', snap => {
    const id = snap.key;
    if (id === myId) return;
    participants[id] = snap.val();
    applyParticipantState(id);
  });
  participantsRef.on('child_removed', snap => {
    const id = snap.key;
    if (id === myId) return;
    delete participants[id];
    closePeer(id);
    removeTile(id);
    appendSystemMessage('A participant has left the room.');
    updateParticipantCount();
    updateAloneGuard();
  });
  participantsRef.on('value', snap => {
    if (!snap.exists()) removeRoomIfEmpty();
  });

  messagesRef.on('child_added', snap => appendMessage(snap.val()));

  updateParticipantCount();
  updateAloneGuard();
}

/* Room auto-close: whenever I am the only person left in the room, arm a
   deletion of the WHOLE room (meta, participants, pairs, messages) that
   fires automatically if my connection drops without a clean "Leave" â€”
   e.g. the tab crashes or the network dies. As soon as anyone else joins,
   the arm is cancelled so their presence doesn't get wiped out by my
   disconnect. Whichever participant is currently alone always holds this
   guard, so the room is reliably cleaned up the moment it's truly empty. */
function updateAloneGuard(){
  if (!roomRef) return;
  const alone = Object.keys(participants).length === 0;
  if (alone) roomRef.onDisconnect().remove();
  else roomRef.onDisconnect().cancel();
}

function removeRoomIfEmpty(){
  if (!roomRef || !participantsRef) return;
  participantsRef.once('value').then(snap => {
    if (snap.exists()) return;
    roomRef.onDisconnect().cancel();
    return roomRef.remove();
  }).catch(console.error);
}

function updateParticipantCount(){
  const n = Object.keys(participants).length + 1;
  participantCount.textContent = n;
  setStatus(n > 1 ? 'Connected' : 'Waiting for others to join', n > 1);
  waitingBanner.style.display = n >= 2 ? 'none' : 'flex';
  waitingBannerText.textContent = 'Share the room code "' + roomCode + ' waiting for others';
}
function setStatus(text, live){
  statusLabel.textContent = text;
  statusText.classList.toggle('live', !!live);
}

function applyParticipantState(id){
  const tile = tileEls[id];
  const state = participants[id];
  if (!tile || !state) return;
  tile.tag.classList.toggle('is-muted', state.micOn === false);
  tile.wrap.classList.toggle('camera-off', state.camOn === false);
}

/* =========================================================================
   TILES
   ========================================================================= */
function addTile(id, label, isLocal, stream){
  const wrap = document.createElement('div');
  wrap.className = 'tile' + (isLocal ? ' local' : '');
  wrap.dataset.id = id;

  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true;
  if (isLocal) video.muted = true;
  if (stream) video.srcObject = stream;

  const tag = document.createElement('div');
  tag.className = 'tile-label';
  tag.innerHTML = '<span class="name">' + label + '</span><span class="mic-off">&#128263;</span>';

  wrap.appendChild(video);
  wrap.appendChild(tag);
  tileGrid.appendChild(wrap);
  tileEls[id] = { wrap, video, tag };
  if (id === myId){
    tag.classList.toggle('is-muted', !micOn);
    wrap.classList.toggle('camera-off', !camOn);
  } else {
    applyParticipantState(id);
  }
  relayoutGrid();
  return tileEls[id];
}
function removeTile(id){
  const t = tileEls[id];
  if (t){ t.wrap.remove(); delete tileEls[id]; }
  relayoutGrid();
}
function relayoutGrid(){
  const n = Math.max(1, Math.min(4, Object.keys(tileEls).length));
  tileGrid.classList.remove('n1', 'n2', 'n3', 'n4');
  tileGrid.classList.add('n' + n);
}
function shortLabel(id){ return id === myId ? 'You' : ('Guest-' + id.slice(0, 4)); }

/* =========================================================================
   WEBRTC â€” one RTCPeerConnection per remote participant (full mesh)
   -------------------------------------------------------------------------
   pairKey is the two participant ids sorted and joined, so both sides
   compute the same database path independently. Whichever side already
   existed in the room when the other joined always becomes the "callee";
   the newcomer is always the "caller" who creates the offer.
   ========================================================================= */
function pairKeyFor(a, b){ return [a, b].sort().join('__'); }

function startConnection(otherId, isCaller, existingPairKey, existingPairVal){
  const pairKey = existingPairKey || pairKeyFor(myId, otherId);
  const pairRef = pairsRef.child(pairKey);
  const pc = new RTCPeerConnection(rtcConfig);
  const entry = { pc, pendingCandidates: [], pairKey, isCaller };
  peers[otherId] = entry;

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = e => {
    const tile = tileEls[otherId] || addTile(otherId, shortLabel(otherId), false, null);
    if (tile.video.srcObject !== e.streams[0]) tile.video.srcObject = e.streams[0];
  };

  const myCandidatesField = isCaller ? 'callerCandidates' : 'calleeCandidates';
  const theirCandidatesField = isCaller ? 'calleeCandidates' : 'callerCandidates';

  pc.onicecandidate = e => { if (e.candidate) pairRef.child(myCandidatesField).push(e.candidate.toJSON()); };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed'){
      closePeer(otherId);
      removeTile(otherId);
    }
  };

  pairRef.child(theirCandidatesField).on('child_added', snap => {
    const data = snap.val();
    if (pc.currentRemoteDescription) pc.addIceCandidate(new RTCIceCandidate(data)).catch(console.error);
    else entry.pendingCandidates.push(data);
  });

  function flushPending(){
    entry.pendingCandidates.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error));
    entry.pendingCandidates = [];
  }

  if (isCaller){
    pairRef.onDisconnect().remove();
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer).then(() => offer))
      .then(offer => pairRef.set({ callerId: myId, calleeId: otherId, offer: { type: offer.type, sdp: offer.sdp } }));

    pairRef.child('answer').on('value', snap => {
      const data = snap.val();
      if (data && !pc.currentRemoteDescription){
        pc.setRemoteDescription(new RTCSessionDescription(data)).then(flushPending);
      }
    });
  } else {
    pc.setRemoteDescription(new RTCSessionDescription(existingPairVal.offer))
      .then(flushPending)
      .then(() => pc.createAnswer())
      .then(answer => pc.setLocalDescription(answer).then(() => answer))
      .then(answer => pairRef.child('answer').set({ type: answer.type, sdp: answer.sdp }));
  }
}

function closePeer(otherId){
  const entry = peers[otherId];
  if (!entry) return;
  try{ pairsRef.child(entry.pairKey).off(); }catch(e){}
  try{ entry.pc.close(); }catch(e){}
  delete peers[otherId];
}

/* =========================================================================
   CHAT
   ========================================================================= */
function appendSystemMessage(text){
  const div = document.createElement('div');
  div.className = 'msg sys';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function appendMessage(data){
  const div = document.createElement('div');
  const mine = data.from === myId;
  div.className = 'msg ' + (mine ? 'me' : 'them');
  const fromEl = document.createElement('div');
  fromEl.className = 'msg-from';
  fromEl.textContent = mine ? 'You' : shortLabel(data.from);
  const textEl = document.createElement('div');
  textEl.textContent = data.text;
  div.appendChild(fromEl);
  div.appendChild(textEl);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
chatToggleBtn.onclick = () => chatPanel.classList.toggle('collapsed');
chatPanelClose.onclick = () => chatPanel.classList.add('collapsed');
chatSendBtn.onclick = sendChatMessage;
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage(); });
function sendChatMessage(){
  const text = chatInput.value.trim();
  if (!text || !messagesRef) return;
  messagesRef.push({ from: myId, text, ts: Date.now() });
  chatInput.value = '';
}

/* =========================================================================
   CONTROLS
   ========================================================================= */
copyCodeBtn.onclick = () => {
  if (!roomCode) return;
  navigator.clipboard.writeText(roomCode).then(() => {
    appendSystemMessage('Room code copied to clipboard.');
  }).catch(() => {});
};

micBtn.onclick = () => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  micBtn.classList.toggle('off', !micOn);
  const t = tileEls[myId];
  if (t) t.tag.classList.toggle('is-muted', !micOn);
  if (participantsRef) participantsRef.child(myId).update({ micOn });
};
camBtn.onclick = () => {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  camBtn.classList.toggle('off', !camOn);
  const t = tileEls[myId];
  if (t) t.wrap.classList.toggle('camera-off', !camOn);
  if (participantsRef) participantsRef.child(myId).update({ camOn });
};

leaveBtn.onclick = () => leaveRoom();

reportBtn.onclick = () => {
  const otherIds = Object.keys(participants);
  if (otherIds.length){
    db.ref('reports').push({ reporter: myId, room: roomCode, participants: otherIds, ts: Date.now() });
  }
  appendSystemMessage('Report submitted. A moderator can review this room.');
};

function leaveRoom(){
  const wasAlone = Object.keys(participants).length === 0;

  Object.keys(peers).forEach(id => closePeer(id));
  Object.keys(tileEls).forEach(id => removeTile(id));
  if (participantsRef){ participantsRef.off(); participantsRef.child(myId).remove(); }
  if (pairsRef) pairsRef.off();
  if (messagesRef) messagesRef.off();
  if (localStream){ localStream.getTracks().forEach(t => t.stop()); localStream = null; }

  // I was the last one in the room â€” close it out entirely so no empty
  // room data lingers in the database.
  if (wasAlone && roomRef){
    roomRef.onDisconnect().cancel();
    roomRef.remove();
  }

  Object.keys(participants).forEach(k => delete participants[k]);
  roomCode = null; roomRef = null; participantsRef = null; pairsRef = null; messagesRef = null;
  chatPanel.classList.add('collapsed');
  joinCodeInput.value = '';

  meetingScreen.style.display = 'none';
  landing.style.display = 'flex';
}

/* Best-effort cleanup if the tab is closed outright. */
window.addEventListener('beforeunload', () => {
  if (participantsRef) participantsRef.child(myId).remove();
});
