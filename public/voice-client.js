/* Browser helper: WebRTC audio is peer-to-peer; Socket.IO only carries signaling. */
(function (global) {
  function newId() {
    const a = new Uint8Array(12); crypto.getRandomValues(a);
    return 'n' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function createVoiceClient({ socket, iceServers, onRemoteStream, onState, onError }) {
    const config = { iceServers: iceServers || [{ urls: 'stun:stun.l.google.com:19302' }] };
    let pc = null, negotiationId = null, localStream = null, pendingIce = [], peerId = null;
    const state = (s) => onState && onState(s);

    async function mic() {
      if (!localStream) localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return localStream;
    }

    function close(notify) {
      if (notify && negotiationId) socket.emit('webrtc:hangup', { negotiationId });
      if (pc) { pc.close(); pc = null; }
      negotiationId = null; peerId = null; pendingIce = [];
      state('idle');
    }

    async function makePc(id, other) {
      close(false);
      negotiationId = id; peerId = other;
      pc = new RTCPeerConnection(config);
      (await mic()).getTracks().forEach((t) => pc.addTrack(t, localStream));
      pc.ontrack = (e) => onRemoteStream && onRemoteStream(e.streams[0]);
      pc.onicecandidate = (e) => {
        if (e.candidate && negotiationId) {
          socket.emit('webrtc:ice-candidate', { negotiationId, candidate: e.candidate.toJSON() });
        }
      };
      pc.onconnectionstatechange = () => pc && state(pc.connectionState);
    }

    async function call(targetUserId) {
      const id = newId();
      await makePc(id, targetUserId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc:offer', { negotiationId: id, targetUserId, sdp: { type: offer.type, sdp: offer.sdp } });
      state('calling');
    }

    async function flushIce() {
      for (const c of pendingIce) await pc.addIceCandidate(c).catch(() => {});
      pendingIce = [];
    }

    socket.on('webrtc:offer', async (m) => {
      try {
        await makePc(m.negotiationId, m.fromUserId);
        await pc.setRemoteDescription(m.sdp);
        await flushIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', { negotiationId: m.negotiationId, sdp: { type: answer.type, sdp: answer.sdp } });
      } catch (e) { onError && onError(e); }
    });
    socket.on('webrtc:answer', async (m) => {
      if (m.negotiationId !== negotiationId || !pc) return; // ignore stale
      await pc.setRemoteDescription(m.sdp); await flushIce();
    });
    socket.on('webrtc:ice-candidate', async (m) => {
      if (m.negotiationId !== negotiationId || !pc) return;
      if (pc.remoteDescription) await pc.addIceCandidate(m.candidate).catch(() => {});
      else pendingIce.push(m.candidate);
    });
    ['webrtc:hangup', 'webrtc:peer-disconnected', 'webrtc:peer-ineligible'].forEach((ev) =>
      socket.on(ev, (m) => { if (m.negotiationId === negotiationId) { close(false); state(ev.split(':')[1]); } }));
    socket.on('webrtc:error', (e) => {
      if (e.negotiationId === negotiationId && e.event === 'webrtc:offer') close(false);
      onError && onError(e);
    });

    return { call, hangup: () => close(true) };
  }
  global.createVoiceClient = createVoiceClient;
})(window);
