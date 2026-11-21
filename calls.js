/* ============================================================
   calls.js — WebRTC calls via Trystero (no account, no server)
   ============================================================ */

import { joinRoom } from 'trystero';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class CallManager {
  constructor({ roomId, userId, displayName, onPeerStream, onPeerLeave, onError }) {
    this.roomId = roomId;
    this.userId = userId;
    this.displayName = displayName;
    this.onPeerStream = onPeerStream || (() => {});
    this.onPeerLeave = onPeerLeave || (() => {});
    this.onError = onError || ((e) => console.error(e));

    this.room = null;
    this.localStream = null;
    this.peers = new Map(); // peerId -> { pc, stream }
    this.audioEnabled = true;
    this.videoEnabled = true;
  }

  async start({ audio = true, video = true } = {}) {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video });
    } catch (err) {
      this.onError(err);
      return null;
    }

    this.room = joinRoom({ appId: 'classe-messenger' }, this.roomId);

    // Receive remote streams
    this.room.onPeerStream((stream, peerId) => {
      this.onPeerStream(peerId, stream);
    });

    this.room.onPeerJoin((peerId) => {
      this.createPeer(peerId);
      if (this.localStream) this.room.addStream(this.localStream, peerId);
    });

    this.room.onPeerLeave((peerId) => {
      this.removePeer(peerId);
      this.onPeerLeave(peerId);
    });

    return this.localStream;
  }

  createPeer(peerId) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, stream: null };
    this.peers.set(peerId, entry);

    pc.ontrack = (e) => {
      entry.stream = e.streams[0];
      this.onPeerStream(peerId, e.streams[0]);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        this.removePeer(peerId);
        this.onPeerLeave(peerId);
      }
    };

    return entry;
  }

  removePeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    try { entry.pc.close(); } catch {}
    this.peers.delete(peerId);
  }

  toggleAudio() {
    this.audioEnabled = !this.audioEnabled;
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = this.audioEnabled));
    return this.audioEnabled;
  }

  toggleVideo() {
    this.videoEnabled = !this.videoEnabled;
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = this.videoEnabled));
    return this.videoEnabled;
  }

  async shareScreen() {
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const videoTrack = screen.getVideoTracks()[0];
      for (const [, entry] of this.peers) {
        const sender = entry.pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(videoTrack);
      }
      videoTrack.onended = () => this.stopScreenShare();
      this.screenStream = screen;
    } catch (err) {
      this.onError(err);
    }
  }

  async stopScreenShare() {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach((t) => t.stop());
    const camTrack = this.localStream?.getVideoTracks()[0];
    if (camTrack) {
      for (const [, entry] of this.peers) {
        const sender = entry.pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(camTrack);
      }
    }
    this.screenStream = null;
  }

  async hangup() {
    for (const peerId of this.peers.keys()) this.removePeer(peerId);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    if (this.room) {
      try { await this.room.leave(); } catch {}
      this.room = null;
    }
  }
}
